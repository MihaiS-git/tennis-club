"use server";

import { loadOperationalBookingDay } from "@/lib/bookings/operational-availability";

import { revalidatePath } from "next/cache";
import { operationalChangeInputSchema } from "@/lib/bookings/operational-policy";
import { changeAdminBooking, loadAdminBookingEditor } from "@/lib/bookings/admin-edit";
import { revalidateCourtActivity } from "@/lib/reservations/revalidation";

export async function loadAdminBookingEditorAction(id: unknown) {
  return loadAdminBookingEditor(id);
}
export async function changeAdminBookingAction(input: unknown) {
  const result = await changeAdminBooking(input);
  const parsed = operationalChangeInputSchema.safeParse(input);
  if (result.ok && parsed.success && parsed.data.save) {
    revalidateCourtActivity("edit");
    revalidatePath(`/admin/bookings/${parsed.data.id}`);
  }
  return result;
}

export async function loadAdminBookingDayAction(input: unknown) {
  return loadOperationalBookingDay(input, "admin");
}
