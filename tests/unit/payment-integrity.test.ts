import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { reservationIntervalsOverlap } from "@/lib/reservations/domain";
import { paymentHasCapturedEvidence, refundFinancialSnapshotMatches } from "@/lib/payments/refund-integrity";
import type { ProcessingRefund } from "@/lib/db/repositories/payments.repository";
import type { PaymentCaptureReceiptEntity } from "@/lib/db/entities/payment-capture-receipt.entity";

const interval = { courtId: randomUUID(), date: "2099-10-15", startMinute: 600, endMinute: 660 };
test.each([
  [630,690,true],
  [610,650,true],
  [660,720,false],
  [540,600,false],
])("reservation interval %i–%i overlap=%s", (startMinute,endMinute,expected) => {
  const other = {...interval,startMinute,endMinute};
  expect(reservationIntervalsOverlap(interval,other)).toBe(expected);
  expect(reservationIntervalsOverlap(other,interval)).toBe(expected);
});
const payment = { id:randomUUID(),booking_id:randomUUID(),method:"online",provider:"stripe",
  provider_payment_id:"pi_original",amount_minor:5000,currency:"RON",status:"succeeded" };
const refund: ProcessingRefund = { id:randomUUID(),booking_id:payment.booking_id,payment_attempt_id:payment.id,
  provider:"stripe",provider_payment_id:"pi_original",amount_minor:5000,currency:"RON",
  status:"pending",created_at:"2026-10-08T12:00:00.123456+00:00",operation_key:"cancellation",captured_amount_minor:5000 };
const capture: PaymentCaptureReceiptEntity = { id:randomUUID(),paymentAttemptId:payment.id,provider:"stripe",
  providerPaymentId:"pi_original",providerCaptureId:"ch_capture",amountMinor:5000,currency:"RON",
  firstObservedAt:new Date(),lastObservedAt:new Date() };
test("refund validates the original capture snapshot, not the current rescheduled booking price", () => {
  expect(refundFinancialSnapshotMatches(refund,payment)).toBe(true);
  for (const changed of [{...payment,id:randomUUID()},{...payment,booking_id:randomUUID()},
    {...payment,provider:"netopia"},{...payment,provider_payment_id:"pi_other"},
    {...payment,amount_minor:7000},{...payment,currency:"EUR"}])
    expect(refundFinancialSnapshotMatches(refund,changed)).toBe(false);
});
test("an exact authoritative capture receipt is required for refunds", () => {
  expect(paymentHasCapturedEvidence(payment,[])).toBe(false);
  const expired={...payment,status:"expired"};
  expect(paymentHasCapturedEvidence(expired,[])).toBe(false);
  expect(paymentHasCapturedEvidence(expired,[capture])).toBe(true);
  for (const changed of [{...capture,paymentAttemptId:randomUUID()},{...capture,providerPaymentId:"pi_other"},
    {...capture,amountMinor:1},{...capture,currency:"EUR" as const}])
    expect(paymentHasCapturedEvidence(expired,[changed])).toBe(false);
  expect(paymentHasCapturedEvidence({...payment,provider:"netopia"},[capture])).toBe(false);
  expect(paymentHasCapturedEvidence({...payment,method:"pay_at_club"},[capture])).toBe(false);
});

// Capture actual repository statements without installed triggers masking a
// missing timestamp or silently supplying immutable financial protection.
test("every payment/refund update explicitly writes transaction-time updated_at through narrow methods", async () => {
  const { DataSource } = await import("typeorm");
  const { vi } = await import("vitest");
  const payments=await import("@/lib/db/repositories/payments.repository");
  const source=new DataSource({type:"postgres",url:"postgresql://unused/unused"});
  const query=vi.spyOn(source.manager,"query").mockResolvedValue([{id:payment.id}]);
  await payments.attachCheckoutPayment(source.manager,{attemptId:payment.id,bookingId:payment.booking_id,
    provider:"stripe",providerPaymentId:"pi_original",tokenHash:"hash"});
  await payments.updateSettlementAttempt(source.manager,payment.id,{status:"succeeded",providerPaymentId:"pi_original",deadline:null});
  await payments.expirePendingAttempt(source.manager,payment.id);
  await payments.writeRefundStatus(source.manager,refund.id,"succeeded");
  expect(query).toHaveBeenCalledTimes(4);
  for (const [sql] of query.mock.calls) {
    expect(sql).toMatch(/updated_at\s*=\s*now\(\)/);
    const assignments=sql.split(/\bSET\b/i)[1].split(/\bWHERE\b/i)[0];
    expect(assignments).not.toMatch(/\b(?:method|provider|amount_minor|currency|booking_id|payment_attempt_id|created_at)\s*=/);
  }
  query.mockRestore();
});


test.each([null, undefined, 0, -1, 1.5])("processing rejects invalid captured-amount snapshot %s", async snapshot => {
  const { DataSource } = await import("typeorm");
  const { vi } = await import("vitest");
  const { lockRefundForProcessing } = await import("@/lib/db/repositories/payments.repository");
  const source = new DataSource({ type: "postgres", url: "postgresql://unused/unused" });
  const query = vi.spyOn(source.manager, "query").mockResolvedValue([{ ...refund, captured_amount_minor: snapshot }]);
  try { await expect(lockRefundForProcessing(source.manager, { id: refund.id })).rejects.toThrow(); }
  finally { query.mockRestore(); }
});

test("a partial refund retains the full captured snapshot and cannot exceed it", () => {
  expect(refundFinancialSnapshotMatches({ ...refund, amount_minor: 2500 }, payment)).toBe(true);
  expect(refundFinancialSnapshotMatches({ ...refund, captured_amount_minor: 2500, amount_minor: 2500 }, payment)).toBe(false);
  expect(refundFinancialSnapshotMatches({ ...refund, amount_minor: 5001 }, payment)).toBe(false);
});
