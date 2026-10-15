import "server-only";
import { readFinancialHistory, type FinancialHistoryRow } from "./financial-history";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { attentionRefundStatuses, paymentNeedsAttention, refundRecoveryStalled, stalledRefundHours } from "./domain";
import { parseAdminPaymentQuery, type AdminPaymentQuery } from "./admin-query";

import { refundableLateCapture } from "./providers/stripe/refund-policy";
// Read-only: automatic recovery owns every financial transition. Admins see
// outcomes and genuine exceptions, never controls over the state machine.
export type AdminPaymentTransaction = Omit<FinancialHistoryRow, "reconciliation" | "booking_status" | "reservation_status"> & {
  reconciliation: (Omit<FinancialHistoryRow["reconciliation"][number], "attempt" | "attempt_id" | "provider_payment_id" | "amount_minor" | "currency"> & { auto_refund: boolean })[];
  needsAttention: boolean; refundStalled: boolean;
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
      attentionRefundStatuses, stalledRefundHours, bookingId: bookingId ? z.uuid().parse(bookingId) : null,
    });
    return { ...page, rows: page.rows.map((row): AdminPaymentTransaction => {
      const { booking_status, reservation_status, reconciliation, ...transaction } = row;
      return { ...transaction, refundStalled: refundRecoveryStalled(row.refund?.status, row.refund?.recovery_started_at),
        reconciliation: reconciliation.map((event) => ({ event_id: event.event_id, provider: event.provider,
          outcome: event.outcome, settlement_result: event.settlement_result, received_at: event.received_at,
          resolved_at: event.resolved_at, resolved_by_user_id: event.resolved_by_user_id,
          reconciliation_required: event.reconciliation_required, auto_refund: event.reconciliation_required
            && refundableLateCapture(event, event.attempt, booking_status, reservation_status) })),
        needsAttention: paymentNeedsAttention(row.refund, reconciliation) };
    }) };
  } catch (error: unknown) {
    logger.error({ event: "payments.admin_read_failed", code: normalizeDatabaseError(error).sqlState }, "Database projection failed");
    throw new Error("Unable to load payment transactions. Try again.");
  }
}
