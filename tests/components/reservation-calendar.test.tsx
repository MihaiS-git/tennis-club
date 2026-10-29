// @vitest-environment jsdom
import { expectToast, lastToast } from "../helpers/notifications";
import { installDialogMock } from "../helpers/dialog";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AdminOperationalOccupancy } from "@/lib/reservations/service";
import { ReservationCalendar } from "@/app/admin/reservations/reservation-calendar";
import { localMinute, localToday } from "@/lib/courts/local-time";

const { reserveAction, ownerEdit, ownerAvailability, ownerBookingLoad, ownerBookingQuote, ownerBookingSave, ownerBookingCancel, cancelAction, ownerCancelAction, cancelBookingAction, editAction, adminAvailability, refresh } = vi.hoisted(() => ({ reserveAction: vi.fn(), ownerEdit: vi.fn(), ownerAvailability: vi.fn(), ownerBookingLoad: vi.fn(), ownerBookingQuote: vi.fn(), ownerBookingSave: vi.fn(), ownerBookingCancel: vi.fn(), ownerCancelAction: vi.fn(), cancelAction: vi.fn(), cancelBookingAction: vi.fn(), editAction: vi.fn(), adminAvailability: vi.fn(), refresh: vi.fn() }));
vi.mock("@/app/my-activity/bookings/actions", () => ({ cancelOwnReservationAction: ownerCancelAction, editOwnReservationAction: ownerEdit,
  loadReservationEditDayAction: ownerAvailability, loadOwnBookingEditDayAction: ownerBookingLoad,
  quoteOwnBookingAction: ownerBookingQuote, rescheduleOwnBookingAction: ownerBookingSave, cancelOwnCustomerBookingAction: ownerBookingCancel }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/admin/reservations/actions", () => ({ reserveCourtAction: reserveAction, cancelAdminReservationAction: cancelAction,
  cancelAdminCustomerBookingAction: cancelBookingAction, editAdminReservationAction: editAction, loadAdminReservationEditDayAction: adminAvailability }));
beforeAll(() => {
  installDialogMock();
});
afterEach(() => { cleanup(); reserveAction.mockReset(); [ownerEdit, ownerAvailability, ownerBookingLoad, ownerBookingQuote, ownerBookingSave, ownerBookingCancel].forEach((mock) => mock.mockReset()); ownerCancelAction.mockReset(); cancelAction.mockReset(); cancelBookingAction.mockReset(); editAction.mockReset(); adminAvailability.mockReset(); refresh.mockReset(); });

