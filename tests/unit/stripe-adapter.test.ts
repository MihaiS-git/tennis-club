import { afterEach, expect, test, vi } from "vitest";
import Stripe from "stripe";
import { stripeAdapter, verifyStripeEvent } from "@/lib/payments/providers/stripe/adapter";

const { create, retrieve, cancel, capture } = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), cancel: vi.fn(), capture: vi.fn() }));
vi.mock("@/lib/payments/providers/stripe/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/providers/stripe/client")>("@/lib/payments/providers/stripe/client");
  return { ...actual, stripeClient: () => ({ paymentIntents: { create, retrieve, cancel, capture }, webhooks: new Stripe("sk_test_Fixture").webhooks }) };
});
afterEach(() => { vi.unstubAllEnvs(); create.mockReset(); retrieve.mockReset(); cancel.mockReset(); capture.mockReset(); });
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
    capture_method: "manual", metadata: { payment_attempt_id: id } }, { idempotencyKey: `court-payment-${id}` });
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
    providerPaymentId: "pi_fixture", providerCaptureId: "pi_fixture", amountMinor: 5000, currency: "RON", outcome: "succeeded" });
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
test("attempts processing cancellation and recovers processing or concurrently captured outcomes", async () => {
  configure();
  const attempt = { id, providerPaymentId: "pi_fixture" };
  retrieve.mockResolvedValueOnce({ status: "processing" }).mockResolvedValueOnce({ status: "processing" })
    .mockResolvedValueOnce({ status: "succeeded" });
  cancel.mockRejectedValue(new Error("Cannot cancel yet"));
  expect(await stripeAdapter.cancelPayment(attempt)).toBe("processing");
  expect(await stripeAdapter.cancelPayment(attempt)).toBe("succeeded");
  expect(cancel).toHaveBeenCalledOnce();
  retrieve.mockResolvedValueOnce({ status: "requires_payment_method" }).mockResolvedValueOnce({ status: "succeeded" });
  expect(await stripeAdapter.cancelPayment(attempt)).toBe("succeeded");
  retrieve.mockResolvedValueOnce({ status: "processing" });
  cancel.mockResolvedValueOnce({ status: "canceled" });
  expect(await stripeAdapter.cancelPayment(attempt)).toBe("cancelled");
  retrieve.mockRejectedValueOnce(new Error("Network timeout"));
  await expect(stripeAdapter.cancelPayment(attempt)).rejects.toThrow("Payment service unavailable.");
});

test("dismissal cancels intents awaiting the customer, including authentication, but never a processing payment", async () => {
  configure();
  const attempt = { id, providerPaymentId: "pi_fixture" };
  const intent = (status: string) => ({ id: "pi_fixture", status, metadata: { payment_attempt_id: id } });
  for (const status of ["requires_payment_method", "requires_confirmation", "requires_action"]) {
    retrieve.mockResolvedValueOnce(intent(status)); cancel.mockResolvedValueOnce({ status: "canceled" });
    expect(await stripeAdapter.dismissPayment(attempt)).toBe("cancelled");
  }
  expect(cancel).toHaveBeenCalledWith("pi_fixture", { cancellation_reason: "abandoned" }, { idempotencyKey: `court-payment-abandon-${id}` });
  cancel.mockClear();
  retrieve.mockResolvedValueOnce(intent("processing"));
  expect(await stripeAdapter.dismissPayment(attempt)).toBe("live");
  retrieve.mockResolvedValueOnce(intent("succeeded"));
  expect(await stripeAdapter.dismissPayment(attempt)).toBe("succeeded");
  retrieve.mockResolvedValueOnce(intent("canceled"));
  expect(await stripeAdapter.dismissPayment(attempt)).toBe("cancelled");
  expect(cancel).not.toHaveBeenCalled();
});

