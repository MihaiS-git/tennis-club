import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { buildBookingRevision } from "@/lib/bookings/revision";
import { describeFinancialContext, refundReasonLabels } from "@/lib/payments/financial-history-context";

const initial = buildBookingRevision({ locationId: randomUUID(), courtId: randomUUID(), locationName: "Original Club", courtName: "Original Court",
  timezone: "UTC", bookingDate: "2099-10-15", startMinute: 600, endMinute: 660, customerName: "Original Customer",
  customerEmail: "original@example.test", customerPhone: "123", totalAmountMinor: 5000, currency: "RON", paymentMethod: "online",
  cancellationNoticeMinutes: 1440, pricingEvidence: { version: 1, rounding: "half-hour-sum-round", courtState: "outdoor",
    slots: [600,630].map(minute => ({ minute, ruleId: randomUUID(), ruleSetId: randomUUID(), hourlyMinor: 5000, startsOn: null, endsOn: null })) } },
  { id: randomUUID(), bookingId: randomUUID(), operationKey: "created", intentHash: "created", kind: "created", bookingState: "pending_payment",
    actorUserId: null, actorScope: "guest", recordedAt: new Date(), adjustmentId: null, cancellationCause: null }, null);
const input = { kind: "payment" as const, revision: initial, adjustment: null, adjustmentStatus: null, appliedRevisionId: null,
  base: null, confirmationRevisionId: null, reason: null, amount: 5000, capturedAmount: null };

test("original requests expose stored context without manufacturing confirmation", () => {
  const result = describeFinancialContext(input);
  expect(result).toMatchObject({ context: { revisionId: initial.id, source: "original_request", confirmationRevisionId: null,
    bookingState: "pending_payment", courtName: "Original Court", customerEmail: "original@example.test" }, proposal: null });
});

test("a confirmed operation key supplies confirmation evidence without replacing initial request facts", () => {
  const confirmation = randomUUID();
  expect(describeFinancialContext({ ...input, confirmationRevisionId: confirmation })).toMatchObject({
    context: { revisionId: initial.id, confirmationRevisionId: confirmation }, booking_total_minor: 5000 });
});

test("late compensation is identified by reason despite sharing the cancellation operation key", () => {
  expect(describeFinancialContext({ ...input, kind: "refund", reason: "late_capture_compensation", capturedAmount: 5000 }))
    .toMatchObject({ operation_label: refundReasonLabels.late_capture_compensation, context: { revisionId: initial.id,
      bookingState: "pending_payment", confirmationRevisionId: null } });
});

test("missing adjustment and refund associations fail instead of falling back", () => {
  expect(() => describeFinancialContext({ ...input, kind: "refund" })).toThrow("Missing refund reason");
  expect(() => describeFinancialContext({ ...input, adjustment: { id: randomUUID(), kind: "reschedule", newTotal: 7500, currency: "RON",
    target: { courtId: randomUUID(), date: "2099-10-15", startMinute: 720, endMinute: 810, expectedUpdatedAt: new Date().toISOString(),
      courtName: "Proposed Court", locationName: "Proposed Club", timezone: "UTC" } } })).toThrow("Missing adjustment contract context");
});
