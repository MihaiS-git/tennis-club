import { expect, test } from "vitest";
import { summarizeReportedFinancials } from "@/lib/payments/financials";

type ReportingInput = Parameters<typeof summarizeReportedFinancials>[0];
type Payment = ReportingInput["payments"][number];
type Capture = ReportingInput["captures"][number];
type Refund = ReportingInput["refunds"][number];
type Execution = ReportingInput["executions"][number];

const payment: Payment = { id: "attempt", provider: "stripe", providerPaymentId: "pi_1",
  amountMinor: 5000, currency: "RON", status: "succeeded", adjustmentId: null };
const capture: Capture = { id: "receipt", paymentAttemptId: payment.id, provider: "stripe",
  providerPaymentId: "pi_1", providerCaptureId: "ch_1", amountMinor: 5000, currency: "RON",
  firstObservedAt: new Date("2026-10-14T10:00:00Z") };
const refund: Refund = { id: "refund", provider: "stripe", providerPaymentId: "pi_1",
  amountMinor: 5000, currency: "RON", status: "succeeded" };
const successfulExecution: Execution = { refundId: refund.id, provider: "stripe", providerPaymentId: "pi_1",
  providerRefundId: "re_1", amountMinor: 5000, currency: "RON", status: "succeeded", terminalResult: "succeeded" };

function report(changes: Partial<ReportingInput> = {}) {
  return summarizeReportedFinancials({ payments: [payment], captures: [capture], refunds: [], executions: [], ...changes });
}

test("normal exact capture reports the distinct verified receipt", () => {
  expect(report()).toMatchObject({
    totals: [{ currency: "RON", captured: 5000, refunded: 0, netPaid: 5000 }],
    captures: [{ providerCaptureId: "ch_1", amount: 5000, currency: "RON", discrepancies: [] }],
  });
});

test("late capture and successful compensation report both actual movements once", () => {
  const result = report({ payments: [{ ...payment, status: "expired" }], refunds: [refund], executions: [successfulExecution] });
  expect(result.totals).toEqual([{ currency: "RON", captured: 5000, refunded: 5000, netPaid: 0,
    refundObligations: 5000, uncompletedRefundObligations: 0 }]);
  expect(result.captures[0]).toMatchObject({ attemptStatus: "expired", discrepancies: [] });
  expect(result.refunds).toEqual([{ id: "refund", amount: 5000, currency: "RON", status: "succeeded",
    reference: "re_1", verified: true }]);
});

test("capture amount mismatch reports actual money and identifies the discrepancy", () => {
  const result = report({ captures: [{ ...capture, amountMinor: 7500 }] });
  expect(result.totals).toMatchObject([{ currency: "RON", captured: 7500, netPaid: 7500 }]);
  expect(result.captures[0]).toMatchObject({ amount: 7500, expectedAmount: 5000, discrepancies: ["amount"] });
});

test("capture currency mismatch remains a separate currency total", () => {
  const result = report({ captures: [{ ...capture, currency: "USD" }] });
  expect(result.totals).toEqual([{ currency: "USD", captured: 5000, refunded: 0, netPaid: 5000,
    refundObligations: 0, uncompletedRefundObligations: 0 }]);
  expect(result.captures[0]).toMatchObject({ currency: "USD", expectedCurrency: "RON", discrepancies: ["currency"] });
});

test("duplicate provider observations never add another capture", () => {
  const result = report({ captures: [capture, { ...capture, id: "duplicate-observation",
    firstObservedAt: new Date("2026-10-14T11:00:00Z") }] });
  expect(result.captures).toHaveLength(1);
  expect(result.totals[0].captured).toBe(5000);
});

test("failed execution followed by successful retry counts one verified refund", () => {
  const failed: Execution = { ...successfulExecution, providerRefundId: "re_failed", status: "failed", terminalResult: "failed" };
  const result = report({ refunds: [refund], executions: [failed, successfulExecution] });
  expect(result.totals[0]).toMatchObject({ refunded: 5000, netPaid: 0 });
  expect(result.refunds[0]).toMatchObject({ verified: true, reference: "re_1" });
});

test("successful-looking obligations without exact verified execution evidence are not reported as refunded", () => {
  const result = report({ refunds: [refund], executions: [{ ...successfulExecution, amountMinor: 4999 }] });
  expect(result.totals[0]).toMatchObject({ refunded: 0, netPaid: 5000, uncompletedRefundObligations: 5000 });
  expect(result.refunds[0]).toMatchObject({ verified: false, reference: null });
});
