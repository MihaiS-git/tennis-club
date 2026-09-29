"use server";

import { revalidatePath } from "next/cache";
import { saveAdminLocation } from "@/lib/admin/locations";

export async function saveLocationAction(input: unknown) {
  const result = await saveAdminLocation(input);
  if (result.ok) {
    revalidatePath("/admin/locations");
    revalidatePath("/courts");
  }
  return result;
}
