// @vitest-environment jsdom
import { toast } from "sonner";
import { expectToast } from "../helpers/notifications";
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BookingEditForm } from "@/components/booking-edit-form";
const { load, quote, save, abandon } = vi.hoisted(() => ({ load: vi.fn(), quote: vi.fn(), save: vi.fn(), abandon: vi.fn() }));
vi.mock("@/app/book/actions", () => ({ abandonCheckoutAction: abandon }));
vi.mock("@/app/book/online-payment", () => ({ OnlinePayment: (props: ComponentProps<typeof import("@/app/book/online-payment").OnlinePayment>) =>
  <button type="button" onClick={() => props.onConfirmed(10000,"RON",null)}>Simulate verified modification payment</button> }));
vi.mock("@/app/my-activity/bookings/actions", () => ({ loadOwnBookingEditDayAction: load,
  quoteOwnBookingAction: quote, rescheduleOwnBookingAction: save }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { load.mockReset(); quote.mockReset(); save.mockReset(); abandon.mockReset(); });

const court = { id: "22222222-2222-4222-8222-222222222222", name: "Court A", is_active: true };
const booking = { id: "33333333-3333-4333-8333-333333333333", booking_date: "2099-10-15", currency: "RON" as const };
const location = { id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "UTC", is_active: true,
  archived_at: null, courts: [court] };
function bookingDay(paymentMethod: "online" | "pay_at_club" = "pay_at_club") {
  return { day: { times: [600, 630, 660, 690], courts: [{ court,
    cells: ["available", "available", "available", "available"] }] }, booking: {
    ...booking, payment_method: paymentMethod, court_id: court.id, starts_at_minute: 600, ends_at_minute: 660, total_amount_minor: 7500,
    location_id: location.id, location_timezone: "UTC", updated_at: "2026-10-01T12:00:00Z",
    current_revision_id: "2026-10-01T12:00:00Z", location, hours: [], occupancy: [], refunds: [],
  } };
}
function renderBooking(scope: "admin" | "owner" = "admin", paymentMethod: "online" | "pay_at_club" = "pay_at_club") {
  load.mockResolvedValue(bookingDay(paymentMethod));
  const onSaved = vi.fn(async () => {});
  render(<BookingEditForm booking={booking} onCancel={vi.fn()} onPendingChange={vi.fn()} onSaved={onSaved}
    actions={scope === "owner" ? { load, quote, save } : undefined} />);
  return onSaved;
}
const saveButton = () => screen.getByRole("button", { name: "Save changes" });
const extendInterval = () => fireEvent.click(screen.getByRole("button", { name: /Court A 2099-10-15 11:00–11:30/ }));

it("loads changed dates and refreshes conflicts without reusing the initial day", async () => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  save.mockResolvedValue({ ok: false, message: "That court is no longer available for the selected time." });
  renderBooking();
  await screen.findByText("Current reservation");
  expect(load).toHaveBeenCalledExactlyOnceWith(booking.id, booking.booking_date);
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2099-10-16" } });
  const slot = await screen.findByRole("button", { name: /Court A 2099-10-16 10:00–10:30/ });
  expect(load).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenLastCalledWith(booking.id, "2099-10-16");
  fireEvent.click(slot);
  await waitFor(() => expect(saveButton()).toHaveProperty("disabled", false));
  const blocked = bookingDay();
  blocked.day.courts[0].cells = ["booked", "booked", "available", "available"];
  load.mockResolvedValueOnce(blocked);
  fireEvent.click(saveButton());
  await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.queryByRole("button", { name: /Court A 2099-10-16 10:00–10:30/ })).toBeNull());
  expect(screen.queryByRole("region", { name: "Selected reservation" })).toBeNull();
  expect(saveButton()).toHaveProperty("disabled", true);
});

