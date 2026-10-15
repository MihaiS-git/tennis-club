import { expect, test } from "vitest";
import { allocateRefund, RefundAllocationError, summarizeBookingFinancials,
  type CaptureReceiptFact, type RefundObligationFact, type RefundPaymentFact } from "@/lib/payments/refund-allocation";

const original: RefundPaymentFact = { id: "original", method: "online", provider: "stripe",
  providerPaymentId: "pi_original", amountMinor: 5000, currency: "RON", status: "succeeded",
  createdAt: new Date("2026-10-12T10:00:00Z") };
const additional: RefundPaymentFact = { ...original, id: "additional", providerPaymentId: "pi_additional",
  amountMinor: 2500, createdAt: new Date("2026-10-12T11:00:00Z") };
const obligation: RefundObligationFact = { id: "refund", paymentAttemptId: additional.id,
  operationKey: "reduction", amountMinor: 1000, status: "pending" };
const capture: CaptureReceiptFact = { paymentAttemptId: original.id, provider: "stripe", providerPaymentId: "pi_original",
  amountMinor: 5000, currency: "RON" };

function allocate(amount: number, refunds: RefundObligationFact[] = [], payments = [original, additional],
  captures: CaptureReceiptFact[] = payments.filter(payment => payment.status === "succeeded").map(payment => ({
    paymentAttemptId: payment.id, provider: "stripe", providerPaymentId: payment.providerPaymentId!,
    amountMinor: payment.amountMinor, currency: payment.currency,
  })), operationKey = "new-operation", onlyAttemptId?: string) {
  return allocateRefund({ amount, payments, refunds, captures, operationKey, onlyAttemptId });
}

test("50 + 25 - 25 allocates the reduction to the newer capture and leaves 50 collected", () => {
  expect(allocate(2500)).toEqual({ kind: "allocate", allocations: [{ paymentAttemptId: additional.id,
    provider: "stripe", providerPaymentId: "pi_additional", amountMinor: 2500, capturedAmountMinor: 2500, currency: "RON" }] });
  const financials = summarizeBookingFinancials([original, additional], [{ ...obligation, amountMinor: 2500, status: "succeeded" }]);
  expect(financials).toMatchObject({ captured: 7500, refunded: 2500, obligated: 2500, netPaid: 5000, refundable: 5000 });
});

test("larger refunds consume newest captures first and split only the remaining amount", () => {
  const result = allocate(6000);
  expect(result.kind === "allocate" && result.allocations.map(a => [a.paymentAttemptId, a.amountMinor]))
    .toEqual([[additional.id, 2500], [original.id, 3500]]);
});

test.each(["pending", "pending_retry", "failed", "succeeded"] as const)("%s obligations reserve capacity", status => {
  const result = allocate(3000, [{ ...obligation, status }]);
  expect(result.kind === "allocate" && result.allocations.map(a => [a.paymentAttemptId, a.amountMinor]))
    .toEqual([[additional.id, 1500], [original.id, 1500]]);
  expect(() => allocate(6501, [{ ...obligation, status }])).toThrow(RefundAllocationError);
});

test("replay returns the existing operation identities without allocating again", () => {
  expect(allocate(1000, [obligation], [original, additional], [], "reduction"))
    .toEqual({ kind: "replay", refundIds: [obligation.id] });
});

test("Pay-at-club debt and uncertain online attempts are not collected funds", () => {
  expect(() => allocate(1, [], [{ ...original, method: "pay_at_club", provider: null, providerPaymentId: null, status: "due" }]))
    .toThrow(RefundAllocationError);
  expect(() => allocate(1, [], [{ ...original, status: "pending" }])).toThrow(RefundAllocationError);
});

test("one deduplicated exact late capture funds the refund once", () => {
  const payment = { ...original, status: "expired" as const };
  expect(allocate(5000, [], [payment], [capture])).toMatchObject({ kind: "allocate",
    allocations: [{ paymentAttemptId: payment.id, capturedAmountMinor: 5000, amountMinor: 5000 }] });
  expect(() => allocate(5001, [], [payment], [capture])).toThrow(RefundAllocationError);
});

test.each([
  { amountMinor: 7500 }, { currency: "EUR" }, { providerPaymentId: "pi_other" },
  { paymentAttemptId: "other" }, { provider: "netopia" },
])("requested amount cannot replace mismatched provider capture %j", changed => {
  expect(() => allocate(5000, [], [{ ...original, status: "expired" }], [{ ...capture, ...changed }]))
    .toThrow(RefundAllocationError);
});

test("single-attempt compensation cannot consume a different capture", () => {
  expect(() => allocate(2501, [], [original, additional], [], "compensation", additional.id)).toThrow(RefundAllocationError);
});

test("single-attempt operations replay only their own attempt/operation identity", () => {
  expect(allocate(5000, [obligation], [original, additional], [capture], "reduction", original.id))
    .toMatchObject({ kind: "allocate", allocations: [{ paymentAttemptId: original.id, amountMinor: 5000 }] });
  expect(allocate(1000, [obligation], [original, additional], [], "reduction", additional.id))
    .toEqual({ kind: "replay", refundIds: [obligation.id] });
});

test("equal creation times use stable attempt-ID ordering", () => {
  const result = allocate(2500, [], [original, { ...additional, createdAt: original.createdAt }]);
  expect(result.kind === "allocate" && result.allocations[0].paymentAttemptId).toBe(additional.id);
});

test("over-reserved captures reject new allocation without hiding inconsistency", () => {
  expect(() => allocate(1, [{ ...obligation, amountMinor: 2501 }])).toThrow("Refund obligations exceed captured funds");
});

test("zero remainder creates no obligation and facts are not mutated", () => {
  const payments = [original, additional], refunds = [{ ...obligation, amountMinor: 2500 }];
  const before = structuredClone({ payments, refunds });
  expect(allocate(0, refunds, payments)).toEqual({ kind: "allocate", allocations: [] });
  expect({ payments, refunds }).toEqual(before);
});