it("offers a reason and Reserve action after selection, without pricing", () => {
  render(<ReservationCalendar canManage date="2099-10-15" location={{ id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC", courts: [] }}
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
  render(<ReservationCalendar canManage date="2099-10-15" location={{ id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC",
    courts: [{ id: "22222222-2222-4222-8222-222222222222", name: "Court 1" }] }}
    day={{ times: [600, 630], courts: [{ court: { id: "22222222-2222-4222-8222-222222222222", name: "Court 1" }, cells: ["booked", "booked"] }] }} />);
  expect(screen.getAllByLabelText(/, Booked/)).toHaveLength(2);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByText(/details|cancel reservation|reason|created by/i)).toBeNull();
});

it("confirms booking cancellation and refreshes the timetable in place", async () => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "RIVUS", timezone: "UTC",
    courts: [{ id: courtId, name: "Court 2" }] };
  const booking = { account_user_id: null, payment_status: null, stripe_refund_available: false, kind: "booking" as const, id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
    payment_method: "pay_at_club" as const,
    booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
    customer_name: "Ana Pop", customer_email: "ana@example.test", customer_phone: "+40 123",
    cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON" as const };
  cancelBookingAction.mockResolvedValue({ ok: true });
  const { rerender } = render(<ReservationCalendar canManage date={booking.booking_date} location={location}
    day={{ times: [600, 630], courts: [{ court: location.courts[0], cells: ["booked", "booked"] }] }}
    adminOccupancy={[booking]} />);
  fireEvent.click(screen.getByRole("button", { name: /10:00–11:00, Booking · Ana Pop/ }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
  const confirmation = screen.getByRole("dialog", { name: "Cancel booking?" });
  for (const value of ["Ana Pop", "RIVUS · Court 2", "15 Oct 2099 · 10:00–11:00", "RON", "90.00",
    "This will cancel the booking and free the court."]) expect(confirmation.textContent).toContain(value);
  expect(within(confirmation).getByRole("button", { name: "Keep booking" })).toBeTruthy();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel booking" }));
  await waitFor(() => expect(cancelBookingAction).toHaveBeenCalledWith({ id: booking.id }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(cancelAction).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(lastToast("success")).toContain("Booking cancelled.");
  rerender(<ReservationCalendar canManage date={booking.booking_date} location={location}
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
  const reservation = { creator_email: null, creator_phone: null, payment_method: null, id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
    booking_date: "2099-10-15", starts_at_minute: 750, ends_at_minute: 840,
    reason: "Coach training", created_by_user_id: "44444444-4444-4444-8444-444444444444", creator_name: "Mihai Stan" };
  adminAvailability.mockImplementation(async (_id, date) => ({ date, location,
    reservation: { ...reservation, updated_at: "2099-10-01T00:00:00Z" },
    day: { times: [750, 780, 810, 840, 870], courts: [
      { court: location.courts[0], cells: ["available", "available", "available", "booked", "available"] },
      { court: location.courts[1], cells: ["available", "available", "available", "available", "available"] },
    ] } }));
  render(<ReservationCalendar canManage date={reservation.booking_date} location={location}
    day={{ times: [750, 780, 810], courts: [{ court: location.courts[0], cells: ["booked", "booked", "booked"] }] }}
    adminOccupancy={[{ ...reservation, kind: "reservation" }]} />);
  fireEvent.click(screen.getByRole("button", { name: /12:30–14:00, Reservation/ }));
  expect(screen.getByText("Mihai Stan")).toBeTruthy();
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
  expect(within(editDialog).getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
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
  render(<ReservationCalendar canManage date={date} location={{ id: "11111111-1111-4111-8111-111111111111", name: "RIVUS",
    timezone: zone, courts: [{ id: courtId, name: "Court 1" }] }}
    day={{ times: [start, start + 30], courts: [{ court: { id: courtId, name: "Court 1" }, cells: ["booked", "booked"] }] }}
    adminOccupancy={[{ creator_email: null, creator_phone: null, payment_method: null, kind: "reservation", id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
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
  expect(within(editDialog).getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  fireEvent.change(within(editDialog).getByLabelText("Reason"), { target: { value: "Updated training" } });
  expect(within(editDialog).getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", false);
  fireEvent.change(within(editDialog).getByLabelText("Reason"), { target: { value: " Training " } });
  expect(within(editDialog).getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  expect(adminAvailability).toHaveBeenCalledOnce();
});

it("locks the Admin direct-reservation dialog during Save and preserves a failed draft for retry", async () => {
  const court = { id: "22222222-2222-4222-8222-222222222222", name: "Court 1" };
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC", courts: [court] };
  const reservation = { creator_email: null, creator_phone: null, payment_method: null, kind: "reservation" as const, id: "33333333-3333-4333-8333-333333333333", court_id: court.id,
    booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
    reason: "Practice", created_by_user_id: null, creator_name: null };
  adminAvailability.mockResolvedValue({ reservation: { ...reservation, updated_at: "2026-10-01T12:00:00Z" },
    day: { times: [600, 630, 660], courts: [{ court, cells: ["available", "available", "available"] }] } });
  let finish: (result: { ok: false; message: string }) => void = () => { throw new Error("Not saving"); };
  editAction.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce({ ok: true, reservation });
  render(<ReservationCalendar canManage date={reservation.booking_date} location={location}
    day={{ times: [600, 630], courts: [{ court, cells: ["booked", "booked"] }] }} adminOccupancy={[reservation]} />);
  fireEvent.click(screen.getByRole("button", { name: /Reservation · Unknown creator/ }));
  fireEvent.click(screen.getByRole("button", { name: "Edit reservation" }));
  const dialog = screen.getByRole("dialog", { name: "Edit reservation" });
  await within(dialog).findByText("Current reservation");
  expect(within(dialog).getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Training" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  expect(within(dialog).getByRole("button", { name: "Close dialog" })).toHaveProperty("disabled", true);
  expect(fireEvent(dialog, new Event("cancel", { cancelable: true }))).toBe(false);
  await act(async () => finish({ ok: false, message: "Try again." }));
  expect(within(dialog).getByLabelText("Reason")).toHaveProperty("value", "Training");
  expect(within(dialog).getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(editAction).toHaveBeenCalledTimes(2);
});

it("keeps the confirmation open with a clear error on stale cancellation", async () => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  cancelAction.mockResolvedValue({ ok: false, message: "This reservation is no longer available to cancel." });
  render(<ReservationCalendar canManage date="2099-10-15" location={{ id: "11111111-1111-4111-8111-111111111111",
    name: "Club", timezone: "UTC", courts: [{ id: courtId, name: "Court 1" }] }}
    day={{ times: [600], courts: [{ court: { id: courtId, name: "Court 1" }, cells: ["booked"] }] }}
    adminOccupancy={[{ creator_email: null, creator_phone: null, payment_method: null, kind: "reservation", id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
      booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
      reason: "Maintenance", created_by_user_id: null, creator_name: null }]} />);
  fireEvent.click(screen.getByRole("button", { name: /Reservation · Unknown creator/ }));
  expect(within(screen.getByRole("dialog", { name: "Reservation details" })).getByText("Unknown creator")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Cancel reservation?" }))
    .getByRole("button", { name: "Cancel reservation" }));
  await expectToast("no longer available");
  expect(screen.getByRole("dialog", { name: "Cancel reservation?" })).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled();
});

it.each(["reservation"] as const)("keeps a past %s read-only in the Admin dialog", (kind) => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  const item = { creator_email: null, creator_phone: null, payment_method: null, kind, id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
    booking_date: "2000-10-15", starts_at_minute: 600, ends_at_minute: 660,
    reason: "Historical event", created_by_user_id: null, creator_name: "Coach",
    customer_name: "Ana Pop", customer_email: "ana@example.test", customer_phone: "+40 123",
    cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON" as const };
  render(<ReservationCalendar canManage date={item.booking_date} location={{ id: "11111111-1111-4111-8111-111111111111",
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

it.each(["reservation", "booking"] as const)("opens shared %s details for a Coach after refresh without Admin actions", (kind) => {
  const court = { id: "22222222-2222-4222-8222-222222222222", name: "Court 1" };
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC", courts: [court] };
  const common = { id: "33333333-3333-4333-8333-333333333333", court_id: court.id,
    booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660 };
  const item: AdminOperationalOccupancy = kind === "reservation" ? { ...common, kind,
    reason: "Training", created_by_user_id: null, creator_name: "Coach", creator_email: "coach@example.test", creator_phone: "123",
    payment_method: null } : { ...common, kind,
    account_user_id: null, customer_name: "Ana Pop", customer_email: "ana@example.test", customer_phone: "+40 123",
    cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON",
    payment_method: "online", stripe_refund_available: true,
    payment_status: { operation: "payment", status: "succeeded", provider: "stripe" } };
  const view = <ReservationCalendar canManage={false} date={item.booking_date} location={location}
    day={{ times: [600, 630], courts: [{ court, cells: ["booked", "booked"] }] }} adminOccupancy={[item]} />;
  const { unmount } = render(view);
  function openAndCheck() {
    fireEvent.click(screen.getByRole("button", { name: /Court 1.*10:00–11:00/ }));
    const dialog = screen.getByRole("dialog", { name: kind === "booking" ? "Booking details" : "Reservation details" });
    for (const value of kind === "booking" ? ["Ana Pop", "ana@example.test", "+40 123", "Guest", "Online", "Payment succeeded (Stripe)", "RON"] : ["Coach", "Training", "coach@example.test", "123"])
      expect(dialog.textContent).toContain(value);
    expect(within(dialog).queryByText("Payment method") !== null).toBe(kind === "booking");
    expect(within(dialog).queryByRole("button", { name: /^(Edit|Cancel) / })).toBeNull();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
  }
  openAndCheck();
  unmount();
  render(view);
  openAndCheck();
  expect(cancelAction).not.toHaveBeenCalled();
  expect(cancelBookingAction).not.toHaveBeenCalled();
  expect(editAction).not.toHaveBeenCalled();
  expect(adminAvailability).not.toHaveBeenCalled();
});

it.each([false, true])("Admin cancellation reflects captured-funds refund availability=%s", async (refundable) => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "RIVUS", timezone: "UTC",
    courts: [{ id: courtId, name: "Court 2" }] };
  const booking = { account_user_id: null,
    payment_status: refundable ? { operation: "payment" as const, status: "succeeded" as const, provider: "stripe" as const } : null,
    kind: "booking" as const, stripe_refund_available: refundable, id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
    payment_method: "online" as const,
    booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
    customer_name: "Ana Pop", customer_email: "ana@example.test", customer_phone: "+40 123",
    cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON" as const };
  cancelBookingAction.mockResolvedValue({ ok: true });
  const { rerender } = render(<ReservationCalendar canManage date={booking.booking_date} location={location}
    day={{ times: [600, 630], courts: [{ court: location.courts[0], cells: ["booked", "booked"] }] }}
    adminOccupancy={[booking]} />);
  fireEvent.click(screen.getByRole("button", { name: /10:00–11:00, Booking · Ana Pop/ }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
  const confirmation = screen.getByRole("dialog", { name: "Cancel booking?" });
  for (const value of ["Ana Pop", "RIVUS · Court 2", "15 Oct 2099 · 10:00–11:00", "RON", "90.00",
    "This will cancel the booking and free the court."]) expect(confirmation.textContent).toContain(value);
  expect(within(confirmation).getByRole("button", { name: "Keep booking" })).toBeTruthy();
  expect(within(confirmation).queryByRole("checkbox")).toBeNull();
  expect(confirmation.textContent?.includes("refunded automatically")).toBe(refundable);
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel booking" }));
  await waitFor(() => expect(cancelBookingAction).toHaveBeenCalledWith({ id: booking.id }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(cancelAction).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(lastToast("success")).toContain("Booking cancelled.");
  rerender(<ReservationCalendar canManage date={booking.booking_date} location={location}
    day={{ times: [600, 630], courts: [{ court: location.courts[0], cells: ["available", "available"] }] }}
    adminOccupancy={[]} />);
  fireEvent.click(screen.getByRole("button", { name: /10:00–10:30, Available/ }));
  expect(screen.getByLabelText("Selected reservation")).toBeTruthy();
});

const coachId = "44444444-4444-4444-8444-444444444444";
const coachCourt = { id: "22222222-2222-4222-8222-222222222222", name: "Court 1" };
const coachLocation = { id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC", courts: [coachCourt] };
const coachReservation = { creator_email: null, creator_phone: null, payment_method: null, kind: "reservation" as const, id: "33333333-3333-4333-8333-333333333333", court_id: coachCourt.id,
  booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
  reason: "Practice", created_by_user_id: coachId, creator_name: "Coach" };
const coachDay = { times: [600, 630] };

it.each([null, coachId])("uses explicit account identity for booking customer type: %s", accountUserId => {
  const booking: AdminOperationalOccupancy = { kind: "booking", id: "booking", court_id: coachCourt.id,
    booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
    account_user_id: accountUserId, payment_method: "pay_at_club", stripe_refund_available: false,
    payment_status: { operation: "payment", status: "due", provider: null },
    customer_name: "Customer", customer_email: "customer@example.test", customer_phone: "123",
    cancellation_notice_minutes: 120, total_amount_minor: 5000, currency: "RON" };
  render(<ReservationCalendar actorUserId={coachId} date={booking.booking_date} location={coachLocation}
    day={{ ...coachDay, courts: [{ court: coachCourt, cells: ["booked", "booked"] }] }} adminOccupancy={[booking]} />);
  fireEvent.click(screen.getByRole("button", { name: /Booking · Customer/ }));
  const dialog = screen.getByRole("dialog", { name: "Booking details" });
  expect(within(dialog).getByText(accountUserId === null ? "Guest" : "Authenticated customer")).toBeTruthy();
  expect(within(dialog).getByText("Pay at club")).toBeTruthy();
  expect(within(dialog).getByText("Payment due at club")).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "Edit booking" }) !== null).toBe(accountUserId !== null);
  expect(within(dialog).queryByRole("button", { name: "Cancel booking" }) !== null).toBe(accountUserId !== null);
});

it("Coach confirms own cancellation, prevents duplicate submits and refreshes freed occupancy", async () => {
  let finish!: (result: { ok: true }) => void;
  ownerCancelAction.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const { rerender } = render(<ReservationCalendar actorUserId={coachId} date={coachReservation.booking_date}
    location={coachLocation} day={{ ...coachDay, courts: [{ court: coachCourt, cells: ["booked", "booked"] }] }} adminOccupancy={[coachReservation]} />);
  fireEvent.click(screen.getByRole("button", { name: /Reservation · Coach/ }));
  expect(screen.getByRole("button", { name: "Edit reservation" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  expect(ownerCancelAction).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog", { name: "Cancel reservation?" })).getByRole("button", { name: "Keep reservation" }));
  expect(ownerCancelAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  const confirmation = screen.getByRole("dialog", { name: "Cancel reservation?" });
  const confirm = within(confirmation).getByRole("button", { name: "Cancel reservation" });
  fireEvent.click(confirm);
  expect(confirm).toHaveProperty("disabled", true);
  fireEvent.click(confirm);
  expect(ownerCancelAction).toHaveBeenCalledExactlyOnceWith(coachReservation.id);
  expect(cancelAction).not.toHaveBeenCalled();
  await act(async () => finish({ ok: true }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(lastToast("success")).toBe("Reservation cancelled.");
  rerender(<ReservationCalendar actorUserId={coachId} date={coachReservation.booking_date} location={coachLocation}
    day={{ times: [600, 630], courts: [{ court: coachCourt, cells: ["available", "available"] }] }} adminOccupancy={[]} />);
  fireEvent.click(screen.getByRole("button", { name: /10:00–10:30, Available/ }));
  expect(screen.getByLabelText("Selected reservation")).toBeTruthy();
});

it.each(["stale", "network"])("Coach cancellation reports %s failure through Sonner and keeps confirmation", async (failure) => {
  if (failure === "stale") ownerCancelAction.mockResolvedValue({ ok: false, message: "This reservation is no longer available to cancel." });
  else ownerCancelAction.mockRejectedValue(new Error("Network"));
  render(<ReservationCalendar actorUserId={coachId} date={coachReservation.booking_date} location={coachLocation}
    day={{ times: [600, 630], courts: [{ court: coachCourt, cells: ["booked", "booked"] }] }} adminOccupancy={[coachReservation]} />);
  fireEvent.click(screen.getByRole("button", { name: /Reservation · Coach/ }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  const confirmation = screen.getByRole("dialog", { name: "Cancel reservation?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel reservation" }));
  await expectToast(failure === "stale" ? "no longer available" : "Unable to cancel");
  expect(screen.getByRole("dialog", { name: "Cancel reservation?" })).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled();
});

it.each(["other Coach", "historical creator", "customer", "guest", "ended", "ended booking"])("Coach cannot cancel %s occupancy", (kind) => {
  const item = kind === "customer" || kind === "guest" || kind === "ended booking" ? { payment_status: null, stripe_refund_available: false, ...coachReservation, kind: "booking" as const,
    account_user_id: kind === "ended booking" ? coachId : kind === "customer" ? "other-user" : null,
    payment_method: "pay_at_club" as const,
    booking_date: kind === "ended booking" ? "2000-10-15" : coachReservation.booking_date, customer_name: "Customer", customer_email: "coach@example.test",
    customer_phone: "123", total_amount_minor: 9000, currency: "RON" as const, cancellation_notice_minutes: 120 }
    : { ...coachReservation, created_by_user_id: kind === "historical creator" ? null : kind === "other Coach" ? "other-user" : coachId,
      booking_date: kind === "ended" ? "2000-10-15" : coachReservation.booking_date };
  render(<ReservationCalendar actorUserId={coachId} date={item.booking_date} location={coachLocation}
    day={{ times: [600, 630], courts: [{ court: coachCourt, cells: ["booked", "booked"] }] }} adminOccupancy={[item]} />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1.*10:00–11:00/ }));
  expect(screen.queryByRole("button", { name: /^(Cancel|Edit) (reservation|booking)$/ })).toBeNull();
  expect(ownerCancelAction).not.toHaveBeenCalled();
});

it.each([false, true])("in-progress cancellation preserves owner/Admin rules with canManage=%s", (canManage) => {
  const clock = new Date();
  const timezone = ["UTC", "America/Los_Angeles", "Asia/Tokyo"].find((zone) => localMinute(zone, clock) >= 120 && localMinute(zone, clock) <= 1260)!;
  const start = Math.floor(localMinute(timezone, clock) / 30) * 30 - 30;
  const item = { ...coachReservation, booking_date: localToday(timezone, clock), starts_at_minute: start, ends_at_minute: start + 120 };
  render(<ReservationCalendar canManage={canManage} actorUserId={coachId} date={item.booking_date} location={{ ...coachLocation, timezone }}
    day={{ times: [start], courts: [{ court: coachCourt, cells: ["past"] }] }} adminOccupancy={[item]} />);
  fireEvent.click(screen.getByRole("button", { name: /Reservation · Coach/ }));
  expect(!!screen.queryByRole("button", { name: "Cancel reservation" })).toBe(!canManage);
});


it.each(["future", "in-progress", "stale"])("Coach edits own reservation through owner actions, preserves failed draft (%s)", async (mode) => {
  const inProgress = mode === "in-progress";
  const clock = new Date();
  const timezone = ["UTC", "America/Los_Angeles", "Asia/Tokyo"].find((zone) => localMinute(zone, clock) >= 120 && localMinute(zone, clock) <= 1260)!;
  const start = Math.floor(localMinute(timezone, clock) / 30) * 30 - 30;
  const item = inProgress ? { ...coachReservation, booking_date: localToday(timezone, clock), starts_at_minute: start, ends_at_minute: start + 120 } : coachReservation;
  const location = { ...coachLocation, timezone: inProgress ? timezone : "UTC" };
  const day = { times: [item.starts_at_minute, item.starts_at_minute + 30, item.starts_at_minute + 60], courts: [{ court: coachCourt, cells: ["available", "available", "available"] }] };
  const token = "2026-10-01T12:00:00.123456Z";
  ownerAvailability.mockResolvedValue({ reservation: { ...item, updated_at: token }, day });
  ownerEdit.mockResolvedValueOnce({ ok: false, message: "Try again.", stale: mode === "stale" }).mockResolvedValueOnce({ ok: true });
  render(<ReservationCalendar actorUserId={coachId} date={item.booking_date} location={location}
    day={{ ...day, courts: [{ court: coachCourt, cells: ["booked", "booked"] }] }} adminOccupancy={[item]} />);
  fireEvent.click(screen.getByRole("button", { name: /Reservation · Coach/ }));
  fireEvent.click(screen.getByRole("button", { name: "Edit reservation" }));
  const dialog = screen.getByRole("dialog", { name: "Edit reservation" });
  const reason = await within(dialog).findByRole("textbox", { name: "Reason" });
  if (inProgress) expect(within(dialog).queryByLabelText("Date")).toBeNull();
  else {
    await within(dialog).findByText("Current reservation");
    fireEvent.click(within(dialog).getByRole("button", { name: /11:00–11:30, Available/ }));
  }
  fireEvent.change(reason, { target: { value: "Updated training" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await expectToast("Try again.", mode === "stale" ? "warning" : "error");
  expect(reason).toHaveProperty("value", "Updated training");
  if (mode === "stale") {
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "Edit reservation" })).toBeTruthy();
    return;
  }
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(ownerEdit).toHaveBeenLastCalledWith(expect.objectContaining({ id: item.id, expectedUpdatedAt: token,
    kind: inProgress ? "reason" : "schedule" }));
  expect(editAction).not.toHaveBeenCalled();
  expect(adminAvailability).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

const ownBooking = { payment_status: null, kind: "booking" as const, id: coachReservation.id, court_id: coachCourt.id,
  payment_method: "online" as const,
  booking_date: coachReservation.booking_date, starts_at_minute: 600, ends_at_minute: 660, account_user_id: coachId,
  customer_name: "Customer", customer_email: "coach@example.test", customer_phone: "123",
  total_amount_minor: 9000, currency: "RON" as const, cancellation_notice_minutes: 43200, stripe_refund_available: true };

it("Coach cancels own booking with automatic refund, preserves failed confirmation and refreshes occupancy", async () => {
  ownerBookingCancel.mockResolvedValueOnce({ ok: false, message: "Try again." }).mockResolvedValueOnce({ ok: true, refundStatus: "succeeded" });
  const { rerender } = render(<ReservationCalendar actorUserId={coachId} date={ownBooking.booking_date} location={coachLocation}
    day={{ times: [600, 630], courts: [{ court: coachCourt, cells: ["booked", "booked"] }] }} adminOccupancy={[ownBooking]} />);
  fireEvent.click(screen.getByRole("button", { name: /Booking · Customer/ }));
  expect(screen.getByRole("button", { name: "Edit booking" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
  const confirmation = screen.getByRole("dialog", { name: "Cancel booking?" });
  expect(within(confirmation).queryByRole("checkbox")).toBeNull();
  expect(ownerBookingCancel).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel booking" }));
  await expectToast("Try again.");
  expect(screen.getByRole("dialog", { name: "Cancel booking?" })).toBeTruthy();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel booking" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(ownerBookingCancel).toHaveBeenLastCalledWith(ownBooking.id);
  expect(cancelBookingAction).not.toHaveBeenCalled();
  expect(lastToast("success")).toContain("Booking cancelled.");
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(<ReservationCalendar actorUserId={coachId} date={ownBooking.booking_date} location={coachLocation}
    day={{ times: [600, 630], courts: [{ court: coachCourt, cells: ["available", "available"] }] }} adminOccupancy={[]} />);
  expect(screen.getAllByRole("button", { name: /Available/ })).toHaveLength(2);
});

it("Coach reschedules own booking with price acknowledgement and owner stale tokens", async () => {
  ownerBookingLoad.mockResolvedValue({ day: { times: [600, 630, 660], courts: [{ court: coachCourt, cells: ["available", "available", "available"] }] },
    booking: { refunds: [], ...ownBooking, location_id: coachLocation.id, location_timezone: "UTC", updated_at: "2026-10-01T12:00:00.123456Z",
      current_revision_id: "2026-10-01T12:00:00.123457Z", location: coachLocation, hours: [], occupancy: [] } });
  ownerBookingQuote.mockResolvedValue({ ok: true, totalAmountMinor: 10000 });
  ownerBookingSave.mockResolvedValueOnce({ ok: false, message: "Try again." }).mockResolvedValueOnce({ ok: true, totalAmountMinor: 10000 });
  render(<ReservationCalendar actorUserId={coachId} date={ownBooking.booking_date} location={coachLocation}
    day={{ times: [600, 630], courts: [{ court: coachCourt, cells: ["booked", "booked"] }] }} adminOccupancy={[ownBooking]} />);
  fireEvent.click(screen.getByRole("button", { name: /Booking · Customer/ }));
  fireEvent.click(screen.getByRole("button", { name: "Edit booking" }));
  const dialog = screen.getByRole("dialog", { name: "Edit booking" });
  await within(dialog).findByText("Current reservation");
  fireEvent.click(within(dialog).getByRole("button", { name: /11:00–11:30, Available/ }));
  await within(dialog).findByRole("checkbox");
  expect(within(dialog).getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await expectToast("Try again.");
  expect(within(dialog).getByRole("checkbox")).toHaveProperty("checked", true);
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(ownerBookingSave).toHaveBeenLastCalledWith(expect.objectContaining({ id: ownBooking.id, startMinute: 600, endMinute: 690,
    expectedUpdatedAt: "2026-10-01T12:00:00.123456Z", expectedRevisionId: "2026-10-01T12:00:00.123457Z",
    expectedTotal: 10000, priceAcknowledged: true, save: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
});


it("preserves the selected interval while reservation creation is pending and allows retry after failure", async () => {
  let finish!: (result: { ok: false; message: string }) => void;
  reserveAction.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const court = { id: "22222222-2222-4222-8222-222222222222", name: "Court 1" };
  render(<ReservationCalendar canManage date="2099-10-15"
    location={{ id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC", courts: [court] }}
    day={{ times: [600, 630], courts: [{ court, cells: ["available", "available"] }] }} />);
  expect(screen.queryByRole("button", { name: "Clear selection" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /10:00–10:30, Available/ }));
  const clear = screen.getByRole("button", { name: "Clear selection" });
  expect(clear).toHaveProperty("disabled", false);
  expect(screen.getByRole("button", { name: "Reserve court" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "Practice" } });
  fireEvent.click(screen.getByRole("button", { name: "Reserve court" }));
  expect(clear).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Reserving…" })).toHaveProperty("disabled", true);
  fireEvent.click(clear);
  expect(screen.getByLabelText("Selected reservation")).toBeTruthy();
  await act(async () => finish({ ok: false, message: "Try again." }));
  expect(clear).toHaveProperty("disabled", false);
  expect(screen.getByRole("button", { name: "Reserve court" })).toHaveProperty("disabled", false);
  fireEvent.click(clear);
  expect(screen.queryByLabelText("Selected reservation")).toBeNull();
});

it.each([
  { included: true, authenticated: false }, { included: false, authenticated: false },
  { included: true, authenticated: true }, { included: false, authenticated: true },
])("shows historical coaching details and Admin navigation (included=$included, authenticated=$authenticated)", ({ included, authenticated }) => {
  const booking = { ...ownBooking, account_user_id: authenticated ? "another-customer" : null, includes_coaching: true,
    coach_name: "Historical Coach", coaching_program_name: "Historical Semi-private",
    location_name: "Historical Club", court_name: "Historical Court", location_timezone: "UTC",
    total_amount_minor: included ? 12000 : 15000, currency: "EUR" as const,
    coaching: { programId: coachReservation.id, coachUserId: coachId, locationId: coachLocation.id,
      participantCount: 2 as const, pricePerPersonMinor: 6000, durationMinutes: 60, source: "coach" as const, amountMinor: 12000,
      currency: "EUR" as const, courtRentalIncluded: included, courtRentalMinor: 3000, courtAmountMinor: included ? 0 : 3000 } };
  const props = { actorUserId: coachId, date: booking.booking_date, location: coachLocation,
    adminOccupancy: [booking] };
  const day = { times: [600, 630], courts: [{ court: coachCourt, cells: ["booked" as const, "booked" as const] }] };
  const { rerender } = render(<ReservationCalendar {...props} day={day} canManage />);
  const block = screen.getByRole("button", { name: /Coaching · Customer/ });
  expect(within(block).getByText("Coaching")).toBeTruthy();
  fireEvent.click(block);
  const dialog = screen.getByRole("dialog", { name: "Booking details" });
  for (const value of ["Historical Coach", "Historical Semi-private", "Historical Club", "Historical Court", "2", authenticated ? "Authenticated customer" : "Guest", "EUR", "Online"])
    expect(within(dialog).getByText(value)).toBeTruthy();
  expect(within(dialog).getByText(included ? "Included" : /Charged separately.*30[.,]00/)).toBeTruthy();
  const terms = within(dialog).getByRole("heading", { name: "Booking terms" }).closest("section")!;
  expect(within(terms).getByText(included ? /120[.,]00/ : /150[.,]00/)).toBeTruthy();
  const coachingSection = within(dialog).getByRole("heading", { name: "Coaching details" }).closest("section")!;
  expect(within(coachingSection).getByText(/120[.,]00/)).toBeTruthy();
  expect(within(coachingSection).getByText("60 min")).toBeTruthy();
  expect(within(dialog).getByRole("link", { name: "View full booking details" }).getAttribute("href")).toBe(`/admin/bookings/${booking.id}?${new URLSearchParams({
    back: `/admin/bookings?view=calendar&location=${coachLocation.id}&date=${booking.booking_date}` })}`);
  expect(within(dialog).getByRole("button", { name: "Cancel booking" })).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: "Edit booking" })).toBeNull();
  rerender(<ReservationCalendar {...props} day={day} canManage={false} />);
  expect(within(dialog).queryByRole("link", { name: "View full booking details" })).toBeNull();
  expect(within(dialog).queryByRole("button", { name: "Cancel booking" })).toBeNull();
});

it("closes the Admin booking preview when following its details link, so no modal outlives the Calendar", () => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "RIVUS", timezone: "UTC", courts: [{ id: courtId, name: "Court 2" }] };
  const booking = { account_user_id: null, payment_status: null, kind: "booking" as const, stripe_refund_available: false,
    id: "33333333-3333-4333-8333-333333333333", court_id: courtId, payment_method: "pay_at_club" as const,
    booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660, customer_name: "Ana Pop", customer_email: "ana@example.test",
    customer_phone: "+40 123", cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON" as const };
  render(<ReservationCalendar canManage date={booking.booking_date} location={location}
    day={{ times: [600, 630], courts: [{ court: location.courts[0], cells: ["booked", "booked"] }] }} adminOccupancy={[booking]} />);
  fireEvent.click(screen.getByRole("button", { name: /Booking · Ana Pop/ }));
  const link = within(screen.getByRole("dialog", { name: "Booking details" })).getByRole("link", { name: "View full booking details" });
  link.addEventListener("click", (event) => event.preventDefault());
  fireEvent.click(link);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(cancelBookingAction).not.toHaveBeenCalled();
});

it.each([
  [{ operation: "payment", status: "succeeded", provider: "stripe" }, "Payment succeeded (Stripe)"],
  [{ operation: "refund", status: "succeeded", provider: "stripe" }, "Refund succeeded (Stripe)"],
  [{ operation: "refund", status: "pending", provider: "stripe" }, "Refund pending (Stripe)"],
  [{ operation: "refund", status: "failed", provider: "stripe" }, "Refund failed (Stripe)"],
  [{ operation: "payment", status: "pending", provider: "stripe" }, "Payment pending (Stripe)"],
  [{ operation: "payment", status: "failed", provider: "stripe" }, "Payment failed (Stripe)"],
  [null, null],
] as const)("Admin booking preview shows one current payment status: %j", (paymentStatus, label) => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "RIVUS", timezone: "UTC", courts: [{ id: courtId, name: "Court 2" }] };
  const booking = { account_user_id: null, payment_status: paymentStatus, kind: "booking" as const, stripe_refund_available: false,
    id: "33333333-3333-4333-8333-333333333333", court_id: courtId, payment_method: "online" as const,
    booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660, customer_name: "Ana Pop", customer_email: "ana@example.test",
    customer_phone: "+40 123", cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON" as const };
  render(<ReservationCalendar canManage date={booking.booking_date} location={location}
    day={{ times: [600, 630], courts: [{ court: location.courts[0], cells: ["booked", "booked"] }] }} adminOccupancy={[booking]} />);
  fireEvent.click(screen.getByRole("button", { name: /Booking · Ana Pop/ }));
  const dialog = screen.getByRole("dialog", { name: "Booking details" });
  expect(within(dialog).queryAllByText("Payment status")).toHaveLength(label ? 1 : 0);
  expect(within(dialog).queryAllByText(/^(Payment|Refund) (succeeded|pending|failed)/)).toHaveLength(label ? 1 : 0);
  if (label) expect(within(dialog).getByText("Payment status").nextElementSibling?.textContent).toBe(label);
});

it("links an Admin's staff reservation preview to its details page with Calendar return, closing the preview", () => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "RIVUS", timezone: "UTC", courts: [{ id: courtId, name: "Court 2" }] };
  const reservation = { creator_email: null, creator_phone: null, payment_method: null, kind: "reservation" as const,
    id: "33333333-3333-4333-8333-333333333333", court_id: courtId, booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
    reason: "Maintenance", created_by_user_id: "44444444-4444-4444-8444-444444444444", creator_name: "Staff Member" };
  const day = { times: [600, 630], courts: [{ court: location.courts[0], cells: ["booked" as const, "booked" as const] }] };
  const { unmount } = render(<ReservationCalendar canManage date={reservation.booking_date} location={location} day={day} adminOccupancy={[reservation]} />);
  fireEvent.click(screen.getByRole("button", { name: /Reservation · Staff Member/ }));
  const link = within(screen.getByRole("dialog", { name: "Reservation details" })).getByRole("link", { name: "View full reservation details" });
  expect(link.getAttribute("href")).toBe(`/admin/bookings/reservations/${reservation.id}?${new URLSearchParams({
    back: `/admin/bookings?view=calendar&location=${location.id}&date=2099-10-15` })}`);
  link.addEventListener("click", (event) => event.preventDefault());
  fireEvent.click(link);
  expect(screen.queryByRole("dialog")).toBeNull();
  unmount();
  // Coaches keep their Calendar dialog without the Admin details destination.
  render(<ReservationCalendar date={reservation.booking_date} location={location} day={day} adminOccupancy={[reservation]} />);
  fireEvent.click(screen.getByRole("button", { name: /Reservation · Staff Member/ }));
  expect(screen.queryByRole("link", { name: "View full reservation details" })).toBeNull();
});

it("links a Coach only to their own reservation and own lesson details, returning to the Coach Calendar", () => {
  const courtId = "22222222-2222-4222-8222-222222222222", coachId = "44444444-4444-4444-8444-444444444444";
  const otherId = "55555555-5555-4555-8555-555555555555";
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "RIVUS", timezone: "UTC",
    courts: [{ id: courtId, name: "Court 2" }] };
  const back = `/coach/bookings?view=calendar&location=${location.id}&date=2099-10-15`;
  const reservation = (id: string, creator: string, name: string, start: number) => ({ creator_email: null, creator_phone: null,
    payment_method: null, kind: "reservation" as const, id, court_id: courtId, booking_date: "2099-10-15", starts_at_minute: start,
    ends_at_minute: start + 30, reason: "Clinic", created_by_user_id: creator, creator_name: name });
  // The Coach projection: own lesson with contact only, every other booking as a bare interval.
  const occupancy: AdminOperationalOccupancy[] = [reservation("33333333-3333-4333-8333-000000000001", coachId, "Me Coach", 600),
    reservation("33333333-3333-4333-8333-000000000002", otherId, "Other Coach", 630),
    { kind: "lesson", id: "33333333-3333-4333-8333-000000000003", court_id: courtId, booking_date: "2099-10-15", starts_at_minute: 660,
      ends_at_minute: 690, coach_user_id: coachId, coach_name: "Me Coach", coaching_program_name: "Juniors", customer_name: "My Student",
      customer_email: "student@example.test", customer_phone: "+40 700" },
    { kind: "occupied", id: `occupied:${courtId}:690`, court_id: courtId, booking_date: "2099-10-15", starts_at_minute: 690, ends_at_minute: 720 }];
  render(<ReservationCalendar actorUserId={coachId} date="2099-10-15" location={location} adminOccupancy={occupancy}
    day={{ times: [600, 630, 660, 690], courts: [{ court: location.courts[0], cells: ["booked", "booked", "booked", "booked"] }] }} />);
  const open = (name: RegExp, title: string) => {
    fireEvent.click(screen.getByRole("button", { name }));
    return screen.getByRole("dialog", { name: title });
  };
  let dialog = open(/Reservation · Me Coach/, "Reservation details");
  expect(within(dialog).getByRole("link", { name: "View full reservation details" }).getAttribute("href"))
    .toBe(`/coach/bookings/reservations/${occupancy[0].id}?${new URLSearchParams({ back })}`);
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  dialog = open(/Reservation · Other Coach/, "Reservation details");
  expect(within(dialog).queryByRole("link")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  dialog = open(/Coaching · My Student/, "Lesson details");
  for (const text of ["Me Coach", "Juniors", "My Student", "student@example.test", "+40 700", "RIVUS", "Court 2"]) expect(within(dialog).getByText(text)).toBeTruthy();
  expect(within(dialog).queryByText(/Total|Currency|Payment|Customer type|Cancellation|Coaching fee/)).toBeNull();
  const link = within(dialog).getByRole("link", { name: "View lesson details" });
  expect(link.getAttribute("href")).toBe(`/coach/bookings/lessons/${occupancy[2].id}?${new URLSearchParams({ back })}`);
  expect(within(dialog).queryByRole("link", { name: "View full booking details" })).toBeNull();
  link.addEventListener("click", (event) => event.preventDefault());
  fireEvent.click(link);
  expect(screen.queryByRole("dialog")).toBeNull();
  const occupied = screen.getByRole("button", { name: "Court 2 2099-10-15 11:30–12:00, Booked" });
  expect(occupied.textContent).toBe("");
  dialog = open(/11:30–12:00, Booked/, "Occupied court details");
  expect(within(dialog).queryByRole("link")).toBeNull();
  expect(within(dialog).queryByText(/Customer|Coach|Payment|Total|@/)).toBeNull();
  expect(within(dialog).getByText("11:30–12:00 (UTC)")).toBeTruthy();
});

it("identifies a temporary checkout hold and its deadline without booking management", () => {
  const courtId = "22222222-2222-4222-8222-222222222222";
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC", courts: [{ id: courtId, name: "Court 2" }] };
  render(<ReservationCalendar canManage date="2099-10-15" location={location}
    day={{ times: [600, 630], courts: [{ court: location.courts[0], cells: ["booked", "booked"] }] }}
    adminOccupancy={[{ kind: "hold", id: "33333333-3333-4333-8333-333333333333", court_id: courtId,
      booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
      hold_expires_at: "2099-10-14T10:10:00Z", customer_name: "Ana", customer_email: "ana@example.test" }]} />);
  fireEvent.click(screen.getByRole("button", { name: /Temporary checkout hold/ }));
  expect(screen.getByRole("dialog", { name: "Temporary checkout hold" })).toBeTruthy();
  expect(screen.getByText("Deadline")).toBeTruthy();
  expect(screen.getByText(/No booking has been confirmed/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Review checkout payment" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancel booking" })).toBeNull();
});
