// @vitest-environment jsdom
import { expectToast, lastToast } from "../helpers/notifications";
import { installDialogMock } from "../helpers/dialog";
import { Activity, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { push, refresh, confirm, coachingConfirm, abandon, paymentProps, settled } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), confirm: vi.fn(), coachingConfirm: vi.fn(), abandon: vi.fn(), paymentProps: vi.fn(), settled: { amount: 11000, currency: "EUR" as "EUR" | "RON" } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("@/app/book/actions", () => ({ commitCustomerBookingAction: confirm, commitCoachingBookingAction: coachingConfirm, abandonCheckoutAction: abandon }));
vi.mock("@/app/book/online-payment", () => ({ OnlinePayment: (props: ComponentProps<typeof import("@/app/book/online-payment").OnlinePayment>) => {
  paymentProps(props);
  return <section aria-label="Online payment"><button onClick={() => props.onConfirmed(settled.amount, settled.currency, null)}>Simulate confirmed status</button>
    <button onClick={() => props.onPaymentStatus?.("processing")}>Simulate processing</button>
    <button onClick={() => props.onPaymentStatus?.("unknown")}>Simulate unknown</button>
    <button onClick={() => props.onPaymentStatus?.("expired")}>Simulate expiry</button></section>;
} }));
import { CalendarControls } from "@/app/book/calendar-controls";
import { BookingCalendar } from "@/app/book/booking-calendar";
import { BookCourtLink } from "@/components/book-court-link";
import type { CourtDay } from "@/lib/courts/calendar";

beforeEach(() => {
  push.mockReset(); refresh.mockReset(); confirm.mockReset(); coachingConfirm.mockReset(); abandon.mockReset(); settled.amount = 11000; settled.currency = "EUR";
  window.history.replaceState(null, "", "/book");
  installDialogMock();
});
afterEach(cleanup);
const courts: CourtDay[] = [1, 2].map((index) => ({
  court: { id: `${index}1111111-1111-4111-8111-111111111111`, name: `Court ${index}`, slug: `court-${index}`,
    surface: "clay", environment: "outdoor", has_lighting: false },
  cells: ["available", "available", "available", "available"], hourlyPrices: [1200, 1200, 2000, 2000], rates: [1200, 1200, 2000, 2000], stateLabel: "outdoor",
}));

it("renders natural court order and keeps the selected court when input order changes", () => {
  const unordered = [10, 3, 1, 4, 2].map((number) => ({ ...courts[0], court: { ...courts[0].court, id: `${number}`, name: `C${number}` } }));
  const props = { onlinePaymentAvailable: true, day: { times: [960, 990, 1020, 1050], courts: unordered }, date: "2099-10-15", locationName: "Club", currency: "RON" as const, cancellationNoticeMinutes: 120, timezone: "UTC" };
  const view = render(<BookingCalendar {...props} />);
  expect(screen.getAllByRole("rowheader").map((element) => element.textContent)).toEqual(["C1outdoor", "C2outdoor", "C3outdoor", "C4outdoor", "C10outdoor"]);
  fireEvent.click(screen.getByRole("button", { name: /C10 2099-10-15 16:00–16:30/ }));
  view.rerender(<BookingCalendar {...props} day={{ ...props.day, courts: [...unordered].reverse() }} />);
  expect(screen.getByRole("button", { name: /C10 2099-10-15 16:00–16:30/ })).toHaveProperty("ariaPressed", "true");
  expect(screen.getByRole("region", { name: "Selected interval" }).textContent).toContain("C10");
});

