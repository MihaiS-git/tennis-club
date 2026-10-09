import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { reservationIntervalsOverlap } from "@/lib/reservations/domain";
import { paymentHasCapturedEvidence, refundFinancialSnapshotMatches } from "@/lib/payments/refund-integrity";
import type { ProcessingRefund, ProviderReceipt } from "@/lib/db/repositories/payments.repository";

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
  provider:"stripe",provider_payment_id:"pi_original",provider_refund_id:null,amount_minor:5000,currency:"RON",
  status:"pending",created_at:"2026-10-08T12:00:00.123456+00:00",admin_lease_token:null,admin_lease_actor_id:null,
  admin_lease_until:null,lease_busy:null };
const event: ProviderReceipt = { provider:"stripe",event_id:"evt_capture",attempt_id:payment.id,
  provider_payment_id:"pi_original",outcome:"succeeded",amount_minor:5000,currency:"RON",
  settlement_result:"expired",reconciliation_required:true };
test("refund validates the original capture snapshot, not the current rescheduled booking price", () => {
  expect(refundFinancialSnapshotMatches(refund,payment)).toBe(true);
  for (const changed of [{...payment,id:randomUUID()},{...payment,booking_id:randomUUID()},
    {...payment,provider:"netopia"},{...payment,provider_payment_id:"pi_other"},
    {...payment,amount_minor:7000},{...payment,currency:"EUR"}])
    expect(refundFinancialSnapshotMatches(refund,changed)).toBe(false);
});
test("a captured attempt or exact successful provider receipt is required for refunds", () => {
  expect(paymentHasCapturedEvidence(payment,[])).toBe(true);
  const expired={...payment,status:"expired"};
  expect(paymentHasCapturedEvidence(expired,[])).toBe(false);
  expect(paymentHasCapturedEvidence(expired,[event])).toBe(true);
  for (const changed of [{...event,attempt_id:randomUUID()},{...event,provider_payment_id:"pi_other"},
    {...event,amount_minor:1},{...event,currency:"EUR"},{...event,outcome:"failed" as const}])
    expect(paymentHasCapturedEvidence(expired,[changed])).toBe(false);
  expect(paymentHasCapturedEvidence({...payment,provider:"netopia"},[event])).toBe(false);
  expect(paymentHasCapturedEvidence({...payment,method:"pay_at_club"},[event])).toBe(false);
});

// Capture actual repository statements without installed triggers masking a
// missing timestamp or silently supplying immutable financial protection.
test("every booking/payment/refund update explicitly writes transaction-time updated_at through narrow methods", async () => {
  const { DataSource } = await import("typeorm");
  const { vi } = await import("vitest");
  const bookings=await import("@/lib/db/repositories/bookings.repository");
  const payments=await import("@/lib/db/repositories/payments.repository");
  const source=new DataSource({type:"postgres",url:"postgresql://unused/unused"});
  const query=vi.spyOn(source.manager,"query").mockResolvedValue([{id:payment.id}]);
  await bookings.updateBookingCancellationStatus(source.manager,payment.booking_id);
  await bookings.updateBookingRescheduleTotal(source.manager,payment.booking_id,5000);
  await bookings.updateSettlementBookingStatus(source.manager,payment.booking_id,"expired");
  await payments.attachCheckoutPayment(source.manager,{attemptId:payment.id,bookingId:payment.booking_id,
    provider:"stripe",providerPaymentId:"pi_original",tokenHash:"hash"});
  await payments.updateSettlementAttempt(source.manager,payment.id,{status:"succeeded",providerPaymentId:"pi_original",deadline:null});
  await payments.expirePendingAttempt(source.manager,payment.id);
  await payments.writeRefundLease(source.manager,refund.id,randomUUID(),randomUUID());
  await payments.writeRefundResult(source.manager,refund.id,{status:"succeeded",providerRefundId:"re_original",lastError:null,clearLease:true});
  expect(query).toHaveBeenCalledTimes(8);
  for (const [sql] of query.mock.calls) {
    expect(sql).toMatch(/updated_at\s*=\s*now\(\)/);
    const assignments=sql.split(/\bSET\b/i)[1].split(/\bWHERE\b/i)[0];
    expect(assignments).not.toMatch(/\b(?:method|provider|amount_minor|currency|booking_id|payment_attempt_id|created_at)\s*=/);
  }
  query.mockRestore();
});
