import "server-only";

import { z } from "zod";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { localMinute, localToday } from "@/lib/courts/local-time";
import { requireReservationRole } from "./authorization";
import { reservationEditSchema } from "./domain";
import { loadReservationEditDayForLocation } from "./edit-availability";
import { isReservationUpcoming, type PersonalReservation } from "./personal";
import { readInternalOccupancy, validateDirectReservationTarget } from "./service";

const userNameSchema = z.object({ first_name: z.string().nullable(), last_name: z.string().nullable() }).nullable();
const reservationSelectSchema = z.object({
  id: z.uuid(), court_id: z.uuid(), updated_at: z.iso.datetime({ offset: true }),
  booking_date: z.iso.date(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
  reason: z.string().nullable(), status: z.literal("active"), created_by_user_id: z.uuid(),
  cancelled_at: z.iso.datetime({ offset: true }).nullable(),
  creator: userNameSchema, canceller: userNameSchema,
  court: z.object({ name: z.string(), location_id: z.uuid(),
    location: z.object({ name: z.string(), timezone: z.string() }),
  }),
});

function displayName(user: z.infer<typeof userNameSchema>) {
  if (!user) return null;
  return [user.first_name, user.last_name].filter((part) => part !== null).join(" ") || null;
}

export async function listPersonalReservations(client?: Awaited<ReturnType<typeof createClient>>, now = new Date()) {
  const supabase = client ?? await createClient();
  const account = await requireReservationRole(supabase);
  // Private columns have no authenticated SELECT grants. Keep this privileged
  // read bound to the verified staff owner rather than widening public access.
  const reader = createBookingWriter();
  const upcoming: PersonalReservation[] = [];
  // Page through the owner's active rows so PostgREST's row cap cannot let
  // finished intervals hide upcoming ones before TypeScript time filtering.
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const result = await reader.from("court_reservations").select(`
      id, court_id, updated_at, booking_date, starts_at_minute, ends_at_minute,
      reason, status, created_by_user_id, cancelled_at,
      court:courts!inner(name, location_id, location:locations!inner(name, timezone)),
      creator:users!court_reservations_created_by_user_id_fkey(first_name, last_name),
      canceller:users!court_reservations_cancelled_by_user_id_fkey(first_name, last_name)
    `).eq("created_by_user_id", account.userId).eq("status", "active")
      .order("booking_date").order("starts_at_minute").order("id")
      .range(offset, offset + pageSize - 1);
    const parsed = z.array(reservationSelectSchema).safeParse(result.data);
    if (result.error || !parsed.success || parsed.data.some((row) => row.created_by_user_id !== account.userId)) {
      logger.error({ event: "activity.reservations_read_failed", code: result.error?.code }, "Failed to load personal reservations");
      throw new Error("Unable to load your reservations.");
    }
    const reservations: PersonalReservation[] = parsed.data.map(({ court, creator, canceller, ...row }) => ({
      ...row, location_id: court.location_id, creator_name: displayName(creator),
      cancelled_by_name: displayName(canceller), location_name: court.location.name,
      location_timezone: court.location.timezone, court_name: court.name,
    }));
    upcoming.push(...reservations.filter((row) => isReservationUpcoming(row, now)));
    if (parsed.data.length < pageSize) break;
  }
  return { upcoming };
}

