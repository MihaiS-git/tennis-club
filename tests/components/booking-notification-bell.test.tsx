// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { installDialogMock } from "../helpers/dialog";
import type { CommitBookingResult } from "@/app/book/actions";

const { commit, cancel } = vi.hoisted(() => ({ commit: vi.fn(), cancel: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/app/book/actions", () => ({ commitCustomerBookingAction: commit, abandonCheckoutAction: vi.fn() }));
vi.mock("@/app/book/online-payment", () => ({ OnlinePayment: () => null }));
vi.mock("@/app/my-activity/bookings/actions", () => ({ cancelOwnCustomerBookingAction: cancel }));
import { BookingConfirmation } from "@/app/book/booking-confirmation";
import { CustomerBookingCancellation } from "@/app/my-activity/bookings/customer-booking-cancellation";
import { NotificationBell } from "@/components/notification-bell";

const flush = async () => { await act(async () => {}); };
const booking = {
  id: "11111111-1111-4111-8111-111111111111", starts_at_instant: "2099-10-15T10:00:00Z",
  booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660,
  location_name: "Club", location_timezone: "UTC", court_name: "Court 1",
  customer_name: "Owner", customer_email: "owner@example.test", customer_phone: "+40 712 345 678",
  cancellation_notice_minutes: 1440, total_amount_minor: 1200, currency: "RON" as const,
};
beforeEach(() => { installDialogMock(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

test.each(["confirmed", "pending_payment", "failed"] as const)("booking %s refreshes both bells only after committed confirmation, without waiting for a poll", async outcome => {
  let persistedUnread = false;
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ unread: persistedUnread }) }));
  vi.stubGlobal("fetch", fetcher);
  let finish!: (result: CommitBookingResult) => void;
  commit.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const details = { locationName: "Club", courtName: "Court 1", date: booking.booking_date,
    startMinute: 600, endMinute: 660, durationMinutes: 60, priceMinor: 1200, currency: "RON" as const };
  render(<><NotificationBell /><NotificationBell /><BookingConfirmation
    selection={{ courtId: booking.id, startMinute: 600, endMinute: 660, durationMinutes: 60, priceMinor: 1200, startRowIndex: 0, endRowIndex: 2 }}
    details={details} contact={{ customerName: booking.customer_name, customerEmail: booking.customer_email, customerPhone: booking.customer_phone }}
    allowPayAtClub onlinePaymentAvailable cancellationNoticeMinutes={1440} timezone="UTC"
    onContactChange={vi.fn()} onBack={vi.fn()} onCommitted={vi.fn()} onUnavailable={vi.fn()} onAbandoned={vi.fn()} /></>);
  await flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const dialog = within(screen.getByRole("dialog"));
  if (outcome !== "pending_payment") fireEvent.click(dialog.getByLabelText("Pay at club"));
  fireEvent.click(dialog.getByRole("button", { name: outcome === "pending_payment" ? "Continue to payment" : "Confirm booking" }));
  expect(commit).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(document.querySelectorAll("[data-unread-indicator]")).toHaveLength(0);
  persistedUnread = outcome === "confirmed";
  await act(async () => finish(outcome === "failed" ? { ok: false, message: "Booking failed." }
    : outcome === "confirmed" ? { ok: true, status: "confirmed", holdExpiresAt: null, totalAmountMinor: 1200, currency: "RON", cancellationPolicy: null }
    : { ok: true, status: "pending_payment", holdExpiresAt: "2099-10-15T09:00:00Z", totalAmountMinor: 1200, currency: "RON", cancellationPolicy: null,
      checkout: { attemptId: booking.id, token: "a".repeat(64), presentation: { kind: "stripe", publishableKey: "pk_test", clientSecret: "secret" } } }));
  await flush();
  expect(fetcher).toHaveBeenCalledTimes(outcome === "confirmed" ? 2 : 1);
  expect(document.querySelectorAll("[data-unread-indicator]")).toHaveLength(outcome === "confirmed" ? 2 : 0);
});

test.each([true, false])("cancellation refreshes both bells only after server success (%s), before refreshing details", async success => {
  let persistedUnread = false;
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ unread: persistedUnread }) }));
  vi.stubGlobal("fetch", fetcher);
  let finish!: (result: { ok: boolean; outcome?: "cancelled"; message?: string }) => void;
  cancel.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const onCancelled = vi.fn(() => new Promise<void>(() => {}));
  render(<><NotificationBell /><NotificationBell /><CustomerBookingCancellation booking={booking}
    staff={false} onCancelled={onCancelled} onPendingChange={vi.fn()} /></>);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel booking" }));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(document.querySelectorAll("[data-unread-indicator]")).toHaveLength(0);
  persistedUnread = success;
  await act(async () => finish(success ? { ok: true, outcome: "cancelled" } : { ok: false, message: "Unable to cancel." }));
  await flush();
  expect(fetcher).toHaveBeenCalledTimes(success ? 2 : 1);
  expect(document.querySelectorAll("[data-unread-indicator]")).toHaveLength(success ? 2 : 0);
  expect(onCancelled).toHaveBeenCalledTimes(success ? 1 : 0);
});
