import "server-only";

import { z } from "zod";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { editDirectReservationCommand, cancelDirectReservationCommand } from "./commands";
import { localToday } from "@/lib/courts/local-time";
import { requireReservationRole } from "./authorization";
import { reservationEditSchema } from "./domain";
import { loadReservationEditDayForLocation } from "./edit-availability";
import { isReservationUpcoming } from "./personal";
import { readInternalOccupancy } from "./service";

export async function getOwnReservationEditDay(input: { reservationId: unknown; date: unknown },
  client?: Awaited<ReturnType<typeof createClient>>, now = new Date()) {
  const supabase = client ?? await createClient();
  const actor = await requireReservationRole(supabase);
  const parsed = z.object({ reservationId: z.uuid(), date: z.iso.date() }).safeParse(input);
  if (!parsed.success) throw new Error("Choose a valid date.");
  let reservation: Awaited<ReturnType<typeof reservations.findReservationEditContext>>;
  try {
    reservation = await reservations.findReservationEditContext((await getDataSource()).manager, parsed.data.reservationId, actor.userId);
  } catch (error: unknown) {
    logger.error({ event: "activity.edit_day_read_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load reservation edit target");
    throw new Error("Unable to load court availability.");
  }
  if (!reservation || reservation.id !== parsed.data.reservationId || reservation.created_by_user_id !== actor.userId
    || !isReservationUpcoming({ ...reservation, status: "active" }, now)) {
    throw new Error("This reservation is no longer available to edit.");
  }
  const timezone = reservation.location_timezone;
  if (parsed.data.date < localToday(timezone, now)) throw new Error("Choose a future date at this location.");
  const occupancy = await readInternalOccupancy({ locationId: reservation.location_id },
    parsed.data.date, now, reservation.id);
  return loadReservationEditDayForLocation({ client: supabase, locationId: reservation.location_id,
    timezone, date: parsed.data.date, occupancy, now });
}

export async function cancelOwnDirectReservation(input: unknown, client?: Awaited<ReturnType<typeof createClient>>) {
  const supabase = client ?? await createClient();
  const actor = await requireReservationRole(supabase);
  const parsed = z.uuid().safeParse(input);
  if (!parsed.success) return { ok: false as const, message: "Choose a valid reservation." };
  try {
    const result = await cancelDirectReservationCommand(parsed.data, actor.userId, "owner");
    if (result.ok) logger.info({ event: "profile.reservation_cancelled", actorId: actor.userId, reservationId: parsed.data }, "Own direct reservation cancelled");
    return result;
  } catch (error: unknown) {
    logger.error({ event: "profile.reservation_cancel_failed", actorId: actor.userId, reservationId: parsed.data,
      code: normalizeDatabaseError(error).sqlState }, "Failed to cancel own direct reservation");
    return { ok: false as const, message: "Unable to cancel this reservation. Try again." };
  }
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
  try {
    const result = await editDirectReservationCommand(parsed.data, actor.userId, "owner", now);
    if (result.ok) {
      logger.info({ event: "profile.reservation_edited", actorId: actor.userId, reservationId: parsed.data.id }, "Own direct reservation edited");
      return { ok: true };
    }
    return result;
  } catch (error: unknown) {
    const failure = normalizeDatabaseError(error);
    if (failure.sqlState === "23P01" && failure.constraint === "court_reservation_no_overlap") return { ok: false,
      message: "That court is no longer available for the selected time. Your existing reservation has not been changed." };
    logger.error({ event: "profile.reservation_edit_failed", actorId: actor.userId, reservationId: parsed.data.id, code: failure.sqlState }, "Failed to edit own direct reservation");
    return { ok: false, message: "Unable to save this reservation. Refresh the details before trying again." };
  }
}