test("dismissal cancel race re-reads the intent and takes the live or succeeded branch", async () => {
  configure();
  const attempt = { id, providerPaymentId: "pi_fixture" };
  const intent = (status: string) => ({ id: "pi_fixture", status, metadata: { payment_attempt_id: id } });
  cancel.mockRejectedValue(new Error("payment_intent_unexpected_state"));
  retrieve.mockResolvedValueOnce(intent("requires_payment_method")).mockResolvedValueOnce(intent("processing"));
  expect(await stripeAdapter.dismissPayment(attempt)).toBe("live");
  retrieve.mockResolvedValueOnce(intent("requires_payment_method")).mockResolvedValueOnce(intent("succeeded"));
  expect(await stripeAdapter.dismissPayment(attempt)).toBe("succeeded");
  retrieve.mockResolvedValueOnce(intent("requires_payment_method")).mockResolvedValueOnce(intent("requires_payment_method"));
  await expect(stripeAdapter.dismissPayment(attempt)).rejects.toThrow("Payment service unavailable.");
  retrieve.mockResolvedValueOnce({ ...intent("requires_payment_method"), metadata: { payment_attempt_id: "other" } });
  await expect(stripeAdapter.dismissPayment(attempt)).rejects.toThrow("Payment service unavailable.");
});

test.each(["requires_action", "requires_capture", "processing"])("navigation cleanup preserves %s instead of cancelling it", async status => {
  configure();
  retrieve.mockResolvedValue({ id: "pi_fixture", status, metadata: { payment_attempt_id: id } });
  expect(await stripeAdapter.dismissPayment({ id, providerPaymentId: "pi_fixture", unusedOnly: true })).toBe("live");
  expect(cancel).not.toHaveBeenCalled();
});

