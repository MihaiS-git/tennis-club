import "server-only";
import { readFinancialHistory, type FinancialHistoryRow } from "./financial-history";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { attentionRefundStatuses, paymentNeedsAttention, refundUnconfirmed, unconfirmedRefundMinutes } from "./domain";
import { checkOnlinePayment } from "./checkout";
import { parseAdminPaymentQuery, type AdminPaymentQuery } from "./admin-query";

import { refundableLateCapture } from "./providers/stripe/refund-policy";
import { processBookingRefund, RefundInProgressError, RefundProcessingError, type RefundStatus } from "./refunds";
// Admins check unresolved payments/refunds with Stripe; no financial state is
// manually edited and payment recovery never dispatches a capture.
export type AdminPaymentTransaction = Omit<FinancialHistoryRow, "reconciliation" | "booking_status" | "reservation_status"> & {
  reconciliation: (Omit<FinancialHistoryRow["reconciliation"][number], "attempt" | "attempt_id" | "provider_payment_id" | "amount_minor" | "currency"> & { auto_refund: boolean })[];
  needsAttention: boolean; refundUnconfirmed: boolean;
};

// Admin presentation of one projected operation; provider evidence stays server-side.
export function toAdminPaymentTransaction(row: FinancialHistoryRow): AdminPaymentTransaction {
  const { booking_status, reservation_status, reconciliation, ...transaction } = row;
  return { ...transaction, refundUnconfirmed: refundUnconfirmed(row.refund?.status, row.refund?.outstanding_since),
    reconciliation: reconciliation.map((event) => ({ event_id: event.event_id, provider: event.provider,
      outcome: event.outcome, settlement_result: event.settlement_result, received_at: event.received_at,
      resolved_at: event.resolved_at, resolved_by_user_id: event.resolved_by_user_id,
      reconciliation_required: event.reconciliation_required, auto_refund: event.reconciliation_required
        && refundableLateCapture(event, event.attempt, booking_status, reservation_status) })),
    needsAttention: Boolean(row.payment_check_required) || paymentNeedsAttention(row.refund, reconciliation) };
}

export async function listAdminPaymentTransactions(query: AdminPaymentQuery,
  reader?: Awaited<ReturnType<typeof createClient>>, bookingId?: string,
  transaction?: { kind: "payment" | "refund" | "booking"; id: string }) {
  const client = reader ?? await createClient();
  await requireActiveAdmin(client);
  const filters = parseAdminPaymentQuery({ ...query, page: String(query.page) });
  try {
    const page = await readFinancialHistory((await getDataSource()).manager, {
      page: filters.page, status: filters.status, provider: filters.provider, method: filters.method,
      attention: filters.attention === "required", search: filters.q, sort: filters.sort, direction: filters.dir,
      transaction: transaction ? { kind: z.enum(["payment", "refund", "booking"]).parse(transaction.kind), id: z.uuid().parse(transaction.id) } : undefined,
      attentionRefundStatuses, unconfirmedRefundMinutes, bookingId: bookingId ? z.uuid().parse(bookingId) : null,
    });
    return { ...page, rows: page.rows.map(toAdminPaymentTransaction) };
  } catch (error: unknown) {
    logger.error({ event: "payments.admin_read_failed", code: normalizeDatabaseError(error).sqlState }, "Database projection failed");
    throw new Error("Unable to load payment transactions. Try again.");
  }
}

export type AdminRefundCheckResult = { ok: true; status: RefundStatus } | { ok: false; message: string };

// The explicit replacement for background refund polling. It reads Stripe for an
// unconfirmed refund and commits the provider result through the shared refund
// service: a request with unknown outcome is only looked up, or replayed with its
// exact idempotency key inside Stripe's retention window, never re-created. A
// replacement is made only after Stripe affirmatively rejected the refund as
// retryable (for example insufficient balance), so no money moved.
export async function checkAdminRefundWithProvider(input: unknown,
  reader?: Awaited<ReturnType<typeof createClient>>): Promise<AdminRefundCheckResult> {
  const actor = await requireActiveAdmin(reader ?? await createClient());
  const parsed = z.strictObject({ refundId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Choose a valid refund." };
  try {
    const status = await processBookingRefund(parsed.data.refundId,
      { actorId: actor.userId, retryRejected: true, strict: true });
    logger.info({ event: "payments.admin_refund_checked", actorId: actor.userId, refundId: parsed.data.refundId, status },
      "Admin checked refund with provider");
    return { ok: true, status };
  } catch (error: unknown) {
    if (error instanceof RefundInProgressError)
      return { ok: false, message: "This refund is being processed right now. Check again in a few minutes." };
    if (error instanceof RefundProcessingError)
      return { ok: false, message: "Stripe could not confirm this refund right now. Nothing was refunded twice; check again later." };
    logger.error({ event: "payments.admin_refund_check_failed", actorId: actor.userId, refundId: parsed.data.refundId },
      "Admin refund check failed");
    return { ok: false, message: "Unable to check this refund. Try again." };
  }
}

// Checks/cancels only the registered intent; never dispatches a capture. Current
// Admin authorization is required before looking up any payment or contacting Stripe.
export async function checkAdminPaymentWithProvider(input: unknown,
  reader?: Awaited<ReturnType<typeof createClient>>): Promise<{ ok: true; status: Awaited<ReturnType<typeof checkOnlinePayment>> } | { ok: false; message: string }> {
  await requireActiveAdmin(reader ?? await createClient());
  const parsed = z.strictObject({ attemptId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Choose a valid payment." };
  try {
    return { ok: true, status: await checkOnlinePayment(parsed.data.attemptId) };
  } catch {
    logger.error({ event: "payments.admin_payment_check_failed", attemptId: parsed.data.attemptId }, "Payment outcome needs reconciliation");
    return { ok: false, message: "Stripe could not confirm this payment. Financial evidence is preserved and accepted occupancy stays protected. Check again later." };
  }
}
