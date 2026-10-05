// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ReservationCalendar } from "@/app/reservations/reservation-calendar";
import { localMinute, localToday } from "@/lib/courts/local-time";

const { cancelAction, cancelBookingAction, editAction, adminAvailability, refresh } = vi.hoisted(() => ({ cancelAction: vi.fn(), cancelBookingAction: vi.fn(), editAction: vi.fn(), adminAvailability: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/reservations/actions", () => ({ reserveCourtAction: vi.fn(), cancelAdminReservationAction: cancelAction,
  cancelAdminCustomerBookingAction: cancelBookingAction, editAdminReservationAction: editAction, loadAdminBookingEditDayAction: vi.fn(), quoteAdminBookingAction: vi.fn(), rescheduleAdminBookingAction: vi.fn(), loadAdminReservationEditDayAction: adminAvailability }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
});
afterEach(() => { cleanup(); cancelAction.mockReset(); cancelBookingAction.mockReset(); editAction.mockReset(); adminAvailability.mockReset(); refresh.mockReset(); });

it("offers a reason and Reserve action after selection, without pricing", () => {
  render(<ReservationCalendar date="2099-10-15" location={{ id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC", courts: [] }}
    day={{ times: [600, 630, 660], courts: [{ court: { id: "22222222-2222-4222-8222-222222222222", name: "Court 1" },
      cells: ["available", "available", "closed"] }] }} />);
  expect(screen.queryByText(/Total|price|payment/i)).toBeNull();
  expect(screen.queryByRole("button", { name: "Reserve court" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2099-10-15 10:00–10:30/ }));
  expect(screen.getByRole("button", { name: "Reserve court" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "Court maintenance" } });
  expect(screen.getByRole("button", { name: "Reserve court" })).toHaveProperty("disabled", false);
  expect(screen.queryByText(/Total|price|payment/i)).toBeNull();
});

it("shows occupied intervals without management controls and prevents their selection", () => {
  render(<ReservationCalendar date="2099-10-15" location={{ id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC",
    courts: [{ id: "22222222-2222-4222-8222-222222222222", name: "Court 1" }] }}
    day={{ times: [600, 630], courts: [{ court: { id: "22222222-2222-4222-8222-222222222222", name: "Court 1" }, cells: ["booked", "booked"] }] }} />);
  expect(screen.getAllByLabelText(/, Booked/)).toHaveLength(2);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByText(/details|cancel reservation|reason|created by/i)).toBeNull();
});

it("opens the whole Admin reservation block while available cells still select", () => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC",
    courts: [{ id: courtId, name: "Court 1" }] };
  render(<ReservationCalendar date="2099-10-15" location={location}
    day={{ times: [600, 630, 660, 690, 720], courts: [{ court: location.courts[0],
      cells: ["booked", "booked", "booked", "available", "available"] }] }}
    adminOccupancy={[{ kind: "reservation", id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
      booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 690,
      reason: "Club event", created_by_user_id: "44444444-4444-4444-8444-444444444444", creator_name: "Mihai Stan" }]} />);
  expect(screen.getByRole("button", { name: /Reservation · Mihai Stan/ })).toBeTruthy();
  for (let attempt = 0; attempt < 2; attempt++) {
    fireEvent.click(screen.getByRole("button", { name: /Court 1 2099-10-15 10:00–11:30, Reservation · Mihai Stan/ }));
    expect(screen.getByRole("dialog").textContent).toContain("Mihai Stan");
    expect(screen.getByRole("dialog").textContent).toContain("Club event");
    expect(screen.getByRole("dialog").textContent).toContain("90 min");
    expect(screen.getByRole("button", { name: "Cancel reservation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit reservation" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
  }
  expect(screen.queryByLabelText("Selected reservation")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2099-10-15 11:30–12:00, Available/ }));
  expect(screen.getByLabelText("Selected reservation")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2099-10-15 10:00–11:30, Reservation/ }));
  expect(screen.getByLabelText("Selected reservation")).toBeTruthy();
});

