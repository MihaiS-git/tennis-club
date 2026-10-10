"use server";

import { revalidatePath } from "next/cache";
import { checkAdminOpeningHoursRemoval, mutateAdminOpeningHours } from "@/lib/admin/opening-hours";

export async function mutateOpeningHoursAction(input: unknown) {
  const result = await mutateAdminOpeningHours(input);
  if (result.ok) revalidatePath("/admin/locations", "layout");
  return result;
}

export async function checkOpeningHoursRemovalAction(input: unknown) {
  return checkAdminOpeningHoursRemoval(input);
}
