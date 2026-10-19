import { installDialogMock } from "../helpers/dialog";
import { toast } from "sonner";
// @vitest-environment jsdom
import { lastToast } from "../helpers/notifications";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PersonalActivity } from "@/app/my-activity/bookings/personal-activity";
import { CustomerBookingCancellation } from "@/app/my-activity/bookings/customer-booking-cancellation";
import { localMinute, localToday } from "@/lib/courts/local-time";
import type { UpcomingActivity, UpcomingCourtActivity } from "@/lib/bookings/activity-service";
import type { PersonalCustomerBooking } from "@/lib/bookings/personal";
import type { PersonalReservation } from "@/lib/reservations/personal";

const { load, cancel, cancelBooking, edit, availability } = vi.hoisted(() => ({ load: vi.fn<typeof import("@/app/my-activity/bookings/actions").loadPersonalActivityAction>(), cancel: vi.fn(), cancelBooking: vi.fn(), edit: vi.fn(), availability: vi.fn() }));
vi.mock("@/app/my-activity/bookings/actions", () => ({ loadPersonalActivityAction: load, cancelOwnReservationAction: cancel, cancelOwnCustomerBookingAction: cancelBooking,
  editOwnReservationAction: edit, loadReservationEditDayAction: availability,
  loadOwnBookingEditDayAction: vi.fn(), quoteOwnBookingAction: vi.fn(), rescheduleOwnBookingAction: vi.fn(),
  loadOwnBookingPaymentAction: vi.fn(async () => ({ ok: true, payment: { method: "online", currency: "RON", timezone: "UTC",
    total: 5000, paid: 5000, refunded: 0, refundPending: 0, outstanding: 0, dueAtClub: 0, operations: [] } })) }));

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/my-activity/bookings",
  useRouter: () => ({ replace: navigation.replace }),
}));

function bookingItem(row: PersonalCustomerBooking): UpcomingCourtActivity { return { kind: "booking", row }; }
function reservationItem(row: PersonalReservation): UpcomingCourtActivity { return { kind: "reservation", row }; }
function activityFixture(ordered: UpcomingCourtActivity[]): UpcomingActivity {
  return { ordered, bookings: ordered.flatMap(item => item.kind === "booking" ? [item.row] : []),
    upcoming: ordered.flatMap(item => item.kind === "reservation" ? [item.row] : []),
    locations: [], courts: [], hasNext: false };
}

async function renderWithServerActivity(props: Omit<ComponentProps<typeof PersonalActivity>, "initialActivity" | "initialError">) {
  return render(<PersonalActivity {...props} initialActivity={await load()} initialError="" />);
}

beforeEach(() => {
  load.mockReset();
  navigation.replace.mockClear();
  cancel.mockReset();
  cancelBooking.mockReset();
  edit.mockReset();
  availability.mockReset();
  installDialogMock();
});
afterEach(cleanup);