it("opens the Admin booking block using stored snapshots", () => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC",
    courts: [{ id: courtId, name: "Court 1" }] };
  const booking = { kind: "booking" as const, id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
    booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 690,
    customer_name: "Ana Pop", customer_email: "ana@example.test", customer_phone: "+40 123",
    cancellation_notice_minutes: 120, total_amount_minor: 7500, currency: "RON" as const };
  render(<ReservationCalendar date={booking.booking_date} location={location}
    day={{ times: [600, 630, 660], courts: [{ court: location.courts[0], cells: ["booked", "booked", "booked"] }] }}
    adminOccupancy={[booking]} />);
  expect(screen.getByRole("button", { name: /Booking · Ana Pop/ })).toBeTruthy();
  for (let attempt = 0; attempt < 2; attempt++) {
    fireEvent.click(screen.getByRole("button", { name: /Court 1 2099-10-15 10:00–11:30, Booking · Ana Pop/ }));
    const dialog = screen.getByRole("dialog", { name: "Booking details" });
    for (const value of ["Ana Pop", "ana@example.test", "+40 123", "Club", "Court 1", "15 Oct 2099",
      "10:00–11:30 (UTC)", "90 min", "RON", "Confirmed"]) expect(dialog.textContent).toContain(value);
    expect(dialog.textContent).toContain("75.00");
    expect(within(dialog).getByRole("button", { name: "Cancel booking" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Edit booking" })).toBeDefined();
    expect(within(dialog).queryByRole("button", { name: /refund|notify|payment/i })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  }
});

it("confirms booking cancellation and refreshes the timetable in place", async () => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "RIVUS", timezone: "UTC",
    courts: [{ id: courtId, name: "Court 2" }] };
  const booking = { kind: "booking" as const, id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
    booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
    customer_name: "Ana Pop", customer_email: "ana@example.test", customer_phone: "+40 123",
    cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON" as const };
  cancelBookingAction.mockResolvedValue({ ok: true });
  const { rerender } = render(<ReservationCalendar date={booking.booking_date} location={location}
    day={{ times: [600, 630], courts: [{ court: location.courts[0], cells: ["booked", "booked"] }] }}
    adminOccupancy={[booking]} />);
  fireEvent.click(screen.getByRole("button", { name: /10:00–11:00, Booking · Ana Pop/ }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
  const confirmation = screen.getByRole("dialog", { name: "Cancel booking?" });
  for (const value of ["Ana Pop", "RIVUS · Court 2", "15 Oct 2099 · 10:00–11:00", "RON", "90.00",
    "This will cancel the booking and free the court."]) expect(confirmation.textContent).toContain(value);
  expect(within(confirmation).getByRole("button", { name: "Keep booking" })).toBeTruthy();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel booking" }));
  await waitFor(() => expect(cancelBookingAction).toHaveBeenCalledWith(booking.id));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(cancelAction).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("Booking cancelled.");
  rerender(<ReservationCalendar date={booking.booking_date} location={location}
    day={{ times: [600, 630], courts: [{ court: location.courts[0], cells: ["available", "available"] }] }}
    adminOccupancy={[]} />);
  fireEvent.click(screen.getByRole("button", { name: /10:00–10:30, Available/ }));
  expect(screen.getByLabelText("Selected reservation")).toBeTruthy();
});

it("reuses the edit timetable for another user's reservation with fixed location and current values", async () => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  const otherCourtId = "55555555-5555-4555-8555-555555555555";
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "RIVUS", timezone: "UTC",
    courts: [{ id: courtId, name: "Court 1" }, { id: otherCourtId, name: "Court 2" }] };
  const reservation = { id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
    booking_date: "2099-10-15", starts_at_minute: 750, ends_at_minute: 840,
    reason: "Coach training", created_by_user_id: "44444444-4444-4444-8444-444444444444", creator_name: "Mihai Stan" };
  adminAvailability.mockImplementation(async (_id, date) => ({ date, location,
    reservation: { ...reservation, updated_at: "2099-10-01T00:00:00Z" },
    day: { times: [750, 780, 810, 840, 870], courts: [
      { court: location.courts[0], cells: ["available", "available", "available", "booked", "available"] },
      { court: location.courts[1], cells: ["available", "available", "available", "available", "available"] },
    ] } }));
  render(<ReservationCalendar date={reservation.booking_date} location={location}
    day={{ times: [750, 780, 810], courts: [{ court: location.courts[0], cells: ["booked", "booked", "booked"] }] }}
    adminOccupancy={[{ ...reservation, kind: "reservation" }]} />);
  fireEvent.click(screen.getByRole("button", { name: /12:30–14:00, Reservation/ }));
  fireEvent.click(screen.getByRole("button", { name: "Edit reservation" }));
  const editDialog = screen.getByRole("dialog", { name: "Edit reservation" });
  await waitFor(() => expect(adminAvailability).toHaveBeenCalledWith(reservation.id, reservation.booking_date));
  expect(within(editDialog).getByText("RIVUS")).toBeTruthy();
  expect(within(editDialog).queryByRole("combobox")).toBeNull();
  expect(within(editDialog).queryByLabelText("Location")).toBeNull();
  expect(within(editDialog).queryByLabelText("Court")).toBeNull();
  expect(within(editDialog).queryByLabelText("From")).toBeNull();
  expect(within(editDialog).queryByLabelText("To")).toBeNull();
  expect(within(editDialog).getByRole("textbox", { name: "Reason" })).toHaveProperty("value", "Coach training");
  expect(within(editDialog).getByLabelText("Date")).toHaveProperty("value", reservation.booking_date);
  await within(editDialog).findByText("Current reservation");
  expect(within(editDialog).getAllByRole("button", { name: /Court 1.*selected/ })).toHaveLength(3);
  expect(within(within(editDialog).getAllByRole("row")[1]).getAllByLabelText(/, Booked/)).toHaveLength(1);
  expect(within(editDialog).getByRole("rowheader", { name: "Court 2" })).toBeTruthy();
  expect(within(editDialog).getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", false);
  fireEvent.change(within(editDialog).getByLabelText("Date"), { target: { value: "2099-10-16" } });
  await waitFor(() => expect(adminAvailability).toHaveBeenLastCalledWith(reservation.id, "2099-10-16"));
  expect(within(editDialog).queryByText("Current reservation")).toBeNull();
  fireEvent.click(within(editDialog).getByRole("button", { name: /Court 2 2099-10-16 12:30–13:00, Available/ }));
  expect(within(editDialog).getByText("Court 2 · 12:30–13:30 · 60 min")).toBeTruthy();
  expect(within(editDialog).getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", false);
});

it("keeps an in-progress Admin edit to reason only", async () => {
  const zone = ["UTC", "America/Los_Angeles", "Pacific/Honolulu", "Asia/Tokyo", "Europe/Bucharest"]
    .find((value) => localMinute(value, new Date()) >= 120 && localMinute(value, new Date()) <= 1320)!;
  const now = new Date();
  const start = Math.floor(localMinute(zone, now) / 30) * 30 - 30;
  const date = localToday(zone, now);
  const courtId = "22222222-2222-4222-8222-222222222222";
  render(<ReservationCalendar date={date} location={{ id: "11111111-1111-4111-8111-111111111111", name: "RIVUS",
    timezone: zone, courts: [{ id: courtId, name: "Court 1" }] }}
    day={{ times: [start, start + 30], courts: [{ court: { id: courtId, name: "Court 1" }, cells: ["booked", "booked"] }] }}
    adminOccupancy={[{ kind: "reservation", id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
      booking_date: date, starts_at_minute: start, ends_at_minute: start + 90,
      reason: "Training", created_by_user_id: null, creator_name: null }]} />);
  fireEvent.click(screen.getAllByRole("button", { name: /Reservation · Unknown creator/ })[0]);
  adminAvailability.mockResolvedValue({ reservation: { updated_at: "2099-10-01T00:00:00Z" } });
  fireEvent.click(screen.getByRole("button", { name: "Edit reservation" }));
  const editDialog = screen.getByRole("dialog", { name: "Edit reservation" });
  await within(editDialog).findByText(/This reservation is in progress/);
  expect(within(editDialog).queryByLabelText("Date")).toBeNull();
  expect(within(editDialog).queryByRole("region", { name: /timetable/ })).toBeNull();
  expect(within(editDialog).getByRole("textbox", { name: "Reason" })).toHaveProperty("value", "Training");
  expect(within(editDialog).getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", false);
  expect(adminAvailability).toHaveBeenCalledOnce();
});

it("saves an Admin edit, refreshes the timetable, and shows the updated details in the same context", async () => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  const reservation = { id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
    booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
    reason: "Training", created_by_user_id: "44444444-4444-4444-8444-444444444444", creator_name: "Coach" };
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "RIVUS", timezone: "UTC",
    courts: [{ id: courtId, name: "Court 1" }] };
  adminAvailability.mockResolvedValue({ reservation: { ...reservation, updated_at: "2099-10-01T00:00:00Z" },
    day: { times: [600, 630], courts: [{ court: location.courts[0], cells: ["available", "available"] }] } });
  editAction.mockResolvedValue({ ok: true, reservation: { court_id: courtId, booking_date: "2099-10-15",
    starts_at_minute: 600, ends_at_minute: 660, reason: "Updated training" } });
  render(<ReservationCalendar date="2099-10-15" location={location}
    day={{ times: [600, 630], courts: [{ court: location.courts[0], cells: ["booked", "booked"] }] }}
    adminOccupancy={[{ ...reservation, kind: "reservation" }]} />);
  fireEvent.click(screen.getByRole("button", { name: /10:00–11:00, Reservation/ }));
  fireEvent.click(screen.getByRole("button", { name: "Edit reservation" }));
  const dialog = screen.getByRole("dialog", { name: "Edit reservation" });
  await within(dialog).findByText("Current reservation");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Reason" }), { target: { value: "Updated training" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(editAction).toHaveBeenCalledWith({ kind: "reason", id: reservation.id,
    expectedUpdatedAt: "2099-10-01T00:00:00Z", reason: "Updated training" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(screen.getByRole("dialog", { name: "Reservation details" }).textContent).toContain("Updated training");
  expect(screen.getByRole("status").textContent).toContain("Reservation updated.");
  editAction.mockResolvedValueOnce({ ok: false,
    message: "That court is no longer available for the selected time. The existing reservation has not been changed." });
  fireEvent.click(screen.getByRole("button", { name: "Edit reservation" }));
  const reopened = screen.getByRole("dialog", { name: "Edit reservation" });
  await within(reopened).findByText("Current reservation");
  fireEvent.change(within(reopened).getByRole("textbox", { name: "Reason" }), { target: { value: "Keep entered reason" } });
  fireEvent.click(within(reopened).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(within(reopened).getByRole("alert").textContent).toContain("has not been changed"));
  expect(within(reopened).getByRole("textbox", { name: "Reason" })).toHaveProperty("value", "Keep entered reason");
  expect(screen.getByRole("dialog", { name: "Edit reservation" })).toBeTruthy();
});

it("confirms Admin cancellation, refreshes in place, and leaves the interval selectable", async () => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC",
    courts: [{ id: courtId, name: "Court 1" }] };
  const occupied = { id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
    booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
    reason: "Club event", created_by_user_id: "44444444-4444-4444-8444-444444444444", creator_name: "Mihai Stan" };
  cancelAction.mockResolvedValue({ ok: true });
  const { rerender } = render(<ReservationCalendar date="2099-10-15" location={location}
    day={{ times: [600, 630], courts: [{ court: location.courts[0], cells: ["booked", "booked"] }] }}
    adminOccupancy={[{ ...occupied, kind: "reservation" }]} />);
  fireEvent.click(screen.getByRole("button", { name: /10:00–11:00, Reservation/ }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  const confirmation = screen.getByRole("dialog", { name: "Cancel reservation?" });
  expect(confirmation.textContent).toContain("Club · Court 1");
  expect(confirmation.textContent).toContain("Mihai Stan");
  expect(confirmation.textContent).toContain("This will free the court");
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel reservation" }));
  await waitFor(() => expect(cancelAction).toHaveBeenCalledWith(occupied.id));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("Reservation cancelled.");
  rerender(<ReservationCalendar date="2099-10-15" location={location}
    day={{ times: [600, 630], courts: [{ court: location.courts[0], cells: ["available", "available"] }] }}
    adminOccupancy={[]} />);
  fireEvent.click(screen.getByRole("button", { name: /10:00–10:30, Available/ }));
  expect(screen.getByLabelText("Selected reservation")).toBeTruthy();
});

it("keeps the confirmation open with a clear error on stale cancellation", async () => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  cancelAction.mockResolvedValue({ ok: false, message: "This reservation is no longer available to cancel." });
  render(<ReservationCalendar date="2099-10-15" location={{ id: "11111111-1111-4111-8111-111111111111",
    name: "Club", timezone: "UTC", courts: [{ id: courtId, name: "Court 1" }] }}
    day={{ times: [600], courts: [{ court: { id: courtId, name: "Court 1" }, cells: ["booked"] }] }}
    adminOccupancy={[{ kind: "reservation", id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
      booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
      reason: "Maintenance", created_by_user_id: null, creator_name: null }]} />);
  fireEvent.click(screen.getByRole("button", { name: /Reservation · Unknown creator/ }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Cancel reservation?" }))
    .getByRole("button", { name: "Cancel reservation" }));
  await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Cancel reservation?" }))
    .getByRole("alert").textContent).toContain("no longer available"));
  expect(refresh).not.toHaveBeenCalled();
});

