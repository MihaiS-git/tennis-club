// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ReservationEditForm } from "@/app/my-activity/bookings/reservation-edit-form";
import type { PersonalReservation } from "@/lib/reservations/personal";

const { availability, edit } = vi.hoisted(() => ({ availability: vi.fn(), edit: vi.fn() }));
vi.mock("@/app/my-activity/bookings/actions", () => ({ loadReservationEditDayAction: availability, editOwnReservationAction: edit }));
beforeEach(() => { availability.mockReset(); edit.mockReset(); });
afterEach(cleanup);

const reservation: PersonalReservation = {
  id: "11111111-1111-4111-8111-111111111111", court_id: "22222222-2222-4222-8222-222222222222",
  location_id: "33333333-3333-4333-8333-333333333333", updated_at: "2026-10-01T12:00:00Z",
  booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 690,
  reason: "Practice", status: "active", created_by_user_id: "44444444-4444-4444-8444-444444444444",
  creator_name: "Alex", cancelled_at: null, cancelled_by_name: null,
  location_name: "RIVUS", location_timezone: "Europe/Bucharest", court_name: "Court A",
};
const courtB = "55555555-5555-4555-8555-555555555555";
const times = [600, 630, 660, 690, 720];
function day(date: string, courtBCells: string[] = ["available", "available", "available", "available", "closed"]) {
  return { date, location: { id: reservation.location_id, name: "RIVUS", timezone: reservation.location_timezone },
    day: { times, courts: [
      { court: { id: reservation.court_id, name: "Court A" }, cells: ["available", "available", "available", "booked", "closed"] },
      { court: { id: courtB, name: "Court B" }, cells: courtBCells },
    ] } };
}
const callbacks = { onCancel: vi.fn(), onSaved: vi.fn(async () => {}), onStale: vi.fn(async () => {}), onPendingChange: vi.fn() };

it("shows fixed location, visible availability and current selection, then reloads the same location for a date change", async () => {
  availability.mockImplementation(async (_id, date) => day(date));
  edit.mockResolvedValue({ ok: true });
  render(<ReservationEditForm reservation={reservation} inProgress={false} {...callbacks} />);
  expect(screen.getByText("RIVUS")).toBeDefined();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByLabelText("Location")).toBeNull();
  expect(screen.queryByLabelText("From")).toBeNull();
  expect(screen.queryByLabelText("To")).toBeNull();
  await screen.findByText("Current reservation");
  expect(screen.getAllByRole("button", { name: /Court A.*selected/ })).toHaveLength(3);
  expect(within(screen.getAllByRole("row")[1]).getAllByLabelText(/, Booked/)).toHaveLength(1);
  expect(screen.getByRole("rowheader", { name: "Court B" })).toBeDefined();
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2099-10-16" } });
  await waitFor(() => expect(availability).toHaveBeenLastCalledWith(reservation.id, "2099-10-16"));
  expect(screen.queryByText("Current reservation")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Court B 2099-10-16 10:00–10:30/ }));
  expect(screen.getByText("Court B · 10:00–11:00 · 60 min")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(edit).toHaveBeenCalledWith({ kind: "schedule", id: reservation.id,
    expectedUpdatedAt: reservation.updated_at, schedule: { courtId: courtB, date: "2099-10-16",
      startMinute: 600, endMinute: 660, reason: "Practice" } }));
});

it("keeps reason and reports a conflict while refreshing newly blocked availability", async () => {
  availability.mockResolvedValueOnce(day(reservation.booking_date))
    .mockResolvedValueOnce(day(reservation.booking_date, ["booked", "booked", "available", "available", "closed"]));
  edit.mockResolvedValue({ ok: false, message: "That court is no longer available for the selected time. Your existing reservation has not been changed." });
  render(<ReservationEditForm reservation={reservation} inProgress={false} {...callbacks} />);
  await screen.findByText("Current reservation");
  fireEvent.click(screen.getByRole("button", { name: /Court B 2099-10-15 10:00–10:30/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "Training" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(availability).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("alert").textContent).toContain("existing reservation has not been changed");
  expect(screen.getByRole("textbox", { name: "Reason" })).toHaveProperty("value", "Training");
  expect(screen.queryByRole("region", { name: "Selected reservation" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Court B 2099-10-15 10:00–10:30/ })).toBeNull();
});
