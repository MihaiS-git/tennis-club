"use server";

import { getAdminBookingDetails } from "@/lib/bookings/admin-details";
import { revalidatePath } from "next/cache";
import { selectActivePaymentProvider, type PaymentSettingsResult } from "@/lib/payments/settings";
import { checkAdminPaymentWithProvider, checkAdminRefundWithProvider, type AdminRefundCheckResult } from "@/lib/payments/admin";
import { revalidateCourtActivity } from "@/lib/reservations/revalidation";
import { deleteAdminNotifications, retryAdminNotification, type AdminNotificationDeleteResult, type AdminNotificationRetryResult } from "@/lib/notifications/admin-notifications";

export async function loadAdminBookingDetailsAction(id: unknown) {
  return getAdminBookingDetails(id);
}

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

export async function deleteNotificationsAction(input: unknown): Promise<AdminNotificationDeleteResult> {
  const result = await deleteAdminNotifications(input);
  if (result.ok && result.deleted.length) {
    revalidatePath("/admin/payments/notifications");
    // A deleted failed email also leaves the customer's in-app notices.
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
