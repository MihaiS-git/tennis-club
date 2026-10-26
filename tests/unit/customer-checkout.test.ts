import { beforeEach, expect, it, vi } from "vitest";

const { create, start, provider, logError } = vi.hoisted(() => ({ create: vi.fn(), start: vi.fn(),
  provider: vi.fn(), logError: vi.fn() }));
vi.mock("@/lib/bookings/service", () => ({ createCustomerBooking: create }));
vi.mock("@/lib/payments/settings", () => ({ activeOnlinePaymentProvider: provider }));
vi.mock("@/lib/payments/checkout", () => ({ startOnlineCheckout: start }));
vi.mock("@/lib/logger", () => ({ logger: { error: logError } }));
import { commitCustomerCheckout } from "@/lib/bookings/checkout";

const intent = { courtId: "c9000000-0000-4000-8000-000000000011", date: "2099-10-15", startMinute: 600, endMinute: 660,
  customerName: "Guest", customerEmail: "guest@example.test", customerPhone: "123",
  expectedTotalAmountMinor: 5000, expectedCurrency: "RON" };
const pending = { ok: true, status: "pending_payment", bookingId: "booking", reservationId: "reservation",
  paymentAttemptId: "attempt", totalAmountMinor: 5000, currency: "RON", holdExpiresAt: "2099-10-15T10:10:00Z",
  cancellationPolicy: null };

beforeEach(() => {
  create.mockReset(); start.mockReset(); logError.mockReset();
  provider.mockReset().mockResolvedValue("stripe");
});

it("starts checkout after the pending court hold commits and preserves its identifiers", async () => {
  const checkout = { attemptId: "attempt", token: "token", presentation: { kind: "stripe" } };
  create.mockResolvedValue(pending);
  start.mockResolvedValue(checkout);
  expect(await commitCustomerCheckout(intent)).toEqual({ ...pending, checkout });
  expect(start).toHaveBeenCalledExactlyOnceWith("attempt");
  expect(logError).not.toHaveBeenCalled();
});

it("keeps the committed hold and logs the attempt when provider initialization fails", async () => {
  create.mockResolvedValue(pending);
  start.mockRejectedValue(new Error("Private Stripe error"));
  expect(await commitCustomerCheckout(intent)).toEqual({ ok: false, availabilityChanged: true,
    message: "Unable to start payment. No booking is confirmed. The temporary hold will expire within 10 minutes." });
  expect(create).toHaveBeenCalledTimes(1);
  expect(logError).toHaveBeenCalledExactlyOnceWith({ event: "payments.checkout_start_failed", attemptId: "attempt" },
    "Unable to start online payment");
});

it("confirms Pay at club bookings without consulting or starting an online provider", async () => {
  const confirmed = { ok: true, status: "confirmed", holdExpiresAt: null, totalAmountMinor: 5000, currency: "RON",
    cancellationPolicy: null };
  create.mockResolvedValue(confirmed);
  expect(await commitCustomerCheckout({ ...intent, paymentMethod: "pay_at_club" })).toBe(confirmed);
  expect(provider).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it("preserves creation rejections and unavailable-provider responses without starting payment", async () => {
  const rejected = { ok: false, availabilityChanged: true, message: "That court is no longer available for the selected time." };
  create.mockResolvedValue(rejected);
  expect(await commitCustomerCheckout(intent)).toBe(rejected);
  provider.mockResolvedValue(null);
  expect(await commitCustomerCheckout(intent)).toEqual({ ok: false,
    message: "Online payment is unavailable. Choose Pay at club if offered, or try again later." });
  expect(create).toHaveBeenCalledTimes(1);
  expect(start).not.toHaveBeenCalled();
});
