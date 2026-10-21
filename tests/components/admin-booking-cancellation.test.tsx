// @vitest-environment jsdom
import { expectToast, lastToast } from "../helpers/notifications";
import { installDialogMock } from "../helpers/dialog";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), records: vi.fn(), cancel: vi.fn(), refresh: vi.fn(),
  notFound: vi.fn(() => { throw new Error("not found"); }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }), notFound: mocks.notFound }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.authorize }));
vi.mock("@/lib/bookings/admin-details", () => ({ getAdminBookingRecords: mocks.records }));
vi.mock("@/app/admin/reservations/actions", () => ({ cancelAdminCustomerBookingAction: mocks.cancel }));

import AdminBookingPage from "@/app/admin/bookings/[bookingId]/page";

const bookingId = "ad000000-0000-4000-8000-000000000001", location = "ad000000-0000-4000-8000-0000000000d1";
const paymentId = "ad000000-0000-4000-8000-0000000000c1";
const booking = { id: bookingId, status: "confirmed", created_at: "2099-01-01T09:30:00+00:00", account_user_id: null,
  booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660, location_name: "RIVUS", location_timezone: "UTC",
  court_name: "Court 2", customer_name: "Ana Pop", customer_email: "ana@example.test", customer_phone: "123",
  cancellation_notice_minutes: 1440, total_amount_minor: 9000, currency: "RON", payment_method: "online",
  includes_coaching: false, coach_name: null, coaching_program_name: null, coaching: null };
const summary = { currency: "RON", total: 9000, paid: 9000, refunded: 0, net: 9000, pendingPayments: 0, pendingRefunds: 0,
  failedRefunds: 0, outstanding: 0, dueAtClub: 0, unrecordedAtClub: 0, activeBooking: true, otherCurrencies: [] };
const operation = { method: "online", provider: "stripe", currency: "RON", needsAttention: false, refunded_minor: 0, proposal: null,
  transaction_kind: "payment", transaction_id: paymentId, operation_label: "Booking payment", amount_minor: 9000,
  transaction_status: "succeeded", created_at: "2099-01-01T09:31:00Z" };
const records = (cancellation: object, overrides: object = {}) => mocks.records.mockResolvedValue({ booking, history: [], summary,
  operations: { page: 1, total: 1, totalPages: 1, rows: [operation] },
  cancellation: { availability: "eligible", startsAt: "2099-10-15T10:00:00.000Z", refundAvailable: true, ...cancellation }, ...overrides });
const open = async (search: Record<string, string> = {}) => render(await AdminBookingPage({
  params: Promise.resolve({ bookingId }), searchParams: Promise.resolve(search) }));

