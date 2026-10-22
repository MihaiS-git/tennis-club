"use server";

import { revalidatePath } from "next/cache";
import { removeOwnCoachingPrice, saveOwnCoachingPrice } from "@/lib/coaching/coach-pricing";
import type { CoachingMutationResult } from "@/lib/coaching/validation";

// The coach is the session's account; the services reject any input naming a coach.
function revalidated(result: CoachingMutationResult) {
  if (result.ok) {
    revalidatePath("/coach/pricing");
    revalidatePath("/admin/coaching", "layout");
    revalidatePath("/coaching", "layout");
    revalidatePath("/book");
  }
  return result;
}

export async function saveOwnCoachingPriceAction(input: unknown) {
  return revalidated(await saveOwnCoachingPrice(input));
}

export async function removeOwnCoachingPriceAction(input: unknown) {
  return revalidated(await removeOwnCoachingPrice(input));
}
