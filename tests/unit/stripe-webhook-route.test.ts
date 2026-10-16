import { beforeEach, expect, test, vi } from "vitest";

const { verify, settle, refund, extend, authorize } = vi.hoisted(() => ({ verify: vi.fn(), settle: vi.fn(), refund: vi.fn(), extend: vi.fn(), authorize: vi.fn() }));
vi.mock("@/lib/payments/checkout", () => ({ resolveAuthorizedCheckoutPayment: authorize }));
vi.mock("@/lib/payments/providers/stripe/adapter", () => ({ verifyStripeEvent: verify }));
vi.mock("@/lib/payments/service", () => ({ processOnlinePaymentEvent: settle }));
vi.mock("@/lib/payments/hold-expiry", () => ({ extendLiveAdjustmentHold: extend }));
vi.mock("@/lib/reservations/revalidation", () => ({ revalidateCourtActivity: vi.fn() }));
vi.mock("@/lib/payments/refunds", async () => {
  class RefundProcessingError extends Error {}
  class RefundInProgressError extends RefundProcessingError {}
  return { processBookingRefund: refund, RefundInProgressError, RefundProcessingError };
});
import { POST } from "@/app/api/payments/stripe/webhook/route";
import { RefundInProgressError, RefundProcessingError } from "@/lib/payments/refunds";

const refundId = "c9000000-0000-4000-8000-000000000021";
const request = () => new Request("http://localhost/api/payments/stripe/webhook", { method: "POST", body: "{}",
  headers: { "stripe-signature": "t=1,v1=signed" } });
beforeEach(() => { vi.resetAllMocks(); verify.mockReturnValue({ provider: "stripe", refundId, outcome: "refund_changed" }); });

test("a signed refund event re-reads the refund through the shared service and never settles a payment", async () => {
  refund.mockResolvedValue("succeeded");
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(refund).toHaveBeenCalledWith(refundId, { strict: true, providerChanged: true });
  expect(settle).not.toHaveBeenCalled();
});

test("a refund still held by another request asks Stripe to redeliver instead of dropping the event", async () => {
  refund.mockRejectedValue(new RefundInProgressError());
  expect((await POST(request())).status).toBe(503);
});

test("unsigned and unrelated events are rejected or ignored before any processing", async () => {
  expect((await POST(new Request("http://localhost/api/payments/stripe/webhook", { method: "POST", body: "{}" }))).status).toBe(400);
  verify.mockReturnValue(null);
  expect((await POST(request())).status).toBe(204);
  expect(refund).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
});

test("a transient refund processing failure is not acknowledged, so Stripe redelivers", async () => {
  refund.mockRejectedValue(new RefundProcessingError());
  expect((await POST(request())).status).toBe(503);
});

test("payment events settle strictly and an authorization is decided by the server, never settled by the event", async () => {
  verify.mockReturnValue({ provider: "stripe", attemptId: refundId, providerPaymentId: "pi_fixture", outcome: "authorized" });
  authorize.mockResolvedValue("succeeded");
  expect((await POST(request())).status).toBe(200);
  expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ attemptId: refundId, providerPaymentId: "pi_fixture" }));
  expect(settle).not.toHaveBeenCalled();
  authorize.mockRejectedValue(new Error("capture outcome unknown"));
  expect((await POST(request())).status).toBe(503);
  const event = { provider: "stripe", eventId: "evt", attemptId: refundId, providerPaymentId: "pi_fixture", outcome: "succeeded", amountMinor: 5000, currency: "RON" };
  verify.mockReturnValue(event);
  settle.mockRejectedValue(new Error("compensation refund unconfirmed"));
  expect((await POST(request())).status).toBe(503);
  expect(settle).toHaveBeenCalledWith(event, { strict: true });
});
