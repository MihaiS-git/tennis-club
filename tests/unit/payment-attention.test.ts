import { expect, test } from "vitest";
import { paymentNeedsAttention, refundRecoveryStalled } from "@/lib/payments/domain";

const now = Date.parse("2026-10-15T12:00:00Z");
const started = (age: number) => new Date(now - age).toISOString();
const day = 24 * 3_600_000;

test.each([
  [day - 1, false], [day, false], [day + 1, true],
])("refund attention preserves the strict 24-hour boundary at age %i", (age, expected) => {
  expect(refundRecoveryStalled("pending_retry", started(age), now)).toBe(expected);
});

test("recent status updates cannot hide old unresolved refunds", () => {
  const refund = { status: "pending_retry", recovery_started_at: started(day + 1), updated_at: started(0) };
  expect(refundRecoveryStalled(refund.status, refund.recovery_started_at, now)).toBe(true);
  // Use real time here because the combined predicate supplies its own clock.
  expect(paymentNeedsAttention({ ...refund, recovery_started_at: new Date(Date.now() - day - 1000).toISOString() }, [])).toBe(true);
});

test.each(["pending", "succeeded", "voided"])("%s refunds do not become stalled with old evidence", status => {
  expect(refundRecoveryStalled(status, started(day + 1), now)).toBe(false);
  expect(paymentNeedsAttention({ status, recovery_started_at: started(day + 1) }, [])).toBe(false);
});

test("definitive failures and reconciliation retain independent attention", () => {
  expect(paymentNeedsAttention({ status: "failed" }, [])).toBe(true);
  expect(paymentNeedsAttention(null, [{ reconciliation_required: true }])).toBe(true);
  expect(paymentNeedsAttention(null, [{ reconciliation_required: false }])).toBe(false);
  expect(refundRecoveryStalled("pending_retry", null, now)).toBe(false);
});
