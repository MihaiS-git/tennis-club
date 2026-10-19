import { beforeEach, expect, it, vi } from "vitest";

const { create, start } = vi.hoisted(() => ({ create: vi.fn(), start: vi.fn() }));
vi.mock("@/lib/coaching/booking", () => ({ createCoachingBooking: create }));
vi.mock("@/lib/payments/checkout", () => ({ startOnlineCheckout: start }));
import { commitCoachingCheckout } from "@/lib/coaching/checkout";

beforeEach(() => { create.mockReset(); start.mockReset(); });

it("starts the existing checkout only after pending lesson creation commits", async () => {
  let commit!: (result: unknown) => void;
  create.mockReturnValue(new Promise(resolve => { commit = resolve; }));
  const result = { ok: true, status: "pending_payment", bookingId: "booking", reservationId: "reservation",
    paymentAttemptId: "attempt", totalAmountMinor: 18000, currency: "RON", holdExpiresAt: "2099-11-02T10:10:00Z" };
  const checkout = { attemptId: "attempt", token: "token", presentation: { kind: "stripe" } };
  start.mockResolvedValue(checkout);
  const intent = { lesson: "intent" };
  const pending = commitCoachingCheckout(intent);
  expect(start).not.toHaveBeenCalled();
  commit(result);
  expect(await pending).toEqual({ ...result, checkout });
  expect(create).toHaveBeenCalledWith(intent, undefined);
  expect(start).toHaveBeenCalledExactlyOnceWith("attempt");
});

it.each(["invalid-input", "account-inactive", "payment-unavailable", "price_changed", "coach-booked", "unpriced"])(
  "preserves %s rejection without starting payment", async reason => {
    const rejected = { ok: false, reason };
    create.mockResolvedValue(rejected);
    expect(await commitCoachingCheckout({})).toBe(rejected);
    expect(start).not.toHaveBeenCalled();
  });

it("reports initialization uncertainty without confirming or replacing the committed hold", async () => {
  create.mockResolvedValue({ ok: true, paymentAttemptId: "attempt" });
  start.mockRejectedValue(new Error("Private Stripe error"));
  expect(await commitCoachingCheckout({})).toMatchObject({ ok: false, availabilityChanged: true,
    message: expect.stringContaining("No booking is confirmed") });
  expect(create).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledTimes(1);
});
