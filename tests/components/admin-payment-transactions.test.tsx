// @vitest-environment jsdom
import { lastToast } from "../helpers/notifications";
import { installDialogMock } from "../helpers/dialog";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TransactionRow } from "@/app/admin/payments/transaction-row";
import type { AdminPaymentTransaction } from "@/lib/payments/admin";
const { retry, reconcile, refresh, push } = vi.hoisted(() => ({ retry: vi.fn(),reconcile: vi.fn(),refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }) }));
vi.mock("@/app/admin/payments/reconciliation-actions", () => ({ retryPaymentRefundAction: retry,resolvePaymentReconciliationAction: reconcile }));
const contract = {
  revisionId: "cd000000-0000-4000-8000-000000000005", bookingState: "cancelled" as const,
  courtId: "cd000000-0000-4000-8000-000000000006", locationId: "cd000000-0000-4000-8000-000000000007",
  courtName: "Court 1", locationName: "Club", timezone: "UTC", bookingDate: "2099-10-15", startMinute: 600, endMinute: 660,
  customerName: "Ana Pop", customerEmail: "snapshot@example.test", customerPhone: "123", totalAmountMinor: 5000,
  currency: "RON" as const, paymentMethod: "online" as const,
};
const transaction: AdminPaymentTransaction = {
  context: { ...contract, source: "refund_context", confirmationRevisionId: null },
  previous_context: null, proposal: null, current_booking: { ...contract, status: "cancelled" },
  financials: { outstanding: 0,
    totals: [{ currency: "RON", captured: 5000, refunded: 0, netPaid: 5000,
      refundObligations: 5000, uncompletedRefundObligations: 5000 }],
    captures: [{ id: "capture-receipt", paymentAttemptId: "cd000000-0000-4000-8000-000000000004",
      provider: "stripe", providerPaymentId: "original-payment", providerCaptureId: "capture-original",
      amount: 5000, currency: "RON", firstObservedAt: "2026-10-06T10:00:00.000Z", attemptStatus: "succeeded",
      expectedAmount: 5000, expectedCurrency: "RON", discrepancies: [] }],
    payments: [], refunds: [] },
  customer_phone: "123", booking_total_minor: 5000,
  transaction_kind: "refund", transaction_id: "cd000000-0000-4000-8000-000000000003", payment_attempt_id: "cd000000-0000-4000-8000-000000000004",
  adjustment_id: null, operation_label: "Full refund", transaction_status: "pending_retry", refunded_minor: 0,
  booking_id: "cd000000-0000-4000-8000-000000000001", reservation_id: "cd000000-0000-4000-8000-000000000002",
  customer_name: "Ana Pop", customer_email: "snapshot@example.test", amount_minor: 5000, currency: "RON", method: "online", provider: "stripe",
  payment_status: "succeeded", provider_payment_id: "original-payment", created_at: "2026-10-06T10:00:00Z", updated_at: "2026-10-06T11:00:00Z",
  booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660, court_name: "Court 1", location_name: "Club", location_timezone: "UTC",
  refund: { executions: [], id: "cd000000-0000-4000-8000-000000000003", amount_minor: 5000, currency: "RON", status: "pending_retry", provider_refund_id: null,
    reason: "booking_cancellation", context_revision_id: contract.revisionId, captured_amount_minor: 5000,
    requested_by_user_id: null, requested_by_name: "Administrator", created_at: "2026-10-06T11:00:00Z", updated_at: "2026-10-06T12:00:00Z", last_error: "provider_request_incomplete" },
  reconciliation: [], needsAttention: true, canRetryRefund: true,
};
installDialogMock();
afterEach(() => { cleanup();retry.mockReset();reconcile.mockReset();refresh.mockReset(); });

