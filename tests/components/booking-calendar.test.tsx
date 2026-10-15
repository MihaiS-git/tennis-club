// @vitest-environment jsdom
import { expectToast, lastToast } from "../helpers/notifications";
import { installDialogMock } from "../helpers/dialog";
import { Activity, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { refresh, confirm, abandon, paymentProps } = vi.hoisted(() => ({ refresh: vi.fn(), confirm: vi.fn(), abandon: vi.fn(), paymentProps: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/book/actions", () => ({ commitCustomerBookingAction: confirm, abandonCheckoutAction: abandon }));
vi.mock("@/app/book/online-payment", () => ({ OnlinePayment: (props: ComponentProps<typeof import("@/app/book/online-payment").OnlinePayment>) => {
  paymentProps(props);
  return <section aria-label="Online payment"><button onClick={() => props.onConfirmed(11000, "EUR", null)}>Simulate confirmed status</button>
    <button onClick={() => props.onPaymentStatus?.("expired")}>Simulate expiry</button></section>;
} }));
import { BookingCalendar } from "@/app/book/booking-calendar";
import type { CourtDay } from "@/lib/courts/calendar";

beforeEach(() => {
  refresh.mockReset(); confirm.mockReset(); abandon.mockReset();
  installDialogMock();
});
afterEach(cleanup);
const courts: CourtDay[] = [1, 2].map((index) => ({
  court: { id: `${index}1111111-1111-4111-8111-111111111111`, name: `Court ${index}`, slug: `court-${index}`,
    surface: "clay", environment: "outdoor", has_lighting: false },
  cells: ["available", "available", "available", "available"], hourlyPrices: [1200, 1200, 2000, 2000], stateLabel: "outdoor",
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
