// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BookingEditForm } from "@/app/reservations/booking-edit-form";
const { load, quote, save } = vi.hoisted(() => ({ load: vi.fn(), quote: vi.fn(), save: vi.fn() }));
vi.mock("@/app/reservations/actions", () => ({ loadAdminBookingEditDayAction: load,
  quoteAdminBookingAction: quote, rescheduleAdminBookingAction: save }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { load.mockReset(); quote.mockReset(); save.mockReset(); });

const court = { id: "22222222-2222-4222-8222-222222222222", name: "Court A", is_active: true };
const booking = { id: "33333333-3333-4333-8333-333333333333", booking_date: "2099-10-15", currency: "RON" as const };
const location = { id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC", is_active: true,
  archived_at: null, courts: [court] };
function renderBooking(scope: "admin" | "owner" = "admin") {
  load.mockResolvedValue({ day: { times: [600, 630, 660, 690], courts: [{ court,
    cells: ["available", "available", "available", "available"] }] }, booking: {
    ...booking, court_id: court.id, starts_at_minute: 600, ends_at_minute: 660, total_amount_minor: 7500,
    location_id: location.id, location_timezone: "UTC", updated_at: "2026-10-01T12:00:00Z",
    booking_updated_at: "2026-10-01T12:00:00Z", location, hours: [], occupancy: [],
  } });
  const onSaved = vi.fn(async () => {});
  render(<BookingEditForm booking={booking} onCancel={vi.fn()} onPendingChange={vi.fn()} onSaved={onSaved}
    actions={scope === "owner" ? { load, quote, save } : undefined} />);
  return onSaved;
}
const saveButton = () => screen.getByRole("button", { name: "Save changes" });
const extendInterval = () => fireEvent.click(screen.getByRole("button", { name: /Court A 2099-10-15 11:00–11:30/ }));

it.each(["admin", "owner"] as const)("requires a current quote for %s rescheduling and disables a reverted interval", async (scope) => {
  let finish: (value: { ok: true; totalAmountMinor: number }) => void = () => { throw new Error("Not quoting"); };
  quote.mockResolvedValueOnce({ ok: true, totalAmountMinor: 7500 })
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  renderBooking(scope);
  await screen.findByText("Current reservation");
  await waitFor(() => expect(quote).toHaveBeenCalledOnce());
  expect(saveButton()).toHaveProperty("disabled", true);
  extendInterval();
  await waitFor(() => expect(quote).toHaveBeenCalledTimes(2));
  expect(saveButton()).toHaveProperty("disabled", true);
  fireEvent.submit(saveButton().closest("form")!);
  expect(save).not.toHaveBeenCalled();
  await act(async () => finish({ ok: true, totalAmountMinor: 7500 }));
  expect(saveButton()).toHaveProperty("disabled", false);
  extendInterval();
  await screen.findByText("Current reservation");
  expect(saveButton()).toHaveProperty("disabled", true);
});

it("invalidates price acknowledgement when the selected interval changes", async () => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 9000 });
  renderBooking();
  await screen.findByText("Current reservation");
  extendInterval();
  await screen.findByRole("checkbox");
  fireEvent.click(screen.getByRole("checkbox"));
  expect(saveButton()).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: /Court A 2099-10-15 11:30–12:00/ }));
  expect(saveButton()).toHaveProperty("disabled", true);
  await waitFor(() => expect(screen.getByRole("checkbox")).toHaveProperty("checked", false));
  expect(saveButton()).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(saveButton()).toHaveProperty("disabled", false);
});

it.each(["returned", "thrown"])("keeps Save disabled after a %s quote failure", async (failure) => {
  quote.mockResolvedValueOnce({ ok: true, totalAmountMinor: 7500 });
  if (failure === "returned") quote.mockResolvedValueOnce({ ok: false, message: "No pricing available." });
  else quote.mockRejectedValueOnce(new Error("Network failure"));
  renderBooking();
  await screen.findByText("Current reservation");
  await waitFor(() => expect(quote).toHaveBeenCalledOnce());
  extendInterval();
  await screen.findByRole("alert");
  expect(saveButton()).toHaveProperty("disabled", true);
  fireEvent.submit(saveButton().closest("form")!);
  expect(save).not.toHaveBeenCalled();
});

it("locks acknowledged bookings while saving and preserves the draft for retry", async () => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 9000 });
  let finish: (value: { ok: false; message: string }) => void = () => { throw new Error("Not saving"); };
  save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce({ ok: true, totalAmountMinor: 9000 });
  const onSaved = renderBooking("owner");
  await screen.findByText("Current reservation");
  extendInterval();
  await screen.findByRole("checkbox");
  fireEvent.click(screen.getByRole("checkbox"));
  const form = saveButton().closest("form")!;
  act(() => { fireEvent.submit(form); fireEvent.submit(form); });
  expect(save).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);
  await act(async () => finish({ ok: false, message: "Try again." }));
  expect(saveButton()).toHaveProperty("disabled", false);
  expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);
  fireEvent.click(saveButton());
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledTimes(2);
});
it("preselects the current interval and requires price acknowledgement and reconfirmation after a changed save quote", async () => {
  const court = { id: "22222222-2222-4222-8222-222222222222", name: "Court A" };
  const booking = { kind: "booking" as const, id: "33333333-3333-4333-8333-333333333333", court_id: court.id,
    booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
    customer_name: "Ana", customer_email: "ana@example.test", customer_phone: "+40 123",
    cancellation_notice_minutes: 120, total_amount_minor: 7500, currency: "RON" as const };
  const location = { id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC", courts: [court] };
  load.mockResolvedValue({ day: { times: [600, 630, 660, 690], courts: [{ court, cells: ["available", "available", "available", "available"] }] },
    booking: { ...booking, location_id: location.id, location_timezone: "UTC", updated_at: "2026-10-01T12:00:00Z",
      booking_updated_at: "2026-10-01T12:00:00Z", occupancy: [] } });
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 9000 });
  save.mockResolvedValueOnce({ ok: false, reason: "price_changed", totalAmountMinor: 10000, message: "The price has changed. Confirm the new total before saving." })
    .mockResolvedValueOnce({ ok: true, totalAmountMinor: 10000 });
  const onSaved = vi.fn(async () => {});
  render(<BookingEditForm booking={booking} location={location} onCancel={vi.fn()} onPendingChange={vi.fn()} onSaved={onSaved} />);
  await screen.findByText("Current reservation");
  expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  expect(screen.queryByRole("textbox", { name: "Reason" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Court A 2099-10-15 11:00–11:30/ }));
  await screen.findByRole("checkbox");
  expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("The price has changed. Confirm the new total before saving.");
  expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
  expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ id: booking.id, courtId: court.id,
    date: booking.booking_date, startMinute: 600, endMinute: 690, expectedTotal: 10000, priceAcknowledged: true, save: true }));
});
