// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PersonalActivity } from "@/app/my-activity/bookings/personal-activity";
import { localMinute, localToday } from "@/lib/courts/local-time";
import type { PersonalCustomerBooking } from "@/lib/bookings/personal";
import type { PersonalReservation } from "@/lib/reservations/personal";

const { load, cancel, cancelBooking, edit, availability } = vi.hoisted(() => ({ load: vi.fn(), cancel: vi.fn(), cancelBooking: vi.fn(), edit: vi.fn(), availability: vi.fn() }));
vi.mock("@/app/my-activity/bookings/actions", () => ({ loadPersonalActivityAction: load, cancelOwnReservationAction: cancel, cancelOwnCustomerBookingAction: cancelBooking,
  editOwnReservationAction: edit, loadReservationEditDayAction: availability }));

async function renderWithServerActivity(props: Omit<ComponentProps<typeof PersonalActivity>, "initialActivity" | "initialError">) {
  return render(<PersonalActivity {...props} initialActivity={await load()} initialError="" />);
}

beforeEach(() => {
  load.mockReset();
  cancel.mockReset();
  cancelBooking.mockReset();
  edit.mockReset();
  availability.mockReset();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
});
afterEach(cleanup);

it("gives ordinary players an empty state from the server activity snapshot", async () => {
  load.mockResolvedValue({ bookings: [], upcoming: [] });
  await renderWithServerActivity({ staff: false });
  expect(await screen.findByText("No upcoming bookings or reservations.")).toBeDefined();
  expect(load).toHaveBeenCalledOnce();
});

