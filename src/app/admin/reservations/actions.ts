"use server";

import { z } from "zod";
import { getAdminBookingEditDay, rescheduleCustomerBookingAsAdmin } from "@/lib/bookings/admin-reschedule";
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

export async function loadAdminBookingEditDayAction(id: unknown, date: unknown) {
  return getAdminBookingEditDay(id, date);
}

export async function rescheduleAdminBookingAction(input: unknown) {
  const parsed = z.object({ save: z.literal(true) }).safeParse(input);
  if (!parsed.success) return { ok: false as const, message: "Invalid save request." };
  const result = await rescheduleCustomerBookingAsAdmin(input);
  if (result.ok) revalidateCourtActivity("edit");
  return result;
}

export async function quoteAdminBookingAction(input: unknown) {
  const parsed = z.object({ save: z.literal(false) }).safeParse(input);
  if (!parsed.success) return { ok: false as const, message: "Invalid quote request." };
  return rescheduleCustomerBookingAsAdmin(input);
}
