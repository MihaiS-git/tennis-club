import "server-only";

import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { localMinute, localToday } from "@/lib/courts/local-time";
import { requireReservationRole } from "./authorization";
import { reservationEditSchema } from "./domain";
import { loadReservationEditDayForLocation } from "./edit-availability";
import type { PersonalReservation } from "./personal";
import { validateDirectReservationTarget } from "./service";

const rowSchema = z.object({
  id: z.uuid(), court_id: z.uuid(), location_id: z.uuid(), updated_at: z.iso.datetime({ offset: true }),
  booking_date: z.iso.date(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
  reason: z.string().nullable(), status: z.enum(["active", "cancelled"]),
  created_by_user_id: z.uuid().nullable(), creator_name: z.string().nullable(),
  cancelled_at: z.iso.datetime({ offset: true }).nullable(), cancelled_by_name: z.string().nullable(),
  location_name: z.string(), location_timezone: z.string(), court_name: z.string(),
});

async function readPersonalReservations(client?: Awaited<ReturnType<typeof createClient>>, now = new Date()) {
  const supabase = client ?? await createClient();
  const account = await readCurrentAccount(supabase);
  if (account.state !== "active") throw new Error("An active account is required.");
  if (!account.roles.some((role) => role === "admin" || role === "coach")) return [];
  const result = await supabase.rpc("list_personal_court_reservations", { p_now: now.toISOString() });
  const parsed = z.array(rowSchema).safeParse(result.data);
  if (result.error || !parsed.success || parsed.data.some((row) => row.created_by_user_id !== account.userId)) {
    logger.error({ event: "activity.reservations_read_failed", code: result.error?.code }, "Failed to load personal reservations");
    throw new Error("Unable to load your reservations.");
  }
  return parsed.data satisfies PersonalReservation[];
}

export async function listPersonalReservations(client?: Awaited<ReturnType<typeof createClient>>, now = new Date()) {
  return { upcoming: await readPersonalReservations(client, now) };
}

export async function getOwnReservationEditDay(input: { reservationId: unknown; date: unknown },
  client?: Awaited<ReturnType<typeof createClient>>, now = new Date()) {
  const supabase = client ?? await createClient();
  await requireReservationRole(supabase);
  const parsed = z.object({ reservationId: z.uuid(), date: z.iso.date() }).safeParse(input);
  if (!parsed.success) throw new Error("Choose a valid date.");
  const reservation = (await listPersonalReservations(supabase, now)).upcoming.find((row) => row.id === parsed.data.reservationId);
  if (!reservation) throw new Error("This reservation is no longer available to edit.");
  if (parsed.data.date < localToday(reservation.location_timezone, now)) throw new Error("Choose a future date at this location.");
  const occupancyResult = await supabase.rpc("list_own_reservation_edit_occupancy", { p_id: reservation.id, p_date: parsed.data.date });
  const occupancy = z.array(z.object({ court_id: z.uuid(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int() })).safeParse(occupancyResult.data);
  if (occupancyResult.error || !occupancy.success) {
    logger.error({ event: "activity.edit_day_read_failed", occupancyCode: occupancyResult.error?.code }, "Failed to load reservation edit occupancy");
    throw new Error("Unable to load court availability.");
  }
  return loadReservationEditDayForLocation({ client: supabase, locationId: reservation.location_id,
    timezone: reservation.location_timezone, date: parsed.data.date, occupancy: occupancy.data, now });
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
