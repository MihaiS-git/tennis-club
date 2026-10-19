// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
const { loadPayment } = vi.hoisted(() => ({ loadPayment: vi.fn() }));
vi.mock(import("@/app/my-activity/bookings/actions"), async (importOriginal) => ({ ...await importOriginal(), loadOwnBookingPaymentAction: loadPayment }));
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
  loadPayment.mockResolvedValue({ ok: true, payment: { method: "pay_at_club", currency: "RON", timezone: "UTC",
    total: 9000, paid: 0, refunded: 0, refundPending: 0, outstanding: 0, dueAtClub: 0, operations: [] } });
  render(<HistoryActivity staff rows={[booking, { ...booking, id: "cancelled", status: "cancelled" }]} />);
  expect(screen.getAllByText("Court", { selector: "td span" })).toHaveLength(2);
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

it("separates completed, processing and failed money movements in a cancelled booking's payment section", async () => {
  installDialogMock();
  loadPayment.mockReset().mockResolvedValue({ ok: true, payment: { method: "online", currency: "RON", timezone: "UTC",
    total: 9000, paid: 12000, refunded: 3000, refundPending: 6000, outstanding: 0, dueAtClub: 0, operations: [
      { kind: "payment", label: "Booking payment", amount: 6000, state: "completed", at: "2026-10-01T10:00:00Z" },
      { kind: "payment", label: "Booking change payment", amount: 6000, state: "completed", at: "2026-10-02T10:00:00Z" },
      { kind: "refund", label: "Booking change refund", amount: 3000, state: "completed", at: "2026-10-03T10:00:00Z" },
      { kind: "refund", label: "Cancellation refund", amount: 6000, state: "pending", at: "2026-10-04T10:00:00Z" },
      { kind: "refund", label: "Cancellation refund", amount: 3000, state: "failed", at: "2026-10-04T10:00:00Z" },
    ] } });
  render(<HistoryActivity rows={[{ ...booking, status: "cancelled" }]} />);
  fireEvent.click(screen.getByRole("row", { name: /Details for/ }));
  const details = screen.getByRole("dialog", { name: "Booking details" });
  expect(loadPayment).toHaveBeenCalledWith("booking");
  const history = await within(details).findByRole("list", { name: "Payment history" });
  expect(Array.from(history.querySelectorAll("li"), item => item.textContent?.replace(/\s/g, " "))).toEqual([
    "Booking payment1 Oct, 10:00+RON 60.00Completed", "Booking change payment2 Oct, 10:00+RON 60.00Completed",
    "Booking change refund3 Oct, 10:00−RON 30.00Completed", "Cancellation refund4 Oct, 10:00−RON 60.00Processing",
    "Cancellation refund4 Oct, 10:00−RON 30.00Failed"]);
  expect(within(details).getByText("Online payment")).toBeDefined();
  expect(within(details).getByText("Refunded").nextElementSibling?.textContent?.replace(/\s/g, " ")).toBe("−RON 30.00");
  expect(within(details).getByText(/not yet confirmed/).closest("dd")?.textContent?.replace(/\s/g, " ")).toContain("RON 60.00");
});

it("offers a retry when payment details cannot be loaded", async () => {
  installDialogMock();
  loadPayment.mockReset().mockResolvedValueOnce({ ok: false, message: "Payment details are unavailable. Try again." })
    .mockResolvedValueOnce({ ok: true, payment: { method: "online", currency: "RON", timezone: "UTC",
      total: 9000, paid: 9000, refunded: 0, refundPending: 0, outstanding: 0, dueAtClub: 0, operations: [] } });
  render(<HistoryActivity rows={[booking]} />);
  fireEvent.click(screen.getByRole("row", { name: /Details for/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByText("Paid").nextElementSibling?.textContent?.replace(/\s/g, " ")).toBe("RON 90.00"));
});

it("gives Completed and Cancelled distinct badge tones in rows and the dialog", () => {
  installDialogMock();
  loadPayment.mockReset().mockResolvedValue({ ok: false, message: "Payment details are unavailable. Try again." });
  render(<HistoryActivity rows={[booking, { ...booking, id: "cancelled", status: "cancelled" }]} />);
  const [completed, cancelled] = ["Completed", "Cancelled"].map(label => screen.getByText(label).className);
  expect(completed).toContain("bg-success-background");
  expect(cancelled).toContain("bg-surface-muted");
  fireEvent.click(screen.getAllByRole("row", { name: /Details for/ })[1]);
  expect(within(screen.getByRole("dialog")).getByText("Cancelled").className).toContain("bg-surface-muted");
});

it.each([true, false])("shows historical coaching names and court types in history (staff=%s)", (staff) => {
  render(<HistoryActivity staff={staff} rows={[booking, { ...booking, id: "lesson", includes_coaching: true,
    coach_name: "Daniel Stoica", coaching_program_name: "Private coaching" }]} />);
  const table = screen.getByRole("table");
  expect(within(table).getByText("Coaching")).toBeDefined();
  expect(within(table).getByText("Daniel Stoica · Private coaching").closest("td")?.textContent)
    .toBe("CoachingDaniel Stoica · Private coaching");
  expect(within(table).getByText("Court", { selector: "td span" })).toBeDefined();
  expect(within(table).getAllByRole("columnheader")).toHaveLength(8);
});
