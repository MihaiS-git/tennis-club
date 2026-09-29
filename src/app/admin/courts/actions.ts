"use server";

import { revalidatePath } from "next/cache";
import { saveAdminCourt } from "@/lib/admin/courts";

export async function saveCourtAction(input: unknown) {
  const result = await saveAdminCourt(input);
  if (result.ok) {
    revalidatePath("/admin/courts");
    revalidatePath("/courts");
  }
  return result;
}
