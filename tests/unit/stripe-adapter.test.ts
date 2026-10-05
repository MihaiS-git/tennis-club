import { afterEach, expect, test, vi } from "vitest";
import Stripe from "stripe";
import { stripeAdapter, verifyStripeEvent } from "@/lib/payments/providers/stripe/adapter";

const { create, retrieve, cancel } = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), cancel: vi.fn() }));
vi.mock("@/lib/payments/providers/stripe/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/providers/stripe/client")>("@/lib/payments/providers/stripe/client");
  return { ...actual, stripeClient: () => ({ paymentIntents: { create, retrieve, cancel }, webhooks: new Stripe("sk_test_Fixture").webhooks }) };
});
afterEach(() => { vi.unstubAllEnvs(); create.mockReset(); retrieve.mockReset(); cancel.mockReset(); });
function configure() {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_Fixture");
  vi.stubEnv("STRIPE_PUBLISHABLE_KEY", "pk_test_Fixture");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_Fixture");
}
const id = "c9000000-0000-4000-8000-000000000011";
test("creates only a card intent from persisted amount with stable attempt idempotency and metadata", async () => {
  configure(); create.mockResolvedValue({ id: "pi_fixture", client_secret: "pi_fixture_secret" });
  expect(await stripeAdapter.createPayment({ id, amountMinor: 5000, currency: "RON" })).toEqual({
    providerPaymentId: "pi_fixture", presentation: { kind: "stripe", clientSecret: "pi_fixture_secret", publishableKey: "pk_test_Fixture" },
  });
  expect(create).toHaveBeenCalledWith({ amount: 5000, currency: "ron", allowed_payment_method_types: ["card"],
    metadata: { payment_attempt_id: id } }, { idempotencyKey: `court-payment-${id}` });
  create.mockRejectedValue(new Error("private provider response"));
  await expect(stripeAdapter.createPayment({ id, amountMinor: 5000, currency: "RON" })).rejects.toThrow("Payment service unavailable.");
});
test("verifies raw signatures before translation, handles cancellation and ignores unrelated intents", () => {
  configure(); const stripe = new Stripe("sk_test_Fixture");
  const payload = (type: string, metadata = { payment_attempt_id: id }) => JSON.stringify({ id: "evt_fixture", type,
    data: { object: { id: "pi_fixture", amount: 5000, amount_received: 5000, currency: "ron", metadata } } });
  const verify = (body: string) => verifyStripeEvent(body, stripe.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_Fixture" }));
  expect(() => verifyStripeEvent(payload("payment_intent.succeeded"), "invalid")).toThrow("Payment service unavailable.");
  expect(verify(payload("payment_intent.succeeded"))).toEqual({ provider: "stripe", eventId: "evt_fixture", attemptId: id,
    providerPaymentId: "pi_fixture", amountMinor: 5000, currency: "RON", outcome: "succeeded" });
  expect(verify(payload("payment_intent.canceled"))?.outcome).toBe("cancelled");
  expect(verify(payload("payment_intent.payment_failed"))?.outcome).toBe("retryable_failed");
  expect(verify(payload("payment_intent.succeeded", { payment_attempt_id: "other" }))).toBeNull();
  expect(verify(payload("payment_intent.created"))).toBeNull();
});

test("explicit abandonment cancels the stored intent idempotently and accepts an already cancelled intent", async () => {
  configure();
  retrieve.mockResolvedValueOnce({ status: "requires_payment_method" }).mockResolvedValueOnce({ status: "canceled" });
  cancel.mockResolvedValue({ status: "canceled" });
  const attempt = { id, providerPaymentId: "pi_fixture" };
  expect(await stripeAdapter.cancelPayment(attempt)).toBe("cancelled");
  expect(cancel).toHaveBeenCalledWith("pi_fixture", { cancellation_reason: "abandoned" },
    { idempotencyKey: `court-payment-abandon-${id}` });
  expect(await stripeAdapter.cancelPayment(attempt)).toBe("cancelled");
  expect(cancel).toHaveBeenCalledTimes(1);
});
test("abandonment preserves processing/completed payments and recovers a concurrent completion", async () => {
  configure();
  const attempt = { id, providerPaymentId: "pi_fixture" };
  retrieve.mockResolvedValueOnce({ status: "processing" }).mockResolvedValueOnce({ status: "succeeded" });
  expect(await stripeAdapter.cancelPayment(attempt)).toBe("processing");
  expect(await stripeAdapter.cancelPayment(attempt)).toBe("succeeded");
  expect(cancel).not.toHaveBeenCalled();
  retrieve.mockResolvedValueOnce({ status: "requires_payment_method" }).mockResolvedValueOnce({ status: "succeeded" });
  cancel.mockRejectedValue(new Error("payment completed concurrently"));
  expect(await stripeAdapter.cancelPayment(attempt)).toBe("succeeded");
});
