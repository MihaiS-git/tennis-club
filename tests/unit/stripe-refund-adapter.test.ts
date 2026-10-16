import Stripe from "stripe";
import { beforeEach, expect, test, vi } from "vitest";
const { create, list, retrieve } = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), retrieve: vi.fn() }));
vi.mock("@/lib/payments/providers/stripe/client", () => ({
  stripeClient: () => ({ refunds: { create, list, retrieve } }),
  StripeProviderError: class extends Error { constructor() { super("Payment service unavailable."); } },
}));
const { prepare, initiate, commit } = vi.hoisted(() => ({
  prepare: vi.fn(), initiate: vi.fn(), commit: vi.fn(),
}));
vi.mock("@/lib/payments/refund-commands", () => ({
  prepareRefund: prepare, initiateRefundExecution: initiate, commitRefundExecution: commit,
}));
vi.mock("@/lib/payments/providers", () => ({ onlinePaymentAdapter: async () => stripeAdapter }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
import { processBookingRefund, RefundInProgressError } from "@/lib/payments/refunds";
import type { RefundExecutionClaim } from "@/lib/payments/refund-commands";
import { stripeAdapter } from "@/lib/payments/providers/stripe/adapter";
const executionId = "cf000000-0000-4000-8000-000000000002";
const refund = { executionId, idempotencyKey: "persisted-exact-key", id: "cf000000-0000-4000-8000-000000000001", providerPaymentId: "original-payment",
  amountMinor: 5000, currency: "RON", providerRefundId: null, operation: "create" as const };
const result = { id: "original-refund", amount: 5000, currency: "ron", payment_intent: "original-payment", status: "succeeded", metadata: { payment_refund_id: refund.id, refund_execution_id: executionId } };
beforeEach(() => { vi.resetAllMocks(); list.mockReturnValue((async function* () {})()); create.mockResolvedValue(result); });
test("uses the original payment, full persisted amount and stable refund idempotency key", async () => {
  expect(await stripeAdapter.refundPayment(refund)).toEqual({ status: "succeeded", providerRefundId: "original-refund", retryable: false, failureReason: undefined });
  await stripeAdapter.refundPayment(refund);
  expect(create).toHaveBeenNthCalledWith(1, { payment_intent: "original-payment", amount: 5000,
    metadata: { payment_refund_id: refund.id, refund_execution_id: executionId } }, { idempotencyKey: refund.idempotencyKey });
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
});
test("recovers accepted refunds after a lost response without creating another", async () => {
  list.mockReturnValue((async function* () { yield { ...result, metadata: { payment_refund_id: refund.id, refund_execution_id: executionId } }; })());
  expect(await stripeAdapter.refundPayment(refund)).toMatchObject({ status: "succeeded" });
  expect(create).not.toHaveBeenCalled();
});
test.each([['succeeded', 'succeeded'], ['pending', 'pending'], ['requires_action', 'pending'], ['failed', 'failed'], ['canceled', 'failed']])("retrieves existing provider refund with state %s", async (providerStatus, status) => {
  list.mockReturnValue((async function* () { yield result; })());
  retrieve.mockResolvedValue({ ...result, status: providerStatus });
  expect(await stripeAdapter.refundPayment({ ...refund, providerRefundId: result.id })).toEqual({ providerRefundId: result.id, status, retryable: false, failureReason: undefined });
  expect(create).not.toHaveBeenCalled();
});
test("network errors and mismatched evidence yield incomplete operation errors", async () => {
  create.mockRejectedValue(new Error("private payment details"));
  await expect(stripeAdapter.refundPayment(refund)).rejects.toThrow("Payment service unavailable.");
  create.mockResolvedValue({ ...result, amount: 1 });
  await expect(stripeAdapter.refundPayment(refund)).rejects.toThrow("Payment service unavailable.");
});

test("definite creation rejections and uncertain network failures remain distinct", async () => {
  create.mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({ message: "private provider details", statusCode: 400 }));
  await expect(stripeAdapter.refundPayment(refund)).rejects.toMatchObject({ evidence: { kind: "request_rejected", operation: "create", providerRefundId: null }, message: "Payment service unavailable." });
  create.mockRejectedValue(new Error("network interrupted"));
  await expect(stripeAdapter.refundPayment(refund)).rejects.toMatchObject({ evidence: { kind: "uncertain", operation: "create", providerRefundId: null } });
});


test.each(["pending", "requires_action"])("accepted creation with %s status has identity but no settled refund", async status => {
  create.mockResolvedValue({ ...result, status });
  expect(await stripeAdapter.refundPayment(refund)).toEqual({ providerRefundId: result.id, status: "pending", retryable: false, failureReason: undefined });
});
test("creation timeout is uncertain", async () => {
  create.mockRejectedValue(new Stripe.errors.StripeConnectionError({ message: "timeout" }));
  await expect(stripeAdapter.refundPayment(refund)).rejects.toMatchObject({ evidence: {
    kind: "uncertain", operation: "create", providerRefundId: null,
  } });
  expect(create).toHaveBeenCalledTimes(1);
});
test.each([undefined, 409, 500])("invalid-request exception with status %s is insufficient rejection evidence", async statusCode => {
  create.mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({ statusCode }));
  await expect(stripeAdapter.refundPayment(refund)).rejects.toMatchObject({ evidence: { kind: "uncertain" } });
});
test("idempotency conflict is uncertain even with a 400 response", async () => {
  create.mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({ statusCode: 400, code: "idempotency_key_in_use" }));
  await expect(stripeAdapter.refundPayment(refund)).rejects.toMatchObject({ evidence: { kind: "uncertain" } });
});
test("discovery rejection never implies creation rejection", async () => {
  list.mockReturnValue((async function* () {
    throw new Stripe.errors.StripeInvalidRequestError({ statusCode: 400 });
  })());
  await expect(stripeAdapter.refundPayment(refund)).rejects.toMatchObject({ evidence: {
    kind: "lookup_failed", operation: "discover", providerRefundId: null,
  } });
  expect(create).not.toHaveBeenCalled();
});
test.each([
  new Stripe.errors.StripeInvalidRequestError({ statusCode: 404 }),
  new Stripe.errors.StripeConnectionError({ message: "timeout" }),
])("retrieval failure retains known identity and never creates", async error => {
  list.mockReturnValue((async function* () { yield result; })());
  retrieve.mockRejectedValue(error);
  await expect(stripeAdapter.refundPayment({ ...refund, providerRefundId: result.id })).rejects.toMatchObject({ evidence: {
    kind: "lookup_failed", operation: "retrieve", providerRefundId: result.id,
  } });
  expect(list).toHaveBeenCalledWith({ payment_intent: refund.providerPaymentId, limit: 100 });
  expect(create).not.toHaveBeenCalled();
});
test("empty recovery lookup is not evidence permitting another creation", async () => {
  await expect(stripeAdapter.refundPayment({ ...refund, operation: "recover" })).rejects.toMatchObject({ evidence: {
    kind: "not_found", operation: "discover", providerRefundId: null,
  } });
  expect(create).not.toHaveBeenCalled();
});
test("recovery rediscovers and verifies the existing refund", async () => {
  list.mockReturnValue((async function* () { yield result; })());
  expect(await stripeAdapter.refundPayment({ ...refund, operation: "recover" })).toEqual({
    providerRefundId: result.id, status: "succeeded", retryable: false, failureReason: undefined,
  });
  expect(create).not.toHaveBeenCalled();
});
test.each([
  { metadata: { payment_refund_id: "other" } },
  { metadata: { payment_refund_id: refund.id, refund_execution_id: "other-execution" } },
  { amount: 1 }, { currency: "eur" }, { payment_intent: "other" }, { id: "other" },
])("retrieved mismatched evidence retains known identity", async mismatch => {
  list.mockReturnValue((async function* () { yield result; })());
  retrieve.mockResolvedValue({ ...result, ...mismatch });
  await expect(stripeAdapter.refundPayment({ ...refund, providerRefundId: result.id })).rejects.toMatchObject({ evidence: {
    kind: "evidence_mismatch", operation: "retrieve", providerRefundId: result.id,
  } });
  expect(create).not.toHaveBeenCalled();
});
test("created identity survives mismatched metadata", async () => {
  create.mockResolvedValue({ ...result, metadata: { payment_refund_id: "other" } });
  await expect(stripeAdapter.refundPayment(refund)).rejects.toMatchObject({ evidence: {
    kind: "evidence_mismatch", operation: "create", providerRefundId: result.id,
  } });
});
test("rediscovered identity survives mismatched financial evidence", async () => {
  list.mockReturnValue((async function* () { yield { ...result, amount: 1 }; })());
  await expect(stripeAdapter.refundPayment(refund)).rejects.toMatchObject({ evidence: {
    kind: "evidence_mismatch", operation: "discover", providerRefundId: result.id,
  } });
  expect(create).not.toHaveBeenCalled();
});
test("forwards the exact stored key without constructing another key", async () => {
  await stripeAdapter.refundPayment({ ...refund, idempotencyKey: "arbitrary-immutable-key" });
  expect(create).toHaveBeenCalledWith({ payment_intent: refund.providerPaymentId, amount: refund.amountMinor,
    metadata: { payment_refund_id: refund.id, refund_execution_id: executionId } },
  { idempotencyKey: "arbitrary-immutable-key" });
});

