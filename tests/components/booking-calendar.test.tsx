// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { refresh, confirm, abandon } = vi.hoisted(() => ({ refresh: vi.fn(), confirm: vi.fn(), abandon: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/book/actions", () => ({ commitCustomerBookingAction: confirm, abandonCheckoutAction: abandon }));
vi.mock("@/app/book/online-payment", () => ({ OnlinePayment: ({ onConfirmed }: ComponentProps<typeof import("@/app/book/online-payment").OnlinePayment>) =>
  <section aria-label="Online payment"><button onClick={() => onConfirmed(11000, "EUR", null)}>Simulate confirmed status</button></section> }));
import { BookingCalendar } from "@/app/book/booking-calendar";
import type { CourtDay } from "@/lib/courts/calendar";

beforeEach(() => {
  refresh.mockReset(); confirm.mockReset(); abandon.mockReset();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
});
afterEach(cleanup);
const courts: CourtDay[] = [1, 2].map((index) => ({
  court: { id: `${index}1111111-1111-4111-8111-111111111111`, name: `Court ${index}`, slug: `court-${index}`,
    surface: "clay", environment: "outdoor", has_lighting: false },
  cells: ["available", "available", "available", "available"], hourlyPrices: [1200, 1200, 2000, 2000], stateLabel: "outdoor",
}));

it("shows one shared court matrix, hourly prices, and one active selection", () => {
  render(<BookingCalendar onlinePaymentAvailable day={{ times: [960, 990, 1020, 1050], courts }} date="2026-10-01" locationName="Club" currency="RON" cancellationNoticeMinutes={120} timezone="Europe/Bucharest" />);
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  expect(screen.getAllByRole("table")).toHaveLength(1);
  expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Court", "16", "17"]);
  expect(screen.getAllByText("12/h")).toHaveLength(4);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30/ }));
  expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText("16:00–17:00 · 60 min")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 17:00–17:30/ }));
  expect(screen.getByText("16:00–17:30 · 90 min")).toBeTruthy();
  expect(screen.getByText(/Total:/).textContent).toMatch(/RON\s*22\.00/);
  expect(screen.queryByText(/Standard price:/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Court 2 2026-10-01 16:00–16:30/ }));
  expect(screen.getByText(/Club · Court 2 ·/)).toBeTruthy();
  expect(screen.getByText("16:00–17:00 · 60 min")).toBeTruthy();
});