it.each([false, true])("validates required contact fields after submit, retains whitespace values and clears only corrected errors (authenticated=%s)", async (authenticated) => {
  render(<BookingCalendar onlinePaymentAvailable authenticated={authenticated}
    initialContact={authenticated ? { customerName: "", customerEmail: "", customerPhone: "" } : undefined}
    day={{ times: [960, 990, 1020, 1050], courts }} date="2026-10-01" locationName="Club" currency="RON" cancellationNoticeMinutes={120} timezone="Europe/Bucharest" />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).queryAllByRole("alert")).toHaveLength(0);
  const fields = [["Name", "Name is required."], ["Email", "Email address is required."], ["Phone", "Phone number is required."]] as const;
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue to payment" }));
  for (const [label, message] of fields) {
    const field = within(dialog).getByLabelText(label);
    const error = within(dialog).getByText(message);
    expect(field.getAttribute("aria-describedby")).toBe(error.id);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(field, { target: { value: "   " } });
    expect(within(dialog).getByText(message)).toBeTruthy();
    // Native email inputs strip surrounding ASCII whitespace themselves.
    expect(field).toHaveProperty("value", label === "Email" ? "" : "   ");
  }
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue to payment" }));
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "  Ana  " } });
  expect(within(dialog).queryByText("Name is required.")).toBeNull();
  expect(within(dialog).getByText("Email address is required.")).toBeTruthy();
  expect(within(dialog).getByText("Phone number is required.")).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "bad-email" } });
  expect(within(dialog).getByText("Enter a valid email address.")).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText("Phone"), { target: { value: "call me" } });
  expect(within(dialog).getByText("Enter a valid phone number, for example +40 712 345 678.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue to payment" }));
  expect(confirm).not.toHaveBeenCalled();
  expect(within(dialog).getByLabelText("Name")).toHaveProperty("value", "  Ana  ");
  expect(within(dialog).getByLabelText("Email")).toHaveProperty("value", "bad-email");
  expect(within(dialog).getByLabelText("Phone")).toHaveProperty("value", "call me");
  fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "  ana@example.test  " } });
  fireEvent.change(within(dialog).getByLabelText("Phone"), { target: { value: "  +40 712 345 678  " } });
  expect(within(dialog).queryAllByRole("alert")).toHaveLength(0);
  expect(within(dialog).queryByText(/Too small|expected string|Zod/)).toBeNull();
  confirm.mockResolvedValue({ ok: false, message: "Please try again." });
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue to payment" }));
  await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ customerName: "Ana", customerEmail: "ana@example.test", customerPhone: "+40 712 345 678" })));
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "Continue to payment" })).toHaveProperty("disabled", false));
  expect(within(dialog).getByLabelText("Name")).toHaveProperty("value", "  Ana  ");
});

