"use server";

import { revalidatePath } from "next/cache";
import { acknowledgeOwnFinancialNotice, markOwnNotificationRead, manageOwnNotifications } from "@/lib/notifications/financial-notices";

export async function acknowledgeFinancialNoticeAction(id: unknown) {
  const result = await acknowledgeOwnFinancialNotice(id);
  if (result.ok) revalidatePath("/my-activity", "layout");
  return result;
}

export async function markNotificationReadAction(id: unknown) {
  const result = await markOwnNotificationRead(id);
  if (result.ok) revalidatePath("/my-activity", "layout");
  return result;
}

export async function manageNotificationsAction(input: unknown) {
  const result = await manageOwnNotifications(input);
  if (result.ok) revalidatePath("/my-activity", "layout");
  return result;
}
