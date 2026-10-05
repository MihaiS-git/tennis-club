// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HistoryActivity } from "@/app/my-activity/bookings/history/history-activity";
import type { CustomerBookingHistoryItem, DirectReservationHistoryItem } from "@/lib/bookings/history";

afterEach(cleanup);

const base: DirectReservationHistoryItem = {
  kind: "reservation", history_at: "2026-09-27T16:30:00Z",
  id: "one", court_id: "court", location_id: "location", updated_at: "2026-10-01T12:00:00Z",
  booking_date: "2026-09-27", starts_at_minute: 1080, ends_at_minute: 1170,
  reason: "Training", status: "active", created_by_user_id: "owner", creator_name: "Alex",
  cancelled_at: null, cancelled_by_name: null, location_name: "RIVUS", location_timezone: "Europe/Bucharest", court_name: "Court 2",
};

const booking: CustomerBookingHistoryItem = {
  kind: "booking", id: "booking", history_at: "2026-09-27T16:30:00Z",
  booking_date: "2026-09-27", starts_at_minute: 1080, ends_at_minute: 1170,
  location_name: "RIVUS", location_timezone: "Europe/Bucharest", court_name: "Court 2",
  status: "confirmed", customer_name: "Snapshot Name", customer_email: "snapshot@example.test",
  customer_phone: "+40 123", cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON",
};

it("shows empty history cleanly", () => {
  render(<HistoryActivity rows={[]} />);
  expect(screen.getByText("No previous or cancelled court activity.")).toBeDefined();
});

it("opens a completed booking with stored contact and price, without actions", () => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
  render(<HistoryActivity rows={[booking, { ...booking, id: "cancelled", status: "cancelled" }]} />);
  expect(screen.getAllByText("Booking")).toHaveLength(2);
  expect(screen.getByText(/RON.*90.*Completed/)).toBeDefined();
  expect(screen.queryByText("snapshot@example.test")).toBeNull();
  fireEvent.click(screen.getAllByRole("button")[0]);
  const details = screen.getByRole("dialog", { name: "Booking details" });
  for (const value of ["Snapshot Name", "snapshot@example.test", "+40 123", "Completed"])
    expect(within(details).getByText(value)).toBeDefined();
  expect(within(details).queryByRole("button", { name: /Edit|Cancel|Change|Restore/ })).toBeNull();
  fireEvent.click(within(details).getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getAllByRole("button")[1]);
  expect(within(screen.getByRole("dialog", { name: "Booking details" })).getByText("Cancelled")).toBeDefined();
});

it("opens cancelled and elapsed reservations with read-only reused details", () => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
  render(<HistoryActivity rows={[{ ...base, id: "cancelled", status: "cancelled",
    cancelled_at: "2026-09-28T10:00:00Z", cancelled_by_name: "Mara" }, base]} />);
  expect(screen.getByText("Cancelled · Training")).toBeDefined();
  expect(screen.getByText("Completed · Training")).toBeDefined();
  fireEvent.click(screen.getAllByRole("button")[0]);
  let details = screen.getByRole("dialog", { name: "Reservation details" });
  expect(within(details).getByText("Mara")).toBeDefined();
  expect(within(details).getByText("Alex")).toBeDefined();
  expect(within(details).queryByRole("button", { name: "Edit reservation" })).toBeNull();
  expect(within(details).queryByRole("button", { name: "Cancel reservation" })).toBeNull();
  fireEvent.click(within(details).getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getAllByRole("button")[1]);
  details = screen.getByRole("dialog", { name: "Reservation details" });
  expect(within(details).getByText("Training")).toBeDefined();
  expect(within(details).queryByRole("button", { name: "Edit reservation" })).toBeNull();
  expect(within(details).queryByRole("button", { name: "Cancel reservation" })).toBeNull();
});