test("a verified processing event is translated only as liveness evidence", () => {
  configure(); const stripe = new Stripe("sk_test_Fixture");
  const body = JSON.stringify({ id: "evt_processing", type: "payment_intent.processing",
    data: { object: { id: "pi_fixture", amount: 5000, currency: "ron", status: "processing", metadata: { payment_attempt_id: id } } } });
  expect(verifyStripeEvent(body, stripe.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_Fixture" })))
    .toEqual({ provider: "stripe", attemptId: id, providerPaymentId: "pi_fixture", outcome: "processing" });
  expect(() => verifyStripeEvent(body, "invalid")).toThrow("Payment service unavailable.");
});

test.each(["refund.created", "refund.updated", "refund.failed"])("a verified %s event carries only the obligation identity to re-read", type => {
  configure(); const stripe = new Stripe("sk_test_Fixture");
  const body = (metadata: Record<string, string>) => JSON.stringify({ id: "evt_refund", type,
    data: { object: { id: "re_fixture", amount: 5000, currency: "ron", status: "succeeded", payment_intent: "pi_fixture", metadata } } });
  const sign = (payload: string) => stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_Fixture" });
  const owned = body({ payment_refund_id: id, refund_execution_id: id });
  expect(verifyStripeEvent(owned, sign(owned))).toEqual({ provider: "stripe", refundId: id, outcome: "refund_changed" });
  // Refunds created elsewhere on the account (e.g. in the Dashboard) are ignored.
  const foreign = body({});
  expect(verifyStripeEvent(foreign, sign(foreign))).toBeNull();
  expect(() => verifyStripeEvent(owned, "invalid")).toThrow("Payment service unavailable.");
});

test("a manual-capture authorization is reported as authorized, never as collected money", async () => {
  configure();
  retrieve.mockResolvedValue({ id: "pi_fixture", status: "requires_capture", amount: 5000, amount_capturable: 5000,
    amount_received: 0, currency: "ron", metadata: { payment_attempt_id: id } });
  expect(await stripeAdapter.readPayment({ id, providerPaymentId: "pi_fixture" }))
    .toEqual({ status: "authorized", amountMinor: 5000, currency: "RON", providerCaptureId: null, live: false });
});

test("capture uses a stable attempt key and only verified intent evidence decides an interrupted capture", async () => {
  configure();
  const succeeded = { id: "pi_fixture", status: "succeeded", amount: 5000, amount_received: 5000, currency: "ron", metadata: { payment_attempt_id: id } };
  capture.mockResolvedValueOnce(succeeded);
  expect(await stripeAdapter.capturePayment({ id, providerPaymentId: "pi_fixture" }))
    .toEqual({ status: "succeeded", amountMinor: 5000, currency: "RON", providerCaptureId: "pi_fixture" });
  expect(capture).toHaveBeenCalledWith("pi_fixture", {}, { idempotencyKey: `court-capture-${id}` });
  // Lost response: the re-read shows the capture ran.
  capture.mockRejectedValueOnce(new Error("socket hang up")); retrieve.mockResolvedValueOnce(succeeded);
  expect(await stripeAdapter.capturePayment({ id, providerPaymentId: "pi_fixture" })).toMatchObject({ status: "succeeded" });
  // Still authorized after a failure: the outcome is unknown and nothing is inferred.
  capture.mockRejectedValueOnce(new Error("timeout"));
  retrieve.mockResolvedValueOnce({ ...succeeded, status: "requires_capture", amount_received: 0 });
  await expect(stripeAdapter.capturePayment({ id, providerPaymentId: "pi_fixture" })).rejects.toThrow("Payment service unavailable.");
  // Another integration's intent is never accepted as capture evidence.
  capture.mockResolvedValueOnce({ ...succeeded, metadata: { payment_attempt_id: "other" } });
  await expect(stripeAdapter.capturePayment({ id, providerPaymentId: "pi_fixture" })).rejects.toThrow("Payment service unavailable.");
});

test("a verified amount_capturable_updated event is only an authorization signal", () => {
  configure(); const stripe = new Stripe("sk_test_Fixture");
  const body = JSON.stringify({ id: "evt_authorized", type: "payment_intent.amount_capturable_updated",
    data: { object: { id: "pi_fixture", amount: 5000, amount_capturable: 5000, currency: "ron", status: "requires_capture", metadata: { payment_attempt_id: id } } } });
  expect(verifyStripeEvent(body, stripe.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_Fixture" })))
    .toEqual({ provider: "stripe", attemptId: id, providerPaymentId: "pi_fixture", outcome: "authorized" });
});

test.each(["ECONNRESET", "ECONNREFUSED"])("installed SDK %s retry crossing grace completes the same accepted capture", async code => {
  configure();
  const acceptedAt = Date.now(), graceEnd = acceptedAt + 120_000;
  let providerNow = acceptedAt;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => providerNow);
  const dispatches: { key: string | null; afterGrace: boolean }[] = [];
  const transport: typeof fetch = async (_url, init) => {
    dispatches.push({ key: new Headers(init?.headers).get("Idempotency-Key"), afterGrace: providerNow > graceEnd });
    if (dispatches.length === 1) {
      providerNow = graceEnd + 1;
      throw Object.assign(new Error("simulated transport failure"), { code });
    }
    return Response.json({ id: "pi_fixture", status: "succeeded", amount_received: 5000, currency: "ron",
      metadata: { payment_attempt_id: id } });
  };
  const client = new Stripe("sk_test_Fixture", { maxNetworkRetries: 2, timeout: 15_000,
    httpClient: Stripe.createFetchHttpClient(transport) });
  capture.mockImplementation((paymentId: string, params: Stripe.PaymentIntentCaptureParams, options: Stripe.RequestOptions) =>
    client.paymentIntents.capture(paymentId, params, options));
  try {
    expect(await stripeAdapter.capturePayment({ id, providerPaymentId: "pi_fixture" })).toMatchObject({ status: "succeeded" });
    expect(capture).toHaveBeenCalledOnce();
    expect(dispatches).toEqual([
      { key: `court-capture-${id}`, afterGrace: false }, { key: `court-capture-${id}`, afterGrace: true },
    ]);
    expect(retrieve).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});
