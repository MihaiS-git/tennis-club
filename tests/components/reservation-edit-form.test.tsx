// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ReservationEditForm } from "@/app/my-activity/bookings/reservation-edit-form";
import type { PersonalReservation } from "@/lib/reservations/personal";

const { availability, edit } = vi.hoisted(() => ({ availability: vi.fn(), edit: vi.fn() }));
vi.mock("@/app/my-activity/bookings/actions", () => ({ loadReservationEditDayAction: availability, editOwnReservationAction: edit }));
beforeEach(() => { vi.clearAllMocks(); availability.mockReset(); edit.mockReset(); });
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

const saveButton = () => screen.getByRole("button", { name: "Save changes" });
const changeReason = (value: string) => fireEvent.change(screen.getByLabelText("Reason"), { target: { value } });

it("keeps unchanged and normalized reason edits pristine, and requires a valid changed reason", async () => {
  availability.mockResolvedValue(day(reservation.booking_date));
  render(<ReservationEditForm reservation={reservation} inProgress={false} {...callbacks} />);
  await screen.findByText("Current reservation");
  expect(saveButton()).toHaveProperty("disabled", true);
  fireEvent.focus(screen.getByLabelText("Reason")); fireEvent.blur(screen.getByLabelText("Reason"));
  expect(saveButton()).toHaveProperty("disabled", true);
  changeReason(" Practice "); expect(saveButton()).toHaveProperty("disabled", true);
  changeReason("Training"); expect(saveButton()).toHaveProperty("disabled", false);
  changeReason("Practice"); expect(saveButton()).toHaveProperty("disabled", true);
  changeReason("   "); expect(saveButton()).toHaveProperty("disabled", true);
  changeReason("x".repeat(256)); expect(saveButton()).toHaveProperty("disabled", true);
});

it("disables Save after reverting the court and interval", async () => {
  availability.mockResolvedValue(day(reservation.booking_date));
  render(<ReservationEditForm reservation={reservation} inProgress={false} {...callbacks} />);
  await screen.findByText("Current reservation");
  fireEvent.click(screen.getByRole("button", { name: /Court B 2099-10-15 10:00–10:30/ }));
  expect(saveButton()).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: /Court A 2099-10-15 10:00–10:30/ }));
  expect(saveButton()).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: /Court A 2099-10-15 11:00–11:30/ }));
  expect(saveButton()).toHaveProperty("disabled", true);
});

it("requires availability and an interval when changing and reverting dates", async () => {
  availability.mockImplementation(async (_id, date) => day(date));
  render(<ReservationEditForm reservation={reservation} inProgress={false} {...callbacks} />);
  await screen.findByText("Current reservation");
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2099-10-16" } });
  expect(saveButton()).toHaveProperty("disabled", true);
  await screen.findByRole("rowheader", { name: "Court A" });
  expect(saveButton()).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: /Court A 2099-10-16 10:00–10:30/ }));
  expect(saveButton()).toHaveProperty("disabled", false);
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: reservation.booking_date } });
  await screen.findByRole("rowheader", { name: "Court A" });
  fireEvent.click(screen.getByRole("button", { name: /Court A 2099-10-15 10:00–10:30/ }));
  fireEvent.click(screen.getByRole("button", { name: /Court A 2099-10-15 11:00–11:30/ }));
  expect(saveButton()).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "" } });
  changeReason("Training"); expect(saveButton()).toHaveProperty("disabled", true);
});

it("disables Save while availability is pending or its required interval is unavailable", async () => {
  let finish: (value: ReturnType<typeof day>) => void = () => { throw new Error("Not loading"); };
  availability.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<ReservationEditForm reservation={reservation} inProgress={false} {...callbacks} />);
  changeReason("Training");
  expect(saveButton()).toHaveProperty("disabled", true);
  expect(screen.getByRole("status").textContent).toContain("Loading court availability");
  await act(async () => finish(day(reservation.booking_date)));
  expect(saveButton()).toHaveProperty("disabled", false);
});

it.each([630, 675])("rejects an invalid persisted interval ending at %s", async (ends_at_minute) => {
  availability.mockResolvedValue(day(reservation.booking_date));
  render(<ReservationEditForm reservation={{ ...reservation, ends_at_minute }} inProgress={false} {...callbacks} />);
  await screen.findByRole("rowheader", { name: "Court A" });
  changeReason("Training");
  expect(saveButton()).toHaveProperty("disabled", true);
  fireEvent.submit(saveButton().closest("form")!);
  expect(edit).not.toHaveBeenCalled();
});

