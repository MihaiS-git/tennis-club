// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { lastToast } from "../helpers/notifications";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), records: vi.fn(), refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), load: vi.fn(), change: vi.fn(), day: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: mocks.push, replace: mocks.replace }), notFound: () => { throw new Error("not found"); } }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.authorize }));
vi.mock("@/lib/bookings/admin-details", () => ({ getAdminBookingRecords: mocks.records }));
vi.mock("@/app/admin/reservations/actions", () => ({ cancelAdminCustomerBookingAction: vi.fn() }));
vi.mock("@/app/admin/bookings/actions", () => ({ loadAdminBookingEditorAction: mocks.load, changeAdminBookingAction: mocks.change, loadAdminBookingDayAction: mocks.day }));
import AdminBookingPage from "@/app/admin/bookings/[bookingId]/page";
import { ReservationCalendar } from "@/app/admin/reservations/reservation-calendar";
import { ReservationControls } from "@/app/admin/reservations/reservation-controls";
import { OperationalBookingEdit, OperationalCalendarReschedule, adminActions } from "@/app/admin/bookings/admin-booking-editor";

const id = "ad000000-0000-4000-8000-000000000001";
const booking = { id, status: "confirmed", created_at: "2099-01-01T09:30:00+00:00", account_user_id: null,
  booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660, location_name: "Central", location_timezone: "UTC",
  court_name: "Court 1", customer_name: "Guest", customer_email: "guest@example.test", customer_phone: "123",
  cancellation_notice_minutes: 1440, total_amount_minor: 9000, currency: "RON", payment_method: "online",
  includes_coaching: false, coach_user_id: null, coach_name: null, coaching_program_name: null, coaching: null };
const editor = { booking, tokens: { current_revision_id: "revision", updated_at: "2099-01-01T00:00:00.123456Z", location_id: "central", court_id: "one" },
  locations: [{ id: "central", name: "Central", courts: [{ id: "one", name: "Court 1" }] },
    { id: "riverside", name: "Riverside", courts: [{ id: "two", name: "Court 2" }] }], coaches: [{ id: "coach", name: "Ana" }, { id: "other", name: "Dan" }] };
function CalendarEditor({ active = true, preloaded = false }: { active?: boolean; preloaded?: boolean } = {}) {
  return <OperationalCalendarReschedule bookingId={active ? id : undefined} capacity="admin" actions={adminActions} locationId="central" date="2099-10-15"
    initialData={preloaded ? { ...editor, booking: { ...booking, currency: "RON" } } : undefined}>
    <ReservationControls locations={editor.locations} locationId="central" date="2099-10-15" today="2099-01-01" href="/admin/bookings?view=calendar" />
    <ReservationCalendar date="2099-10-15" location={{ id: "central", name: "Central", timezone: "UTC", courts: editor.locations[0].courts }}
      day={{ times: [600,630,660,690,720,750], courts: [{ court: editor.locations[0].courts[0], cells: ["booked","booked","available","available","available","available"] }] }} />
    {!active && <OperationalBookingEdit bookingId={id} capacity="admin" />}
  </OperationalCalendarReschedule>;
}
const financial = { consequence: "none", currency: "RON", currentAmountMinor: 9000, destinationAmountMinor: 9000,
  customerAmountMinor: 9000, refundMinor: 0, absorbedMinor: 0 };
async function openEditor() {
  render(<CalendarEditor />);
 
  await screen.findByLabelText("Location");
  fireEvent.change(screen.getByLabelText("Location"), { target: { value: "riverside" } });
  fireEvent.click(await screen.findByRole("button", { name: /Court 2 .*10:00–11:00/ }));
}
beforeAll(() => installDialogMock());
beforeEach(() => { vi.clearAllMocks(); mocks.authorize.mockResolvedValue({ userId: "admin" }); mocks.load.mockResolvedValue(editor);
  mocks.day.mockImplementation(async (input: { locationId: string; date: string }) => ({
    date: input.date, today: "2099-01-01", tokens: editor.tokens,
    location: { id: input.locationId, timezone: "UTC", currency: "RON" },
    day: { times: [600,630,660,690,720,750], courts: [{ court: { id: input.locationId === "central" ? "one" : "two", name: input.locationId === "central" ? "Court 1" : "Court 2" }, cells: Array(6).fill("available") }] },
    starts: [600,630,660,690,720].map(startMinute => ({ courtId: input.locationId === "central" ? "one" : "two", startMinute })),
  })); });
afterEach(cleanup);

test.each([null, "another-customer"])("Details offers operational editing for owner %s", async account_user_id => {
  mocks.records.mockResolvedValue({ booking: { ...booking, account_user_id }, history: [],
    summary: { currency: "RON", total: 9000, paid: 9000, refunded: 0, net: 9000, pendingPayments: 0, pendingRefunds: 0, failedRefunds: 0, outstanding: 0, dueAtClub: 0, unrecordedAtClub: 0, activeBooking: true, otherCurrencies: [] }, operations: { rows: [], totalPages: 1 },
    cancellation: { availability: "eligible", startsAt: "2099-10-15T10:00:00Z", refundAvailable: true } });
  render(await AdminBookingPage({ params: Promise.resolve({ bookingId: id }), searchParams: Promise.resolve({}) }));
  expect(within(screen.getByRole("region", { name: "Booking actions" })).getByRole("button", { name: "Edit booking" })).toBeTruthy();
});

