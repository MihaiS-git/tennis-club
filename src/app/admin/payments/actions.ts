"use server";

import { revalidatePath } from "next/cache";
import { selectActivePaymentProvider, type PaymentSettingsResult } from "@/lib/payments/settings";
import { checkAdminPaymentWithProvider, checkAdminRefundWithProvider, type AdminRefundCheckResult } from "@/lib/payments/admin";
import { revalidateCourtActivity } from "@/lib/reservations/revalidation";
import { retryAdminNotification, type AdminNotificationRetryResult } from "@/lib/notifications/admin-notifications";

export async function selectPaymentProviderAction(input: unknown): Promise<PaymentSettingsResult> {
  const result = await selectActivePaymentProvider(input);
  if (result.ok) {
    revalidatePath("/admin/payments/transactions");
    revalidatePath("/admin/payments/settings");
    revalidatePath("/book");
  }
  return result;
}

export async function checkRefundWithProviderAction(input: unknown): Promise<AdminRefundCheckResult> {
  const result = await checkAdminRefundWithProvider(input);
  if (result.ok) {
    revalidatePath("/admin/payments/transactions", "layout");
    // A completed refund can finalize a pending cancellation or price reduction.
    revalidateCourtActivity("cancel");
  }
  return result;
}

export async function retryNotificationAction(input: unknown): Promise<AdminNotificationRetryResult> {
  const result = await retryAdminNotification(input);
  if (result.ok) {
    revalidatePath("/admin/payments/notifications");
    revalidatePath("/my-activity", "layout");
  }
  return result;
}

export async function checkPaymentWithProviderAction(input: unknown) {
  const result = await checkAdminPaymentWithProvider(input);
  revalidatePath("/admin/payments/transactions", "layout");
  revalidateCourtActivity("create");
  return result;
}
