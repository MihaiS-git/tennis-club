import "server-only";
import type { EntityManager } from "typeorm";
import { z } from "zod";
import { listAdminTransactionProjection, loadAdminTransactionContext } from "@/lib/db/repositories/payments.repository";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { paymentMethodSchema, paymentProviderSchema } from "./domain";
import { paymentStatusSchema } from "./admin-query";
import { paymentFactSchema, providerEventFactSchema } from "./facts";
import { refundReasons } from "./refund-context";
import { describeFinancialContext, revisionContext } from "./financial-history-context";
import { summarizeReportedFinancials } from "./financials";

const safeRefundErrors = new Set(["provider_request_incomplete", "provider_refund_failed", "provider_request_rejected",
  "uncertain", "lookup_failed", "not_found", "evidence_mismatch"]);
const safeRefundError = (value: string | null) => value === null ? null
  : safeRefundErrors.has(value) ? value : "processing_error";

const timestamp = z.iso.datetime({ offset: true });
const refundSchema = z.object({ id: z.uuid(), amount_minor: z.number().int().positive(), currency: z.enum(locationCurrencies),
  reason: z.enum(refundReasons), context_revision_id: z.uuid(),
  status: z.enum(["pending", "pending_retry", "succeeded", "failed"]), provider_refund_id: z.string().nullable(),
  captured_amount_minor: z.number().int().positive(),
  requested_by_user_id: z.uuid().nullable(), requested_by_name: z.string().nullable(),
  created_at: timestamp, updated_at: timestamp, last_error: z.string().nullable() });
const transactionSchema = z.object({
  transaction_kind: z.enum(["payment", "refund", "booking"]), transaction_id: z.uuid(),
  payment_attempt_id: z.uuid().nullable(), adjustment_id: z.uuid().nullable(),
  context_revision_id: z.uuid(), current_revision_id: z.uuid(), base_revision_id: z.uuid().nullable(),
  applied_revision_id: z.uuid().nullable(), confirmation_revision_id: z.uuid().nullable(),
  adjustment_status: z.enum(["pending", "applied", "cancelled", "expired", "unsuccessful"]).nullable(),
  transaction_status: z.enum(["pending", "pending_retry", "succeeded", "failed", "cancelled", "expired", "due"]).nullable(),
  refunded_minor: z.number().int().nonnegative(), booking_id: z.uuid(), reservation_id: z.uuid(),
  amount_minor: z.number().int().positive(), currency: z.enum(locationCurrencies), method: paymentMethodSchema.nullable(),
  provider: paymentProviderSchema.nullable(), payment_status: paymentStatusSchema.nullable(), provider_payment_id: z.string().nullable(),
  created_at: timestamp, updated_at: timestamp, refund: refundSchema.nullable(),
  booking_status: z.string(), reservation_status: z.string(),
  reconciliation: z.array(providerEventFactSchema.extend({ provider: paymentProviderSchema, attempt: paymentFactSchema, received_at: timestamp })),
});

