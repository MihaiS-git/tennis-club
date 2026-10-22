// @vitest-environment jsdom
import { expectToast } from "../helpers/notifications";
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BookingEditForm } from "@/components/booking-edit-form";
import { BookingTimetable } from "@/components/booking-timetable";
import { formatMoney } from "@/lib/pricing/money";

const { load, quote, save } = vi.hoisted(() => ({ load: vi.fn(), quote: vi.fn(), save: vi.fn() }));
vi.mock("@/app/book/actions", () => ({ abandonCheckoutAction: vi.fn() }));
vi.mock("@/app/book/online-payment", () => ({ OnlinePayment: (props: ComponentProps<typeof import("@/app/book/online-payment").OnlinePayment>) =>
  <button type="button" onClick={() => props.onConfirmed(10000, "RON", null)}>Simulate verified modification payment</button> }));
vi.mock("@/app/my-activity/bookings/actions", () => ({ loadOwnBookingEditDayAction: load,
  quoteOwnBookingAction: quote, rescheduleOwnBookingAction: save }));
// The /book timetable itself, observed to prove the lesson editor reuses it.
vi.mock("@/components/booking-timetable", async (original) => {
  const actual = await original<typeof import("@/components/booking-timetable")>();
  return { ...actual, BookingTimetable: vi.fn(actual.BookingTimetable) };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { load.mockReset(); quote.mockReset(); save.mockReset(); });

const courtA = { id: "22222222-2222-4222-8222-222222222222", name: "Court A", is_active: true };
const courtB = { id: "44444444-4444-4444-8444-444444444444", name: "Court B", is_active: true };
const booking = { id: "33333333-3333-4333-8333-333333333333", booking_date: "2099-10-15", currency: "RON" as const };
const location = { id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC", is_active: true,
  archived_at: null, courts: [courtA, courtB] };
const times = [600, 630, 660, 690, 720, 750];
const offer = (court: typeof courtA, total: number) => ({ id: court.id, name: court.name,
  coachingAmountMinor: 6000, courtAmountMinor: total - 6000, totalAmountMinor: total });
const start = (startMinute: number, courts: ReturnType<typeof offer>[]) => ({ startMinute, endMinute: startMinute + 60,
  startsAt: "2099-10-15T10:00:00Z", endsAt: "2099-10-15T11:00:00Z", courts });
const lesson = (starts: ReturnType<typeof start>[]) => ({ coach: { id: "55555555-5555-4555-8555-555555555555", name: "Daniel Stoica" },
  program: { id: "66666666-6666-4666-8666-666666666666", name: "Private coaching", participantCount: 1 as const, courtRentalIncluded: false },
  durationMinutes: 60, coachingAmountMinor: 6000, starts });
// The lesson's own 10:00 slot on Court A is free: the server excludes it from occupancy.
const days: Record<string, { day: unknown; coaching: ReturnType<typeof lesson> }> = {
  "2099-10-15": { day: { times, courts: [
    { court: courtA, cells: ["available", "available", "available", "available", "available", "available"] },
    { court: courtB, cells: ["available", "available", "booked", "available", "available", "available"] },
  ] }, coaching: lesson([start(600, [offer(courtA, 7500), offer(courtB, 7500)]), start(690, [offer(courtA, 7500), offer(courtB, 9000)])]) },
  "2099-10-16": { day: { times, courts: [
    { court: courtA, cells: ["booked", "booked", "available", "available", "available", "available"] },
    { court: courtB, cells: ["available", "available", "available", "available", "available", "available"] },
  ] }, coaching: lesson([start(720, [offer(courtB, 6500)])]) },
};

function renderLesson() {
  load.mockImplementation(async (_id: string, date: string) => ({ day: days[date].day, booking: {
    ...booking, payment_method: "online", court_id: courtA.id, starts_at_minute: 600, ends_at_minute: 660, total_amount_minor: 7500,
    location_id: location.id, location_timezone: "UTC", updated_at: "2026-10-01T12:00:00Z",
    current_revision_id: "77777777-7777-4777-8777-777777777777", location, hours: [], occupancy: [], refunds: [],
    coaching: days[date].coaching } }));
  const onSaved = vi.fn(async () => {});
  const onAdjustment = vi.fn();
  render(<BookingEditForm booking={booking} onCancel={vi.fn()} onPendingChange={vi.fn()} onSaved={onSaved}
    onAdjustment={onAdjustment} actions={{ load, quote, save }} />);
  return { onSaved, onAdjustment };
}
const cell = (name: RegExp) => screen.getByRole("button", { name });
const saveButton = () => screen.getByRole("button", { name: "Save changes" });
const lessonTerms = () => within(screen.getByRole("region", { name: "Lesson" }));
async function opened() {
  await screen.findByText("Current reservation");
  await waitFor(() => expect(quote).toHaveBeenCalledOnce());
}
async function choose(name: RegExp, total: number) {
  quote.mockResolvedValueOnce({ ok: true, totalAmountMinor: total });
  fireEvent.click(cell(name));
  await waitFor(() => expect(within(screen.getByRole("region", { name: "Booking price" })).getByText("New total")
    .nextElementSibling?.textContent).toBe(formatMoney(total, "RON")));
}

it("reuses the /book timetable with fixed lesson terms and the original lesson preselected", async () => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  renderLesson();
  await opened();
  expect(vi.mocked(BookingTimetable)).toHaveBeenCalled();
  expect(screen.getByRole("table", { name: "Court timetable" })).toBeTruthy();
  for (const [term, value] of [["Location", "Club"], ["Coach", "Daniel Stoica"], ["Program", "Private coaching"],
    ["Duration", "60 min"], ["Original", "2099-10-15 · 10:00–11:00 · Court A"]])
    expect(lessonTerms().getByText(term).nextElementSibling?.textContent).toBe(value);
  expect(lessonTerms().getByText("Choose a new lesson start")).toBeTruthy();
  expect(screen.queryByRole("combobox")).toBeNull();
  // The lesson's own reservation does not block its start.
  expect(cell(/Court A 2099-10-15 10:00–11:00, 60 min lesson/).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("button", { name: /Court B 2099-10-15 11:00/ })).toBeNull();
  expect(screen.getByLabelText(/Court A 2099-10-15 10:30–11:00, No lesson start/)).toBeTruthy();
  expect(saveButton()).toHaveProperty("disabled", true);
  fireEvent.submit(saveButton().closest("form")!);
  expect(save).not.toHaveBeenCalled();
});

