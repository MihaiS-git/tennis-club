// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { HistoryActivity } from "@/app/my-activity/history/history-activity";
import type { CustomerBookingHistoryItem } from "@/lib/bookings/history";

afterEach(cleanup);

const booking: CustomerBookingHistoryItem = {
  kind: "booking", id: "booking", history_at: "2026-09-27T16:30:00Z",
  booking_date: "2026-09-27", starts_at_minute: 1080, ends_at_minute: 1170,
  location_name: "RIVUS", location_timezone: "Europe/Bucharest", court_name: "Court 2",
  status: "confirmed", customer_name: "Snapshot Name", customer_email: "snapshot@example.test",
  customer_phone: "+40 123", cancellation_notice_minutes: 120, total_amount_minor: 9000, currency: "RON",
};

it("opens a completed booking with stored contact and price, without actions", () => {
  installDialogMock();
  render(<HistoryActivity staff rows={[booking, { ...booking, id: "cancelled", status: "cancelled" }]} />);
  expect(screen.getAllByText("Booking")).toHaveLength(2);
  expect(screen.getAllByText(/RON.*90/)).toHaveLength(2);
  expect(screen.getByText("Completed")).toBeDefined();
  expect(screen.queryByText("snapshot@example.test")).toBeNull();
  fireEvent.keyDown(screen.getAllByRole("row", { name: /Details for/ })[0], { key: " " });
  const details = screen.getByRole("dialog", { name: "Booking details" });
  for (const value of ["Snapshot Name", "snapshot@example.test", "+40 123", "Completed"])
    expect(within(details).getByText(value)).toBeDefined();
  expect(within(details).queryByRole("button", { name: /Edit|Cancel|Change|Restore/ })).toBeNull();
  fireEvent.click(within(details).getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getAllByRole("row", { name: /Details for/ })[1]);
  expect(within(screen.getByRole("dialog", { name: "Booking details" })).getByText("Cancelled")).toBeDefined();
});
