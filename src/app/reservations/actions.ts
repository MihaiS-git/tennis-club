"use server";

import { revalidatePath } from "next/cache";
import { cancelCustomerBookingAsAdmin, cancelDirectReservationAsAdmin, createDirectReservation, editDirectReservationAsAdmin, getAdminReservationEditDay } from "@/lib/reservations/service";

export async function reserveCourtAction(input: unknown) {
  const result = await createDirectReservation(input);
  if (result.ok) {
    revalidatePath("/reservations");
    revalidatePath("/book");
  }
  return result;
}

export async function cancelAdminReservationAction(id: unknown) {
  const result = await cancelDirectReservationAsAdmin(id);
  if (result.ok) {
    revalidatePath("/reservations");
    revalidatePath("/book");
  }
  return result;
}

export async function cancelAdminCustomerBookingAction(id: unknown) {
  const result = await cancelCustomerBookingAsAdmin(id);
  if (result.ok) {
    revalidatePath("/reservations");
    revalidatePath("/book");
    revalidatePath("/my-activity/bookings");
    revalidatePath("/my-activity/bookings/history");
  }
  return result;
}

export async function loadAdminReservationEditDayAction(reservationId: unknown, date: unknown) {
  return getAdminReservationEditDay({ reservationId, date });
}

export async function editAdminReservationAction(input: unknown) {
  const result = await editDirectReservationAsAdmin(input);
  if (result.ok) {
    revalidatePath("/reservations");
    revalidatePath("/book");
  }
  return result;
}
