"use server";

import { revalidatePath } from "next/cache";
import { acknowledgeOwnFinancialNotice } from "@/lib/notifications/financial-notices";

export async function acknowledgeFinancialNoticeAction(id: unknown) {
  const result = await acknowledgeOwnFinancialNotice(id);
  if (result.ok) revalidatePath("/my-activity", "layout");
  return result;
}
