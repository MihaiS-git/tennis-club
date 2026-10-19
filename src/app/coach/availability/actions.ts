"use server";

import { revalidatePath } from "next/cache";
import { changeOwnCoachAvailability } from "@/lib/coaching/availability";

export async function changeOwnCoachAvailabilityAction(input: unknown) {
  const result = await changeOwnCoachAvailability(input);
  if (result.ok) {
    revalidatePath("/coach/availability");
    revalidatePath("/admin/coaching/availability");
  }
  return result;
}