it.each([false, true])("shows errors on blur only for touched contact fields (authenticated=%s)", (authenticated) => {
  render(<BookingCalendar onlinePaymentAvailable authenticated={authenticated} day={{ times: [960, 990, 1020, 1050], courts }}
    date="2026-10-01" locationName="Club" currency="RON" cancellationNoticeMinutes={120} timezone="Europe/Bucharest" />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
  fireEvent.blur(screen.getByLabelText("Name"));
  expect(screen.getByText("Name is required.")).toBeTruthy();
  expect(screen.queryByText("Email address is required.")).toBeNull();
  expect(screen.queryByText("Phone number is required.")).toBeNull();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ana" } });
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
});

it("shows one shared court matrix, hourly prices, and one active selection", () => {
  render(<BookingCalendar onlinePaymentAvailable day={{ times: [960, 990, 1020, 1050], courts }} date="2026-10-01" locationName="Club" currency="RON" cancellationNoticeMinutes={120} timezone="Europe/Bucharest" />);
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  expect(screen.getAllByRole("table")).toHaveLength(1);
  expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Court", "16", "17"]);
  // Cells stay uncluttered; prices are bands beneath each court.
  expect(screen.getAllByRole("button", { name: /^Court \d 2026/ }).every((cell) => cell.textContent === "")).toBe(true);
  expect(screen.getAllByRole("cell", { name: /^Court \d 16:00–17:00, RON 12\/h$/ })).toHaveLength(2);
  expect(screen.getAllByRole("cell", { name: /^Court \d 17:00–18:00, RON 20\/h$/ })).toHaveLength(2);
  expect(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30, RON 12\/h/ })).toBeTruthy();
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
  expect(within(dialog).getByText("Thu, 1 Oct 2026")).toBeTruthy();
  expect(within(dialog).getByText("16:00–17:00")).toBeTruthy();
  expect(within(dialog).getByText("60 min")).toBeTruthy();
  expect(within(dialog).getByText(/2 hours' notice/)).toBeTruthy();
  expect(within(dialog).getByText(/RON\s*12\.00/)).toBeTruthy();
  expect((within(dialog).getByLabelText("Online payment") as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(dialog).getByLabelText("Pay at club"));
  for (const label of ["Name", "Email", "Phone"])
    expect((within(dialog).getByLabelText(label) as HTMLInputElement).value).toBe("");
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

it.each([
  { customerName: "Account Name", customerEmail: "account@example.test", customerPhone: "+40 123" },
  { customerName: "", customerEmail: "account@example.test", customerPhone: "" },
])("prefills editable account contact on first open and preserves edits through failures and refreshes: %j", async (initialContact) => {
  confirm.mockResolvedValueOnce({ ok: false, message: "Unable to book. Please retry.", fieldErrors: { customerPhone: "Check phone." } })
    .mockRejectedValueOnce(new Error("Network failure"))
    .mockResolvedValueOnce({ ok: false, availabilityChanged: true,
      message: "That court is no longer available for the selected time." })
    .mockResolvedValueOnce({ ok: true, status: "confirmed", totalAmountMinor: 1200, currency: "RON", cancellationPolicy: null });
  const props = { onlinePaymentAvailable: true, authenticated: true,
    day: { times: [960, 990, 1020, 1050], courts }, date: "2026-10-01",
    locationName: "Club", currency: "RON", cancellationNoticeMinutes: 120, timezone: "Europe/Bucharest" } satisfies ComponentProps<typeof BookingCalendar>;
  const { rerender } = render(<BookingCalendar {...props} initialContact={{ ...initialContact, customerPhone: "" }} />);
  // A refreshed profile before the first open supplies the latest defaults.
  rerender(<BookingCalendar {...props} initialContact={initialContact} />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const fields = [["Name", "customerName"], ["Email", "customerEmail"], ["Phone", "customerPhone"]] as const;
  for (const [label, key] of fields)
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(initialContact[key]);
  const editedContact = { customerName: "Booking Name", customerEmail: "booking@example.test", customerPhone: "+40 456" };
  for (const [label, key] of fields)
    fireEvent.change(screen.getByLabelText(label), { target: { value: editedContact[key] } });
  function expectEdits() {
    for (const [label, key] of fields)
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(editedContact[key]);
  }
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "invalid" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  expect(confirm).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("invalid");
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: editedContact.customerEmail } });
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  await screen.findByText("Check phone.");
  expectEdits();
  rerender(<BookingCalendar {...props} initialContact={{ customerName: "Refreshed Name", customerEmail: "refreshed@example.test", customerPhone: "+40 999" }} />);
  expectEdits();
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  await expectToast("Unable to confirm the booking. Please try again.");
  expectEdits();
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  await waitFor(() => expect(lastToast("warning")).toContain("Please choose another time."));
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  expect(refresh).toHaveBeenCalledOnce();
  rerender(<BookingCalendar {...props} initialContact={initialContact} />);
  fireEvent.click(screen.getByRole("button", { name: /Court 2 2026-10-01 16:00–16:30/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expectEdits();
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  await screen.findByRole("region", { name: "Booking confirmed" });
  expect(confirm).toHaveBeenCalledTimes(4);
  for (const [intent] of confirm.mock.calls) expect(intent).toMatchObject(editedContact);
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

const checkout = { attemptId: "c9000000-0000-4000-8000-000000000011", token: "a".repeat(64),
  presentation: { kind: "stripe", clientSecret: "pi_fixture_secret", publishableKey: "pk_test_Fixture" } };
async function openCheckout() {
  confirm.mockResolvedValue({ ok: true, status: "pending_payment", holdExpiresAt: "2099-10-15T10:00:00Z", checkout,
    totalAmountMinor: 1200, currency: "RON" });
  render(<BookingCalendar onlinePaymentAvailable day={{ times: [960, 990, 1020, 1050], courts }}
    date="2026-10-01" locationName="Club" currency="RON" cancellationNoticeMinutes={120} timezone="Europe/Bucharest"
    initialContact={{ customerName: "Guest", customerEmail: "guest@example.test", customerPhone: "123" }} />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  await screen.findByRole("region", { name: "Online payment" });
}

function renderNavbarBookingLink() {
  // Prevent jsdom's document navigation after the real link handler runs.
  return render(<nav onClick={event => event.preventDefault()}><BookCourtLink className="" /></nav>);
}

it("starts a fresh booking from the navbar after verified online payment on the same route", async () => {
  renderNavbarBookingLink();
  await openCheckout();
  fireEvent.click(screen.getByRole("button", { name: "Simulate confirmed status" }));
  await screen.findByRole("region", { name: "Booking confirmed" });
  expect(screen.getByText(/Online payment received/)).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.body.style.overflow).toBe("");
  fireEvent.click(screen.getByRole("link", { name: "Book a court" }));
  expect(screen.queryByRole("region", { name: "Booking confirmed" })).toBeNull();
  expect(screen.getByRole("table")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Selected interval" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Court 2 2026-10-01 17:00–17:30/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continue to payment" })).toBeTruthy();
  expect(confirm).toHaveBeenCalledOnce();
  expect(abandon).not.toHaveBeenCalled();
});

it.each(["pending", "processing", "unknown"])("navbar re-selection preserves %s payment and its confirmation callback", async status => {
  renderNavbarBookingLink();
  await openCheckout();
  if (status !== "pending") fireEvent.click(screen.getByRole("button", { name: `Simulate ${status}` }));
  const payment = screen.getByRole("region", { name: "Online payment" });
  fireEvent.click(screen.getByRole("link", { name: "Book a court" }));
  expect(screen.getByRole("region", { name: "Online payment" })).toBe(payment);
  expect(abandon).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Simulate confirmed status" }));
  await screen.findByRole("region", { name: "Booking confirmed" });
});

it("preserves an incomplete booking when re-selecting the navbar link", () => {
  renderNavbarBookingLink();
  render(<BookingCalendar onlinePaymentAvailable day={{ times: [960, 990, 1020, 1050], courts }}
    date="2026-10-01" locationName="Club" currency="RON" cancellationNoticeMinutes={120} timezone="UTC" />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30/ }));
  fireEvent.click(screen.getByRole("link", { name: "Book a court" }));
  expect(screen.getByRole("region", { name: "Selected interval" })).toBeTruthy();
  expect(confirm).not.toHaveBeenCalled();
});
it.each(["Close dialog", "Close", "escape"])("%s dismisses an expired checkout without cancellation or late reopening", async trigger => {
  await openCheckout();
  const late = paymentProps.mock.calls.at(-1)![0].onConfirmed;
  fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
  fireEvent.click(screen.getByRole("button", { name: "Simulate expiry" }));
  expect(screen.queryByRole("button", { name: "Keep paying" })).toBeNull();
  if (trigger === "escape") fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  else fireEvent.click(screen.getByRole("button", { name: trigger }));
  expect(screen.queryByRole("dialog")).toBeNull();
  late(11000, "EUR", null);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("region", { name: "Booking confirmed" })).toBeNull();
  expect(abandon).not.toHaveBeenCalled();
  expect(lastToast("warning")).toContain("does not confirm payment cancellation");
});
it("stops payment on cancellation, rejects late confirmations, retries safely, and closes after verified cancellation", async () => {
  await openCheckout();
  const late = paymentProps.mock.calls.at(-1)![0].onConfirmed;
  abandon.mockResolvedValueOnce({ ok: false, message: "Unable to confirm cancellation. Do not pay again yet." })
    .mockResolvedValueOnce({ ok: true, paymentStatus: "cancelled" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
  fireEvent.click(screen.getByRole("button", { name: "Keep paying" }));
  expect(abandon).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
  await expectToast("Unable to confirm cancellation");
  expect(screen.queryByRole("region", { name: "Online payment" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Keep paying" })).toBeNull();
  late(11000, "EUR", null);
  expect(screen.queryByRole("region", { name: "Booking confirmed" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry cancellation" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(abandon).toHaveBeenLastCalledWith({ attemptId: checkout.attemptId, token: checkout.token });
  expect(refresh).toHaveBeenCalledOnce();
});
it("can leave while the cancellation action is unavailable and ignores its late result", async () => {
  let finish!: (value: unknown) => void;
  abandon.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await openCheckout();
  fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel payment" }));
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  finish({ ok: true, paymentStatus: "cancelled" });
  await waitFor(() => expect(lastToast("warning")).toContain("does not confirm payment cancellation"));
  expect(screen.queryByRole("region", { name: "Booking confirmed" })).toBeNull();
});


it.each([false, true])("shows staff-handled cancellation instructions only for guest bookings (authenticated=%s)", async (authenticated) => {
  const instruction = "To request cancellation, please contact the club before the cancellation deadline. Club staff will handle your request and any applicable refund.";
  confirm.mockResolvedValue({ ok: true, status: "confirmed", holdExpiresAt: null, totalAmountMinor: 1200, currency: "RON", cancellationPolicy: { noticeMinutes: 60, cutoff: "2026-10-01T12:00:00Z" } });
  render(<BookingCalendar onlinePaymentAvailable allowPayAtClub authenticated={authenticated} initialContact={{ customerName: "Player", customerEmail: "player@example.test", customerPhone: "+40 123" }}
    day={{ times: [960, 990, 1020, 1050], courts }} date="2026-10-01" locationName="Club" currency="RON" cancellationNoticeMinutes={120} timezone="UTC" />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const dialogTerms = within(screen.getByRole("dialog")).getByRole("region", { name: "Cancellation terms" });
  expect(within(dialogTerms).getByText(/2 hours' notice/)).toBeTruthy();
  expect(within(dialogTerms).queryByText(instruction) !== null).toBe(!authenticated);
  if (!authenticated) for (const [label, value] of [["Name", "Player"], ["Email", "player@example.test"], ["Phone", "+40 123"]])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByLabelText("Pay at club"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm booking" }));
  const confirmed = await screen.findByRole("region", { name: "Booking confirmed" });
  const confirmedTerms = within(confirmed).getByRole("region", { name: "Cancellation terms" });
  expect(within(confirmedTerms).getByText(/1 hour's notice/)).toBeTruthy();
  expect(within(confirmedTerms).queryByText(instruction) !== null).toBe(!authenticated);
});

it("discards completed confirmation when Next.js hides and restores the route, while active refresh preserves it", async () => {
  confirm.mockResolvedValue({ ok: true, status: "confirmed", totalAmountMinor: 1200, currency: "RON", cancellationPolicy: null });
  const calendar = <BookingCalendar onlinePaymentAvailable allowPayAtClub authenticated initialContact={{ customerName: "Member", customerEmail: "member@example.test", customerPhone: "+40 123" }}
    day={{ times: [960, 990, 1020, 1050], courts }} date="2026-10-01" locationName="Club" currency="RON" cancellationNoticeMinutes={120} timezone="UTC" />;
  const { rerender } = render(<Activity mode="visible">{calendar}</Activity>);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByLabelText("Pay at club"));
  fireEvent.click(screen.getByRole("button", { name: "Confirm booking" }));
  await screen.findByRole("region", { name: "Booking confirmed" });
  rerender(<Activity mode="visible">{calendar}</Activity>);
  expect(screen.getByRole("region", { name: "Booking confirmed" })).toBeTruthy();
  rerender(<Activity mode="hidden">{calendar}</Activity>);
  rerender(<Activity mode="visible">{calendar}</Activity>);
  expect(screen.queryByRole("region", { name: "Booking confirmed" })).toBeNull();
  expect(screen.getByRole("table")).toBeTruthy();
  expect(confirm).toHaveBeenCalledOnce();
});

it("splits price bands at half-hour rate changes and keeps the rate visible on booked time", () => {
  const court: CourtDay = { ...courts[0], cells: ["available", "available", "booked", "available"],
    hourlyPrices: [1200, 1500, null, 2000], rates: [1200, 1500, 1500, 2000] };
  render(<BookingCalendar onlinePaymentAvailable day={{ times: [960, 990, 1020, 1050], courts: [court] }} date="2026-10-01"
    locationName="Club" currency="RON" cancellationNoticeMinutes={120} timezone="UTC" />);
  const bands = within(screen.getByRole("row", { name: "Court 1 hourly prices" })).getAllByRole("cell").filter((cell) => cell.hasAttribute("aria-colspan"));
  expect(bands.map((band) => [band.getAttribute("aria-label"), band.textContent])).toEqual([
    ["Court 1 16:00–16:30, RON 12/h", "12"], ["Court 1 16:30–17:30, RON 15/h", "15"], ["Court 1 17:30–18:00, RON 20/h", "20"]]);
  // The selected-interval quote stays authoritative.
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2026-10-01 16:00–16:30/ }));
  expect(screen.getByText(/Total:/).textContent).toMatch(/RON\s*13\.50/);
});

it("gives every unavailable state its own non-danger treatment and a matching legend entry", () => {
  const row: CourtDay = { ...courts[0], cells: ["past", "booked", "closed", "unavailable", "available", "available"],
    hourlyPrices: [null, null, null, null, 1200, 1200], rates: [1200, 1200, null, null, 1200, 1200] };
  render(<BookingCalendar day={{ times: [960, 990, 1020, 1050, 1080, 1110], courts: [row] }} date="2099-10-15" locationName="Club"
    currency="RON" cancellationNoticeMinutes={120} timezone="UTC" />);
  const legend = screen.getByRole("list", { name: "Timetable legend" });
  expect(Array.from(legend.querySelectorAll("li"), (item) => item.textContent)).toEqual(["Available", "Booked", "Past", "Closed", "No pricing", "Selected"]);
  const classes = ["Past", "Booked", "Closed", "No pricing"].map((label) => screen.getByLabelText(new RegExp(`Court 1 .*, ${label}$`)).className);
  for (const className of classes) expect(className).not.toMatch(/danger/);
  expect(new Set(classes).size).toBe(4);
  fireEvent.click(screen.getByRole("button", { name: /18:00–18:30/ }));
  expect(screen.getByRole("button", { name: /18:00–18:30.*selected/ }).className).toContain("bg-primary");
});


const coaching = {
  locationId: "a1111111-1111-4111-8111-111111111111", programId: "b1111111-1111-4111-8111-111111111111",
  coachId: "c1111111-1111-4111-8111-111111111111", programName: "Private technique", coachName: "Coach Ana",
  durationMinutes: 90, participantCount: 1 as const, courtRentalIncluded: false,
  starts: [{ startMinute: 960, endMinute: 1050, startsAt: "2099-10-15T16:00:00Z", endsAt: "2099-10-15T17:30:00Z",
    courts: courts.map((court, index) => ({ id: court.court.id, name: court.court.name,
      coachingAmountMinor: 12000, courtAmountMinor: 5000 + index * 1000, totalAmountMinor: 17000 + index * 1000 })) }],
};
const coachingProps = { day: { times: [960, 990, 1020, 1050], courts }, date: "2099-10-15", locationName: "Club", currency: "RON" as const,
  cancellationNoticeMinutes: 120, timezone: "UTC", onlinePaymentAvailable: true, allowPayAtClub: false, coaching };

it("uses the same timetable for every court but only allows complete server-offered lessons", () => {
  const blocked = { ...courts[0], court: { ...courts[0].court, id: "blocked", name: "Court 3" } };
  render(<BookingCalendar {...coachingProps} day={{ ...coachingProps.day, courts: [...courts, blocked] }} />);
  expect(screen.getAllByRole("rowheader")).toHaveLength(3);
  expect(screen.queryByRole("region", { name: "Selected interval" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Court 3/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Court 1 2099-10-15 16:30–/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Court 1 .*90 min lesson/ }));
  expect(screen.getByRole("region", { name: "Selected interval" }).textContent).toContain("16:00–17:30 · 90 min");
  expect(screen.getByRole("region", { name: "Selected interval" }).textContent).toMatch(/170[.,]00/);
  const selectedCells = document.querySelectorAll('[aria-label$=", selected"]');
  expect(selectedCells).toHaveLength(3);
  for (const cell of selectedCells) expect(cell.classList.contains("bg-primary")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Court 2 .*90 min lesson/ }));
  expect(screen.getByRole("region", { name: "Selected interval" }).textContent).toMatch(/180[.,]00/);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const details = screen.getByRole("region", { name: "Booking details" });
  expect(details.textContent).toContain("Private technique");
  expect(details.textContent).toContain("Coach Ana");
  expect(details.textContent).toMatch(/120[.,]00/);
  expect(details.textContent).toMatch(/60[.,]00/);
  expect(screen.queryByRole("radio", { name: "Pay at club" })).toBeNull();
});

it("does not offer lessons across an occupied cell even when advisory offers have become stale", () => {
  render(<BookingCalendar {...coachingProps} day={{ ...coachingProps.day, courts: courts.map(row => ({ ...row, cells: ["available", "booked", "available", "available"] })) }} />);
  expect(screen.queryByRole("button", { name: /90 min lesson/ })).toBeNull();
});

it.each([{ authenticated: false, semi: false }, { authenticated: true, semi: false }, { authenticated: false, semi: true }, { authenticated: true, semi: true }])("reuses coaching contact and verified confirmation (authenticated=$authenticated, semi=$semi)", async ({ authenticated, semi }) => {
  const selectedCoaching = semi ? { ...coaching, programName: "Semi-private coaching", participantCount: 2 as const } : coaching;
  coachingConfirm.mockResolvedValue({ ok: true, status: "pending_payment", holdExpiresAt: "2099-10-15T10:00:00Z", checkout,
    totalAmountMinor: 17000, currency: "RON" });
  settled.amount = 17000; settled.currency = "RON";
  const view = render(<BookingCalendar {...coachingProps} coaching={selectedCoaching} authenticated={authenticated}
    initialContact={authenticated ? { customerName: "Account", customerEmail: "account@example.test", customerPhone: "123" } : undefined} />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 .*90 min lesson/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  if (!authenticated) {
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Guest" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "guest@example.test" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "123" } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  await screen.findByRole("region", { name: "Online payment" });
  expect(screen.queryByRole("region", { name: "Booking confirmed" })).toBeNull();
  expect(coachingConfirm).toHaveBeenCalledExactlyOnceWith({ locationId: coaching.locationId, programId: coaching.programId,
    coachId: coaching.coachId, courtId: courts[0].court.id, date: "2099-10-15", startMinute: 960, durationMinutes: 90,
    customerName: authenticated ? "Account" : "Guest", customerEmail: authenticated ? "account@example.test" : "guest@example.test",
    customerPhone: "123", expectedTotalAmountMinor: 17000, expectedCurrency: "RON" });
  expect(confirm).not.toHaveBeenCalled();
  // Server Action revalidation makes our protected hold unavailable publicly.
  // The mounted checkout must retain the original lesson breakdown and total.
  view.rerender(<BookingCalendar {...coachingProps} authenticated={authenticated} coaching={{ ...selectedCoaching, starts: [] }} />);
  const heldDetails = screen.getByRole("region", { name: "Booking details" });
  expect(heldDetails.textContent).toMatch(/120[.,]00/);
  expect(heldDetails.textContent).toMatch(/50[.,]00/);
  expect(heldDetails.textContent).toMatch(/170[.,]00/);
  fireEvent.click(screen.getByRole("button", { name: "Simulate expiry" }));
  expect(screen.queryByRole("region", { name: "Booking confirmed" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Simulate confirmed status" }));
  const success = await screen.findByRole("region", { name: "Booking confirmed" });
  expect(success.textContent).toContain("Your coach and court are booked");
  expect(success.textContent).toContain(selectedCoaching.programName);
  expect(success.textContent).toContain(semi ? "2 players" : "1 player");
  expect(success.textContent).not.toContain("confirmation email");
  expect(screen.queryByRole("link", { name: "View my bookings" }) !== null).toBe(authenticated);
});

it.each(["price", "availability"])("clears stale coaching %s and retains entered contact for a fresh selection", async kind => {
  coachingConfirm.mockResolvedValue(kind === "price" ? { ok: false, reason: "price_changed", totalAmountMinor: 19000, currency: "RON" }
    : { ok: false, availabilityChanged: true, message: "The coach is no longer available." });
  render(<BookingCalendar {...coachingProps} initialContact={{ customerName: "Guest", customerEmail: "guest@example.test", customerPhone: "123" }} />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 .*90 min lesson/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Edited guest" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("region", { name: "Selected interval" })).toBeNull();
  expect(refresh).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Court 2 .*90 min lesson/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Edited guest");
});

it("shows court rental included and uses the supplied lesson total without adding court-only rates", () => {
  const included = { ...coaching, courtRentalIncluded: true, starts: coaching.starts.map(start => ({ ...start,
    courts: start.courts.map(court => ({ ...court, coachingAmountMinor: 12000, courtAmountMinor: 0, totalAmountMinor: 12000 })) })) };
  render(<BookingCalendar {...coachingProps} coaching={included} />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 .*90 min lesson/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("region", { name: "Booking details" }).textContent).toContain("Included");
  expect(screen.getByRole("region", { name: "Booking details" }).textContent).toMatch(/120[.,]00/);
});


it("keeps coaching unconfirmed when checkout initialization fails", async () => {
  coachingConfirm.mockResolvedValue({ ok: false, message: "Online payment is unavailable." });
  render(<BookingCalendar {...coachingProps} initialContact={{ customerName: "Guest", customerEmail: "guest@example.test", customerPhone: "123" }} />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 .*90 min lesson/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  await waitFor(() => expect(coachingConfirm).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("region", { name: "Online payment" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Booking confirmed" })).toBeNull();
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Guest");
  expect(confirm).not.toHaveBeenCalled();
});


it("switches programs with fresh selections and retains customer contact", () => {
  const view = render(<BookingCalendar {...coachingProps} />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 .*90 min lesson/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Name/ }), { target: { value: "Returning Guest" } });
  const semi = { ...coaching, programId: "semi", programName: "Semi-private coaching", participantCount: 2 as const };
  view.rerender(<BookingCalendar {...coachingProps} coaching={semi} />);
  expect(screen.queryByRole("region", { name: "Selected interval" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: /Name/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Court 1 .*90 min lesson/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("textbox", { name: /Name/ })).toHaveProperty("value", "Returning Guest");
  const details = screen.getByRole("region", { name: "Booking details" });
  expect(details.textContent).toContain("Semi-private coaching");
  expect(details.textContent).toContain("Participants2 players");
  expect(details.textContent).toMatch(/170[.,]00/);
});


it("switches coaches with fresh offers, preserves courts and clears the old lesson", () => {
  const view = render(<BookingCalendar {...coachingProps} />);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 .*90 min lesson/ }));
  expect(screen.getByRole("region", { name: "Selected interval" })).toBeTruthy();
  view.rerender(<BookingCalendar {...coachingProps} coaching={{ ...coaching, coachId: "other-coach", coachName: "Coach Dan", starts: [] }} />);
  expect(screen.queryByRole("region", { name: "Selected interval" })).toBeNull();
  expect(screen.queryByRole("button", { name: /90 min lesson/ })).toBeNull();
  expect(screen.getAllByRole("rowheader")).toHaveLength(courts.length);
  expect(screen.getByText("No lesson start")).toBeTruthy();
  view.rerender(<BookingCalendar {...coachingProps} />);
  expect(screen.getAllByRole("button", { name: /90 min lesson/ })).toHaveLength(courts.length);
});


function CoachingResetControls() {
  return <CalendarControls locations={[{ id: coaching.locationId, name: "Club" }]} locationId={coaching.locationId}
    date={coachingProps.date} today={coachingProps.date} coaching={{ program: coaching.programId, coach: coaching.coachId, duration: "90" }} />;
}

it("Clear filters clears the selected lesson even when the default URL and timetable context stay the same", () => {
  window.history.replaceState(null, "", "/book?mode=coaching");
  render(<><CoachingResetControls /><BookingCalendar {...coachingProps} /></>);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 .*90 min lesson/ }));
  expect(screen.getByRole("region", { name: "Selected interval" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.queryByRole("region", { name: "Selected interval" })).toBeNull();
  expect(refresh).toHaveBeenCalledOnce();
  expect(coachingConfirm).not.toHaveBeenCalled();
  expect(abandon).not.toHaveBeenCalled();
});

it.each(["review", "submitting", "pending", "processing"])("Clear filters preserves %s confirmation/payment and cannot navigate or cancel it", async phase => {
  if (phase === "submitting") coachingConfirm.mockImplementation(() => new Promise(() => {}));
  else coachingConfirm.mockResolvedValue({ ok: true, status: "pending_payment", holdExpiresAt: "2099-10-15T10:00:00Z", checkout,
    totalAmountMinor: 17000, currency: "RON" });
  render(<><CoachingResetControls /><BookingCalendar {...coachingProps} authenticated
    initialContact={{ customerName: "Member", customerEmail: "member@example.test", customerPhone: "123" }} /></>);
  fireEvent.click(screen.getByRole("button", { name: /Court 1 .*90 min lesson/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  if (phase !== "review") fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
  if (phase === "pending" || phase === "processing") await screen.findByRole("region", { name: "Online payment" });
  if (phase === "processing") fireEvent.click(screen.getByRole("button", { name: "Simulate processing" }));
  refresh.mockClear();
  // jsdom does not enforce native modal inertness; this also exercises the
  // cancellation guard against a programmatically dispatched background click.
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Selected interval" })).toBeTruthy();
  expect(push).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(abandon).not.toHaveBeenCalled();
  expect(coachingConfirm).toHaveBeenCalledTimes(phase === "review" ? 0 : 1);
  if (phase === "pending" || phase === "processing") expect(screen.getByRole("region", { name: "Online payment" })).toBeTruthy();
});