it.each([true])("renders every owned row and opens each detail dialog (staff=%s)", async (staff) => {
  const booking = (id: string, start: number, zone = "UTC"): PersonalCustomerBooking => ({
    id, starts_at_instant: `2099-10-15T${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")}:00${zone === "Europe/Bucharest" ? "+03:00" : "Z"}`, booking_date: "2099-10-15", starts_at_minute: start, ends_at_minute: start + 60,
    location_name: "Club", location_timezone: zone, court_name: id,
    customer_name: `Customer ${id}`, customer_email: `${id}@example.test`, customer_phone: "123",
    cancellation_notice_minutes: 120, total_amount_minor: 5000, currency: "RON",
  });
  const reservation = (id: string, start: number): PersonalReservation => ({
    id, court_id: id, location_id: "location", updated_at: "2026-10-01T12:00:00Z",
    booking_date: "2099-10-15", starts_at_minute: start, ends_at_minute: start + 60,
    location_name: "Club", location_timezone: "UTC", court_name: id,
    reason: `Reason ${id}`, status: "active", created_by_user_id: "owner", creator_name: "Owner",
    cancelled_at: null, cancelled_by_name: null,
  });
  // The two tied bookings must use the ID tie-breaker; Bucharest 10:00 is earlier
  // than UTC 09:00 despite its later wall-clock time.
  const bookings = [booking("booking-b", 600), booking("booking-a", 600), booking("booking-first", 600, "Europe/Bucharest")];
  const upcoming = staff ? [reservation("reservation-last", 660), reservation("reservation-middle", 540)] : [];
  const ordered = staff ? [bookings[2], upcoming[1], bookings[1], bookings[0], upcoming[0]]
    : [bookings[2], bookings[1], bookings[0]];
  load.mockResolvedValue(activityFixture(ordered.map(row => "customer_name" in row ? bookingItem(row) : reservationItem(row))));
  await renderWithServerActivity({ staff, userId: "owner" });
  const region = await screen.findByRole("region", { name: "Upcoming" });
  const buttons = within(region).getAllByRole("row", { name: /Details for/ });
  expect(buttons).toHaveLength(staff ? 5 : 3);
  expect(within(region).getAllByRole("row").slice(1)).toHaveLength(ordered.length);
  for (const [index, row] of ordered.entries()) {
    expect(buttons[index].closest("tr")!.textContent).toContain(row.court_name);
    expect(buttons[index].closest("tr")!.textContent).toContain("60 min");
    if (index === 0) fireEvent.keyDown(buttons[index], { key: "Enter" });
    else fireEvent.click(buttons[index]);
    const isBooking = "customer_name" in row;
    const dialog = screen.getByRole("dialog", { name: isBooking ? "Booking" : "Reservation details" });
    expect(within(dialog).getByText(row.court_name)).toBeDefined();
    if (isBooking) {
      expect(buttons[index].closest("tr")!.textContent).toMatch(/RON\s*50\.00/);
      expect(within(dialog).getByText(row.customer_email)).toBeDefined();
      expect(within(dialog).getByRole("button", { name: "Cancel booking" })).toBeDefined();
      expect(within(dialog).getByRole("button", { name: "Edit booking" })).toBeDefined();
    } else {
      expect(buttons[index].closest("tr")!.textContent).toContain("—");
      expect(within(dialog).getByText(row.reason!)).toBeDefined();
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  }
  expect(load).toHaveBeenCalledOnce();
});

it("loads on the bookings page and offers cancellation only for the owner's Upcoming reservation", async () => {
  const active: PersonalReservation = { id: "one", court_id: "court", location_id: "location", updated_at: "2026-10-01T12:00:00Z", booking_date: "2099-10-12", starts_at_minute: 840, ends_at_minute: 960,
    reason: "Course with Andrej", status: "active", created_by_user_id: "owner", creator_name: "Andrej",
    cancelled_at: null, cancelled_by_name: null, location_name: "RIVUS", location_timezone: "Europe/Bucharest", court_name: "Court 2" };
  load.mockResolvedValue(activityFixture([reservationItem(active)]));
  await renderWithServerActivity({ staff: true, userId: "owner" });
  const upcoming = await screen.findByRole("region", { name: "Upcoming" });
  expect(within(upcoming).getByText("Court 2")).toBeDefined();
  expect(screen.queryByText("Cancelled")).toBeNull();
  expect(screen.queryByText("Past")).toBeNull();
  fireEvent.click(within(upcoming).getByRole("row", { name: /Details for/ }));
  const dialog = screen.getByRole("dialog", { name: "Reservation details" });
  expect(within(dialog).getByText("Course with Andrej")).toBeDefined();
  expect(within(dialog).getByText("Andrej")).toBeDefined();
  expect(within(dialog).getByText("120 min")).toBeDefined();
  expect(within(dialog).getByRole("button", { name: "Edit reservation" })).toBeDefined();
  expect(within(dialog).getByRole("button", { name: "Cancel reservation" })).toBeDefined();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("region", { name: "History" })).toBeNull();
  expect(load).toHaveBeenCalledOnce();
});