const lateEvent: AdminPaymentTransaction["reconciliation"][number] = {
  event_id: "late-capture-event",provider: "stripe",outcome: "succeeded",settlement_result: "expired",
  reconciliation_required: true,can_refund: true,received_at: "2026-10-06T11:00:00Z",resolved_at: null,resolved_by_user_id: null,
};
test("retry submits only the refund ID, disables repeated clicks, refreshes and displays success", async () => {
  if (!transaction.refund) throw new Error("Missing fixture refund");
  const updated = { ...transaction,needsAttention: false,canRetryRefund: false,refund: { ...transaction.refund,status: "succeeded" as const } };
  retry.mockResolvedValue({ ok: true,transaction: updated,message: "Full refund succeeded." });
  render(<TransactionRow detail transaction={transaction} />);
  const button = screen.getByRole("button", { name: "Retry refund" });
  fireEvent.click(button);fireEvent.click(button);
  expect(button.hasAttribute("disabled")).toBe(true);
  await waitFor(() => expect(lastToast("success")).toBe("Full refund succeeded."));
  expect(retry).toHaveBeenCalledExactlyOnceWith(transaction.refund.id);expect(refresh).toHaveBeenCalledOnce();
  expect(screen.queryByText("Needs attention")).toBeNull();expect(screen.queryByRole("button", { name: "Retry refund" })).toBeNull();
});
test("reconciliation submits only event ID and toasts errors without losing detail", async () => {
  reconcile.mockResolvedValue({ ok: false,message: "Another refund request is in progress. Refresh shortly." });
  render(<TransactionRow detail transaction={{ ...transaction,refund: null,reconciliation: [lateEvent] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Refund captured payment" }));
  await waitFor(() => expect(lastToast()).toContain("in progress"));
  expect(reconcile).toHaveBeenCalledExactlyOnceWith(lateEvent.event_id);expect(screen.getByRole("region", { name: "Transaction details" })).toBeDefined();
});

test("NETOPIA transactions and events expose no Stripe recovery actions", () => {
  render(<TransactionRow detail transaction={{ ...transaction,provider: "netopia",canRetryRefund: false,reconciliation: [{ ...lateEvent,provider: "netopia",can_refund: false }] }} />);
  expect(screen.queryByRole("button", { name: "Retry refund" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Refund captured payment" })).toBeNull();
});

test("rows navigate to the actual operation and retain list filters", () => {
  render(<table><tbody><TransactionRow transaction={transaction} listHref="/admin/payments/transactions?q=Ana&page=2" /></tbody></table>);
  const href = `/admin/payments/transactions/refund/${transaction.transaction_id}?q=Ana&page=2`;
  expect(screen.getByRole("link", { name: "Full refund" }).getAttribute("href")).toBe(href);
  fireEvent.keyDown(screen.getByRole("row", { name: /Full refund/ }), { key: "Enter" });
  expect(push).toHaveBeenCalledWith(href);
});

test("a partial refund leaves its original payment partially refunded", () => {
  render(<table><tbody><TransactionRow transaction={{ ...transaction, transaction_kind: "payment", transaction_status: "succeeded", refunded_minor: 2500,
    operation_label: "Original payment", refund: null }} /></tbody></table>);
  expect(screen.getByText("Paid · Partially refunded")).toBeDefined();
  expect(screen.queryByText("Paid · Fully refunded")).toBeNull();
});

test.each(["success", "error"])("financial details ignore late %s responses after disposal", async outcome => {
  let finish!: (value: unknown) => void;
  retry.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<TransactionRow detail transaction={transaction} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry refund" }));
  expect(screen.getByRole("status").textContent).toBe("Processing financial operation…");
  view.unmount();
  await act(async () => finish(outcome === "success" ? { ok: true, transaction, message: "Finished" } : { ok: false, message: "Failed" }));
  expect(refresh).not.toHaveBeenCalled();
});

test.each(["pending", "unsuccessful"] as const)("%s proposal is separate from the accepted transaction context", status => {
  const proposal = { adjustmentId: "cd000000-0000-4000-8000-000000000008", courtId: contract.courtId,
    date: "2099-10-16", startMinute: 720, endMinute: 810, expectedUpdatedAt: transaction.updated_at,
    courtName: "Proposed Court", locationName: "Proposed Club", timezone: "Europe/Bucharest",
    totalAmountMinor: 7500, currency: "RON" as const, status, acceptedRevisionId: null };
  render(<TransactionRow detail transaction={{ ...transaction, transaction_kind: "payment", operation_label: "Additional adjustment payment",
    refund: null, context: { ...contract, bookingState: "confirmed", source: "adjustment_base", confirmationRevisionId: null }, proposal,
    current_booking: { ...contract, courtName: "Current Court", totalAmountMinor: 10000, status: "confirmed" } }} />);
  expect(screen.getByText(status === "pending" ? "Proposed — Pending" : "Proposed — Not applied (unsuccessful)")).toBeDefined();
  expect(screen.getByText("Proposed Court")).toBeDefined();
  expect(screen.getByText("Transaction context")).toBeDefined();
  expect(screen.getByText("Current booking summary")).toBeDefined();
  expect(screen.getByText(/Booking total:.*100\.00/)).toBeDefined();
  expect(screen.getByText("Contract total").nextElementSibling?.textContent).toMatch(/50\.00/);
});

test("compensation shows its immutable reason and never claims booking confirmation", () => {
  if (!transaction.refund) throw new Error("Missing refund fixture");
  render(<TransactionRow detail transaction={{ ...transaction, operation_label: "Late capture compensation",
    context: { ...contract, bookingState: "pending_payment", source: "refund_context", confirmationRevisionId: null },
    refund: { ...transaction.refund, reason: "late_capture_compensation" } }} />);
  expect(screen.getAllByText("Late capture compensation")).toHaveLength(2);
  expect(screen.getByText("Original pending checkout request")).toBeDefined();
  expect(screen.getByText("Current booking status: Cancelled")).toBeDefined();
  expect(screen.queryByText("Accepted booking")).toBeNull();
  expect(screen.queryByText("Confirmation revision")).toBeNull();
});


test.each([
  ["provider_request_rejected", "The provider definitively rejected this refund request."],
  ["uncertain", "The refund request may have been accepted. Its outcome is not yet confirmed."],
  ["lookup_failed", "The provider refund could not be checked. Its outcome remains unconfirmed."],
  ["not_found", "The previous refund request could not be recovered. Its outcome remains uncertain."],
  ["evidence_mismatch", "The provider response did not match the stored refund request. Review is required."],
])("execution recovery error %s retains safe Admin detail", (last_error, message) => {
  if (!transaction.refund) throw new Error("Missing refund fixture");
  render(<TransactionRow detail transaction={{ ...transaction, refund: { ...transaction.refund, last_error } }} />);
  expect(screen.getByText(message)).toBeDefined();
});


test.each([
  ["succeeded"], ["failed", "succeeded"], ["rejected", "succeeded"], ["uncertain"], ["pending"], ["ready"],
] as const)("execution history displays %j without changing obligation or context", (...statuses) => {
  if (!transaction.refund) throw new Error("Missing refund fixture");
  const executions: NonNullable<AdminPaymentTransaction["refund"]>["executions"] = statuses.map((status, index) => {
    const terminalResult = status === "succeeded" || status === "failed" || status === "rejected" ? status : null;
    return { id: `execution-${index + 1}`, executionNumber: index + 1, provider: "stripe", providerPaymentId: "original-payment",
      amountMinor: 5000, currency: "RON", createdAt: "2026-10-06T10:00:00Z",
      dispatchInitiatedAt: status === "ready" ? null : "2026-10-06T10:01:00Z",
      providerRefundId: status === "rejected" || status === "uncertain" || status === "ready" ? null : `re_historical_${index + 1}`,
      firstUncertainAt: status === "uncertain" ? "2026-10-06T10:02:00Z" : null,
      terminalResult, completedAt: terminalResult ? "2026-10-06T10:03:00Z" : null,
      status, lastCheckedAt: status === "ready" ? null : "2026-10-06T10:04:00Z",
      lastError: index === 0 ? "raw secret exception" : null, unresolved: terminalResult === null };
  });
  render(<TransactionRow detail transaction={{ ...transaction, refund: { ...transaction.refund, last_error: null, executions } }} />);
  const history = screen.getByText("Refund execution history").closest("section");
  if (!history) throw new Error("Missing history section");
  const view = within(history);
  expect(view.getAllByRole("heading", { level: 3 }).slice(1).map(heading => heading.textContent))
    .toEqual(statuses.map((_, index) => `Execution ${index + 1}`));
  for (const execution of executions) {
    const block = view.getByText(`Execution ${execution.executionNumber}`).parentElement;
    if (!block) throw new Error("Missing execution block");
    const fields = within(block);
    expect(fields.getByText(execution.id)).toBeDefined();
    expect(fields.getByText("Requested amount").nextElementSibling?.textContent).toMatch(/50\.00/);
    expect(fields.getByText("Unresolved").nextElementSibling?.textContent).toBe(execution.unresolved ? "Yes" : "No");
    if (execution.providerRefundId) expect(fields.getByText(execution.providerRefundId)).toBeDefined();
    expect(fields.getByText("Verified completion").nextElementSibling?.textContent)
      .toBe(execution.completedAt ? "6 Oct 2026, 10:03 UTC" : "—");
    if (!execution.terminalResult) expect(fields.getByText("No confirmed outcome")).toBeDefined();
  }
  expect(view.queryByText(/raw secret/)).toBeNull();
  expect(view.getByText("A refund processing error was recorded.")).toBeDefined();
  expect(screen.getByText("Reason").nextElementSibling?.textContent).toBe("Booking cancellation");
  expect(screen.getByText("Contract total").nextElementSibling?.textContent).toMatch(/50\.00/);
});

test("an obligation without an execution shows an explicit empty history", () => {
  render(<TransactionRow detail transaction={transaction} />);
  expect(screen.getByText("No executions recorded.")).toBeDefined();
});

test("financial details separate currencies and identify mismatched captures", () => {
  const mismatch: AdminPaymentTransaction["financials"]["captures"][number] = {
    ...transaction.financials.captures[0], id: "capture-mismatch", providerCaptureId: "capture-usd",
    amount: 7500, currency: "USD", discrepancies: ["amount", "currency"],
  };
  render(<TransactionRow detail transaction={{ ...transaction, financials: { ...transaction.financials,
    totals: [
      { currency: "RON", captured: 5000, refunded: 5000, netPaid: 0, refundObligations: 5000, uncompletedRefundObligations: 0 },
      { currency: "USD", captured: 7500, refunded: 0, netPaid: 7500, refundObligations: 0, uncompletedRefundObligations: 0 },
    ], captures: [...transaction.financials.captures, mismatch] } }} />);
  expect(screen.getByText(/RON: Captured.*50\.00.*Refunded.*50\.00.*Net.*0\.00/)).toBeDefined();
  expect(screen.getByText(/USD: Captured.*75\.00.*Refunded.*0\.00.*Net.*75\.00/)).toBeDefined();
  expect(screen.getByText((_, element) => element?.tagName === "P"
    && element.textContent?.includes("Capture capture-usd:") === true).textContent).toMatch(/75\.00/);
  expect(screen.getByText((_, element) => element?.tagName === "P"
    && element.textContent?.includes("Discrepancy: amount, currency") === true).textContent).toMatch(/Requested.*50\.00/);
});
