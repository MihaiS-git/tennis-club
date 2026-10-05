"use server";

import { logger } from "@/lib/logger";
import { revalidatePath } from "next/cache";
import { cancelOwnCustomerBooking } from "@/lib/bookings/self-cancellation-service";
import { listOwnUpcomingCustomerBookings } from "@/lib/bookings/personal-service";
import { cancelOwnDirectReservation, editOwnDirectReservation, getOwnReservationEditDay, listPersonalReservations } from "@/lib/reservations/personal-service";

export async function loadPersonalActivityAction() {
  const [reservations, bookings] = await Promise.all([
    listPersonalReservations(), listOwnUpcomingCustomerBookings(),
  ]);
  return { ...reservations, bookings };
}

export async function cancelOwnReservationAction(id: unknown) {
  const result = await cancelOwnDirectReservation(id);
  if (result.ok) {
    revalidatePath("/reservations");
    revalidatePath("/book");
  }
  return result;
}

export async function loadReservationEditDayAction(reservationId: unknown, date: unknown) {
  return getOwnReservationEditDay({ reservationId, date });
}

export async function editOwnReservationAction(input: unknown) {
  const result = await editOwnDirectReservation(input);
  if (result.ok) {
    revalidatePath("/reservations");
    revalidatePath("/book");
  }
  return result;
}

export async function cancelOwnCustomerBookingAction(id: unknown) {
  try {
    const result = await cancelOwnCustomerBooking(id);
    if (result.ok) {
      revalidatePath("/my-activity/bookings");
      revalidatePath("/my-activity/bookings/history");
      revalidatePath("/reservations");
      revalidatePath("/book");
    }
    return result;
  } catch {
    logger.error({ event: "bookings.self_cancel_action_failed" }, "Customer self-cancellation failed");
    return { ok: false as const, message: "Unable to cancel this booking. Try again." };
  }
}
