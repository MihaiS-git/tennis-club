import Stripe from "stripe";
import { beforeEach, expect, test, vi } from "vitest";
const { create, list, retrieve } = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), retrieve: vi.fn() }));
vi.mock("@/lib/payments/providers/stripe/client", () => ({
  stripeClient: () => ({ refunds: { create, list, retrieve } }),
  StripeProviderError: class extends Error { constructor() { super("Payment service unavailable."); } },
}));
import { stripeAdapter } from "@/lib/payments/providers/stripe/adapter";
const refund = { id: "cf000000-0000-4000-8000-000000000001", providerPaymentId: "original-payment",
  amountMinor: 5000, currency: "RON", providerRefundId: null };
const result = { id: "original-refund", amount: 5000, currency: "ron", payment_intent: "original-payment", status: "succeeded" };
beforeEach(() => { vi.resetAllMocks(); list.mockReturnValue((async function* () {})()); create.mockResolvedValue(result); });
test("uses the original payment, full persisted amount and stable refund idempotency key", async () => {
  expect(await stripeAdapter.refundPayment(refund)).toEqual({ status: "succeeded", providerRefundId: "original-refund" });
  await stripeAdapter.refundPayment(refund);
  expect(create).toHaveBeenNthCalledWith(1, { payment_intent: "original-payment", amount: 5000,
    metadata: { payment_refund_id: refund.id } }, { idempotencyKey: `court-payment-refund-${refund.id}` });
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
});
test("recovers accepted refunds after a lost response without creating another", async () => {
  list.mockReturnValue((async function* () { yield { ...result, metadata: { payment_refund_id: refund.id } }; })());
  expect(await stripeAdapter.refundPayment(refund)).toMatchObject({ status: "succeeded" });
  expect(create).not.toHaveBeenCalled();
});
test.each([['failed', 'failed']])("retrieves existing provider refund with state %s", async (providerStatus, status) => {
  retrieve.mockResolvedValue({ ...result, status: providerStatus });
  expect(await stripeAdapter.refundPayment({ ...refund, providerRefundId: result.id })).toEqual({ providerRefundId: result.id, status });
  expect(create).not.toHaveBeenCalled();
});
test("network errors and mismatched evidence yield safe retry errors", async () => {
  create.mockRejectedValue(new Error("private payment details"));
  await expect(stripeAdapter.refundPayment(refund)).rejects.toThrow("Payment service unavailable.");
  create.mockResolvedValue({ ...result, amount: 1 });
  await expect(stripeAdapter.refundPayment(refund)).rejects.toThrow("Payment service unavailable.");
});

test("definite invalid refund requests are terminal and network failures stay retryable", async () => {
  create.mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({ message: "private provider details" }));
  await expect(stripeAdapter.refundPayment(refund)).rejects.toMatchObject({ retryable: false,message: "Payment service unavailable." });
  create.mockRejectedValue(new Error("network interrupted"));
  await expect(stripeAdapter.refundPayment(refund)).rejects.toMatchObject({ retryable: true });
});