test.each([
  ["none", 9000, 9000, 0, 0], ["club_absorbs", 12000, 9000, 0, 3000],
  ["refund", 7000, 7000, 2000, 0], ["amount_reduced", 7000, 7000, 0, 0],
])("%s quotes must be reviewed before explicit confirmation", async (consequence, destinationAmountMinor, customerAmountMinor, refundMinor, absorbedMinor) => {
  const quote = { ...financial, consequence, destinationAmountMinor, customerAmountMinor, refundMinor, absorbedMinor };
  mocks.change.mockResolvedValueOnce({ ok: true, financial: quote }).mockResolvedValueOnce({ ok: true, changed: true });
  await openEditor();
  expect(mocks.change).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Preview change" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
  await screen.findByRole("region", { name: "Financial preview" });
  expect(mocks.change).toHaveBeenLastCalledWith(expect.objectContaining({ save: false, locationId: "riverside", courtId: "two",
    expectedUpdatedAt: editor.tokens.updated_at, expectedRevisionId: "revision", overrideCoachRestrictions: true }));
  expect(mocks.refresh).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm booking change" }));
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledOnce());
  expect(mocks.change).toHaveBeenLastCalledWith(expect.objectContaining({ save: true, financialAcceptance: quote }));
  expect(mocks.change.mock.calls[0][0].requestId).toBe(mocks.change.mock.calls[1][0].requestId);
});

test("editing the destination invalidates the previous quote", async () => {
  mocks.change.mockResolvedValue({ ok: true, financial });
  await openEditor(); fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
  await screen.findByRole("button", { name: "Confirm booking change" });
  fireEvent.click(screen.getByRole("button", { name: /Court 2 .*12:00–13:00/ }));
  expect(screen.queryByRole("button", { name: "Confirm booking change" })).toBeNull();
});

test.each(["stale", "financial_changed", "court-unavailable", "coach-booked", "cross_currency"])("%s keeps the editor open with an error", async reason => {
  mocks.change.mockResolvedValue({ ok: false, reason });
  await openEditor(); fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Confirm booking change" })).toBeNull();
  expect(mocks.refresh).not.toHaveBeenCalled();
});

test.each(["pending", "applied", "unsuccessful"])("a %s refund reports its authoritative outcome", async adjustmentStatus => {
  mocks.change.mockResolvedValueOnce({ ok: true, financial: { ...financial, consequence: "refund", refundMinor: 2000 } })
    .mockResolvedValueOnce({ ok: true, adjustmentStatus, refundStatus: adjustmentStatus === "applied" ? "succeeded" : "pending" });
  await openEditor(); fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm booking change" }));
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledOnce());
  expect(lastToast(adjustmentStatus === "unsuccessful" ? "error" : "success")).toContain(adjustmentStatus === "pending" ? "original booking remains confirmed" : adjustmentStatus === "applied" ? "refund completed" : "booking has not changed");
});