export async function getOwnReservationEditDay(input: { reservationId: unknown; date: unknown },
  client?: Awaited<ReturnType<typeof createClient>>, now = new Date()) {
  const supabase = client ?? await createClient();
  const actor = await requireReservationRole(supabase);
  const parsed = z.object({ reservationId: z.uuid(), date: z.iso.date() }).safeParse(input);
  if (!parsed.success) throw new Error("Choose a valid date.");
  const reader = createBookingWriter();
  const result = await reader.from("court_reservations").select(`
    id, created_by_user_id, status, booking_date, starts_at_minute, ends_at_minute,
    court:courts!inner(location_id, is_active, location:locations!inner(timezone, is_active, archived_at))
  `).eq("id", parsed.data.reservationId).eq("created_by_user_id", actor.userId).eq("status", "active")
    .eq("court.is_active", true).eq("court.location.is_active", true).is("court.location.archived_at", null)
    .maybeSingle();
  const target = z.object({
    id: z.uuid(), created_by_user_id: z.uuid(), status: z.literal("active"),
    booking_date: z.iso.date(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
    court: z.object({ location_id: z.uuid(), is_active: z.literal(true),
      location: z.object({ timezone: z.string(), is_active: z.literal(true), archived_at: z.null() }) }),
  }).nullable().safeParse(result.data);
  if (result.error || !target.success) {
    logger.error({ event: "activity.edit_day_read_failed", code: result.error?.code }, "Failed to load reservation edit target");
    throw new Error("Unable to load court availability.");
  }
  const reservation = target.data;
  if (!reservation || reservation.id !== parsed.data.reservationId || reservation.created_by_user_id !== actor.userId
    || !isReservationUpcoming({ ...reservation, location_timezone: reservation.court.location.timezone }, now)) {
    throw new Error("This reservation is no longer available to edit.");
  }
  const timezone = reservation.court.location.timezone;
  if (parsed.data.date < localToday(timezone, now)) throw new Error("Choose a future date at this location.");
  const occupancy = await readInternalOccupancy({ locationId: reservation.court.location_id },
    parsed.data.date, now, reservation.id);
  return loadReservationEditDayForLocation({ client: supabase, locationId: reservation.court.location_id,
    timezone, date: parsed.data.date, occupancy, now });
}

export async function cancelOwnDirectReservation(input: unknown, client?: Awaited<ReturnType<typeof createClient>>) {
  const supabase = client ?? await createClient();
  const actor = await requireReservationRole(supabase);
  const parsed = z.uuid().safeParse(input);
  if (!parsed.success) return { ok: false as const, message: "Choose a valid reservation." };
  const { data, error } = await supabase.rpc("cancel_own_court_reservation", { p_id: parsed.data });
  if (error) {
    logger.error({ event: "profile.reservation_cancel_failed", actorId: actor.userId, reservationId: parsed.data, code: error.code }, "Failed to cancel own direct reservation");
    return { ok: false as const, message: "Unable to cancel this reservation. Try again." };
  }
  if (!data) return { ok: false as const, message: "This reservation is no longer available to cancel." };
  logger.info({ event: "profile.reservation_cancelled", actorId: actor.userId, reservationId: parsed.data }, "Own direct reservation cancelled");
  return { ok: true as const };
}

export type EditReservationResult = { ok: true } | { ok: false; message: string; stale?: boolean; fieldErrors?: Record<string, string> };

export async function editOwnDirectReservation(input: unknown, client?: Awaited<ReturnType<typeof createClient>>, now = new Date()): Promise<EditReservationResult> {
  const supabase = client ?? await createClient();
  const actor = await requireReservationRole(supabase);
  const parsed = reservationEditSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path.at(-1) ?? "form");
      fieldErrors[field] ??= issue.message;
    }
    return { ok: false, message: "Check the reservation details.", fieldErrors };
  }
  const edit = parsed.data;
  const activity = await listPersonalReservations(supabase, now);
  const reservation = activity.upcoming.find((row) => row.id === edit.id);
  if (!reservation) return { ok: false, message: "This reservation is no longer available to edit." };
  if (reservation.updated_at !== edit.expectedUpdatedAt) return { ok: false, stale: true,
    message: "This reservation has changed since you opened it. Refresh the details and try again." };
  const today = localToday(reservation.location_timezone, now);
  const inProgress = reservation.booking_date === today && reservation.starts_at_minute <= localMinute(reservation.location_timezone, now);
  if (edit.kind === "schedule") {
    if (inProgress) return { ok: false, message: "An in-progress reservation can only change its reason." };
    const target = await validateDirectReservationTarget({ ...edit.schedule, locationId: reservation.location_id }, supabase, now, actor.userId);
    if (!target.ok) return target;
  }
  const { data, error } = await supabase.rpc("edit_own_court_reservation", {
    p_id: edit.id, p_expected_updated_at: edit.expectedUpdatedAt,
    p_reason: edit.kind === "reason" ? edit.reason : edit.schedule.reason,
    p_schedule: edit.kind === "schedule",
    p_court_id: edit.kind === "schedule" ? edit.schedule.courtId : null,
    p_booking_date: edit.kind === "schedule" ? edit.schedule.date : null,
    p_starts_at_minute: edit.kind === "schedule" ? edit.schedule.startMinute : null,
    p_ends_at_minute: edit.kind === "schedule" ? edit.schedule.endMinute : null,
  });
  if (error) {
    if (error.code === "23P01") return { ok: false,
      message: "That court is no longer available for the selected time. Your existing reservation has not been changed." };
    logger.error({ event: "profile.reservation_edit_failed", actorId: actor.userId, reservationId: edit.id, code: error.code }, "Failed to edit own direct reservation");
    return { ok: false, message: "Unable to save this reservation. Refresh the details before trying again." };
  }
  if (data === "stale") return { ok: false, stale: true,
    message: "This reservation has changed since you opened it. Refresh the details and try again." };
  if (data !== "updated") return { ok: false, message: "This reservation is no longer available to edit." };
  logger.info({ event: "profile.reservation_edited", actorId: actor.userId, reservationId: edit.id }, "Own direct reservation edited");
  return { ok: true };
}