// One read path serves both paginated lists and exact operation details.
export async function readFinancialHistory(manager: EntityManager, query: Parameters<typeof listAdminTransactionProjection>[1]) {
  const page = z.object({ rows: z.array(transactionSchema), page: z.number().int().positive(),
    total: z.number().int().nonnegative(), totalPages: z.number().int().positive() })
    .parse(await listAdminTransactionProjection(manager, query));
  const bookingIds = [...new Set(page.rows.map(row => row.booking_id))];
  const revisionIds = [...new Set(page.rows.flatMap(row => [row.context_revision_id, row.current_revision_id,
    row.base_revision_id, row.confirmation_revision_id]).filter((id): id is string => id !== null))];
  const adjustmentIds = [...new Set(page.rows.map(row => row.adjustment_id).filter((id): id is string => id !== null))];
  const facts = await loadAdminTransactionContext(manager, { bookingIds, revisionIds, adjustmentIds });
  const executionHistory = new Map<string, typeof facts.executions>();
  for (const execution of facts.executions) {
    const history = executionHistory.get(execution.refundId) ?? [];
    history.push(execution);
    executionHistory.set(execution.refundId, history);
  }
  const revisions = new Map(facts.revisions.map(revision => [revision.id, revision]));
  const adjustments = new Map(facts.adjustments.map(adjustment => [adjustment.id, adjustment]));
  const financials = new Map(bookingIds.map(id => [id, summarizeReportedFinancials({
    payments: facts.payments.filter(payment => payment.bookingId === id),
    captures: facts.captures.filter(capture => paymentsForBooking(facts.payments, id).has(capture.paymentAttemptId)),
    refunds: facts.refunds.filter(refund => refund.bookingId === id),
    executions: facts.executions.filter(execution => facts.refunds.some(refund => refund.bookingId === id && refund.id === execution.refundId)),
  })]));
  const revisionFor = (id: string, bookingId: string) => {
    const revision = revisions.get(id);
    if (!revision || revision.bookingId !== bookingId) throw new Error("Missing or cross-booking financial context");
    return revision;
  };
  return { ...page, rows: page.rows.map(row => {
    const { context_revision_id, current_revision_id, base_revision_id, applied_revision_id,
      confirmation_revision_id, adjustment_status, ...operation } = row;
    const revision = revisionFor(context_revision_id, row.booking_id);
    const current = revisionFor(current_revision_id, row.booking_id);
    const base = base_revision_id ? revisionFor(base_revision_id, row.booking_id) : null;
    const adjustment = row.adjustment_id ? adjustments.get(row.adjustment_id) : null;
    if (row.adjustment_id && (!adjustment || adjustment.bookingId !== row.booking_id))
      throw new Error("Missing or cross-booking adjustment context");
    const financial = financials.get(row.booking_id);
    if (!financial) throw new Error("Missing booking financial facts");
    return { ...operation,
      refund: row.refund ? { ...row.refund, last_error: safeRefundError(row.refund.last_error),
        executions: (executionHistory.get(row.refund.id) ?? []).map(execution => ({
          id: execution.id, executionNumber: execution.executionNumber, provider: execution.provider,
          providerPaymentId: execution.providerPaymentId, amountMinor: execution.amountMinor, currency: execution.currency,
          createdAt: execution.createdAt.toISOString(), dispatchInitiatedAt: execution.dispatchInitiatedAt?.toISOString() ?? null,
          providerRefundId: execution.providerRefundId, firstUncertainAt: execution.firstUncertainAt?.toISOString() ?? null,
          terminalResult: execution.terminalResult, completedAt: execution.completedAt?.toISOString() ?? null,
          status: execution.status, lastCheckedAt: execution.lastCheckedAt?.toISOString() ?? null,
          lastError: safeRefundError(execution.lastError),
          unresolved: ["ready", "pending", "uncertain"].includes(execution.status),
        })) } : null,
      ...describeFinancialContext({ kind: row.transaction_kind, revision, base,
        adjustment: adjustment ? { ...adjustment, currency: z.enum(locationCurrencies).parse(adjustment.currency) } : null,
        adjustmentStatus: adjustment_status, appliedRevisionId: applied_revision_id,
        confirmationRevisionId: confirmation_revision_id, reason: row.refund?.reason ?? null,
        amount: row.amount_minor, capturedAmount: row.refund?.captured_amount_minor ?? null }),
      current_booking: { ...revisionContext(current), status: row.booking_status },
      financials: { ...financial, outstanding: ["confirmed", "pending_payment"].includes(row.booking_status)
        ? Math.max(0, current.totalAmountMinor
          - (financial.totals.find(total => total.currency === current.currency)?.netPaid ?? 0)) : 0 },
    };
  }) };
}

function paymentsForBooking(payments: Awaited<ReturnType<typeof loadAdminTransactionContext>>["payments"], bookingId: string) {
  return new Set(payments.filter(payment => payment.bookingId === bookingId).map(payment => payment.id));
}
export type FinancialHistoryRow = Awaited<ReturnType<typeof readFinancialHistory>>["rows"][number];
