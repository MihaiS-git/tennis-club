"use server";

import { loadOperationalBookingDay } from "@/lib/bookings/operational-availability";

import { revalidatePath } from "next/cache";
import { changeCoachBooking, loadCoachBookingEditor } from "@/lib/bookings/coach-edit";
import { operationalChangeInputSchema } from "@/lib/bookings/operational-policy";
import { cancelAssignedLessonAsCoach } from "@/lib/bookings/coach-bookings";
import { revalidateCourtActivity } from "@/lib/reservations/revalidation";

export async function cancelCoachLessonAction(input: unknown) {
  const result = await cancelAssignedLessonAsCoach(input);
  if (result.ok) {
    revalidateCourtActivity("cancel");
  }
  return result;
}

export async function loadCoachBookingEditorAction(id: unknown) {
  return loadCoachBookingEditor(id);
}

export async function changeCoachBookingAction(input: unknown) {
  const result = await changeCoachBooking(input);
  const parsed = operationalChangeInputSchema.safeParse(input);
  if (result.ok && parsed.success && parsed.data.save) {
    revalidateCourtActivity("edit");
    revalidatePath(`/coach/bookings/lessons/${parsed.data.id}`);
    revalidatePath(`/admin/bookings/${parsed.data.id}`);
  }
  return result;
}

export async function loadCoachBookingDayAction(input: unknown) {
  return loadOperationalBookingDay(input, "coach");
}
