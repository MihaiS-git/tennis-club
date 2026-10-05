"use server";

import { z } from "zod";
import { getOwnBookingEditDay, rescheduleOwnCustomerBooking } from "@/lib/bookings/self-reschedule";
import { logger } from "@/lib/logger";
import { revalidateCourtActivity } from "@/lib/reservations/revalidation";
import { cancelOwnCustomerBooking } from "@/lib/bookings/self-cancellation-service";
import { listOwnUpcomingActivity } from "@/lib/bookings/activity-service";
import { cancelOwnDirectReservation, editOwnDirectReservation, getOwnReservationEditDay } from "@/lib/reservations/personal-service";

export async function loadPersonalActivityAction(input: unknown = {}) {
  const parsed = z.record(z.string(), z.union([z.string(), z.array(z.string()), z.undefined()])).safeParse(input);
  if (!parsed.success) throw new Error("Invalid activity query.");
  return listOwnUpcomingActivity(parsed.data);
}

export async function cancelOwnReservationAction(id: unknown) {
  const result = await cancelOwnDirectReservation(id);
  if (result.ok) {
    revalidateCourtActivity("cancel");
  }
  return result;
}

export async function loadReservationEditDayAction(reservationId: unknown, date: unknown) {
  return getOwnReservationEditDay({ reservationId, date });
}

export async function editOwnReservationAction(input: unknown) {
  const result = await editOwnDirectReservation(input);
  if (result.ok) {
    revalidateCourtActivity("edit");
  }
  return result;
}

export async function cancelOwnCustomerBookingAction(id: unknown) {
  try {
    const result = await cancelOwnCustomerBooking(id);
    if (result.ok) {
      revalidateCourtActivity("cancel");
    }
    return result;
  } catch {
    logger.error({ event: "bookings.self_cancel_action_failed" }, "Customer self-cancellation failed");
    return { ok: false as const, message: "Unable to cancel this booking. Try again." };
  }
}

export async function loadOwnBookingEditDayAction(id: unknown, date: unknown) {
  return getOwnBookingEditDay(id, date);
}

export async function quoteOwnBookingAction(input: unknown) {
  if (!z.object({ save: z.literal(false) }).safeParse(input).success)
    return { ok: false as const, message: "Invalid quote request." };
  return rescheduleOwnCustomerBooking(input);
}

export async function rescheduleOwnBookingAction(input: unknown) {
  if (!z.object({ save: z.literal(true) }).safeParse(input).success)
    return { ok: false as const, message: "Invalid save request." };
  const result = await rescheduleOwnCustomerBooking(input);
  if (result.ok) revalidateCourtActivity("edit");
  return result;
}
