import "server-only";
import { prepareAdminRefund } from "./refund-commands";
import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { processBookingRefund } from "./refunds";
import {
  listAdminPaymentTransactions,
  type AdminPaymentTransaction,
} from "./admin";
import { parseAdminPaymentQuery } from "./admin-query";

export type AdminRefundActionResult =
  | { ok: true; transaction: AdminPaymentTransaction; message: string }
  | { ok: false; message: string };
type Reader = Awaited<ReturnType<typeof createClient>>;

async function execute(
  kind: "retry" | "reconcile",
  id: unknown,
  reader?: Reader,
): Promise<AdminRefundActionResult> {
  const client = reader ?? (await createClient());
  const actor = await requireActiveAdmin(client);
  const parsed = (
    kind === "retry" ? z.uuid() : z.string().trim().min(1).max(255)
  ).safeParse(id);
  if (!parsed.success)
    return { ok: false, message: "Choose a valid payment record." };
  let prepared;
  try {
    prepared = await prepareAdminRefund(kind, parsed.data, actor.userId);
  } catch {
    logger.error(
      { event: "payments.admin_refund_prepare_failed" },
      "Admin refund preparation failed",
    );
    return {
      ok: false,
      message: "Unable to prepare this refund. Refresh and try again.",
    };
  }
  if (prepared.outcome === "unavailable")
    return {
      ok: false,
      message:
        "This payment is not eligible for this action. Refresh its details.",
    };
  if (prepared.outcome === "already_refunded")
    return { ok: false, message: "This refund has already succeeded." };
  if (prepared.outcome === "busy")
    return {
      ok: false,
      message: "Another refund request is in progress. Refresh shortly.",
    };
  if (!("bookingId" in prepared)) throw new Error("Invalid refund preparation");
  const bookingId = prepared.bookingId;
  if (prepared.outcome === "ready")
    await processBookingRefund(prepared.claim.refund.id, prepared.claim);
  // Always re-read authoritative detail data; do not turn an adapter response into UI truth.
  const page = await listAdminPaymentTransactions(
    parseAdminPaymentQuery({}),
    client,
    bookingId,
  );
  const transaction = page.rows.find((row) => row.booking_id === bookingId);
  if (!transaction)
    return {
      ok: false,
      message:
        "The refund request was handled, but its details could not be refreshed. Refresh the page.",
    };
  const status = transaction.refund?.status;
  const unresolved = transaction.reconciliation.some(
    (event) => event.reconciliation_required,
  );
  const resolved =
    transaction.reconciliation.some((event) => event.resolved_at !== null) &&
    !transaction.needsAttention;
  logger.info(
    {
      event: "payments.admin_refund_result",
      actorId: actor.userId,
      bookingId: bookingId,
      status,
      resolved,
    },
    "Admin Stripe refund operation completed",
  );
  return {
    ok: true,
    transaction,
    message:
      status === "succeeded"
        ? resolved
          ? "Full refund succeeded. Reconciliation resolved."
          : "Full refund succeeded."
        : status === "failed"
          ? "The refund failed. Review the refund error before retrying."
          : `The refund is awaiting completion or retry.${unresolved ? " Reconciliation remains unresolved." : ""}`,
  };
}
export async function retryAdminPaymentRefund(id: unknown, reader?: Reader) {
  return execute("retry", id, reader);
}
export async function resolveAdminPaymentReconciliation(
  id: unknown,
  reader?: Reader,
) {
  return execute("reconcile", id, reader);
}
