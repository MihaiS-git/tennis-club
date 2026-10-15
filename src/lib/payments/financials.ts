import "server-only";

import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import { z } from "zod";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import type { PaymentAttemptEntity } from "@/lib/db/entities/payment-attempt.entity";
import type { PaymentCaptureReceiptEntity } from "@/lib/db/entities/payment-capture-receipt.entity";
import type { PaymentRefundEntity } from "@/lib/db/entities/payment-refund.entity";
import type { RefundExecutionEntity } from "@/lib/db/entities/refund-execution.entity";
import { loadBookingFinancialFacts, insertRefundAllocations } from "@/lib/db/repositories/payments.repository";
import { listCaptureReceipts } from "@/lib/db/repositories/payment-capture-receipts.repository";
import { allocateRefund, summarizeBookingFinancials } from "./refund-allocation";
import type { RefundReason } from "./refund-context";

export async function bookingFinancials(manager: EntityManager, bookingId: string, lock = false) {
  const { payments, refunds } = await loadBookingFinancialFacts(manager, bookingId, lock);
  return summarizeBookingFinancials(payments, refunds);
}

type CaptureDiscrepancy = "provider" | "provider_payment_id" | "amount" | "currency";
// Timestamps and reasons are display-only; they never affect totals or verification.
type ReportingPayment = Pick<PaymentAttemptEntity, "id" | "provider" | "providerPaymentId" | "amountMinor" |
  "currency" | "status" | "adjustmentId"> & Partial<Pick<PaymentAttemptEntity, "createdAt">>;
type ReportingCapture = Pick<PaymentCaptureReceiptEntity, "id" | "paymentAttemptId" | "provider" | "providerPaymentId" |
  "providerCaptureId" | "amountMinor" | "currency" | "firstObservedAt">;
type ReportingRefund = Pick<PaymentRefundEntity, "id" | "provider" | "providerPaymentId" | "amountMinor" | "currency" | "status">
  & Partial<Pick<PaymentRefundEntity, "createdAt" | "reason">>;
type ReportingExecution = Pick<RefundExecutionEntity, "refundId" | "provider" | "providerPaymentId" | "providerRefundId" |
  "amountMinor" | "currency" | "status" | "terminalResult"> & Partial<Pick<RefundExecutionEntity, "completedAt">>;

