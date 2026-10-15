import "server-only";
import { readFinancialHistory, type FinancialHistoryRow } from "./financial-history";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { attentionRefundStatuses, paymentNeedsAttention } from "./domain";
import { parseAdminPaymentQuery, type AdminPaymentQuery } from "./admin-query";

import { refundableLateCapture, refundRetryEligible } from "./providers/stripe/refund-policy";
export type AdminPaymentTransaction = Omit<FinancialHistoryRow, "reconciliation" | "booking_status" | "reservation_status"> & {
  reconciliation: (Omit<FinancialHistoryRow["reconciliation"][number], "attempt" | "attempt_id" | "provider_payment_id" | "amount_minor" | "currency"> & { can_refund: boolean })[];
  needsAttention: boolean; canRetryRefund: boolean;
};

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
      attentionRefundStatuses, bookingId: bookingId ? z.uuid().parse(bookingId) : null,
    });
    return { ...page, rows: page.rows.map((row): AdminPaymentTransaction => {
      const { booking_status, reservation_status, reconciliation, ...transaction } = row;
      return { ...transaction, canRetryRefund: refundRetryEligible(row.refund?.status, row.provider),
        reconciliation: reconciliation.map((event) => ({ event_id: event.event_id, provider: event.provider,
          outcome: event.outcome, settlement_result: event.settlement_result, received_at: event.received_at,
          resolved_at: event.resolved_at, resolved_by_user_id: event.resolved_by_user_id,
          reconciliation_required: event.reconciliation_required, can_refund: event.reconciliation_required
            && refundableLateCapture(event, event.attempt, booking_status, reservation_status) })),
        needsAttention: paymentNeedsAttention(row.refund?.status, reconciliation) };
    }) };
  } catch (error: unknown) {
    logger.error({ event: "payments.admin_read_failed", code: normalizeDatabaseError(error).sqlState }, "Database projection failed");
    throw new Error("Unable to load payment transactions. Try again.");
  }
}
