// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), records: vi.fn(), refresh: vi.fn(), dismiss: vi.fn(), form: vi.fn(),
  notFound: vi.fn(() => { throw new Error("not found"); }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }), notFound: mocks.notFound }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.authorize }));
vi.mock("@/lib/bookings/admin-details", () => ({ getAdminBookingRecords: mocks.records }));
vi.mock("@/app/admin/reservations/actions", () => ({ cancelAdminCustomerBookingAction: vi.fn() }));
vi.mock("@/app/my-activity/bookings/actions", () => ({ dismissOwnBookingAdjustmentAction: mocks.dismiss }));
// The existing owner form owns loading, quotes, price acknowledgment and payment differences.
vi.mock("@/components/booking-edit-form", () => ({ BookingEditForm: (props: {
  booking: { id: string }; actions?: unknown; onCancel: () => void; onSaved: () => Promise<void>; onAdjustment?: (id: string | null) => void;
}) => { mocks.form(props); return <div data-testid="edit-form">
  <button type="button" onClick={() => void props.onSaved()}>Save stub</button>
  <button type="button" onClick={() => props.onAdjustment?.("ad000000-0000-4000-8000-0000000000e1")}>Propose stub</button>
  <button type="button" onClick={props.onCancel}>Back stub</button>
</div>; } }));

import AdminBookingPage from "@/app/admin/bookings/[bookingId]/page";

const adminId = "ad000000-0000-4000-8000-0000000000a1", bookingId = "ad000000-0000-4000-8000-000000000001";
const booking = { id: bookingId, status: "confirmed", created_at: "2099-01-01T09:30:00+00:00", account_user_id: adminId,
  booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660, location_name: "RIVUS", location_timezone: "UTC",
  court_name: "Court 2", customer_name: "Admin Owner", customer_email: "admin@example.test", customer_phone: "123",
  cancellation_notice_minutes: 1440, total_amount_minor: 9000, currency: "RON", payment_method: "online",
  includes_coaching: false, coach_name: null, coaching_program_name: null, coaching: null };
const summary = { currency: "RON", total: 9000, paid: 9000, refunded: 0, net: 9000, pendingPayments: 0, pendingRefunds: 0,
  failedRefunds: 0, outstanding: 0, dueAtClub: 0, unrecordedAtClub: 0, activeBooking: true, otherCurrencies: [] };
const records = (bookingOverrides: object = {}, availability = "eligible") => mocks.records.mockResolvedValue({
  booking: { ...booking, ...bookingOverrides }, history: [], summary, operations: { page: 1, total: 0, totalPages: 1, rows: [] },
  cancellation: { availability, startsAt: "2099-10-15T10:00:00.000Z", refundAvailable: true } });
const open = async (search: Record<string, string> = {}) => render(await AdminBookingPage({
  params: Promise.resolve({ bookingId }), searchParams: Promise.resolve(search) }));

beforeAll(() => installDialogMock());
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue({ state: "active", userId: adminId, roles: ["admin"] });
  mocks.dismiss.mockResolvedValue({ ok: true }); });
afterEach(() => cleanup());

test("the Admin's own court booking opens the existing owner edit form and refreshes details after saving", async () => {
  records();
  await open({ back: "/admin/bookings?view=calendar&date=2099-10-15" });
  fireEvent.click(within(screen.getByRole("region", { name: "Booking actions" })).getByRole("button", { name: "Edit booking" }));
  const dialog = screen.getByRole("dialog", { name: "Edit booking" });
  // Default owner actions: no Admin-specific rescheduling path exists.
  expect(mocks.form).toHaveBeenLastCalledWith(expect.objectContaining({ booking: expect.objectContaining({ id: bookingId,
    booking_date: "2099-10-15", currency: "RON" }) }));
  expect(mocks.form.mock.lastCall![0].actions).toBeUndefined();
  fireEvent.click(within(dialog).getByRole("button", { name: "Save stub" }));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog", { name: "Edit booking" })).toBeNull();
  expect(mocks.dismiss).not.toHaveBeenCalled();
  // Return navigation is untouched by editing.
  expect(screen.getByRole("link", { name: "Back to Calendar" }).getAttribute("href")).toBe("/admin/bookings?view=calendar&date=2099-10-15");
});

test("closing with an unpaid proposed modification discards it through the existing owner action", async () => {
  records();
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Edit booking" }));
  fireEvent.click(screen.getByRole("button", { name: "Propose stub" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Edit booking" })).getByRole("button", { name: "Back stub" }));
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  expect(mocks.dismiss).toHaveBeenCalledExactlyOnceWith("ad000000-0000-4000-8000-0000000000e1");
});

test.each([
  ["another customer's booking", { account_user_id: "ad000000-0000-4000-8000-0000000000b2" }, "eligible"],
  ["a guest booking", { account_user_id: null }, "eligible"],
  ["a coaching booking", { includes_coaching: true }, "eligible"],
  ["a cancelled booking", { status: "cancelled" }, "unavailable"],
  ["a started booking", {}, "started"],
  ["a booking with a change in progress", {}, "change_pending"],
  ["a booking with a pending cancellation", {}, "cancellation_pending"],
])("%s offers no editing", async (_, overrides, availability) => {
  records(overrides, availability);
  await open();
  expect(screen.queryByRole("button", { name: "Edit booking" })).toBeNull();
  expect(mocks.form).not.toHaveBeenCalled();
});
