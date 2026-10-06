// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { TransactionRow } from "@/app/admin/payments/transaction-row";
import type { AdminPaymentTransaction } from "@/lib/payments/admin";
const { retry, reconcile, refresh } = vi.hoisted(() => ({ retry: vi.fn(),reconcile: vi.fn(),refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/admin/payments/reconciliation-actions", () => ({ retryPaymentRefundAction: retry,resolvePaymentReconciliationAction: reconcile }));
const transaction: AdminPaymentTransaction = {
  booking_id: "cd000000-0000-4000-8000-000000000001", reservation_id: "cd000000-0000-4000-8000-000000000002",
  customer_name: "Ana Pop", customer_email: "snapshot@example.test", amount_minor: 5000, currency: "RON", method: "online", provider: "stripe",
  payment_status: "succeeded", provider_payment_id: "original-payment", created_at: "2026-10-06T10:00:00Z", updated_at: "2026-10-06T11:00:00Z",
  booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660, court_name: "Court 1", location_name: "Club", location_timezone: "UTC",
  refund: { id: "cd000000-0000-4000-8000-000000000003", amount_minor: 5000, currency: "RON", status: "pending_retry", provider_refund_id: null,
    requested_by_user_id: null, requested_by_name: "Administrator", created_at: "2026-10-06T11:00:00Z", updated_at: "2026-10-06T12:00:00Z", last_error: "provider_request_incomplete" },
  reconciliation: [], needsAttention: true, canRetryRefund: true,
};
afterEach(() => { cleanup();retry.mockReset();reconcile.mockReset();refresh.mockReset(); });
test("clicking a transaction opens a focused payment/booking/refund/attention dialog", () => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
  render(<table><tbody><TransactionRow transaction={transaction} /></tbody></table>);
  const row = screen.getByRole("row", { name: /Payment details for Ana Pop/ });
  expect(screen.getByText("Needs attention")).toBeDefined();
  fireEvent.click(row);
  const dialog = screen.getByRole("dialog", { name: "Payment details" });
  for (const value of ["Payment", "Booking", "Refund", "Reconciliation", "original-payment", transaction.booking_id,
    "snapshot@example.test", "Administrator", "Pending retry"]) expect(within(dialog).getAllByText(value).length).toBeGreaterThan(0);
  expect(within(dialog).queryByRole("textbox")).toBeNull(); expect(within(dialog).queryByRole("combobox")).toBeNull();
  expect(within(dialog).getAllByRole("button").map(button => button.textContent || button.getAttribute("aria-label"))).toEqual(["Close dialog", "Retry refund", "Close"]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(row);
  fireEvent.keyDown(row, { key: "Enter" }); expect(screen.getByRole("dialog")).toBeDefined();
});
test("ordinary paid rows show no refund or reconciliation section", () => {
  render(<table><tbody><TransactionRow transaction={{ ...transaction, refund: null, needsAttention: false }} /></tbody></table>);
  fireEvent.click(screen.getByRole("row", { name: /Payment details/ }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).queryByRole("heading", { name: "Refund" })).toBeNull();
  expect(within(dialog).queryByRole("heading", { name: "Reconciliation" })).toBeNull();
  expect(screen.queryByText("Needs attention")).toBeNull();
});

test("persisted refund errors are translated without exposing raw stack details", () => {
  if (!transaction.refund) throw new Error("Missing fixture refund");
  render(<table><tbody><TransactionRow transaction={{ ...transaction, refund: { ...transaction.refund, last_error: "private stack or provider response" } }} /></tbody></table>);
  fireEvent.click(screen.getByRole("row", { name: /Payment details/ }));
  expect(screen.getByText("A refund processing error was recorded.")).toBeDefined();
  expect(screen.queryByText("private stack or provider response")).toBeNull();
});

const lateEvent: AdminPaymentTransaction["reconciliation"][number] = {
  event_id: "late-capture-event",provider: "stripe",outcome: "succeeded",settlement_result: "expired",
  reconciliation_required: true,can_refund: true,received_at: "2026-10-06T11:00:00Z",resolved_at: null,resolved_by_user_id: null,
};
test.each([true, false])("renders server-decided retry capability: %s", (canRetryRefund) => {
  render(<table><tbody><TransactionRow transaction={{ ...transaction, canRetryRefund }} /></tbody></table>);
  fireEvent.click(screen.getByRole("row", { name: /Payment details/ }));
  expect(Boolean(screen.queryByRole("button", { name: "Retry refund" }))).toBe(canRetryRefund);
});
test("retry submits only the refund ID, disables repeated clicks, refreshes and displays success", async () => {
  if (!transaction.refund) throw new Error("Missing fixture refund");
  const updated = { ...transaction,needsAttention: false,canRetryRefund: false,refund: { ...transaction.refund,status: "succeeded" as const } };
  retry.mockResolvedValue({ ok: true,transaction: updated,message: "Full refund succeeded." });
  render(<table><tbody><TransactionRow transaction={transaction} /></tbody></table>);
  fireEvent.click(screen.getByRole("row", { name: /Payment details/ }));
  const button = screen.getByRole("button", { name: "Retry refund" });
  fireEvent.click(button);fireEvent.click(button);
  expect(button.hasAttribute("disabled")).toBe(true);
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Full refund succeeded."));
  expect(retry).toHaveBeenCalledExactlyOnceWith(transaction.refund.id);expect(refresh).toHaveBeenCalledOnce();
  expect(screen.queryByText("Needs attention")).toBeNull();expect(screen.queryByRole("button", { name: "Retry refund" })).toBeNull();
});
test.each([true,false])("captured refund action is limited to eligible late cases: %s", (canRefund) => {
  render(<table><tbody><TransactionRow transaction={{ ...transaction,refund: null,reconciliation: [{ ...lateEvent,can_refund: canRefund }] }} /></tbody></table>);
  fireEvent.click(screen.getByRole("row", { name: /Payment details/ }));
  expect(Boolean(screen.queryByRole("button", { name: "Refund captured payment" }))).toBe(canRefund);
});
test("reconciliation submits only event ID and shows inline errors without losing detail", async () => {
  reconcile.mockResolvedValue({ ok: false,message: "Another refund request is in progress. Refresh shortly." });
  render(<table><tbody><TransactionRow transaction={{ ...transaction,refund: null,reconciliation: [lateEvent] }} /></tbody></table>);
  fireEvent.click(screen.getByRole("row", { name: /Payment details/ }));
  fireEvent.click(screen.getByRole("button", { name: "Refund captured payment" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("in progress"));
  expect(reconcile).toHaveBeenCalledExactlyOnceWith(lateEvent.event_id);expect(screen.getByRole("dialog")).toBeDefined();
});
test("successful reconciliation refreshes the detail and removes attention/actions", async () => {
  if (!transaction.refund) throw new Error("Missing fixture refund");
  const updated: AdminPaymentTransaction = { ...transaction,needsAttention: false,canRetryRefund: false,
    refund: { ...transaction.refund,status: "succeeded" },reconciliation: [{ ...lateEvent,can_refund: false,reconciliation_required: false,resolved_at: "2026-10-06T12:00:00Z" }] };
  reconcile.mockResolvedValue({ ok: true,transaction: updated,message: "Full refund succeeded. Reconciliation resolved." });
  render(<table><tbody><TransactionRow transaction={{ ...transaction,refund: null,reconciliation: [lateEvent] }} /></tbody></table>);
  fireEvent.click(screen.getByRole("row", { name: /Payment details/ }));fireEvent.click(screen.getByRole("button", { name: "Refund captured payment" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Reconciliation resolved"));
  expect(screen.getByText(/Resolved ·/)).toBeDefined();expect(screen.queryByText("Needs attention")).toBeNull();
  expect(screen.queryByRole("button", { name: "Refund captured payment" })).toBeNull();
});

test("NETOPIA transactions and events expose no Stripe recovery actions", () => {
  render(<table><tbody><TransactionRow transaction={{ ...transaction,provider: "netopia",canRetryRefund: false,reconciliation: [{ ...lateEvent,provider: "netopia",can_refund: false }] }} /></tbody></table>);
  fireEvent.click(screen.getByRole("row", { name: /Payment details/ }));
  expect(screen.queryByRole("button", { name: "Retry refund" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Refund captured payment" })).toBeNull();
});