it("allows valid reason-only changes in progress without availability", async () => {
  edit.mockResolvedValue({ ok: true });
  render(<ReservationEditForm reservation={reservation} inProgress {...callbacks} />);
  expect(saveButton()).toHaveProperty("disabled", true);
  changeReason(" Training "); expect(saveButton()).toHaveProperty("disabled", false);
  changeReason("Practice"); expect(saveButton()).toHaveProperty("disabled", true);
  changeReason(" "); expect(saveButton()).toHaveProperty("disabled", true);
  changeReason("Training"); fireEvent.click(saveButton());
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledOnce());
  expect(edit).toHaveBeenCalledWith({ kind: "reason", id: reservation.id,
    expectedUpdatedAt: reservation.updated_at, reason: "Training" });
  expect(availability).not.toHaveBeenCalled();
});

it("locks pending submission, prevents duplicates, preserves failures and allows retry", async () => {
  availability.mockResolvedValue(day(reservation.booking_date));
  let finish: (value: { ok: false; message: string }) => void = () => { throw new Error("Not saving"); };
  edit.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce({ ok: true });
  render(<ReservationEditForm reservation={reservation} inProgress={false} {...callbacks} />);
  await screen.findByText("Current reservation");
  changeReason("Training");
  const form = saveButton().closest("form")!;
  act(() => { fireEvent.submit(form); fireEvent.submit(form); });
  expect(edit).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("Reason")).toHaveProperty("disabled", true);
  expect(callbacks.onPendingChange).toHaveBeenLastCalledWith(true);
  await act(async () => finish({ ok: false, message: "Unable to save. Try again." }));
  expect(screen.getByRole("alert").textContent).toContain("Try again");
  expect(screen.getByLabelText("Reason")).toHaveProperty("value", "Training");
  expect(saveButton()).toHaveProperty("disabled", false);
  expect(callbacks.onPendingChange).toHaveBeenLastCalledWith(false);
  fireEvent.click(saveButton());
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledOnce());
  expect(edit).toHaveBeenCalledTimes(2);
});

it("preserves the draft and enables retry after a thrown save error", async () => {
  availability.mockResolvedValue(day(reservation.booking_date));
  edit.mockRejectedValueOnce(new Error("Network failure")).mockResolvedValueOnce({ ok: true });
  render(<ReservationEditForm reservation={reservation} inProgress={false} {...callbacks} />);
  await screen.findByText("Current reservation");
  changeReason("Training"); fireEvent.click(saveButton());
  await screen.findByText(/Unable to save this reservation/);
  expect(screen.getByLabelText("Reason")).toHaveProperty("value", "Training");
  expect(saveButton()).toHaveProperty("disabled", false);
  fireEvent.click(saveButton());
  await waitFor(() => expect(callbacks.onSaved).toHaveBeenCalledOnce());
});

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
  expect(saveButton()).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: /Court B 2099-10-15 11:00–11:30/ }));
  expect(saveButton()).toHaveProperty("disabled", false);
});

it("keeps misaligned timetable intervals invalid using the existing schedule schema", async () => {
  const result = day(reservation.booking_date);
  availability.mockResolvedValue({ ...result, day: { ...result.day, times: [615, 645, 675, 705, 735] } });
  render(<ReservationEditForm reservation={reservation} inProgress={false} {...callbacks} />);
  await screen.findByRole("rowheader", { name: "Court B" });
  fireEvent.click(screen.getByRole("button", { name: /Court B 2099-10-15 10:15–10:45/ }));
  expect(saveButton()).toHaveProperty("disabled", true);
});

it("retains reason changes after availability fails and allows retry", async () => {
  availability.mockRejectedValueOnce(new Error("Network failure")).mockResolvedValueOnce(day(reservation.booking_date));
  render(<ReservationEditForm reservation={reservation} inProgress={false} {...callbacks} />);
  changeReason("Training");
  await screen.findByText(/Unable to load court availability/);
  expect(saveButton()).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(saveButton()).toHaveProperty("disabled", true);
  await screen.findByText("Current reservation");
  expect(screen.getByLabelText("Reason")).toHaveProperty("value", "Training");
  expect(saveButton()).toHaveProperty("disabled", false);
});
