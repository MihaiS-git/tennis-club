// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BookingEditForm } from "@/app/reservations/booking-edit-form";
const { load, quote, save } = vi.hoisted(() => ({ load: vi.fn(), quote: vi.fn(), save: vi.fn() }));
vi.mock("@/app/reservations/actions", () => ({ loadAdminBookingEditDayAction: load,
  quoteAdminBookingAction: quote, rescheduleAdminBookingAction: save }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
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
  expect(screen.queryByRole("textbox", { name: "Reason" })).toBeNull();
  await screen.findByRole("checkbox");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("Confirm the new total before saving.");
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText("The price has changed. Confirm the new total before saving.");
  expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ id: booking.id, courtId: court.id,
    date: booking.booking_date, startMinute: 600, endMinute: 660, expectedTotal: 10000, priceAcknowledged: true, save: true }));
});
