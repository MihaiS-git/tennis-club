// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AdminPaymentTransaction } from "@/lib/payments/admin";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), records: vi.fn(), transactions: vi.fn(),
  notFound: vi.fn(() => { throw new Error("not found"); }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), notFound: mocks.notFound }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.authorize }));
vi.mock("@/lib/bookings/admin-details", () => ({ getAdminBookingRecords: mocks.records }));
vi.mock("@/lib/payments/admin", () => ({ listAdminPaymentTransactions: mocks.transactions }));
vi.mock("@/app/admin/payments/actions", () => ({ checkRefundWithProviderAction: vi.fn(), checkPaymentWithProviderAction: vi.fn() }));

import AdminBookingPage from "@/app/admin/bookings/[bookingId]/page";
import TransactionPage from "@/app/admin/payments/transactions/[kind]/[transactionId]/page";

const bookingId = "ae000000-0000-4000-8000-000000000001", otherBookingId = "ae000000-0000-4000-8000-000000000009";
const paymentId = "ae000000-0000-4000-8000-0000000000c1", sourceRefundId = "ae000000-0000-4000-8000-0000000000c2";
const location = "ae000000-0000-4000-8000-0000000000d1";
const booking = { id: bookingId, status: "confirmed", created_at: "2024-12-20T09:30:00+00:00", account_user_id: null,
  booking_date: "2025-01-01", starts_at_minute: 600, ends_at_minute: 690, location_name: "Club", location_timezone: "UTC",
  court_name: "Court 1", customer_name: "Guest Person", customer_email: "guest@example.test", customer_phone: "123",
  cancellation_notice_minutes: 1440, total_amount_minor: 4550, currency: "RON", payment_method: "online" };
const summary = { currency: "RON", total: 4550, paid: 4550, refunded: 0, net: 4550, pendingPayments: 0, pendingRefunds: 0,
  failedRefunds: 0, outstanding: 0, dueAtClub: 0, unrecordedAtClub: 0, activeBooking: true, otherCurrencies: [] };
const operation = { method: "online", provider: "stripe", currency: "RON", needsAttention: false, refunded_minor: 0, proposal: null,
  transaction_kind: "payment", transaction_id: paymentId, operation_label: "Booking payment", amount_minor: 4550,
  transaction_status: "succeeded", created_at: "2024-12-20T09:31:00Z" };
const contract = { revisionId: "ae000000-0000-4000-8000-0000000000e1", bookingState: "confirmed" as const,
  courtId: "ae000000-0000-4000-8000-0000000000e2", locationId: location, courtName: "Court 1", locationName: "Club", timezone: "UTC",
  bookingDate: "2025-01-01", startMinute: 600, endMinute: 690, customerName: "Guest Person", customerEmail: "guest@example.test",
  customerPhone: "123", totalAmountMinor: 4550, currency: "RON" as const, paymentMethod: "online" as const };
const transaction: AdminPaymentTransaction = {
  context: { ...contract, source: "booking_revision", confirmationRevisionId: null }, previous_context: null, proposal: null,
  current_booking: { ...contract, status: "confirmed" }, financials: null, customer_phone: "123", booking_total_minor: 4550,
  transaction_kind: "payment", transaction_id: paymentId, payment_attempt_id: paymentId, adjustment_id: null,
  operation_label: "Booking payment", transaction_status: "succeeded", refunded_minor: 0, booking_id: bookingId,
  reservation_id: "ae000000-0000-4000-8000-0000000000e3", account_user_id: null, customer_name: "Guest Person",
  customer_email: "guest@example.test", amount_minor: 4550, currency: "RON", method: "online", provider: "stripe",
  payment_status: "succeeded", provider_payment_id: null, created_at: "2024-12-20T09:31:00Z", updated_at: "2024-12-20T09:31:00Z",
  booking_date: "2025-01-01", starts_at_minute: 600, ends_at_minute: 690, court_name: "Court 1", location_name: "Club",
  location_timezone: "UTC", refund: null, reconciliation: [], needsAttention: false, refundUnconfirmed: false,
} as unknown as AdminPaymentTransaction;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({ roles: ["admin"] });
  mocks.records.mockResolvedValue({ booking, history: [], summary,
    operations: { page: 2, total: 21, totalPages: 2, rows: [operation] } });
  mocks.transactions.mockResolvedValue({ rows: [transaction], page: 1, total: 1, totalPages: 1 });
});
afterEach(cleanup);

const searchOf = (href: string) => Object.fromEntries(new URL(href, "http://x").searchParams);
const renderTransaction = async (search: Record<string, string>, kind = "payment") =>
  render(await TransactionPage({ params: Promise.resolve({ kind, transactionId: paymentId }), searchParams: Promise.resolve(search) }));
const bookingLink = () => screen.getByRole("link", { name: `Booking ${bookingId}` }).getAttribute("href")!;