it("selects another court and start of the fixed length and shows the server-quoted surcharge", async () => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  renderLesson();
  await opened();
  await choose(/Court B 2099-10-15 11:30–12:30, 60 min lesson, RON\s90.00 total/, 9000);
  expect(quote).toHaveBeenLastCalledWith(expect.objectContaining({ id: booking.id, courtId: courtB.id, date: "2099-10-15",
    startMinute: 690, endMinute: 750, save: false }));
  expect(Object.keys(quote.mock.lastCall![0])).not.toContain("excludeReservationId");
  expect(lessonTerms().getByText("Proposed").nextElementSibling?.textContent).toBe("2099-10-15 · 11:30–12:30 · Court B");
  expect(screen.getByText(/Additional amount payable:.*RON\s15\.00/)).toBeTruthy();
  expect(screen.getByRole("region", { name: "Booking price" }).textContent).toContain(formatMoney(7500, "RON"));
  expect(saveButton()).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(saveButton()).toHaveProperty("disabled", false);
  // Returning to the original lesson is not a change.
  fireEvent.click(cell(/Court A 2099-10-15 10:00–11:00/));
  await waitFor(() => expect(saveButton()).toHaveProperty("disabled", true));
  expect(lessonTerms().getByText("Choose a new lesson start")).toBeTruthy();
});

