"use server";

import { revalidatePath } from "next/cache";
import { saveAdminCourt } from "@/lib/admin/courts";
import { saveAdminCourtCoverage, removeAdminCourtCoverage } from "@/lib/admin/court-coverage";

export async function saveCoverageAction(input: unknown) {
  const result = await saveAdminCourtCoverage(input);
  if (result.ok) revalidatePath("/admin/courts");
  return result;
}

export async function removeCoverageAction(input: unknown) {
  const result = await removeAdminCourtCoverage(input);
  if (result.ok) revalidatePath("/admin/courts");
  return result;
}

export async function saveCourtAction(input: unknown) {
  const result = await saveAdminCourt(input);
  if (result.ok) {
    revalidatePath("/admin/courts");
    revalidatePath("/courts");
  }
  return result;
}