it("renders a legacy null creator safely", () => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  render(<ReservationCalendar date="2099-10-15" location={{ id: "11111111-1111-4111-8111-111111111111",
    name: "Club", timezone: "UTC", courts: [{ id: courtId, name: "Court 1" }] }}
    day={{ times: [600], courts: [{ court: { id: courtId, name: "Court 1" }, cells: ["booked"] }] }}
    adminOccupancy={[{ kind: "reservation", id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
      booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
      reason: "Maintenance", created_by_user_id: null, creator_name: null }]} />);
  fireEvent.click(screen.getByRole("button", { name: /Reservation · Unknown creator/ }));
  expect(screen.getByRole("dialog").textContent).toContain("Unknown creator");
});

it.each(["booking", "reservation"] as const)("keeps a past %s read-only in the Admin dialog", (kind) => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  const item = { kind, id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
    booking_date: "2000-10-15", starts_at_minute: 600, ends_at_minute: 660,
    reason: "Historical event", created_by_user_id: null, creator_name: "Coach",
    customer_name: "Ana Pop", customer_email: "ana@example.test", customer_phone: "+40 123",
    cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON" as const };
  render(<ReservationCalendar date={item.booking_date} location={{ id: "11111111-1111-4111-8111-111111111111",
    name: "Club", timezone: "Europe/Bucharest", courts: [{ id: courtId, name: "Court 1" }] }}
    day={{ times: [600, 630], courts: [{ court: { id: courtId, name: "Court 1" }, cells: ["past", "past"] }] }}
    adminOccupancy={[item]} />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1.*10:00–11:00/ }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).queryByRole("button", { name: /^Cancel (booking|reservation)$/ })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: /^Edit (booking|reservation)$/ })).toBeNull();
  expect(cancelAction).not.toHaveBeenCalled();
  expect(cancelBookingAction).not.toHaveBeenCalled();
});

it("opens past occupancy for a Coach without private details or operational actions", () => {
  const court = { id: "22222222-2222-4222-8222-222222222222", name: "Court 1" };
  render(<ReservationCalendar date="2000-10-15"
    location={{ id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "Europe/Bucharest", courts: [court] }}
    day={{ times: [600, 630, 660, 690], courts: [{ court, cells: ["booked", "booked", "past", "past"] }] }}
    occupancy={[{ court_id: court.id, starts_at_minute: 600, ends_at_minute: 660 }]} />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1.*10:00–11:00, Booked/ }));
  const dialog = screen.getByRole("dialog", { name: "Occupied court details" });
  expect(within(dialog).getByText("Court 1")).toBeTruthy();
  expect(within(dialog).getByText("10:00–11:00 (Europe/Bucharest)")).toBeTruthy();
  expect(within(dialog).queryByText(/customer|reason|created by|price|total/i)).toBeNull();
  expect(within(dialog).getAllByRole("button").every((button) => button.textContent === "Close" || button.getAttribute("aria-label") === "Close dialog")).toBe(true);
  expect(screen.queryByRole("button", { name: /Available|Reserve court|Edit |Cancel / })).toBeNull();
});