// This is an Admin reporting read model, not the operational balance used to
// allocate refunds. Actual captures come only from provider-unique receipts;
// successful refund obligations count once only when an exact execution has a
// verified successful terminal result.
export function summarizeReportedFinancials(input: {
  payments: readonly ReportingPayment[];
  captures: readonly ReportingCapture[];
  refunds: readonly ReportingRefund[];
  executions: readonly ReportingExecution[];
}) {
  const payments = new Map(input.payments.map(payment => [payment.id, payment]));
  const distinctCaptures = new Map<string, ReportingCapture>();
  for (const capture of input.captures) {
    const identity = `${capture.provider}\u0000${capture.providerCaptureId}`;
    if (!distinctCaptures.has(identity)) distinctCaptures.set(identity, capture);
  }
  const captures = [...distinctCaptures.values()].map(capture => {
    const payment = payments.get(capture.paymentAttemptId);
    const discrepancies: CaptureDiscrepancy[] = [];
    if (!payment || payment.provider !== capture.provider) discrepancies.push("provider");
    if (!payment || payment.providerPaymentId !== capture.providerPaymentId) discrepancies.push("provider_payment_id");
    if (!payment || payment.amountMinor !== capture.amountMinor) discrepancies.push("amount");
    if (!payment || payment.currency !== capture.currency) discrepancies.push("currency");
    return {
      id: capture.id, paymentAttemptId: capture.paymentAttemptId, provider: capture.provider,
      providerPaymentId: capture.providerPaymentId, providerCaptureId: capture.providerCaptureId,
      amount: capture.amountMinor, currency: capture.currency,
      firstObservedAt: capture.firstObservedAt.toISOString(),
      attemptStatus: payment?.status ?? null,
      expectedAmount: payment?.amountMinor ?? null, expectedCurrency: payment?.currency ?? null,
      discrepancies,
    };
  });
  const executions = new Map<string, ReportingExecution[]>();
  for (const execution of input.executions) {
    const rows = executions.get(execution.refundId) ?? [];
    rows.push(execution);
    executions.set(execution.refundId, rows);
  }
  const refunds = input.refunds.map(refund => {
    const verifiedExecution = refund.status === "succeeded"
      ? (executions.get(refund.id) ?? []).find(execution => execution.status === "succeeded"
        && execution.terminalResult === "succeeded" && execution.providerRefundId !== null
        && execution.provider === refund.provider && execution.providerPaymentId === refund.providerPaymentId
        && execution.amountMinor === refund.amountMinor && execution.currency === refund.currency) ?? null
      : null;
    return { id: refund.id, amount: refund.amountMinor, currency: refund.currency, status: refund.status,
      reference: verifiedExecution?.providerRefundId ?? null, verified: verifiedExecution !== null,
      reason: refund.reason ?? null, createdAt: refund.createdAt?.toISOString() ?? null,
      verifiedAt: verifiedExecution?.completedAt?.toISOString() ?? null };
  });
  const currencies = new Set([...captures.map(capture => capture.currency), ...refunds.map(refund => refund.currency)]);
  const totals = [...currencies].sort().map(currency => {
    const captured = captures.filter(capture => capture.currency === currency).reduce((sum, capture) => sum + capture.amount, 0);
    const currencyRefunds = refunds.filter(refund => refund.currency === currency);
    const refunded = currencyRefunds.filter(refund => refund.verified).reduce((sum, refund) => sum + refund.amount, 0);
    // A voided obligation (abandoned change, no money moved) is not owed.
    const refundObligations = currencyRefunds.filter(refund => refund.status !== "voided").reduce((sum, refund) => sum + refund.amount, 0);
    return { currency, captured, refunded, netPaid: captured - refunded, refundObligations,
      uncompletedRefundObligations: refundObligations - refunded };
  });
  return { totals, captures, refunds,
    payments: input.payments.map(payment => ({ id: payment.id, amount: payment.amountMinor, currency: payment.currency,
      status: payment.status, reference: payment.providerPaymentId, adjustmentId: payment.adjustmentId,
      createdAt: payment.createdAt?.toISOString() ?? null })) };
}

// Caller owns the booking lock (and the existing location lock for occupancy
// commands). Never start a second transaction or acquire a parent lock here.
export async function allocateBookingRefund(manager: EntityManager, input: {
  bookingId: string; amount: number; operationKey: string;
  adjustmentId?: string; actorId: string | null; onlyAttemptId?: string;
  reason: RefundReason; contextRevisionId: string;
}) {
  const { payments, refunds } = await loadBookingFinancialFacts(manager, input.bookingId, true, input.onlyAttemptId);
  const captures = await listCaptureReceipts(manager, input.bookingId, input.onlyAttemptId);
  const plan = allocateRefund({ payments, refunds, captures, operationKey: input.operationKey,
    amount: input.amount, onlyAttemptId: input.onlyAttemptId });
  if (plan.kind === "replay") {
    if (refunds.some(refund => plan.refundIds.includes(refund.id)
      && (refund.reason !== input.reason || refund.contextRevisionId !== input.contextRevisionId
        || refund.adjustmentId !== (input.adjustmentId ?? null))))
      throw new Error("Refund operation context changed");
    return plan.refundIds;
  }
  const rows = plan.allocations.map(allocation => ({ ...allocation, id: randomUUID(), bookingId: input.bookingId,
    operationKey: input.operationKey, adjustmentId: input.adjustmentId ?? null,
    reason: input.reason, contextRevisionId: input.contextRevisionId,
    currency: z.enum(locationCurrencies).parse(allocation.currency), status: "pending" as const,
    requestedByUserId: input.actorId }));
  await insertRefundAllocations(manager, rows);
  return rows.map(row => row.id);
}