beforeAll(() => installDialogMock());
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue({ roles: ["admin"] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

test("Booking Details cancels through the existing Admin action, shows the refund outcome and refreshes", async () => {
  records({});
  mocks.cancel.mockResolvedValue({ ok: true, outcome: "cancelled", refundStatus: "succeeded" });
  await open();
  fireEvent.click(within(screen.getByRole("region", { name: "Booking actions" })).getByRole("button", { name: "Cancel booking" }));
  const confirmation = screen.getByRole("dialog", { name: "Cancel booking?" });
  for (const value of ["Ana Pop", "RIVUS · Court 2", "15 Oct 2099 · 10:00–11:00", "90.00", "RON", "This will cancel the booking and free the court.",
    "Captured online funds will be refunded automatically."]) expect(confirmation.textContent).toContain(value);
  expect(mocks.cancel).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel booking" }));
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel booking" }));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  // One request: the service, not the page, owns lifecycle, refunds and idempotency.
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith({ id: bookingId });
  expect(lastToast("success")).toBe("Booking cancelled. Your payment has been refunded.");
  expect(screen.queryByRole("dialog", { name: "Cancel booking?" })).toBeNull();
});

test("a declined or failed cancellation keeps the confirmation open with an actionable message", async () => {
  records({ refundAvailable: false });
  mocks.cancel.mockResolvedValueOnce({ ok: false, message: "A change to this booking is still being processed. Try again shortly." })
    .mockRejectedValueOnce(new Error("network"));
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
  const confirmation = screen.getByRole("dialog", { name: "Cancel booking?" });
  expect(confirmation.textContent).not.toContain("refunded automatically");
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel booking" }));
  await expectToast("A change to this booking is still being processed. Try again shortly.");
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel booking" }));
  await expectToast("Unable to cancel this booking. Try again.");
  expect(screen.getByRole("dialog", { name: "Cancel booking?" })).toBeTruthy();
  expect(mocks.refresh).not.toHaveBeenCalled();
});

test("a pending cancellation is an asynchronous outcome, not a failure", async () => {
  records({});
  mocks.cancel.mockResolvedValue({ ok: true, outcome: "cancellation_pending" });
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Cancel booking?" })).getByRole("button", { name: "Cancel booking" }));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  expect(lastToast("success")).toBe("Cancellation requested. The booking stays confirmed until the refund is confirmed.");
});

test.each([
  ["unavailable", null],
  ["started", "This booking has started and can no longer be cancelled."],
  ["cancellation_pending", "Cancellation requested. The booking stays confirmed until the refund is confirmed."],
  ["change_pending", "A change to this booking is still being processed. Cancellation is available once it finishes."],
])("ineligible booking (%s) offers no cancellation", async (availability, message) => {
  records({ availability }, availability === "unavailable" ? { booking: { ...booking, status: "cancelled" } } : {});
  await open();
  expect(screen.queryByRole("button", { name: "Cancel booking" })).toBeNull();
  if (message) expect(screen.getByRole("status").textContent).toBe(message);
  else expect(screen.queryByRole("region", { name: "Booking actions" })).toBeNull();
  // Financial and history records stay read-only either way.
  expect(screen.getByRole("link", { name: /Booking payment|Payment/ })).toBeDefined();
});

test("an open page withdraws cancellation when the booking starts", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2099-10-15T09:59:00Z"));
  records({});
  await open();
  expect(screen.getByRole("button", { name: "Cancel booking" })).toBeTruthy();
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(screen.queryByRole("button", { name: "Cancel booking" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("This booking has started and can no longer be cancelled.");
});

test("opened from the Calendar, Back and transaction links return to that location and date", async () => {
  records({});
  const calendar = `/admin/bookings?view=calendar&location=${location}&date=2099-10-15`;
  await open({ back: calendar });
  expect(screen.getByRole("link", { name: "Back to Calendar" }).getAttribute("href")).toBe(calendar);
  const transaction = new URL(screen.getByRole("link", { name: /Booking payment|Payment/ }).getAttribute("href")!, "http://x");
  const booking = new URL(transaction.searchParams.get("back")!, "http://x");
  expect(booking.pathname).toBe(`/admin/bookings/${bookingId}`);
  expect(booking.searchParams.get("back")).toBe(calendar);
});

test.each([
  [`/admin/bookings?view=calendar&location=not-a-uuid&date=2099-02-30&extra=1`, "/admin/bookings?view=calendar"],
  [`/admin/bookings?view=calendar&location=${location.toUpperCase()}`, `/admin/bookings?view=calendar&location=${location}`],
])("rebuilds a Calendar return %s from validated values only", async (back, expected) => {
  records({ availability: "unavailable" });
  await open({ back });
  expect(screen.getByRole("link", { name: "Back to Calendar" }).getAttribute("href")).toBe(expected);
});

test("a List return without view stays the List's own back link", async () => {
  records({ availability: "unavailable" });
  await open({ status: "confirmed", sort: "scheduled", page: "2", back: "/admin/bookings?status=cancelled" });
  expect(screen.queryByRole("link", { name: "Back to Calendar" })).toBeNull();
  expect(screen.getByRole("link", { name: "Back to Bookings" }).getAttribute("href")).toBe("/admin/bookings?status=confirmed&sort=scheduled&page=2");
});
