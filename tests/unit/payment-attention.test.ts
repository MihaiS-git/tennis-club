import { expect, test } from "vitest";
import { paymentNeedsAttention, refundUnconfirmed, unconfirmedRefundMinutes } from "@/lib/payments/domain";

const now = Date.parse("2026-10-15T12:00:00Z");
const started = (age: number) => new Date(now - age).toISOString();
const grace = unconfirmedRefundMinutes * 60_000;

test.each([
  [grace - 1, false], [grace, false], [grace + 1, true],
])("an unconfirmed refund needs attention strictly after the grace period at age %i", (age, expected) => {
  expect(refundUnconfirmed("pending_retry", started(age), now)).toBe(expected);
  expect(refundUnconfirmed("pending", started(age), now)).toBe(expected);
});

test("recent status updates cannot hide old unresolved refunds", () => {
  const refund = { status: "pending_retry", outstanding_since: started(grace + 1), updated_at: started(0) };
  expect(refundUnconfirmed(refund.status, refund.outstanding_since, now)).toBe(true);
  // Use real time here because the combined predicate supplies its own clock.
  expect(paymentNeedsAttention({ ...refund, outstanding_since: new Date(Date.now() - grace - 1000).toISOString() }, [])).toBe(true);
});

test.each(["succeeded", "voided"])("%s refunds never need attention with old evidence", status => {
  expect(refundUnconfirmed(status, started(grace + 1), now)).toBe(false);
  expect(paymentNeedsAttention({ status, outstanding_since: started(grace + 1) }, [])).toBe(false);
});

test("definitive failures and reconciliation retain independent attention", () => {
  expect(paymentNeedsAttention({ status: "failed" }, [])).toBe(true);
  expect(paymentNeedsAttention(null, [{ reconciliation_required: true }])).toBe(true);
  expect(paymentNeedsAttention(null, [{ reconciliation_required: false }])).toBe(false);
  expect(refundUnconfirmed("pending_retry", null, now)).toBe(false);
});