it("opens guest details, validates without clearing values, and submits only intent", async () => {
  confirm.mockResolvedValue({ ok: true, status: "confirmed", holdExpiresAt: null, totalAmountMinor: 1200, currency: "RON", cancellationPolicy: { noticeMinutes: 60, cutoff: "2026-10-01T12:00:00Z" } });
  render(<BookingCalendar onlinePaymentAvailable allowPayAtClub day={{ times: [960, 990, 1020, 1050], courts }} date="2026-10-01" locationName="Club" currency="RON" cancellationNoticeMinutes={120} timezone="Europe/Bucharest" />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Club")).toBeTruthy();
  expect(within(dialog).getByText("Court 1")).toBeTruthy();
  expect(within(dialog).getByText("1 Oct 2026")).toBeTruthy();
  expect(within(dialog).getByText("16:00–17:00")).toBeTruthy();
  expect(within(dialog).getByText("60 min")).toBeTruthy();
  expect(within(dialog).getByText(/2 hours' notice/)).toBeTruthy();
  expect(within(dialog).getByText(/RON\s*12\.00/)).toBeTruthy();
  expect((within(dialog).getByLabelText("Online payment") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(dialog).getByLabelText("Pay at club"));
  expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("");
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm booking" }));
  expect(within(dialog).getAllByRole("alert").length).toBeGreaterThan(0);
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Guest Name" } });
  fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "wrong" } });
  fireEvent.change(within(dialog).getByLabelText("Phone"), { target: { value: "+40 123" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm booking" }));
  expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Guest Name");
  expect((within(dialog).getByLabelText("Phone") as HTMLInputElement).value).toBe("+40 123");
  fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "guest@example.test" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm booking" }));
  await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  expect(confirm.mock.calls[0][0]).toEqual({ paymentMethod: "pay_at_club", courtId: courts[0].court.id, date: "2026-10-01",
    startMinute: 960, endMinute: 1020, customerName: "Guest Name",
    customerEmail: "guest@example.test", customerPhone: "+40 123",
    expectedTotalAmountMinor: 1200, expectedCurrency: "RON" });
  await waitFor(() => expect(screen.getByRole("region", { name: "Booking confirmed" })).toBeTruthy());
  expect(screen.queryByRole("region", { name: "Selected interval" })).toBeNull();
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.getByText(/1 hour's notice/)).toBeTruthy();
  expect(screen.getByText(/Cancellation deadline:/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Book another court" }));
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
});

it("prefills editable account contact and preserves it after a booking race", async () => {
  confirm.mockResolvedValueOnce({ ok: false, availabilityChanged: true,
    message: "That court is no longer available for the selected time." });
  const initialContact = { customerName: "Account Name", customerEmail: "account@example.test", customerPhone: "123" };
  render(<BookingCalendar onlinePaymentAvailable day={{ times: [960, 990, 1020, 1050], courts }} date="2026-10-01"
    locationName="Club" currency="RON" cancellationNoticeMinutes={120} timezone="Europe/Bucharest" initialContact={initialContact} />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Account Name");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Booking Name" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Please choose another time."));
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  expect(refresh).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: /Court 2 2026-10-01 16:00–16:30/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Booking Name");
});

it("keeps customer details visible on a server configuration error", async () => {
  confirm.mockResolvedValue({ ok: false, message: "That court is not available for booking." });
  render(<BookingCalendar onlinePaymentAvailable day={{ times: [960, 990, 1020, 1050], courts }} date="2026-10-01" locationName="Club" currency="RON" cancellationNoticeMinutes={120} timezone="Europe/Bucharest" />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Guest" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "guest@example.test" } });
  fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "123" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not available for booking"));
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Guest");
});

it("preserves the draft and interval through repeated price and currency changes before success", async () => {
  confirm.mockResolvedValueOnce({ ok: false, reason: "price_changed", totalAmountMinor: 9900, currency: "RON" })
    .mockResolvedValueOnce({ ok: false, reason: "price_changed", totalAmountMinor: 11000, currency: "EUR" })
    .mockResolvedValueOnce({ ok: true, status: "pending_payment", holdExpiresAt: "2026-10-01T12:10:00Z", totalAmountMinor: 11000, currency: "EUR", cancellationPolicy: null,
      checkout: { attemptId: "11111111-1111-4111-8111-111111111111", token: "a".repeat(64),
        presentation: { kind: "stripe", clientSecret: "test-client-presentation", publishableKey: "test-key" } } });
  render(<BookingCalendar onlinePaymentAvailable day={{ times: [960, 990, 1020, 1050], courts }} date="2026-10-01" locationName="Club" currency="RON" cancellationNoticeMinutes={120} timezone="Europe/Bucharest" />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Guest" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "guest@example.test" } });
  fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "123" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).getByText("Price changed")).toBeTruthy());
  expect(within(dialog).getByText("Previous total").nextSibling?.textContent).toMatch(/RON\s*12\.00/);
  expect(within(dialog).getByText("New total").nextSibling?.textContent).toMatch(/RON\s*99\.00/);
  expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Guest");
  expect(screen.getByRole("region", { name: "Selected interval" })).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue to payment" }));
  await waitFor(() => expect(within(dialog).getByText("New total").nextSibling?.textContent).toMatch(/€\s*110\.00/));
  expect(within(dialog).getByText("Previous total").nextSibling?.textContent).toMatch(/RON\s*99\.00/);
  expect(confirm.mock.calls.map(([input]) => [input.expectedTotalAmountMinor, input.expectedCurrency]))
    .toEqual([[1200, "RON"], [9900, "RON"]]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue to payment" }));
  await screen.findByRole("region", { name: "Online payment" });
  expect(screen.queryByRole("region", { name: "Booking confirmed" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Simulate confirmed status" }));
  const success = await screen.findByRole("region", { name: "Booking confirmed" });
  expect(within(success).getByText(/€\s*110\.00/)).toBeTruthy();
  expect(success).toBeTruthy();
  expect(screen.queryByLabelText("Pay at club")).toBeNull();
  expect(success.textContent).not.toContain("price changed before confirmation");
  expect(confirm.mock.calls[2][0]).toMatchObject({ expectedTotalAmountMinor: 11000,
    expectedCurrency: "EUR", customerName: "Guest", startMinute: 960, endMinute: 1020 });
});

it("disables unconfigured online payment while allowing an explicit Pay at club choice", async () => {
  confirm.mockResolvedValue({ ok: true, status: "confirmed", holdExpiresAt: null,
    totalAmountMinor: 1200, currency: "RON", cancellationPolicy: null });
  render(<BookingCalendar onlinePaymentAvailable={false} allowPayAtClub day={{ times: [960, 990, 1020, 1050], courts }}
    date="2026-10-01" locationName="Club" currency="RON" cancellationNoticeMinutes={120} timezone="Europe/Bucharest"
    initialContact={{ customerName: "Guest", customerEmail: "guest@example.test", customerPhone: "123" }} />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect((screen.getByLabelText("Online payment") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Continue to payment" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Online payment is currently unavailable.")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Pay at club"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm booking" }));
  await screen.findByRole("region", { name: "Booking confirmed" });
  expect(confirm.mock.calls[0][0].paymentMethod).toBe("pay_at_club");
});

it.each(["close", "escape", "cancel"])("confirms checkout abandonment via %s, clears the interval and refreshes only after release", async (trigger) => {
  const checkout = { attemptId: "c9000000-0000-4000-8000-000000000011", token: "a".repeat(64),
    presentation: { kind: "stripe", clientSecret: "pi_fixture_secret", publishableKey: "pk_test_Fixture" } };
  confirm.mockResolvedValue({ ok: true, status: "pending_payment", holdExpiresAt: "2099-10-15T10:00:00Z", checkout,
    totalAmountMinor: 1200, currency: "RON" });
  abandon.mockResolvedValueOnce({ ok: false, message: "Unable to cancel payment. Please try again." }).mockResolvedValueOnce({ ok: true });
  render(<BookingCalendar onlinePaymentAvailable day={{ times: [960, 990, 1020, 1050], courts }}
    date="2026-10-01" locationName="Club" currency="RON" cancellationNoticeMinutes={120} timezone="Europe/Bucharest"
    initialContact={{ customerName: "Guest", customerEmail: "guest@example.test", customerPhone: "123" }} />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  await screen.findByRole("region", { name: "Online payment" });
  const dialog = screen.getByRole("dialog");
  if (trigger === "escape") fireEvent(dialog, new Event("cancel", { cancelable: true }));
  else fireEvent.click(screen.getByRole("button", { name: trigger === "close" ? "Close dialog" : "Cancel payment" }));
  expect(screen.getByText("Cancel payment? Your held court will be released.")).toBeTruthy();
  expect(abandon).not.toHaveBeenCalled();
  // The same close action reverses confirmation without closing the payment dialog.
  if (trigger === "escape") fireEvent(dialog, new Event("cancel", { cancelable: true }));
  else fireEvent.click(screen.getByRole("button", { name: trigger === "close" ? "Close dialog" : "Keep paying" }));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("region", { name: "Online payment" })).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.queryByText("Cancel payment? Your held court will be released.")).toBeNull();
  expect(abandon).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
  await screen.findByText("Unable to cancel payment. Please try again.");
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Selected interval" })).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(abandon).toHaveBeenLastCalledWith({ attemptId: checkout.attemptId, token: checkout.token });
  expect(screen.queryByRole("region", { name: "Selected interval" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Booking confirmed" })).toBeNull();
  expect(refresh).toHaveBeenCalledTimes(1);
});