const claim: RefundExecutionClaim = {
  token: "token", actorId: null, bookingId: refund.id,
  refund: { id: refund.id, booking_id: refund.id, payment_attempt_id: refund.id, operation_key: "cancellation",
    adjustment_id: null, reason: "booking_cancellation",
    provider: "stripe", provider_payment_id: refund.providerPaymentId, amount_minor: refund.amountMinor,
    captured_amount_minor: refund.amountMinor, currency: "RON", status: "pending", created_at: "2026-10-13T12:00:00Z" },
  execution: { id: executionId, refundId: refund.id, executionNumber: 1, provider: "stripe",
    providerPaymentId: refund.providerPaymentId, amountMinor: refund.amountMinor, currency: "RON",
    idempotencyKey: refund.idempotencyKey, initiatedByUserId: null, createdAt: new Date(), updatedAt: new Date(),
    dispatchInitiatedAt: null, providerRefundId: null, firstUncertainAt: null, firstUncertaintyEvidence: null,
    terminalResult: null, terminalEvidence: null, completedAt: null, status: "ready", leaseToken: "token",
    leaseUntil: new Date(Date.now() + 300_000), lastCheckedAt: null, lastError: null },
};
beforeEach(() => {
  prepare.mockResolvedValue({ outcome: "ready", claim });
  initiate.mockResolvedValue({ outcome: "dispatch", operation: "create", execution: claim.execution });
  commit.mockImplementation(async (_claim, observation) => ({ status: observation.kind === "verified" ? observation.status
    : observation.evidence.kind === "request_rejected" ? "failed" : "pending_retry", notice: null }));
});
test("service initiates dispatch before contacting Stripe with exact persisted parameters", async () => {
  expect(await processBookingRefund(refund.id)).toBe("succeeded");
  expect(initiate).toHaveBeenCalledWith(claim);
  expect(initiate.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
  expect(commit).toHaveBeenCalledWith(claim, { kind: "verified", status: "succeeded", providerRefundId: result.id, retryable: false, failureReason: undefined });
});
test("service persists a returned identity even when evidence mismatches", async () => {
  create.mockResolvedValue({ ...result, amount: 1 });
  expect(await processBookingRefund(refund.id)).toBe("pending_retry");
  expect(commit).toHaveBeenCalledWith(claim, { kind: "error", evidence: {
    kind: "evidence_mismatch", operation: "create", providerRefundId: result.id,
  } });
});
test("service reuses an execution for an empty lookup without creating", async () => {
  initiate.mockResolvedValue({ outcome: "dispatch", operation: "recover", execution: { ...claim.execution, dispatchInitiatedAt: new Date() } });
  expect(await processBookingRefund(refund.id)).toBe("pending_retry");
  expect(create).not.toHaveBeenCalled();
  expect(commit).toHaveBeenCalledWith(claim, { kind: "error", evidence: { kind: "not_found", operation: "discover", providerRefundId: null } });
});
test.each([null, "admin"])("request/Admin claimant %s uses the same definitive rejection completion", async actorId => {
  create.mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({ statusCode: 400 }));
  const prepared = { ...claim, actorId };
  prepare.mockResolvedValue({ outcome: "ready", claim: prepared });
  expect(await processBookingRefund(refund.id, actorId ? { actorId, retryRejected: true } : undefined)).toBe("failed");
  expect(prepare).toHaveBeenCalledWith(refund.id, actorId ? { actorId, retryRejected: true } : {});
  expect(commit).toHaveBeenCalledWith(prepared, { kind: "error", evidence: {
    kind: "request_rejected", operation: "create", providerRefundId: null, retryable: false, failureReason: "invalid_request",
  } });
});
test("service retrieval failure retains known identity", async () => {
  initiate.mockResolvedValue({ outcome: "dispatch", operation: "recover", execution: { ...claim.execution, providerRefundId: result.id } });
  list.mockReturnValue((async function* () { yield result; })());
  retrieve.mockRejectedValue(new Stripe.errors.StripeInvalidRequestError({ statusCode: 404 }));
  expect(await processBookingRefund(refund.id, { actorId: "admin" })).toBe("pending_retry");
  expect(commit).toHaveBeenCalledWith(expect.anything(), { kind: "error", evidence: {
    kind: "lookup_failed", operation: "retrieve", providerRefundId: result.id,
  } });
  expect(create).not.toHaveBeenCalled();
});
test.each(["pending", "succeeded", "failed"])("service persists verified %s evidence", async status => {
  create.mockResolvedValue({ ...result, status });
  expect(await processBookingRefund(refund.id)).toBe(status);
  expect(commit).toHaveBeenCalledWith(claim, { kind: "verified", status, providerRefundId: result.id, retryable: false, failureReason: undefined });
});
test.each(["succeeded", "failed"])("automatic terminal %s short circuit has no provider request", async status => {
  prepare.mockResolvedValue({ outcome: "terminal", status, notice: null });
  expect(await processBookingRefund(refund.id)).toBe(status);
  expect(create).not.toHaveBeenCalled();
  expect(initiate).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
});
test("busy shared lease prevents provider requests", async () => {
  prepare.mockResolvedValue({ outcome: "busy", status: "pending_retry" });
  expect(await processBookingRefund(refund.id)).toBe("pending_retry");
  expect(initiate).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
test("a failed dispatch transaction prevents Stripe calls", async () => {
  initiate.mockRejectedValue(new Error("database unavailable"));
  expect(await processBookingRefund(refund.id)).toBe("pending_retry");
  expect(create).not.toHaveBeenCalled();
});
test("a busy execution is never dispatched; webhook and Admin callers are told to retry", async () => {
  prepare.mockResolvedValue({ outcome: "busy", status: "pending" });
  expect(await processBookingRefund(refund.id)).toBe("pending");
  await expect(processBookingRefund(refund.id, { strict: true })).rejects.toBeInstanceOf(RefundInProgressError);
  expect(initiate).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
