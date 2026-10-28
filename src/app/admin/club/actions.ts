"use server";
import { revalidatePath } from "next/cache";
import { saveClubContact, saveClubSettings, sendClubTestEmail } from "@/lib/club/settings";

export async function saveClubSettingsAction(input: unknown) {
  const result = await saveClubSettings(input);
  if (result.ok) revalidatePath("/admin/club");
  return result;
}
export async function saveClubContactAction(input: unknown) {
  const result = await saveClubContact(input);
  if (result.ok) revalidatePath("/admin/club");
  return result;
}
export async function sendClubTestEmailAction() {
  return sendClubTestEmail();
}
