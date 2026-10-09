"use server";

import { revalidatePath } from "next/cache";
import { saveAdminLocation, setAdminLocationArchived, setAdminLocationPublication } from "@/lib/admin/locations";

function revalidateLocations() {
  revalidatePath("/admin/locations", "layout");
  revalidatePath("/courts");
  revalidatePath("/book");
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

export async function setLocationPublicationAction(input: unknown) {
  const result = await setAdminLocationPublication(input);
  if (result.ok) revalidateLocations();
  return result;
}
