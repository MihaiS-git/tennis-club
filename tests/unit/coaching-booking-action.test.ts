import { beforeEach, expect, it, vi } from "vitest";
const { checkout, revalidate } = vi.hoisted(() => ({ checkout: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/coaching/checkout", () => ({ commitCoachingCheckout: checkout }));
vi.mock("next/cache", () => ({ revalidatePath: revalidate }));
vi.mock("@/lib/reservations/revalidation", () => ({ revalidateCourtActivity: vi.fn() }));
import { commitCoachingBookingAction } from "@/app/book/actions";
const intent = { locationId: "a1111111-1111-4111-8111-111111111111", programId: "b1111111-1111-4111-8111-111111111111",
  coachId: "c1111111-1111-4111-8111-111111111111", courtId: "d1111111-1111-4111-8111-111111111111",
  date: "2099-10-15", startMinute: 600, durationMinutes: 90, customerName: "Guest", customerEmail: "guest@example.test",
  customerPhone: "123", expectedTotalAmountMinor: 18000, expectedCurrency: "RON" };
beforeEach(() => { checkout.mockReset(); revalidate.mockReset(); });
it("validates server input and rejects supplied account identity or payment method", async () => {
  for (const extra of [{ accountUserId: intent.coachId }, { paymentMethod: "pay_at_club" }, { customerEmail: "invalid" }])
    expect(await commitCoachingBookingAction({ ...intent, ...extra })).toMatchObject({ ok: false });
  expect(checkout).not.toHaveBeenCalled();
});
it("returns only the existing pending checkout presentation and preserves the combined total", async () => {
  const payment = { attemptId: "attempt", token: "token", presentation: { kind: "stripe" } };
  checkout.mockResolvedValue({ ok: true, status: "pending_payment", bookingId: "private", reservationId: "private",
    totalAmountMinor: 18000, currency: "RON", holdExpiresAt: "deadline", checkout: payment });
  expect(await commitCoachingBookingAction(intent)).toEqual({ ok: true, status: "pending_payment", totalAmountMinor: 18000,
    currency: "RON", holdExpiresAt: "deadline", checkout: payment, cancellationPolicy: null });
  expect(checkout).toHaveBeenCalledWith(intent);
});
it.each(["not-offered", "unpriced", "coach-booked", "changed"])("refreshes stale %s selections", async reason => {
  checkout.mockResolvedValue({ ok: false, reason, message: "Select another lesson." });
  expect(await commitCoachingBookingAction(intent)).toMatchObject({ ok: false, availabilityChanged: true });
  expect(revalidate).toHaveBeenCalledWith("/book");
});
it("preserves price-change and initialization-failure outcomes without fabricating confirmation", async () => {
  checkout.mockResolvedValueOnce({ ok: false, reason: "price_changed", totalAmountMinor: 19000, currency: "RON" });
  expect(await commitCoachingBookingAction(intent)).toEqual({ ok: false, reason: "price_changed", totalAmountMinor: 19000, currency: "RON" });
  checkout.mockRejectedValueOnce(new Error("Private provider error"));
  expect(await commitCoachingBookingAction(intent)).toEqual({ ok: false, message: "Unable to start this lesson booking. Please try again." });
});
