// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TransactionRow } from "@/app/admin/payments/transaction-row";
import type { AdminPaymentTransaction } from "@/lib/payments/admin";
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
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
  refund: { id: "cd000000-0000-4000-8000-000000000003", amount_minor: 5000, currency: "RON", status: "pending_retry", provider_refund_id: null,
    reason: "booking_cancellation", context_revision_id: contract.revisionId, captured_amount_minor: 5000,
    requested_by_user_id: null, requested_by_name: "Administrator", created_at: "2026-10-06T11:00:00Z", updated_at: "2026-10-06T12:00:00Z", recovery_started_at: "2026-10-06T11:00:00Z", last_error: "provider_request_incomplete" },
  reconciliation: [], needsAttention: false, refundStalled: false,
};
afterEach(() => { cleanup(); push.mockReset(); });

const lateEvent: AdminPaymentTransaction["reconciliation"][number] = {
  event_id: "late-capture-event", provider: "stripe", outcome: "succeeded", settlement_result: "expired",
  reconciliation_required: true, auto_refund: true, received_at: "2026-10-06T11:00:00Z", resolved_at: null, resolved_by_user_id: null,
};

test("routine refund uncertainty explains automatic recovery without manual controls", () => {
  render(<TransactionRow detail transaction={transaction} />);
  expect(screen.getByText("The refund is being confirmed with Stripe automatically. No action is needed.")).toBeDefined();
  expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry refund" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Refund captured payment" })).toBeNull();
});

test("late captured payment explains automatic compensation without reclaiming the court", () => {
  render(<TransactionRow detail transaction={{ ...transaction, refund: null, reconciliation: [lateEvent], needsAttention: true }} />);
  const attention = within(screen.getByRole("region", { name: "Needs attention" }));
  expect(attention.getByText(/court was not reclaimed; the payment is being returned automatically/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Refund captured payment" })).toBeNull();
});

test("mismatched captured evidence requires investigation rather than automatic compensation", () => {
  render(<TransactionRow detail transaction={{ ...transaction, refund: null, reconciliation: [{ ...lateEvent,
    settlement_result: "amount_mismatch", auto_refund: false }], needsAttention: true }} />);
  expect(screen.getByText(/amount Stripe received does not match.*Review this payment in Stripe/)).toBeDefined();
});

test("NETOPIA transactions expose no manual Stripe recovery actions", () => {
  render(<TransactionRow detail transaction={{ ...transaction, provider: "netopia" }} />);
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

test.each(["pending", "unsuccessful"] as const)("%s proposal stays separate from the immutable transaction context", status => {
  const proposal: NonNullable<AdminPaymentTransaction["proposal"]> = {
    adjustmentId: "cd000000-0000-4000-8000-000000000008", kind: "reschedule", courtId: contract.courtId,
    date: "2099-10-16", startMinute: 720, endMinute: 810,
    courtName: "Proposed Court", locationName: "Proposed Club", timezone: "Europe/Bucharest",
    totalAmountMinor: 7500, currency: "RON", status, acceptedRevisionId: null,
  };
  render(<TransactionRow detail transaction={{ ...transaction, transaction_kind: "payment", refund: null,
    context: { ...contract, bookingState: "confirmed", source: "adjustment_base", confirmationRevisionId: null }, proposal,
    current_booking: { ...contract, courtName: "Current Court", totalAmountMinor: 10000, status: "confirmed" } }} />);
  const modification = within(screen.getByRole("region", { name: "Modification" }));
  expect(modification.getByText("Requested modification (not applied)")).toBeDefined();
  expect(modification.getByText("Club · Court 1")).toBeDefined();
  expect(modification.getByText("Proposed Club · Proposed Court")).toBeDefined();
  expect(modification.queryByText(/Current Court/)).toBeNull();
  expect(modification.getByText(/50\.00/)).toBeDefined();
  expect(modification.getByText(/75\.00/)).toBeDefined();
});

test("compensation retains immutable context and the provider-confirmed outcome", () => {
  if (!transaction.refund) throw new Error("Missing refund fixture");
  render(<TransactionRow detail transaction={{ ...transaction, operation_label: "Late capture compensation",
    context: { ...contract, bookingState: "pending_payment", source: "refund_context", confirmationRevisionId: null },
    transaction_status: "succeeded", refund: { ...transaction.refund, status: "succeeded", reason: "late_capture_compensation",
      provider_refund_id: "re_confirmed" } }} />);
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Late capture compensation");
  expect(screen.getByText("The refund was confirmed by Stripe.")).toBeDefined();
  expect(screen.getByText("Club · Court 1")).toBeDefined();
  expect(screen.getByText("re_confirmed")).toBeDefined();
  expect(screen.queryByText("Confirmation revision")).toBeNull();
});

test.each([
  ["provider_refund_failed", "Stripe reported that the refund failed."],
  ["provider_request_rejected", "Stripe declined this refund."],
])("definitive %s explains external repayment", (last_error, message) => {
  if (!transaction.refund) throw new Error("Missing refund fixture");
  render(<TransactionRow detail transaction={{ ...transaction, transaction_status: "failed", needsAttention: true,
    refund: { ...transaction.refund, status: "failed", last_error } }} />);
  expect(screen.getByText(new RegExp(message.replaceAll(".", "\\.")))).toBeDefined();
  expect(screen.getByText(/arrange the repayment with the customer directly/)).toBeDefined();
});

test("stalled recovery requests investigation without offering another refund", () => {
  render(<TransactionRow detail transaction={{ ...transaction, needsAttention: true, refundStalled: true }} />);
  expect(screen.getByText(/over a day.*Check it in the Stripe Dashboard/)).toBeDefined();
  expect(screen.getByText(/Do not issue another refund/)).toBeDefined();
  expect(screen.queryByRole("button")).toBeNull();
});

test("Admin detail excludes execution internals and raw provider errors", () => {
  if (!transaction.refund) throw new Error("Missing refund fixture");
  render(<TransactionRow detail transaction={{ ...transaction, refund: { ...transaction.refund, last_error: "raw secret exception" } }} />);
  expect(screen.queryByText(/raw secret/)).toBeNull();
  expect(screen.queryByRole("region", { name: "Refund execution history" })).toBeNull();
  expect(screen.queryByText("Technical details")).toBeNull();
  expect(screen.queryByText("capture-original")).toBeNull();
});