it("discards earlier booking responses when switching bookings and reloads on reopening", async () => {
  let finish: (value: ReturnType<typeof bookingDay>) => void = () => { throw new Error("Not loading"); };
  load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(bookingDay());
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  const props = { onCancel: vi.fn(), onPendingChange: vi.fn(), onSaved: vi.fn(async () => {}) };
  const view = render(<BookingEditForm booking={booking} {...props} />);
  const other = { ...booking, id: "88888888-8888-4888-8888-888888888888" };
  const otherDay = bookingDay();
  otherDay.day.courts[0].cells = ["booked", "booked", "available", "available"];
  load.mockResolvedValue(otherDay);
  view.rerender(<BookingEditForm booking={other} {...props} />);
  await screen.findByRole("table", { name: "Court timetable" });
  expect(load.mock.calls).toEqual([[booking.id, booking.booking_date], [other.id, other.booking_date]]);
  await act(async () => finish(bookingDay()));
  expect(screen.queryByRole("button", { name: /Court A 2099-10-15 10:00–10:30/ })).toBeNull();
  view.unmount();
  load.mockResolvedValue(bookingDay());
  render(<BookingEditForm booking={other} {...props} />);
  await screen.findByText("Current reservation");
  expect(load).toHaveBeenCalledTimes(3);
  expect(load).toHaveBeenLastCalledWith(other.id, other.booking_date);
});

it("retries a failed initial booking load by reopening the editor", async () => {
  load.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue(bookingDay());
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  const props = { booking, onCancel: vi.fn(), onPendingChange: vi.fn(), onSaved: vi.fn(async () => {}) };
  const view = render(<BookingEditForm {...props} />);
  await screen.findByRole("alert");
  view.unmount();
  render(<BookingEditForm {...props} />);
  await screen.findByText("Current reservation");
  expect(load).toHaveBeenCalledTimes(2);
});

it("refreshes the preloaded date after a court conflict", async () => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  save.mockResolvedValue({ ok: false, message: "That court is no longer available for the selected time." });
  renderBooking();
  await screen.findByText("Current reservation");
  extendInterval();
  await waitFor(() => expect(saveButton()).toHaveProperty("disabled", false));
  const blocked = bookingDay();
  blocked.day.courts[0].cells = ["available", "available", "booked", "booked"];
  load.mockResolvedValueOnce(blocked);
  fireEvent.click(saveButton());
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(load).toHaveBeenLastCalledWith(booking.id, booking.booking_date);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Selected reservation" })).toBeNull());
  expect(saveButton()).toHaveProperty("disabled", true);
});

it("preserves the revision tokens and rejected draft when the server reports a stale booking", async () => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  save.mockResolvedValue({ ok: false, reason: "stale", message: "This booking has changed. Close and reopen its details." });
  const onSaved = renderBooking();
  await screen.findByText("Current reservation");
  extendInterval();
  await waitFor(() => expect(saveButton()).toHaveProperty("disabled", false));
  fireEvent.click(saveButton());
  await expectToast("This booking has changed.");
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ expectedUpdatedAt: bookingDay().booking.updated_at,
    expectedRevisionId: bookingDay().booking.current_revision_id }));
  expect(screen.getByText("Court A · 10:00–11:30 · 90 min")).toBeDefined();
  expect(onSaved).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledOnce();
});

it.each(["admin", "owner"] as const)("requires a current quote for %s rescheduling and disables a reverted interval", async (scope) => {
  let finish: (value: { ok: true; totalAmountMinor: number }) => void = () => { throw new Error("Not quoting"); };
  quote.mockResolvedValueOnce({ ok: true, totalAmountMinor: 7500 })
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  renderBooking(scope);
  await screen.findByText("Current reservation");
  await waitFor(() => expect(quote).toHaveBeenCalledOnce());
  expect(load).toHaveBeenCalledExactlyOnceWith(booking.id, booking.booking_date);
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
  await expectToast();
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
      current_revision_id: "2026-10-01T12:00:00Z", occupancy: [], refunds: [] } });
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 9000 });
  save.mockResolvedValueOnce({ ok: false, reason: "price_changed", totalAmountMinor: 10000, message: "The price has changed. Confirm the new total before saving." })
    .mockResolvedValueOnce({ ok: true, totalAmountMinor: 10000 });
  const onSaved = vi.fn(async () => {});
  render(<BookingEditForm booking={booking} location={location} onCancel={vi.fn()} onPendingChange={vi.fn()} onSaved={onSaved} />);
  await screen.findByText("Current reservation");
  // An explicit empty refund collection renders no refund entries.
  expect(screen.queryByText(/^Refund /)).toBeNull();
  expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  expect(screen.queryByRole("textbox", { name: "Reason" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Court A 2099-10-15 11:00–11:30/ }));
  await screen.findByRole("checkbox");
  expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await expectToast("The price has changed. Confirm the new total before saving.");
  expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
  expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ id: booking.id, courtId: court.id,
    date: booking.booking_date, startMinute: 600, endMinute: 690, expectedTotal: 10000, priceAcknowledged: true, save: true }));
});