it("does not offer cancellation when a reservation has a different creator", async () => {
  load.mockResolvedValue(activityFixture([reservationItem({ id: "one", court_id: "court", location_id: "location", updated_at: "2026-10-01T12:00:00Z", booking_date: "2026-10-12", starts_at_minute: 840, ends_at_minute: 960,
    reason: "Practice", status: "active", created_by_user_id: "another", creator_name: "Another",
    cancelled_at: null, cancelled_by_name: null, location_name: "RIVUS", location_timezone: "Europe/Bucharest", court_name: "Court 2" })]));
  await renderWithServerActivity({ staff: true, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("row", { name: /Details for/ }));
  expect(within(screen.getByRole("dialog", { name: "Reservation details" })).queryByRole("button", { name: "Cancel reservation" })).toBeNull();
  expect(within(screen.getByRole("dialog", { name: "Reservation details" })).queryByRole("button", { name: "Edit reservation" })).toBeNull();
});

it("edits a future reservation in the details dialog and shows refreshed details", async () => {
  const reservationId = "11111111-1111-4111-8111-111111111111";
  const locationId = "22222222-2222-4222-8222-222222222222";
  const courtA = "33333333-3333-4333-8333-333333333333";
  const courtB = "44444444-4444-4444-8444-444444444444";
  const active: PersonalReservation = { id: reservationId, court_id: courtA, location_id: locationId, updated_at: "2026-10-01T12:00:00Z",
    booking_date: "2099-10-15", starts_at_minute: 840, ends_at_minute: 960, reason: "Practice", status: "active",
    created_by_user_id: "owner", creator_name: "Alex", cancelled_at: null, cancelled_by_name: null,
    location_name: "RIVUS", location_timezone: "Europe/Bucharest", court_name: "Court 2" };
  load.mockResolvedValueOnce(activityFixture([reservationItem(active)])).mockResolvedValueOnce(activityFixture([reservationItem({ ...active,
    court_id: courtB, court_name: "Court 3", reason: "Training", updated_at: "2026-10-01T12:01:00Z" })]));
  availability.mockResolvedValue({ date: active.booking_date, location: { id: locationId, name: "RIVUS", timezone: "Europe/Bucharest" },
    day: { times: [840, 870, 900, 930, 960, 990], courts: [
      { court: { id: courtA, name: "Court 2" }, cells: Array(6).fill("available") },
      { court: { id: courtB, name: "Court 3" }, cells: Array(6).fill("available") },
    ] } });
  edit.mockResolvedValue({ ok: true });
  await renderWithServerActivity({ staff: true, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("row", { name: /Details for/ }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Reservation details" })).getByRole("button", { name: "Edit reservation" }));
  const dialog = screen.getByRole("dialog", { name: "Edit reservation" });
  expect(within(dialog).getByText("RIVUS")).toBeDefined();
  expect(within(dialog).queryByRole("combobox")).toBeNull();
  expect(within(dialog).queryByLabelText("Location")).toBeNull();
  expect(within(dialog).queryByLabelText("From")).toBeNull();
  expect(within(dialog).queryByLabelText("To")).toBeNull();
  await within(dialog).findByRole("rowheader", { name: "Court 3" });
  expect(within(dialog).getByText("Current reservation")).toBeDefined();
  expect(within(dialog).getAllByRole("button", { name: /Court 2.*selected/ })).toHaveLength(4);
  fireEvent.click(within(dialog).getByRole("button", { name: /Court 3 2099-10-15 14:00–14:30/ }));
  fireEvent.click(within(dialog).getByRole("button", { name: /Court 3 2099-10-15 15:30–16:00/ }));
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), { target: { value: "   " } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  expect(edit).not.toHaveBeenCalled();
  expect(within(dialog).getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  expect(within(dialog).getByText("Court 3 · 14:00–16:00 · 120 min")).toBeDefined();
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), { target: { value: "Training" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(edit).toHaveBeenCalledWith({ kind: "schedule", id: reservationId, expectedUpdatedAt: active.updated_at,
    schedule: { courtId: courtB, date: "2099-10-15", startMinute: 840, endMinute: 960, reason: "Training" } }));
  const updated = await screen.findByRole("dialog", { name: "Reservation details" });
  expect(within(updated).getByText("Court 3")).toBeDefined();
  expect(within(updated).getByText("Training")).toBeDefined();
  expect(lastToast("success")).toBe("Reservation updated.");
  expect(screen.getByRole("region", { name: "Upcoming" })).toBeDefined();
});

it("shows an in-progress reservation's schedule read-only and edits only its reason", async () => {
  const reservationId = "11111111-1111-4111-8111-111111111111";
  const now = new Date();
  const zone = ["UTC", "America/Los_Angeles", "Pacific/Honolulu", "Asia/Tokyo", "Europe/Bucharest"]
    .find((item) => localMinute(item, now) >= 120 && localMinute(item, now) <= 1320)!;
  const start = Math.floor(localMinute(zone, now) / 30) * 30 - 30;
  const active: PersonalReservation = { id: reservationId, court_id: "33333333-3333-4333-8333-333333333333",
    location_id: "22222222-2222-4222-8222-222222222222", updated_at: "2026-10-01T12:00:00Z",
    booking_date: localToday(zone, now), starts_at_minute: start, ends_at_minute: start + 90,
    reason: "Practice", status: "active", created_by_user_id: "owner", creator_name: "Alex",
    cancelled_at: null, cancelled_by_name: null, location_name: "RIVUS", location_timezone: zone, court_name: "Court 2" };
  load.mockResolvedValueOnce(activityFixture([reservationItem(active)])).mockResolvedValueOnce(activityFixture([reservationItem({ ...active,
    reason: "Training", updated_at: "2026-10-01T12:01:00Z" })]));
  edit.mockResolvedValue({ ok: true });
  await renderWithServerActivity({ staff: true, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("row", { name: /Details for/ }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Reservation details" })).getByRole("button", { name: "Edit reservation" }));
  const dialog = screen.getByRole("dialog", { name: "Edit reservation" });
  expect(within(dialog).getByText(/cannot be changed/)).toBeDefined();
  expect(within(dialog).queryByRole("combobox")).toBeNull();
  expect(within(dialog).queryByLabelText("Date")).toBeNull();
  expect(availability).not.toHaveBeenCalled();
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), { target: { value: "Training" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(edit).toHaveBeenCalledWith({ kind: "reason", id: reservationId, expectedUpdatedAt: active.updated_at, reason: "Training" }));
});

it("refreshes changed details after a stale edit instead of overwriting them", async () => {
  const active: PersonalReservation = { id: "11111111-1111-4111-8111-111111111111", court_id: "33333333-3333-4333-8333-333333333333",
    location_id: "22222222-2222-4222-8222-222222222222", updated_at: "2026-10-01T12:00:00Z",
    booking_date: "2099-10-15", starts_at_minute: 840, ends_at_minute: 960, reason: "Practice", status: "active",
    created_by_user_id: "owner", creator_name: "Alex", cancelled_at: null, cancelled_by_name: null,
    location_name: "RIVUS", location_timezone: "Europe/Bucharest", court_name: "Court 2" };
  load.mockResolvedValueOnce(activityFixture([reservationItem(active)])).mockResolvedValueOnce(activityFixture([reservationItem({ ...active,
    reason: "Newer update", updated_at: "2026-10-01T12:01:00Z" })]));
  availability.mockResolvedValue({ date: active.booking_date,
    location: { id: active.location_id, name: "RIVUS", timezone: "Europe/Bucharest" },
    day: { times: [840, 870, 900, 930], courts: [{ court: { id: active.court_id, name: "Court 2" },
      cells: ["available", "available", "available", "available"] }] } });
  edit.mockResolvedValue({ ok: false, stale: true, message: "This reservation has changed since you opened it." });
  await renderWithServerActivity({ staff: true, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("row", { name: /Details for/ }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Reservation details" })).getByRole("button", { name: "Edit reservation" }));
  const form = screen.getByRole("dialog", { name: "Edit reservation" });
  await within(form).findByText("Current reservation");
  fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "My draft" } });
  fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(edit).toHaveBeenCalledWith({ kind: "reason", id: active.id,
    expectedUpdatedAt: active.updated_at, reason: "My draft" }));
  const details = await screen.findByRole("dialog", { name: "Reservation details" });
  expect(within(details).getByText("Newer update")).toBeDefined();
  expect(lastToast("warning")).toContain("changed since you opened it");
});

const cancellableBooking: PersonalCustomerBooking = {
  id: "11111111-1111-4111-8111-111111111111", starts_at_instant: "2099-10-15T10:00:00Z",
  booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
  location_name: "Club", location_timezone: "UTC", court_name: "Customer court",
  customer_name: "Owner", customer_email: "owner@example.test", customer_phone: "123",
  cancellation_notice_minutes: 1440, total_amount_minor: 5000, currency: "RON",
};

it("adopts revalidated server snapshots while mounted and preserves an open dialog", () => {
  const { rerender } = render(<PersonalActivity staff={false} userId="owner"
    initialActivity={activityFixture([])} initialError="" />);
  expect(screen.getByText("No upcoming bookings or reservations match your filters.")).toBeDefined();
  rerender(<PersonalActivity staff={false} userId="owner"
    initialActivity={activityFixture([bookingItem(cancellableBooking)])} initialError="" />);
  fireEvent.click(within(screen.getByRole("region", { name: "Upcoming" })).getByRole("row", { name: /Details for/ }));
  const dialog = screen.getByRole("dialog", { name: "Booking" });
  rerender(<PersonalActivity staff={false} userId="owner"
    initialActivity={activityFixture([bookingItem(cancellableBooking), bookingItem({ ...cancellableBooking, id: "new", court_name: "New court" })])}
    initialError="" />);
  expect(within(screen.getByRole("region", { name: "Upcoming" })).getAllByRole("row", { name: /Details for/ })).toHaveLength(2);
  expect(screen.getByRole("dialog", { name: "Booking" })).toBe(dialog);
  expect(load).not.toHaveBeenCalled();
});

it("renders filter options even for empty results and resets the page when selecting a filter", () => {
  const location = "22222222-2222-4222-8222-222222222222";
  const court = "33333333-3333-4333-8333-333333333333";
  const activity: UpcomingActivity = { ...activityFixture([]),
    locations: [{ id: location, name: "Central" }],
    courts: [{ id: court, name: "Central court", location_id: location }] };
  render(<PersonalActivity staff userId="owner" initialActivity={activity} initialError=""
    listQuery={{ page: "3", type: "reservation" }} />);
  expect(screen.getByRole("option", { name: "Central" })).toHaveProperty("value", location);
  expect(screen.queryByRole("option", { name: "Central court" })).toBeNull();
  expect(screen.getByRole("combobox", { name: "Court" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: location } });
  const params = new URL(navigation.replace.mock.lastCall![0], "http://localhost").searchParams;
  expect(params.get("location")).toBe(location);
  expect(params.get("type")).toBe("reservation");
  expect(params.has("page")).toBe(false);
  expect(screen.getByText("No upcoming bookings or reservations match your filters.")).toBeDefined();
  cleanup();
  render(<PersonalActivity staff userId="owner" initialActivity={activity} initialError=""
    listQuery={{ type: "reservation", location }} />);
  expect(screen.getByRole("option", { name: "Central court" })).toHaveProperty("value", court);
});

it("uses hasNext across page transitions and retains filters in pagination links", () => {
  const location = "22222222-2222-4222-8222-222222222222";
  const first: UpcomingActivity = { ...activityFixture([bookingItem(cancellableBooking)]), hasNext: true };
  const query = { location, type: "booking", sort: "duration", direction: "desc" };
  const { rerender } = render(<PersonalActivity staff userId="owner" initialActivity={first} initialError="" listQuery={query} />);
  expect(screen.queryByRole("link", { name: "Previous" })).toBeNull();
  expect(screen.getByLabelText("Page 1").getAttribute("aria-current")).toBe("page");
  const next = screen.getByRole("link", { name: "Next" });
  expect(Object.fromEntries(new URL(next.getAttribute("href")!, "http://localhost").searchParams))
    .toMatchObject({ ...query, page: "2" });
  rerender(<PersonalActivity staff userId="owner" initialActivity={activityFixture([bookingItem(cancellableBooking)])}
    initialError="" listQuery={{ ...query, page: "2" }} />);
  expect(screen.queryByRole("link", { name: "Next" })).toBeNull();
  expect(new URL(screen.getByRole("link", { name: "Previous" }).getAttribute("href")!, "http://localhost").searchParams.get("page"))
    .toBe("1");
  rerender(<PersonalActivity staff userId="owner" initialActivity={activityFixture([])} initialError="" listQuery={{ ...query, page: "3" }} />);
  expect(screen.getByRole("link", { name: "Return to first page" })).toBeDefined();
  rerender(<PersonalActivity staff userId="owner" initialActivity={activityFixture([])} initialError="" listQuery={query} />);
  expect(screen.queryByRole("navigation", { name: "Activity pages" })).toBeNull();
});

it("preserves nullable reservation details", () => {
  const row: PersonalReservation = {
    id: "one", court_id: "court", location_id: "location", updated_at: "2026-10-01T12:00:00Z",
    booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
    location_name: "Club", location_timezone: "UTC", court_name: "Court",
    reason: null, status: "active", created_by_user_id: "owner", creator_name: null,
    cancelled_at: null, cancelled_by_name: null,
  };
  render(<PersonalActivity staff userId="owner" initialActivity={activityFixture([reservationItem(row)])} initialError="" />);
  fireEvent.click(screen.getByRole("row", { name: /Details for/ }));
  const dialog = screen.getByRole("dialog", { name: "Reservation details" });
  expect(within(dialog).getByText("Not recorded")).toBeDefined();
  expect(within(dialog).getByText("You")).toBeDefined();
  expect(within(dialog).getByRole("button", { name: "Cancel reservation" })).toBeDefined();
});

it.each([
  [undefined, "Booking cancelled."],
  ["succeeded", "Booking cancelled. Your payment has been refunded."],
  ["pending_retry", "Booking cancelled. Your refund has been requested."],
  ["failed", "Booking cancelled. Part of the refund could not be completed; the club will contact you."],
])("customer cancellation shows refund state %s and refreshes Upcoming", async (refundStatus, message) => {
  const notification = vi.spyOn(toast, "success");
  load.mockResolvedValueOnce(activityFixture([bookingItem(cancellableBooking)]))
    .mockResolvedValueOnce(activityFixture([]));
  cancelBooking.mockResolvedValue({ ok: true, refundStatus });
  await renderWithServerActivity({ staff: false, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("row", { name: /Details for/ }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Booking" })).getByRole("button", { name: "Cancel booking" }));
  expect(cancelBooking).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog", { name: "Cancel booking?" })).getByRole("button", { name: "Keep booking" }));
  expect(cancelBooking).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog", { name: "Booking" })).getByRole("button", { name: "Cancel booking" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Cancel booking?" })).getByRole("button", { name: "Cancel booking" }));
  await waitFor(() => expect(cancelBooking).toHaveBeenCalledWith(cancellableBooking.id));
  expect(await screen.findByText("No upcoming bookings or reservations match your filters.")).toBeDefined();
  expect(lastToast("success")).toBe(message);
  expect(notification).toHaveBeenCalledExactlyOnceWith(message, expect.objectContaining({ id: expect.any(Number) }));
  notification.mockRestore();
  expect(cancel).not.toHaveBeenCalled();
});

it("reports a committed cancellation accurately when the details refresh rejects", async () => {
  cancelBooking.mockResolvedValue({ ok: true, refundStatus: "succeeded" });
  const onCancelled = vi.fn(async () => { throw new Error("Refresh failed"); });
  render(<CustomerBookingCancellation booking={cancellableBooking} staff={false} onCancelled={onCancelled} onPendingChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Cancel booking?" })).getByRole("button", { name: "Cancel booking" }));
  await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
    "Booking cancelled. Your payment has been refunded.",
    expect.objectContaining({ description: expect.stringContaining("refresh") }),
  ));
  expect(toast.error).not.toHaveBeenCalled();
  expect(onCancelled).toHaveBeenCalledOnce();
});

it.each([true])("applies snapshot notice only to ordinary owners (staff=%s)", async (staff) => {
  load.mockResolvedValue(activityFixture([bookingItem({ ...cancellableBooking,
    starts_at_instant: new Date(Date.now() + 60 * 60_000).toISOString() })]));
  await renderWithServerActivity({ staff, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("row", { name: /Details for/ }));
  const dialog = screen.getByRole("dialog", { name: "Booking" });
  if (staff) expect(within(dialog).getByRole("button", { name: "Cancel booking" })).toBeDefined();
  else {
    expect(within(dialog).queryByRole("button", { name: "Cancel booking" })).toBeNull();
    expect(within(dialog).getByText(/requires 24 hours' notice/)).toBeDefined();
    expect(within(dialog).queryByRole("button", { name: "Edit booking" })).toBeNull();
  }
});

it("toasts a stale cancellation error while keeping confirmation open and prevents duplicate requests", async () => {
  load.mockResolvedValue(activityFixture([bookingItem(cancellableBooking)]));
  let resolve!: (value: { ok: false; message: string }) => void;
  cancelBooking.mockImplementation(() => new Promise((done) => { resolve = done; }));
  await renderWithServerActivity({ staff: false, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("row", { name: /Details for/ }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Booking" })).getByRole("button", { name: "Cancel booking" }));
  const confirmation = screen.getByRole("dialog", { name: "Cancel booking?" });
  const button = within(confirmation).getByRole("button", { name: "Cancel booking" });
  fireEvent.click(button); fireEvent.click(button);
  expect(cancelBooking).toHaveBeenCalledOnce();
  resolve({ ok: false, message: "The cancellation notice period for this booking has expired." });
  await waitFor(() => expect(lastToast()).toContain("has expired"));
  expect(load).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog", { name: "Booking" })).toBeDefined();
});

it("shows each upcoming booking's actual status in the table and its details dialog", () => {
  const booking = (id: string, flags: Pick<PersonalCustomerBooking, "payment_pending" | "pending_change">): PersonalCustomerBooking => ({
    id, starts_at_instant: "2099-10-15T10:00:00Z", booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
    location_name: "Club", location_timezone: "UTC", court_name: `Court ${id}`, customer_name: "Customer", customer_email: "c@example.test",
    customer_phone: "123", cancellation_notice_minutes: 120, total_amount_minor: 5000, currency: "RON", ...flags,
  });
  const rows = [booking("a", {}), booking("b", { payment_pending: true }), booking("c", { pending_change: "reschedule" }),
    booking("d", { pending_change: "cancellation", payment_pending: true })];
  render(<PersonalActivity staff={false} initialActivity={activityFixture(rows.map(bookingItem))} initialError="" />);
  expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
  const statuses = screen.getAllByRole("row").slice(1).map(row => within(row).getAllByRole("cell").at(-1)?.textContent);
  expect(statuses).toEqual(["Confirmed", "Payment processing", "Modification pending", "Cancellation pending"]);
  fireEvent.click(screen.getByRole("row", { name: /Court b/ }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Payment processing")).toBeTruthy();
  expect(within(dialog).queryByText("Confirmed")).toBeNull();
});

it.each([false, true])("withholds coaching Edit while retaining cancellation (coaching=%s)", includes_coaching => {
  render(<CustomerBookingCancellation booking={{ ...cancellableBooking, includes_coaching }} staff={false}
    onCancelled={vi.fn()} onPendingChange={vi.fn()} onEdit={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Edit booking" }) !== null).toBe(!includes_coaching);
  expect(screen.getByRole("button", { name: "Cancel booking" })).toBeDefined();
});

it.each([true, false])("shows historical coaching names alongside court bookings (staff=%s)", (staff) => {
  render(<PersonalActivity staff={staff} initialActivity={activityFixture([
    bookingItem(cancellableBooking), bookingItem({ ...cancellableBooking, id: "lesson", includes_coaching: true,
      coach_name: "Daniel Stoica", coaching_program_name: "Private coaching" }),
  ])} initialError="" />);
  const table = screen.getByRole("table");
  expect(within(table).getByText("Coaching")).toBeDefined();
  expect(within(table).getByText("Daniel Stoica · Private coaching").closest("td")?.textContent)
    .toBe("CoachingDaniel Stoica · Private coaching");
  expect(within(table).getByText("Court", { selector: "td span" })).toBeDefined();
  expect(within(table).getAllByRole("columnheader")).toHaveLength(8);
});
