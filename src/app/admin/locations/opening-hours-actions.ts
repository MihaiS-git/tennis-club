"use server";

import { revalidatePath } from "next/cache";
import { saveAdminOpeningHours, removeAdminOpeningHours } from "@/lib/admin/opening-hours";

export async function saveOpeningHoursAction(input: unknown) {
  const result = await saveAdminOpeningHours(input);
  if (result.ok) revalidatePath("/admin/locations");
  return result;
}

export async function removeOpeningHoursAction(input: unknown) {
  const result = await removeAdminOpeningHours(input);
  if (result.ok) revalidatePath("/admin/locations");
  return result;
}