it("owns loading progress through completion, disposal and late responses", async () => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 7500 });
  renderBooking();
  await screen.findByText("Current reservation");
  expect(screen.queryByText("Loading booking…")).toBeNull();
  expect(toast.loading).not.toHaveBeenCalledWith("Loading booking…");
  cleanup();
  let resolve!: (value: unknown) => void;
  load.mockImplementation(() => new Promise(done => { resolve = done; }));
  const view = render(<BookingEditForm booking={booking} onCancel={vi.fn()} onPendingChange={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toBe("Loading booking…");
  view.unmount();
  await act(async () => resolve({ booking: null }));
  expect(screen.queryByText("Loading booking…")).toBeNull();
  expect(toast.loading).not.toHaveBeenCalledWith("Loading booking…");
});

it("shows a genuine load error and suppresses late errors after disposal", async () => {
  load.mockRejectedValue(new Error("Unavailable"));
  const view = render(<BookingEditForm booking={booking} onCancel={vi.fn()} onPendingChange={vi.fn()} onSaved={vi.fn()} />);
  await screen.findByRole("alert");
  expect(toast.error).toHaveBeenCalledWith("This booking is no longer available to edit. Close and reopen its details.");
  const id = vi.mocked(toast.error).mock.results.at(-1)?.value;
  view.unmount();
  expect(toast.dismiss).toHaveBeenCalledWith(id);
  let reject!: (error: Error) => void;
  load.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  const late = render(<BookingEditForm booking={booking} onCancel={vi.fn()} onPendingChange={vi.fn()} onSaved={vi.fn()} />);
  late.unmount();
  const errors = vi.mocked(toast.error).mock.calls.length;
  await act(async () => reject(new Error("Late failure")));
  expect(vi.mocked(toast.error).mock.calls).toHaveLength(errors);
});

it("shows the surcharge and waits for verified payment before completing a paid modification", async () => {
  quote.mockResolvedValue({ok:true,totalAmountMinor:10000});
  save.mockResolvedValue({ok:true,totalAmountMinor:10000,adjustmentId:booking.id,adjustmentStatus:"pending",
    checkout:{attemptId:booking.id,token:"a".repeat(64),presentation:{kind:"stripe",clientSecret:"pi_secret",publishableKey:"pk_test_Fixture"}},
    holdExpiresAt:"2099-10-15T10:00:00Z"});
  const onSaved=renderBooking("owner","online");
  await screen.findByText("Current reservation"); extendInterval();
  await screen.findByText(/Additional amount payable:.*25\.00/);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(saveButton());
  await screen.findByRole("region",{name:"Booking modification"});
  expect(screen.getByText("Current total")).toBeTruthy();
  expect(screen.getByText("Proposed total")).toBeTruthy();
  expect(screen.getByText("Additional amount payable")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Customer payment link" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  expect(onSaved).not.toHaveBeenCalled();
  expect(save.mock.calls[0][0]).toMatchObject({expectedTotal:10000,priceAcknowledged:true,requestId:expect.any(String)});
  fireEvent.click(screen.getByRole("button",{name:"Simulate verified modification payment"}));
  await waitFor(()=>expect(onSaved).toHaveBeenCalledOnce());
});

it("shows the eligible difference and durable pending refund instead of claiming refund success", async () => {
  quote.mockResolvedValue({ok:true,totalAmountMinor:5000});
  save.mockResolvedValue({ok:true,totalAmountMinor:5000,adjustmentId:booking.id,adjustmentStatus:"applied",refundStatus:"pending_retry"});
  const onSaved=renderBooking("owner","online");
  await screen.findByText("Current reservation"); extendInterval();
  await screen.findByText(/Eligible refund:.*25\.00/);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(saveButton());
  await screen.findByText("Refund requested, awaiting confirmation");
  expect(screen.getByText("Refund amount")).toBeTruthy();
  expect(screen.getByText("Refund status")).toBeTruthy();
  expect(screen.queryByText("Refund completed")).toBeNull();
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.queryByRole("button",{name:/^Close$/})).toBeNull();
});

