"use server";
import { revalidatePath } from "next/cache";
import { retryAdminPaymentRefund, resolveAdminPaymentReconciliation, type AdminRefundActionResult } from "@/lib/payments/admin-reconciliation";
import { logger } from "@/lib/logger";

async function perform(operation: () => Promise<AdminRefundActionResult>): Promise<AdminRefundActionResult> {
  try {
    const result = await operation();
    revalidatePath("/admin/payments");
    return result;
  } catch {
    logger.error({ event: "payments.admin_reconciliation_action_failed" }, "Admin payment action failed");
    return { ok: false, message: "Unable to complete this payment action. Refresh and try again." };
  }
}
export async function retryPaymentRefundAction(id: unknown) {
  return perform(() => retryAdminPaymentRefund(id));
}
export async function resolvePaymentReconciliationAction(id: unknown) {
  return perform(() => resolveAdminPaymentReconciliation(id));
}