test("coaching edits choose a new Coach without accepting mutable lesson terms", async () => {
  mocks.load.mockResolvedValue({ ...editor, booking: { ...booking, includes_coaching: true, coach_user_id: "coach" } });
  mocks.change.mockResolvedValue({ ok: true, financial });
  await openEditor();
  fireEvent.change(screen.getByLabelText("Assigned Coach"), { target: { value: "other" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Preview change" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
  await screen.findByRole("region", { name: "Financial preview" });
  expect(mocks.change).toHaveBeenCalledWith(expect.objectContaining({ coachUserId: "other" }));
  expect(mocks.change.mock.calls[0][0]).not.toHaveProperty("durationMinutes");
  expect(mocks.change.mock.calls[0][0]).not.toHaveProperty("coachingAmountMinor");
});

test("load failure is visible and never invokes a mutation", async () => {
  mocks.load.mockRejectedValue(new Error("offline"));
  render(<CalendarEditor />);
  expect(await screen.findByRole("alert")).toBeTruthy(); expect(mocks.change).not.toHaveBeenCalled();
});


test("date navigation clears the destination and loads another day", async () => {
  await openEditor();
  fireEvent.click(screen.getByRole("button", { name: "Next day" }));
  await waitFor(() => expect(mocks.day).toHaveBeenLastCalledWith(expect.objectContaining({ date: "2099-10-16" })));
  expect(screen.getByRole("button", { name: "Preview change" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByLabelText("Start time")).toBeNull();
  expect(screen.queryByLabelText("Destination court")).toBeNull();
});

test("original occupancy is marked and a Coach-only reassignment preserves court and time", async () => {
  mocks.load.mockResolvedValue({ ...editor, booking: { ...booking, includes_coaching: true, coach_user_id: "coach" } });
  mocks.change.mockResolvedValue({ ok: true, financial });
  render(<CalendarEditor />);
 
  expect(await screen.findByRole("button", { name: /Court 1 .*10:00–11:00.*Original reservation.*selected/ })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Assigned Coach"), { target: { value: "other" } });
  await waitFor(() => expect(mocks.day).toHaveBeenLastCalledWith(expect.objectContaining({ coachUserId: "other" })));
  await waitFor(() => expect(screen.getByRole("button", { name: "Preview change" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Preview change" }));
  await screen.findByRole("region", { name: "Financial preview" });
  expect(mocks.change).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ locationId: "central", courtId: "one", date: booking.booking_date, startMinute: 600, coachUserId: "other", save: false }));
});

test("occupied cells and starts without the full duration cannot be selected", async () => {
  mocks.day.mockResolvedValue({ tokens: editor.tokens, today: "2099-01-01", location: { timezone: "UTC", currency: "RON" },
    day: { times: [600,630,660,690], courts: [{ court: { id: "one", name: "Court 1" }, cells: ["available","available","booked","available"] }] },
    starts: [{ courtId: "one", startMinute: 600 }] });
  render(<CalendarEditor />);
  await screen.findByLabelText(/Court 1 .*11:30–12:00, Unavailable start/);
  expect(screen.queryByRole("button", { name: / 11:00–/ })).toBeNull();
  expect(screen.queryByRole("button", { name: / 11:30–/ })).toBeNull();
  expect(screen.getByLabelText(/Court 1 .*11:00–11:30, Booked/)).toBeTruthy();
  expect(screen.getByLabelText(/Court 1 .*11:30–12:00, Unavailable start/)).toBeTruthy();
});

test("a changed revision in an availability response blocks preview", async () => {
  mocks.day.mockResolvedValue({ tokens: { ...editor.tokens, current_revision_id: "changed" } });
  render(<CalendarEditor />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This booking changed. Exit rescheduling and reopen it.");
  expect(screen.getByRole("button", { name: "Preview change" }).hasAttribute("disabled")).toBe(true);
  expect(mocks.change).not.toHaveBeenCalled();
});


test("entry navigates to the staff Calendar without loading a second scheduler", () => {
  const onStart = vi.fn();
  render(<OperationalBookingEdit bookingId={id} capacity="admin" onStart={onStart} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit booking" }));
  expect(mocks.push).toHaveBeenCalledWith(`/admin/bookings?view=calendar&reschedule=${id}`);
  expect(onStart).toHaveBeenCalledOnce();
  expect(mocks.load).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("exit preserves the displayed destination and makes no booking change", async () => {
  await openEditor();
  expect(screen.getAllByRole("table", { name: "Court timetable" })).toHaveLength(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Exit rescheduling" }));
  expect(mocks.replace).toHaveBeenCalledWith("/admin/bookings?view=calendar&location=riverside&date=2099-10-15");
  expect(mocks.change).not.toHaveBeenCalled();
});

test("enter and exit reuse the mounted Calendar and controls without repeating availability", async () => {
  render(<CalendarEditor active={false} />);
  const timetable = screen.getByRole("table", { name: "Court timetable" });
  const location = screen.getByLabelText("Location");
  const date = screen.getByLabelText("Date");
  fireEvent.click(screen.getByRole("button", { name: "Edit booking" }));
  await screen.findByRole("button", { name: /Court 1 .*10:00–11:00.*Original reservation.*selected/ });
  expect(screen.getByRole("table", { name: "Court timetable" })).toBe(timetable);
  expect(screen.getByLabelText("Location")).toBe(location);
  expect(screen.getByLabelText("Date")).toBe(date);
  expect(mocks.day).toHaveBeenCalledOnce();
  expect(mocks.push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Court 1 .*12:00–13:00/ }));
  fireEvent.change(location, { target: { value: "central" } });
  fireEvent.change(date, { target: { value: "2099-10-15" } });
  expect(mocks.day).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText("Assigned Coach")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Exit rescheduling" }));
  expect(screen.getByRole("table", { name: "Court timetable" })).toBe(timetable);
  expect(screen.queryByRole("region", { name: "Rescheduling booking" })).toBeNull();
  expect(mocks.day).toHaveBeenCalledOnce();
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(mocks.replace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Court 1 .*11:00–11:30/ }));
  expect(screen.getByRole("region", { name: "Selected reservation" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next day" }));
  expect(mocks.push).toHaveBeenCalledWith("/admin/bookings?view=calendar&location=central&date=2099-10-16");
});


test("List/Details entry reuses the server-loaded editor without another editor request", async () => {
  render(<CalendarEditor preloaded />);
  await screen.findByRole("button", { name: /Court 1 .*10:00–11:00.*Original reservation.*selected/ });
  expect(mocks.load).not.toHaveBeenCalled();
  expect(mocks.day).toHaveBeenCalledOnce();
  expect(screen.getAllByRole("table", { name: "Court timetable" })).toHaveLength(1);
});