it("reloads lesson availability for a new date", async () => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  renderLesson();
  await opened();
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2099-10-16" } });
  await screen.findByRole("button", { name: /Court B 2099-10-16 12:00–13:00, 60 min lesson, RON\s65.00 total/ });
  expect(load).toHaveBeenLastCalledWith(booking.id, "2099-10-16");
  expect(screen.queryByRole("button", { name: /Court A 2099-10-16/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Court B 2099-10-16 10:00/ })).toBeNull();
  await choose(/Court B 2099-10-16 12:00–13:00/, 6500);
  expect(lessonTerms().getByText("Proposed").nextElementSibling?.textContent).toBe("2099-10-16 · 12:00–13:00 · Court B");
});

it("applies an unchanged-price lesson move directly", async () => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  save.mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  const { onSaved } = renderLesson();
  await opened();
  await choose(/Court A 2099-10-15 11:30–12:30/, 7500);
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(saveButton());
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: booking.id, courtId: courtA.id, date: "2099-10-15",
    startMinute: 690, endMinute: 750, expectedTotal: 7500, save: true }));
});

it("uses the existing surcharge checkout and keeps the original lesson until payment is verified", async () => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  save.mockResolvedValue({ ok: true, totalAmountMinor: 9000, adjustmentId: booking.id, adjustmentStatus: "pending",
    target: { courtId: courtB.id, date: "2099-10-15", startMinute: 690, endMinute: 750 },
    checkout: { attemptId: booking.id, token: "a".repeat(64), presentation: { kind: "stripe", clientSecret: "pi_secret", publishableKey: "pk_test_Fixture" } },
    holdExpiresAt: "2099-10-15T10:00:00Z" });
  const { onSaved, onAdjustment } = renderLesson();
  await opened();
  await choose(/Court B 2099-10-15 11:30–12:30/, 9000);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(saveButton());
  await screen.findByRole("region", { name: "Booking modification" });
  expect(screen.getByText("Complete your modification")).toBeTruthy();
  expect(screen.getByText("Your original booking remains confirmed until payment and the change are verified.")).toBeTruthy();
  expect(onAdjustment).toHaveBeenLastCalledWith(booking.id);
  expect(onSaved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Simulate verified modification payment" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
});

it("uses the existing refund-backed adjustment without claiming the lesson moved", async () => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  save.mockResolvedValue({ ok: true, totalAmountMinor: 6500, adjustmentId: booking.id, adjustmentStatus: "pending", refundStatus: "pending" });
  const { onSaved, onAdjustment } = renderLesson();
  await opened();
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2099-10-16" } });
  await screen.findByRole("button", { name: /Court B 2099-10-16 12:00–13:00/ });
  await choose(/Court B 2099-10-16 12:00–13:00/, 6500);
  expect(screen.getByText(/Eligible refund:.*RON\s10\.00/)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(saveButton());
  await screen.findByText("Refund requested, awaiting confirmation");
  expect(screen.getByText("Your original booking remains confirmed. The change is applied automatically once the refund is confirmed.")).toBeTruthy();
  expect(onAdjustment).toHaveBeenLastCalledWith(null);
  expect(onSaved).not.toHaveBeenCalled();
});

it("reports a rejected lesson move and keeps the selection for retry", async () => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  let finish!: (value: { ok: false; message: string }) => void;
  save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  renderLesson();
  await opened();
  await choose(/Court A 2099-10-15 11:30–12:30/, 7500);
  const form = saveButton().closest("form")!;
  act(() => { fireEvent.submit(form); fireEvent.submit(form); });
  expect(save).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
  expect(cell(/Court A 2099-10-15 11:30–12:30/)).toHaveProperty("disabled", true);
  await act(async () => finish({ ok: false, message: "The coach is no longer available at that time. The booking has not changed." }));
  await expectToast("The coach is no longer available at that time.");
  expect(cell(/Court A 2099-10-15 11:30–12:30/).getAttribute("aria-pressed")).toBe("true");
  expect(saveButton()).toHaveProperty("disabled", false);
});