test("booking → transaction → booking restores list filters, both pages and the booking's own back context", async () => {
  const transactionsList = `/admin/payments/transactions/refund/${sourceRefundId}?q=Ana&page=4`;
  const bookingSearch = { q: "guest", status: "confirmed", location, sort: "scheduled", dir: "asc", page: "3", history: "2",
    back: transactionsList };
  render(await AdminBookingPage({ params: Promise.resolve({ bookingId }), searchParams: Promise.resolve(bookingSearch) }));
  const backToSource = screen.getByRole("link", { name: "Back to Transaction" }).getAttribute("href")!;
  const toTransaction = within(screen.getByRole("table", { name: "Financial history" }))
    .getByRole("link", { name: "Booking payment" }).getAttribute("href")!;
  expect(toTransaction.startsWith(`/admin/payments/transactions/payment/${paymentId}?back=`)).toBe(true);
  cleanup();

  await renderTransaction(searchOf(toTransaction));
  const toBooking = bookingLink();
  expect(toBooking).toBe(`/admin/bookings/${bookingId}?${new URLSearchParams({ q: "guest", status: "confirmed", location,
    sort: "scheduled", dir: "asc", page: "3", back: backToSource, history: "2" })}#financial-history`);
  // Its own list link is unchanged.
  expect(screen.getByRole("link", { name: "Back to transactions" }).getAttribute("href")).toBe(`/admin/payments/transactions?${
    new URLSearchParams({ status: "all", provider: "all", method: "all", attention: "all", q: "", page: "1", sort: "date", dir: "desc" })}`);
  cleanup();

  mocks.records.mockClear();
  render(await AdminBookingPage({ params: Promise.resolve({ bookingId }), searchParams: Promise.resolve(searchOf(toBooking)) }));
  expect(mocks.records).toHaveBeenCalledWith(bookingId, { historyPage: 2 });
  expect(screen.getByRole("link", { name: "Back to Transaction" }).getAttribute("href")).toBe(backToSource);
  expect(within(screen.getByRole("table", { name: "Financial history" })).getByRole("link", { name: "Booking payment" })
    .getAttribute("href")).toBe(toTransaction);
});

test("without a return target Booking Details still goes back to Bookings with its filters", async () => {
  render(await AdminBookingPage({ params: Promise.resolve({ bookingId }), searchParams: Promise.resolve({ status: "confirmed", page: "2" }) }));
  const toTransaction = within(screen.getByRole("table", { name: "Financial history" }))
    .getByRole("link", { name: "Booking payment" }).getAttribute("href")!;
  cleanup();
  await renderTransaction(searchOf(toTransaction));
  const toBooking = bookingLink();
  expect(toBooking).toBe(`/admin/bookings/${bookingId}?status=confirmed&page=2&history=2#financial-history`);
  cleanup();
  render(await AdminBookingPage({ params: Promise.resolve({ bookingId }), searchParams: Promise.resolve(searchOf(toBooking)) }));
  expect(screen.getByRole("link", { name: "Back to Bookings" }).getAttribute("href")).toBe("/admin/bookings?status=confirmed&page=2");
});

test("independently opened Transaction Details keep their existing booking link and list context", async () => {
  await renderTransaction({ q: "Ana", page: "2" });
  const href = bookingLink();
  expect(href.startsWith(`/admin/bookings/${bookingId}?`)).toBe(true);
  expect(searchOf(href).back).toBe(`/admin/payments/transactions/payment/${paymentId}?${
    new URLSearchParams({ status: "all", provider: "all", method: "all", attention: "all", q: "Ana", page: "2", sort: "date", dir: "desc" })}`);
});

test.each([
  ["another booking", `/admin/bookings/${otherBookingId}?status=confirmed`],
  ["an external URL", `https://evil.example/admin/bookings/${bookingId}`],
  ["a protocol-relative URL", `//evil.example/admin/bookings/${bookingId}`],
  ["a script URL", "javascript:alert(1)"],
  ["a malformed booking ID", "/admin/bookings/not-a-uuid"],
  ["a different Admin page", `/admin/users/${bookingId}`],
  ["a nested booking path", `/admin/bookings/${bookingId}/edit`],
])("a return target to %s is ignored", async (_, back) => {
  await renderTransaction({ back });
  expect(searchOf(bookingLink()).back).toBe(`/admin/payments/transactions/payment/${paymentId}?${
    new URLSearchParams({ status: "all", provider: "all", method: "all", attention: "all", q: "", page: "1", sort: "date", dir: "desc" })}`);
});

test("restored booking links are rebuilt from validated parameters only", async () => {
  await renderTransaction({ back: `/admin/bookings/${bookingId.toUpperCase()}?${new URLSearchParams({ status: "bogus", page: "-1",
    history: "x", sort: "price", injected: "1", back: "https://evil.example/admin/payments/transactions" })}` });
  expect(bookingLink()).toBe(`/admin/bookings/${bookingId}#financial-history`);
});

test("authorization runs before any transaction read", async () => {
  mocks.authorize.mockRejectedValueOnce(new Error("forbidden"));
  await expect(TransactionPage({ params: Promise.resolve({ kind: "payment", transactionId: paymentId }),
    searchParams: Promise.resolve({ back: `/admin/bookings/${bookingId}` }) })).rejects.toThrow("forbidden");
  expect(mocks.transactions).not.toHaveBeenCalled();
});
