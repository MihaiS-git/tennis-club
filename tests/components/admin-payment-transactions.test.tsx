// @vitest-environment jsdom
import { lastToast } from "../helpers/notifications";
import { installDialogMock } from "../helpers/dialog";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TransactionRow } from "@/app/admin/payments/transaction-row";
import type { AdminPaymentTransaction } from "@/lib/payments/admin";
const { retry, reconcile, refresh, push } = vi.hoisted(() => ({ retry: vi.fn(),reconcile: vi.fn(),refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }) }));
vi.mock("@/app/admin/payments/reconciliation-actions", () => ({ retryPaymentRefundAction: retry,resolvePaymentReconciliationAction: reconcile }));
const transaction: AdminPaymentTransaction = {
  transaction_kind: "refund", transaction_id: "cd000000-0000-4000-8000-000000000003", payment_attempt_id: "cd000000-0000-4000-8000-000000000004",
  adjustment_id: null, operation_label: "Full refund", transaction_status: "pending_retry", refunded_minor: 0,
  booking_id: "cd000000-0000-4000-8000-000000000001", reservation_id: "cd000000-0000-4000-8000-000000000002",
  customer_name: "Ana Pop", customer_email: "snapshot@example.test", amount_minor: 5000, currency: "RON", method: "online", provider: "stripe",
  payment_status: "succeeded", provider_payment_id: "original-payment", created_at: "2026-10-06T10:00:00Z", updated_at: "2026-10-06T11:00:00Z",
  booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660, court_name: "Court 1", location_name: "Club", location_timezone: "UTC",
  refund: { id: "cd000000-0000-4000-8000-000000000003", amount_minor: 5000, currency: "RON", status: "pending_retry", provider_refund_id: null,
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
