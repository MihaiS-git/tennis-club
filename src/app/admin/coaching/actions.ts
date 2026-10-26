"use server";

import { revalidatePath } from "next/cache";
import {
  deleteCoachingProgram, deleteCoachProfile, saveClubCoachingPrices, saveCoachingProgram, saveCoachProfile,
  setCoachingProgramStatus, setCoachVisibility,
} from "@/lib/coaching/admin";
import { changeCoachAvailability } from "@/lib/coaching/availability";
import type { CoachingMutationResult } from "@/lib/coaching/validation";

function revalidated(result: CoachingMutationResult) {
  if (result.ok) {
    revalidatePath("/admin/coaching", "layout");
    revalidatePath("/coaching", "layout");
    revalidatePath("/book");
  }
  return result;
}

export async function saveCoachingProgramAction(input: unknown) {
  return revalidated(await saveCoachingProgram(input));
}

export async function setCoachingProgramStatusAction(input: unknown) {
  return revalidated(await setCoachingProgramStatus(input));
}

export async function saveCoachProfileAction(input: unknown) {
  return revalidated(await saveCoachProfile(input));
}

export async function setCoachVisibilityAction(input: unknown) {
  return revalidated(await setCoachVisibility(input));
}

export async function saveClubCoachingPricesAction(input: unknown) {
  return revalidated(await saveClubCoachingPrices(input));
}

// Availability is not public, so the public Coaching page is not revalidated.
export async function changeCoachAvailabilityAction(coachUserId: string, change: unknown) {
  const result = await changeCoachAvailability({ coach_user_id: coachUserId, change });
  if (result.ok) {
    revalidatePath("/admin/coaching/availability");
    revalidatePath("/coach/availability");
  }
  return result;
}

export async function deleteCoachingProgramAction(input: unknown) {
  return revalidated(await deleteCoachingProgram(input));
}

export async function deleteCoachProfileAction(input: unknown) {
  return revalidated(await deleteCoachProfile(input));
}
