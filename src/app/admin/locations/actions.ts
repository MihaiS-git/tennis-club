"use server";

import { revalidatePath } from "next/cache";
import { saveAdminLocation, setAdminLocationArchived } from "@/lib/admin/locations";

function revalidateLocations() {
  revalidatePath("/admin/locations");
  revalidatePath("/courts");
}

export async function saveLocationAction(input: unknown) {
  const result = await saveAdminLocation(input);
  if (result.ok) revalidateLocations();
  return result;
}

export async function archiveLocationAction(input: unknown) {
  const result = await setAdminLocationArchived(input);
  if (result.ok) revalidateLocations();
  return result;
}
