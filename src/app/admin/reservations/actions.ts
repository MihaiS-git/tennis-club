"use server";

import { revalidateCourtActivity } from "@/lib/reservations/revalidation";
import { cancelCustomerBookingAsAdmin, cancelDirectReservationAsAdmin, createDirectReservation, editDirectReservationAsAdmin, getAdminReservationEditDay } from "@/lib/reservations/service";

export async function reserveCourtAction(input: unknown) {
  const result = await createDirectReservation(input);
  if (result.ok) {
    revalidateCourtActivity("create");
  }
  return result;
}

export async function cancelAdminReservationAction(id: unknown) {
  const result = await cancelDirectReservationAsAdmin(id);
  if (result.ok) {
    revalidateCourtActivity("cancel");
  }
  return result;
}

export async function cancelAdminCustomerBookingAction(id: unknown) {
  const result = await cancelCustomerBookingAsAdmin(id);
  if (result.ok) {
    revalidateCourtActivity("cancel");
  }
  return result;
}

export async function loadAdminReservationEditDayAction(reservationId: unknown, date: unknown) {
  return getAdminReservationEditDay({ reservationId, date });
}

export async function editAdminReservationAction(input: unknown) {
  const result = await editDirectReservationAsAdmin(input);
  if (result.ok) {
    revalidateCourtActivity("edit");
  }
  return result;
}