it.each([false, true])("renders every owned row and opens each detail dialog (staff=%s)", async (staff) => {
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
  load.mockResolvedValue({ bookings, upcoming });
  await renderWithServerActivity({ staff, userId: "owner" });
  const region = await screen.findByRole("region", { name: "Upcoming" });
  const buttons = within(region).getAllByRole("button");
  const ordered = staff ? [bookings[2], upcoming[1], bookings[1], bookings[0], upcoming[0]]
    : [bookings[2], bookings[1], bookings[0]];
  expect(buttons).toHaveLength(staff ? 5 : 3);
  expect(within(region).getAllByRole("listitem")).toHaveLength(ordered.length);
  for (const [index, row] of ordered.entries()) {
    expect(buttons[index].textContent).toContain(row.court_name);
    expect(buttons[index].textContent).toContain("60 min");
    fireEvent.click(buttons[index]);
    const isBooking = "customer_name" in row;
    const dialog = screen.getByRole("dialog", { name: isBooking ? "Booking" : "Reservation details" });
    expect(within(dialog).getByText(row.court_name)).toBeDefined();
    if (isBooking) {
      expect(buttons[index].textContent).toMatch(/RON\s*50\.00/);
      expect(within(dialog).getByText(row.customer_email)).toBeDefined();
      expect(within(dialog).getByRole("button", { name: "Cancel booking" })).toBeDefined();
      expect(within(dialog).queryByRole("button", { name: /edit/i })).toBeNull();
    } else {
      expect(buttons[index].textContent).toContain(row.reason);
      expect(within(dialog).getByText(row.reason!)).toBeDefined();
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  }
  expect(load).toHaveBeenCalledOnce();
});

it("places an in-progress booking before future bookings", async () => {
  const now = new Date();
  const zone = ["UTC", "Pacific/Honolulu", "Asia/Tokyo"]
    .find((item) => localMinute(item, now) >= 120 && localMinute(item, now) <= 1320)!;
  const start = Math.floor(localMinute(zone, now) / 30) * 30 - 30;
  const current: PersonalCustomerBooking = { id: "current", starts_at_instant: new Date(now.getTime() - 30 * 60_000).toISOString(), booking_date: localToday(zone, now),
    starts_at_minute: start, ends_at_minute: start + 90, location_name: "Club", location_timezone: zone,
    court_name: "Current court", customer_name: "Owner", customer_email: "owner@example.test",
    customer_phone: "123", cancellation_notice_minutes: 120, total_amount_minor: 5000, currency: "RON" };
  load.mockResolvedValue({ bookings: [{ ...current, id: "future", starts_at_instant: "2099-10-15T10:00:00Z", booking_date: "2099-10-15", court_name: "Future court" }, current], upcoming: [] });
  await renderWithServerActivity({ staff: false });
  const rows = within(await screen.findByRole("region", { name: "Upcoming" })).getAllByRole("button");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Current court");
  expect(rows[1].textContent).toContain("Future court");
});

it("shows an owner's booking snapshot in details and sorts it with direct reservations", async () => {
  const booking = { id: "booking", starts_at_instant: "2099-10-15T10:00:00+03:00", booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 690,
    location_name: "RIVUS", location_timezone: "Europe/Bucharest", court_name: "Court 2",
    customer_name: "Historical Name", customer_email: "old@example.test", customer_phone: "+40 123",
    cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON" };
  const reservation = { id: "reservation", court_id: "court", location_id: "location", updated_at: "2026-10-01T12:00:00Z",
    booking_date: "2099-10-15", starts_at_minute: 540, ends_at_minute: 660, reason: "Training", status: "active",
    created_by_user_id: "owner", creator_name: "Owner", cancelled_at: null, cancelled_by_name: null,
    location_name: "RIVUS", location_timezone: "UTC", court_name: "Court 1" };
  load.mockResolvedValue({ bookings: [booking], upcoming: [reservation] });
  await renderWithServerActivity({ staff: true, userId: "owner" });
  const upcoming = await screen.findByRole("region", { name: "Upcoming" });
  const buttons = within(upcoming).getAllByRole("button");
  expect(buttons).toHaveLength(2);
  expect(buttons[0].textContent).toContain("Booking");
  expect(buttons[1].textContent).toContain("Reservation");
  expect(buttons[0].textContent).toContain("RON");
  expect(buttons[0].textContent).not.toContain("old@example.test");
  fireEvent.click(buttons[0]);
  const dialog = screen.getByRole("dialog", { name: "Booking" });
  expect(within(dialog).getByText("Historical Name")).toBeDefined();
  expect(within(dialog).getByText("old@example.test")).toBeDefined();
  expect(within(dialog).getByText("+40 123")).toBeDefined();
  expect(within(dialog).getByText(/RON\s*90\.00/)).toBeDefined();
  expect(within(dialog).getByText("Confirmed")).toBeDefined();
  expect(within(dialog).getByRole("button", { name: "Cancel booking" })).toBeDefined();
  expect(within(dialog).queryByRole("button", { name: /edit|pay/i })).toBeNull();
});

it("shows a normal player's own booking without a direct reservation", async () => {
  load.mockResolvedValue({ bookings: [{ id: "booking", starts_at_instant: "2099-10-15T10:00:00+03:00", booking_date: "2099-10-15", starts_at_minute: 600,
    ends_at_minute: 660, location_name: "RIVUS", location_timezone: "UTC", court_name: "Court 2",
    customer_name: "Owner", customer_email: "owner@example.test", customer_phone: "123",
    cancellation_notice_minutes: 120, total_amount_minor: 5000, currency: "RON" }], upcoming: [] });
  await renderWithServerActivity({ staff: false });
  const upcoming = await screen.findByRole("region", { name: "Upcoming" });
  expect(within(upcoming).getByText("Booking")).toBeDefined();
  expect(within(upcoming).queryByText("Reservation")).toBeNull();
});

it("loads on the bookings page and offers cancellation only for the owner's Upcoming reservation", async () => {
  const active = { id: "one", court_id: "court", location_id: "location", updated_at: "2026-10-01T12:00:00Z", booking_date: "2026-10-12", starts_at_minute: 840, ends_at_minute: 960,
    reason: "Course with Andrej", status: "active", created_by_user_id: "owner", creator_name: "Andrej",
    cancelled_at: null, cancelled_by_name: null, location_name: "RIVUS", location_timezone: "Europe/Bucharest", court_name: "Court 2" };
  const cancelled = { ...active, id: "two", booking_date: "2026-10-08", status: "cancelled", reason: null,
    cancelled_at: "2026-10-08T12:00:00Z", cancelled_by_name: null };
  const elapsed = { ...active, id: "three", booking_date: "2026-10-01" };
  load.mockResolvedValue({ bookings: [], upcoming: [active], history: [cancelled, elapsed] });
  await renderWithServerActivity({ staff: true, userId: "owner" });
  const upcoming = await screen.findByRole("region", { name: "Upcoming" });
  expect(within(upcoming).getByText("Course with Andrej")).toBeDefined();
  expect(screen.queryByText("Cancelled")).toBeNull();
  expect(screen.queryByText("Past")).toBeNull();
  fireEvent.click(within(upcoming).getByRole("button"));
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

it("confirms cancellation, refreshes Upcoming, and keeps the activity section mounted", async () => {
  const active = { id: "one", court_id: "court", location_id: "location", updated_at: "2026-10-01T12:00:00Z", booking_date: "2026-10-12", starts_at_minute: 840, ends_at_minute: 960,
    reason: "Practice", status: "active", created_by_user_id: "owner", creator_name: "Alex",
    cancelled_at: null, cancelled_by_name: null, location_name: "RIVUS", location_timezone: "Europe/Bucharest", court_name: "Court 2" };
  load.mockResolvedValueOnce({ bookings: [], upcoming: [active], history: [] }).mockResolvedValueOnce({ bookings: [], upcoming: [], history: [{ ...active,
    status: "cancelled", cancelled_at: "2026-10-02T12:00:00Z", cancelled_by_name: "Alex" }] });
  cancel.mockResolvedValue({ ok: true });
  await renderWithServerActivity({ staff: true, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("button"));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Reservation details" })).getByRole("button", { name: "Cancel reservation" }));
  const confirmation = screen.getByRole("dialog", { name: "Cancel reservation?" });
  expect(within(confirmation).getByText(/This will free the court/)).toBeDefined();
  expect(within(confirmation).getByRole("button", { name: "Keep reservation" })).toBeDefined();
  expect(cancel).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel reservation" }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith("one"));
  await waitFor(() => expect(screen.getByText("No upcoming bookings or reservations.")).toBeDefined());
  expect(within(screen.getByRole("region", { name: "Upcoming" })).queryByRole("button")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Reservation cancelled.");
});

it("does not offer cancellation when a reservation has a different creator", async () => {
  load.mockResolvedValue({ bookings: [], upcoming: [{ id: "one", court_id: "court", location_id: "location", updated_at: "2026-10-01T12:00:00Z", booking_date: "2026-10-12", starts_at_minute: 840, ends_at_minute: 960,
    reason: "Practice", status: "active", created_by_user_id: "another", creator_name: "Another",
    cancelled_at: null, cancelled_by_name: null, location_name: "RIVUS", location_timezone: "Europe/Bucharest", court_name: "Court 2" }], history: [] });
  await renderWithServerActivity({ staff: true, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("button"));
  expect(within(screen.getByRole("dialog", { name: "Reservation details" })).queryByRole("button", { name: "Cancel reservation" })).toBeNull();
  expect(within(screen.getByRole("dialog", { name: "Reservation details" })).queryByRole("button", { name: "Edit reservation" })).toBeNull();
});

it("edits a future reservation in the details dialog and shows refreshed details", async () => {
  const reservationId = "11111111-1111-4111-8111-111111111111";
  const locationId = "22222222-2222-4222-8222-222222222222";
  const courtA = "33333333-3333-4333-8333-333333333333";
  const courtB = "44444444-4444-4444-8444-444444444444";
  const active = { id: reservationId, court_id: courtA, location_id: locationId, updated_at: "2026-10-01T12:00:00Z",
    booking_date: "2099-10-15", starts_at_minute: 840, ends_at_minute: 960, reason: "Practice", status: "active",
    created_by_user_id: "owner", creator_name: "Alex", cancelled_at: null, cancelled_by_name: null,
    location_name: "RIVUS", location_timezone: "Europe/Bucharest", court_name: "Court 2" };
  load.mockResolvedValueOnce({ bookings: [], upcoming: [active], history: [] }).mockResolvedValueOnce({ bookings: [], upcoming: [{ ...active,
    court_id: courtB, court_name: "Court 3", reason: "Training", updated_at: "2026-10-01T12:01:00Z" }], history: [] });
  availability.mockResolvedValue({ date: active.booking_date, location: { id: locationId, name: "RIVUS", timezone: "Europe/Bucharest" },
    day: { times: [840, 870, 900, 930, 960, 990], courts: [
      { court: { id: courtA, name: "Court 2" }, cells: Array(6).fill("available") },
      { court: { id: courtB, name: "Court 3" }, cells: Array(6).fill("available") },
    ] } });
  edit.mockResolvedValue({ ok: true });
  await renderWithServerActivity({ staff: true, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("button"));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Reservation details" })).getByRole("button", { name: "Edit reservation" }));
  const dialog = screen.getByRole("dialog", { name: "Edit reservation" });
  expect(within(dialog).getByText("RIVUS")).toBeDefined();
  expect(within(dialog).queryByRole("combobox")).toBeNull();
  expect(within(dialog).queryByLabelText("Location")).toBeNull();
  expect(within(dialog).queryByLabelText("From")).toBeNull();
  expect(within(dialog).queryByLabelText("To")).toBeNull();
  await within(dialog).findByRole("region", { name: "Court 3 timetable" });
  expect(within(dialog).getByText("Current reservation")).toBeDefined();
  expect(within(dialog).getAllByRole("button", { name: /Court 2.*selected/ })).toHaveLength(4);
  fireEvent.click(within(dialog).getByRole("button", { name: /Court 3 2099-10-15 14:00–14:30/ }));
  fireEvent.click(within(dialog).getByRole("button", { name: /Court 3 2099-10-15 15:30–16:00/ }));
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), { target: { value: "   " } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  expect(edit).not.toHaveBeenCalled();
  expect(within(dialog).getByText("Enter a reason.")).toBeDefined();
  expect(within(dialog).getByText("Court 3 · 14:00–16:00 · 120 min")).toBeDefined();
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), { target: { value: "Training" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(edit).toHaveBeenCalledWith({ kind: "schedule", id: reservationId, expectedUpdatedAt: active.updated_at,
    schedule: { courtId: courtB, date: "2099-10-15", startMinute: 840, endMinute: 960, reason: "Training" } }));
  const updated = await screen.findByRole("dialog", { name: "Reservation details" });
  expect(within(updated).getByText("Court 3")).toBeDefined();
  expect(within(updated).getByText("Training")).toBeDefined();
  expect(screen.getByRole("status").textContent).toBe("Reservation updated.");
  expect(screen.getByRole("region", { name: "Upcoming" })).toBeDefined();
});

it("shows an in-progress reservation's schedule read-only and edits only its reason", async () => {
  const reservationId = "11111111-1111-4111-8111-111111111111";
  const now = new Date();
  const zone = ["UTC", "America/Los_Angeles", "Pacific/Honolulu", "Asia/Tokyo", "Europe/Bucharest"]
    .find((item) => localMinute(item, now) >= 120 && localMinute(item, now) <= 1320)!;
  const start = Math.floor(localMinute(zone, now) / 30) * 30 - 30;
  const active = { id: reservationId, court_id: "33333333-3333-4333-8333-333333333333",
    location_id: "22222222-2222-4222-8222-222222222222", updated_at: "2026-10-01T12:00:00Z",
    booking_date: localToday(zone, now), starts_at_minute: start, ends_at_minute: start + 90,
    reason: "Practice", status: "active", created_by_user_id: "owner", creator_name: "Alex",
    cancelled_at: null, cancelled_by_name: null, location_name: "RIVUS", location_timezone: zone, court_name: "Court 2" };
  load.mockResolvedValueOnce({ bookings: [], upcoming: [active], history: [] }).mockResolvedValueOnce({ bookings: [], upcoming: [{ ...active,
    reason: "Training", updated_at: "2026-10-01T12:01:00Z" }], history: [] });
  edit.mockResolvedValue({ ok: true });
  await renderWithServerActivity({ staff: true, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("button"));
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
  const active = { id: "11111111-1111-4111-8111-111111111111", court_id: "33333333-3333-4333-8333-333333333333",
    location_id: "22222222-2222-4222-8222-222222222222", updated_at: "2026-10-01T12:00:00Z",
    booking_date: "2099-10-15", starts_at_minute: 840, ends_at_minute: 960, reason: "Practice", status: "active",
    created_by_user_id: "owner", creator_name: "Alex", cancelled_at: null, cancelled_by_name: null,
    location_name: "RIVUS", location_timezone: "Europe/Bucharest", court_name: "Court 2" };
  load.mockResolvedValueOnce({ bookings: [], upcoming: [active], history: [] }).mockResolvedValueOnce({ bookings: [], upcoming: [{ ...active,
    reason: "Newer update", updated_at: "2026-10-01T12:01:00Z" }], history: [] });
  availability.mockResolvedValue({ date: active.booking_date,
    location: { id: active.location_id, name: "RIVUS", timezone: "Europe/Bucharest" },
    day: { times: [840, 870, 900, 930], courts: [{ court: { id: active.court_id, name: "Court 2" },
      cells: ["available", "available", "available", "available"] }] } });
  edit.mockResolvedValue({ ok: false, stale: true, message: "This reservation has changed since you opened it." });
  await renderWithServerActivity({ staff: true, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("button"));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Reservation details" })).getByRole("button", { name: "Edit reservation" }));
  const form = screen.getByRole("dialog", { name: "Edit reservation" });
  await within(form).findByText("Current reservation");
  fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(edit).toHaveBeenCalledWith({ kind: "reason", id: active.id,
    expectedUpdatedAt: active.updated_at, reason: "Practice" }));
  const details = await screen.findByRole("dialog", { name: "Reservation details" });
  expect(within(details).getByText("Newer update")).toBeDefined();
  expect(within(details).getByRole("alert").textContent).toContain("changed since you opened it");
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
    initialActivity={{ bookings: [], upcoming: [] }} initialError="" />);
  expect(screen.getByText("No upcoming bookings or reservations.")).toBeDefined();
  rerender(<PersonalActivity staff={false} userId="owner"
    initialActivity={{ bookings: [cancellableBooking], upcoming: [] }} initialError="" />);
  fireEvent.click(within(screen.getByRole("region", { name: "Upcoming" })).getByRole("button"));
  const dialog = screen.getByRole("dialog", { name: "Booking" });
  rerender(<PersonalActivity staff={false} userId="owner"
    initialActivity={{ bookings: [cancellableBooking, { ...cancellableBooking, id: "new", court_name: "New court" }], upcoming: [] }}
    initialError="" />);
  expect(within(screen.getByRole("region", { name: "Upcoming" })).getAllByRole("button")).toHaveLength(2);
  expect(screen.getByRole("dialog", { name: "Booking" })).toBe(dialog);
  expect(load).not.toHaveBeenCalled();
});

it("retains inline retry after an initial server read error", async () => {
  load.mockResolvedValue({ bookings: [], upcoming: [] });
  render(<PersonalActivity staff={false} initialActivity={null}
    initialError="Unable to load your court activity. Try again." />);
  expect(screen.getByRole("alert").textContent).toContain("Unable to load");
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No upcoming bookings or reservations.")).toBeDefined();
  expect(load).toHaveBeenCalledOnce();
});

it("confirms customer self-cancellation, preserves the page, and refreshes Upcoming", async () => {
  load.mockResolvedValueOnce({ bookings: [cancellableBooking], upcoming: [] })
    .mockResolvedValueOnce({ bookings: [], upcoming: [] });
  cancelBooking.mockResolvedValue({ ok: true });
  await renderWithServerActivity({ staff: false, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("button"));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Booking" })).getByRole("button", { name: "Cancel booking" }));
  expect(cancelBooking).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog", { name: "Cancel booking?" })).getByRole("button", { name: "Keep booking" }));
  expect(cancelBooking).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog", { name: "Booking" })).getByRole("button", { name: "Cancel booking" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Cancel booking?" })).getByRole("button", { name: "Cancel booking" }));
  await waitFor(() => expect(cancelBooking).toHaveBeenCalledWith(cancellableBooking.id));
  expect(await screen.findByText("No upcoming bookings or reservations.")).toBeDefined();
  expect(screen.getByRole("status").textContent).toBe("Booking cancelled.");
  expect(cancel).not.toHaveBeenCalled();
});

it.each([false, true])("keeps in-progress customer details readable without cancellation (staff=%s)", async (staff) => {
  load.mockResolvedValue({ bookings: [{ ...cancellableBooking,
    starts_at_instant: new Date(Date.now() - 60_000).toISOString() }], upcoming: [] });
  await renderWithServerActivity({ staff, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("button"));
  const dialog = screen.getByRole("dialog", { name: "Booking" });
  expect(within(dialog).queryByRole("button", { name: "Cancel booking" })).toBeNull();
  expect(within(dialog).getByText(/this booking has started/)).toBeDefined();
  expect(within(dialog).getByText("owner@example.test")).toBeDefined();
});

it.each([false, true])("applies snapshot notice only to ordinary owners (staff=%s)", async (staff) => {
  load.mockResolvedValue({ bookings: [{ ...cancellableBooking,
    starts_at_instant: new Date(Date.now() + 60 * 60_000).toISOString() }], upcoming: [] });
  await renderWithServerActivity({ staff, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("button"));
  const dialog = screen.getByRole("dialog", { name: "Booking" });
  if (staff) expect(within(dialog).getByRole("button", { name: "Cancel booking" })).toBeDefined();
  else {
    expect(within(dialog).queryByRole("button", { name: "Cancel booking" })).toBeNull();
    expect(within(dialog).getByText(/requires 24 hours' notice/)).toBeDefined();
  }
});

it("keeps a stale cancellation error beside the confirmation and prevents duplicate requests", async () => {
  load.mockResolvedValue({ bookings: [cancellableBooking], upcoming: [] });
  let resolve!: (value: { ok: false; message: string }) => void;
  cancelBooking.mockImplementation(() => new Promise((done) => { resolve = done; }));
  await renderWithServerActivity({ staff: false, userId: "owner" });
  fireEvent.click(within(await screen.findByRole("region", { name: "Upcoming" })).getByRole("button"));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Booking" })).getByRole("button", { name: "Cancel booking" }));
  const confirmation = screen.getByRole("dialog", { name: "Cancel booking?" });
  const button = within(confirmation).getByRole("button", { name: "Cancel booking" });
  fireEvent.click(button); fireEvent.click(button);
  expect(cancelBooking).toHaveBeenCalledOnce();
  resolve({ ok: false, message: "The cancellation notice period for this booking has expired." });
  await waitFor(() => expect(within(confirmation).getByRole("alert").textContent).toContain("has expired"));
  expect(load).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog", { name: "Booking" })).toBeDefined();
});
