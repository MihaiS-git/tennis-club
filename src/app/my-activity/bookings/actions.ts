"use server";

import { revalidatePath } from "next/cache";
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
