import { beforeEach, expect, it, vi } from "vitest";

const { create, revalidate, start, abandon } = vi.hoisted(() => ({ create: vi.fn(), revalidate: vi.fn(), start: vi.fn(), abandon: vi.fn() }));
vi.mock("@/lib/bookings/service", () => ({ createCustomerBooking: create }));
vi.mock("@/lib/payments/settings", () => ({ activeOnlinePaymentProvider: async () => "stripe" }));
vi.mock("@/lib/payments/checkout", () => ({ startOnlineCheckout: start, abandonOnlineCheckout: abandon }));
vi.mock("next/cache", () => ({ revalidatePath: revalidate }));

import { abandonCheckoutAction, commitCustomerBookingAction } from "@/app/book/actions";

const intent = { courtId: "c9000000-0000-4000-8000-000000000011", date: "2099-10-15",
  startMinute: 600, endMinute: 660, customerName: "  Guest  ",
  customerEmail: " guest@example.test ", customerPhone: " 123 ",
  expectedTotalAmountMinor: 5000, expectedCurrency: "RON" };

beforeEach(() => { create.mockReset(); revalidate.mockReset(); start.mockReset(); abandon.mockReset(); });

it("validates with the booking schema and sends only customer intent to the service", async () => {
  expect(await commitCustomerBookingAction({ ...intent, total_amount_minor: 1 })).toMatchObject({ ok: false });
  expect(create).not.toHaveBeenCalled();
  expect(await commitCustomerBookingAction({ ...intent, customerEmail: "wrong" }))
    .toMatchObject({ ok: false, fieldErrors: { customerEmail: expect.any(String) } });
  expect(revalidate).not.toHaveBeenCalled();
  create.mockResolvedValue({ ok: true, status: "confirmed", holdExpiresAt: null, bookingId: "id", reservationId: "id", totalAmountMinor: 5000, currency: "RON", cancellationPolicy: { noticeMinutes: 120, cutoff: null } });
  expect(await commitCustomerBookingAction(intent)).toEqual({ ok: true, status: "confirmed", holdExpiresAt: null, totalAmountMinor: 5000, currency: "RON", cancellationPolicy: { noticeMinutes: 120, cutoff: null } });
  expect(create).toHaveBeenCalledWith({ ...intent, customerName: "Guest",
    customerEmail: "guest@example.test", customerPhone: "123", paymentMethod: "online" });
  expect(revalidate.mock.calls).toEqual([
    ["/book"], ["/reservations"], ["/my-activity/bookings"],
  ]);
});

it("returns service authorization and availability failures without creating a guest fallback", async () => {
  create.mockResolvedValueOnce({ ok: false, message: "This account cannot create a booking." });
  expect(await commitCustomerBookingAction(intent)).toEqual({ ok: false,
    message: "This account cannot create a booking.", availabilityChanged: undefined });
  expect(revalidate).not.toHaveBeenCalled();
  create.mockResolvedValueOnce({ ok: false, availabilityChanged: true,
    message: "That court is no longer available for the selected time." });
  expect(await commitCustomerBookingAction(intent)).toMatchObject({ ok: false, availabilityChanged: true });
  // A detected conflict refreshes occupancy only, never the successful-mutation surfaces.
  expect(revalidate.mock.calls).toEqual([["/book"]]);
});

it("passes through authoritative price changes without refreshing availability", async () => {
  create.mockResolvedValue({ ok: false, reason: "price_changed", totalAmountMinor: 6000, currency: "EUR" });
  expect(await commitCustomerBookingAction(intent)).toEqual({ ok: false, reason: "price_changed",
    totalAmountMinor: 6000, currency: "EUR" });
  expect(revalidate).not.toHaveBeenCalled();
});

it("waits for successful persistence before invalidating affected reads", async () => {
  let finish!: (value: unknown) => void;
  create.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const pending = commitCustomerBookingAction(intent);
  expect(revalidate).not.toHaveBeenCalled();
  finish({ ok: true, status: "confirmed", holdExpiresAt: null, totalAmountMinor: 5000, currency: "RON", cancellationPolicy: { noticeMinutes: 120, cutoff: null } });
  await pending;
  expect(revalidate.mock.calls).toEqual([
    ["/book"], ["/reservations"], ["/my-activity/bookings"],
  ]);
});

it("returns the existing safe error without invalidating when persistence throws", async () => {
  create.mockRejectedValue(new Error("private database detail"));
  expect(await commitCustomerBookingAction(intent)).toEqual({ ok: false,
    message: "Unable to confirm the booking. Please try again." });
  expect(revalidate).not.toHaveBeenCalled();
});

it("returns payment presentation only after atomic hold creation and never confirms a pending attempt", async () => {
  create.mockResolvedValue({ ok: true, status: "pending_payment", holdExpiresAt: "2099-10-15T10:10:00Z",
    bookingId: "booking", reservationId: "reservation", paymentAttemptId: "attempt", totalAmountMinor: 5000,
    currency: "RON", cancellationPolicy: null });
  const checkout = { attemptId: "attempt", token: "token", presentation: { kind: "stripe", clientSecret: "client-secret", publishableKey: "publishable-key" } };
  start.mockResolvedValue(checkout);
  expect(await commitCustomerBookingAction(intent)).toEqual({ ok: true, status: "pending_payment", holdExpiresAt: "2099-10-15T10:10:00Z",
    checkout, totalAmountMinor: 5000, currency: "RON", cancellationPolicy: null });
  expect(start).toHaveBeenCalledWith("attempt");
  start.mockRejectedValue(new Error("private provider error"));
  expect(await commitCustomerBookingAction(intent)).toMatchObject({ ok: false, availabilityChanged: true,
    message: expect.stringContaining("No booking is confirmed") });
});

it("abandonment invalidates public availability only after a verified hold release", async () => {
  const access = { attemptId: intent.courtId, token: "a".repeat(64) };
  abandon.mockResolvedValueOnce({ released: false });
  expect(await abandonCheckoutAction(access)).toMatchObject({ ok: false });
  expect(revalidate).not.toHaveBeenCalled();
  abandon.mockResolvedValueOnce({ released: true });
  expect(await abandonCheckoutAction(access)).toEqual({ ok: true });
  expect(abandon).toHaveBeenLastCalledWith(access);
  expect(revalidate.mock.calls).toEqual([["/book"]]);
});