it.each(["succeeded", "failed", "pending"])("separates refund amount and %s status without adding dismissal controls", async (refundStatus) => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 5000 });
  save.mockResolvedValue({ ok: true, totalAmountMinor: 5000, adjustmentId: booking.id, adjustmentStatus: "applied", refundStatus });
  renderBooking("owner", "online");
  await screen.findByText("Current reservation"); extendInterval();
  await screen.findByRole("checkbox"); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(saveButton());
  await screen.findByText("Refund amount");
  expect(screen.getByText("Updated total")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain(refundStatus === "succeeded" ? "Refund completed" : refundStatus === "failed" ? "Refund could not be completed; the club will contact you" : "Refund requested, awaiting confirmation");
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
});

it("reports the unpaid modification for X and offers no other dismissal or recovery control", async () => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 10000 });
  save.mockResolvedValue({ ok: true, totalAmountMinor: 10000, adjustmentId: booking.id, adjustmentStatus: "pending",
    checkout: { attemptId: booking.id, token: "a".repeat(64), presentation: { kind: "stripe", clientSecret: "pi_secret", publishableKey: "pk_test_Fixture" } }, holdExpiresAt: "2099-10-15T10:00:00Z" });
  const onAdjustment = vi.fn();
  load.mockResolvedValue({ day: { times: [600, 630, 660, 690], courts: [{ court, cells: ["available", "available", "available", "available"] }] },
    booking: { ...booking, payment_method: "online", court_id: court.id, starts_at_minute: 600, ends_at_minute: 660, total_amount_minor: 7500,
      location_id: location.id, location_timezone: "UTC", updated_at: "2026-10-01T12:00:00Z",
      current_revision_id: "2026-10-01T12:00:00Z", location, hours: [], occupancy: [], refunds: [] } });
  render(<BookingEditForm booking={booking} onCancel={vi.fn()} onPendingChange={vi.fn()} onSaved={vi.fn(async () => {})}
    onAdjustment={onAdjustment} actions={{ load, quote, save }} />);
  await screen.findByText("Current reservation"); extendInterval();
  await screen.findByRole("checkbox"); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(saveButton());
  await screen.findByRole("region", { name: "Booking modification" });
  expect(onAdjustment).toHaveBeenLastCalledWith(booking.id);
  expect(screen.queryByRole("button", { name: /Cancel modification|Recover/ })).toBeNull();
  expect(abandon).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Simulate verified modification payment" }));
  expect(onAdjustment).toHaveBeenLastCalledWith(null);

  // Reopening is always a fresh form, even when the server still reports the earlier modification.
  cleanup();
  load.mockClear();
  load.mockResolvedValue({ day: { times: [600, 630, 660, 690], courts: [{ court, cells: ["available", "available", "available", "available"] }] },
    booking: { ...booking, payment_method: "online", court_id: court.id, starts_at_minute: 600, ends_at_minute: 660, total_amount_minor: 7500,
      location_id: location.id, location_timezone: "UTC", updated_at: "2026-10-01T12:00:00Z",
      current_revision_id: "2026-10-01T12:00:00Z", location, hours: [], occupancy: [], refunds: [],
      pending_adjustment_id: booking.id, adjustment_status: "pending" },
    adjustment: { totalAmountMinor: 10000, holdExpiresAt: "2099-10-15T10:00:00Z" } });
  render(<BookingEditForm booking={booking} onCancel={vi.fn()} onPendingChange={vi.fn()} onSaved={vi.fn()} actions={{ load, quote, save }} />);
  await screen.findByText("Current reservation");
  expect(load).toHaveBeenCalledExactlyOnceWith(booking.id, booking.booking_date);
  expect(screen.queryByRole("region", { name: "Booking modification" })).toBeNull();
});

it.each(["cancelled", "expired", "unsuccessful"])("presents the %s modification outcome without a bottom Close action", async (adjustmentStatus) => {
  quote.mockResolvedValue({ ok: true, totalAmountMinor: 10000 });
  save.mockResolvedValue({ ok: true, totalAmountMinor: 10000, adjustmentId: booking.id, adjustmentStatus });
  renderBooking("owner", "online");
  await screen.findByText("Current reservation"); extendInterval();
  await screen.findByRole("checkbox"); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(saveButton());
  await screen.findByText("Modification ended");
  expect(screen.getByText("The original booking was preserved.")).toBeTruthy();
  expect(screen.getByText("Proposed total")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
});
