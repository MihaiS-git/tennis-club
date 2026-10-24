import { buildBookingRevision } from "@/lib/bookings/revision";
import * as revisions from "@/lib/db/repositories/booking-revisions.repository";
import { DataSource, EntityManager } from "typeorm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { inTransaction } from "@/lib/db/transaction";
import { LocationEntity } from "@/lib/db/entities/location.entity";
import { bookingFinancials, allocateBookingRefund } from "@/lib/payments/financials";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { lockReservationActorFacts } from "@/lib/db/repositories/accounts.repository";
import { cancelCustomerBookingCommand, rescheduleCustomerBookingCommand } from "@/lib/bookings/commands";
import { expirePaymentHoldsAtLocation } from "@/lib/payments/hold-expiry";
import { CourtEntity } from "@/lib/db/entities/court.entity";
import { LocationPricingRuleEntity } from "@/lib/db/entities/location-pricing-rule.entity";
import { listCheckoutPricing } from "@/lib/db/repositories/pricing.repository";
import { listCheckoutLocationCourts, listCheckoutCourtCoverage, lockLocations } from "@/lib/db/repositories/clubs.repository";
import { hasOccupancyConflict } from "@/lib/reservations/occupancy";
import { processOnlinePaymentEvent } from "@/lib/payments/service";
import * as adjustments from "@/lib/db/repositories/booking-adjustments.repository";
import * as captures from "@/lib/db/repositories/payment-capture-receipts.repository";
import { BookingAdjustmentEntity } from "@/lib/db/entities/booking-adjustment.entity";
import { PaymentAttemptEntity } from "@/lib/db/entities/payment-attempt.entity";
import { PaymentRefundEntity } from "@/lib/db/entities/payment-refund.entity";

vi.mock("@/lib/db/transaction");
vi.mock("@/lib/db/repositories/accounts.repository");
vi.mock("@/lib/db/repositories/booking-adjustments.repository");
vi.mock("@/lib/payments/financials");
vi.mock("@/lib/db/repositories/pricing.repository");
vi.mock("@/lib/payments/hold-expiry");
vi.mock("@/lib/db/repositories/payments.repository");
vi.mock("@/lib/db/repositories/payment-capture-receipts.repository");
vi.mock("@/lib/db/repositories/bookings.repository");
vi.mock("@/lib/db/repositories/booking-revisions.repository");
vi.mock("@/lib/db/repositories/reservations.repository");
vi.mock("@/lib/db/repositories/clubs.repository");
vi.mock("@/lib/reservations/occupancy");
vi.mock("@/lib/notifications/events", () => ({
  recordBookingTransition: vi.fn(),
  recordBookingFinancialException: vi.fn(),
  recordSuccessfulRefund: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

const id = "00000000-0000-4000-8000-000000000001";
const revisionFixture = (paymentMethod: "online" | "pay_at_club", notice: number, bookingState: "confirmed" | "pending_payment") => buildBookingRevision({
  locationId:id,courtId:id,locationName:"Club",courtName:"Court",timezone:"UTC",bookingDate:"2099-10-15",startMinute:600,endMinute:660,
  customerName:"Customer",customerEmail:"snapshot@example.test",customerPhone:"123",totalAmountMinor:5000,currency:"RON",paymentMethod,
  cancellationNoticeMinutes:notice,pricingEvidence:{version:1,rounding:"half-hour-sum-round",courtState:"outdoor",
    slots:[600,630].map(minute=>({minute,ruleId:id,ruleSetId:id,hourlyMinor:5000,startsOn:null,endsOn:null}))},
},{id,bookingId:id,kind:"created",bookingState,operationKey:"created",intentHash:"fixture",actorUserId:id,actorScope:"customer",
  recordedAt:new Date("2099-10-14T10:00:00Z"),adjustmentId:null,cancellationCause:null},null);
const event = { attemptId: id, provider: "stripe" as const, providerPaymentId: "pi_test", eventId: "evt_test",
  providerCaptureId: "pi_test", amountMinor: 5000, currency: "RON", outcome: "succeeded" as const };
const source = new DataSource({ type: "postgres" }); // No connection.
const runner = source.createQueryRunner();
const manager = new EntityManager(source, runner);
let committed: boolean;
beforeEach(() => {
  vi.resetAllMocks(); committed = false;
  vi.mocked(adjustments.readAdjustmentHolds).mockResolvedValue({ total: 0, valid: 0 });
  Object.defineProperty(runner, "isTransactionActive", { value: true, configurable: true });
  vi.spyOn(manager, "query").mockResolvedValue([]);
  vi.mocked(bookingFinancials).mockResolvedValue({ payments: [], refunds: [], captures: [],
    captured: 0, refunded: 0, obligated: 0, netPaid: 0, refundable: 0 });
  vi.mocked(allocateBookingRefund).mockResolvedValue([]);
  vi.mocked(inTransaction).mockImplementation(async work => {
    const result = await work(manager); committed = true; return result;
  });
  vi.mocked(payments.discoverSettlementParent).mockResolvedValue({ booking_id: id, reservation_id: id, location_id: id });
  vi.mocked(captures.recordCaptureReceipt).mockResolvedValue({ id, payment_attempt_id:id, provider:"stripe",
    provider_payment_id:"pi_test",provider_capture_id:"pi_test",amount_minor:5000,currency:"RON" });
  vi.mocked(lockLocations).mockResolvedValue([Object.assign(new LocationEntity(), { id, name: "Club", timezone: "UTC", currency: "RON", isActive: true, isPublic: true, archivedAt: null, customerCancellationNoticeMinutes: 1440 })]);
  vi.mocked(bookings.findBookingForUpdate).mockResolvedValue({ id, reservation_id: id, status: "pending_payment",
    customer_name: "Customer", customer_email: "snapshot@example.test", cancellation_notice_minutes: 1440, total_amount_minor: 5000, currency: "RON", account_user_id:id,current_revision_id:id,
    revision:revisionFixture("online",1440,"pending_payment"),customer_phone:"123",payment_method:"online",updated_at:"2099-10-14T10:00:00Z",token_matches:null });
  vi.mocked(reservations.findReservationForUpdate).mockResolvedValue({ id, court_id: id, coach_user_id: null, booking_date: "2099-10-15",
    starts_at_minute: 600, ends_at_minute: 660, reason: null, created_by_user_id: null, status: "held",
    created_at: "2099-10-14T10:00:00Z", updated_at: "2099-10-14T10:00:00Z", cancelled_at: null,
    cancelled_by_user_id: null, hold_expires_at: "2099-10-14T10:10:00Z", token_matches: null });
  vi.mocked(payments.lockSettlementAttempt).mockResolvedValue({ id, booking_id: id, method: "online", provider: "stripe",
    provider_payment_id: "pi_test", amount_minor: 5000, currency: "RON", status: "pending", expires_at: "2099-10-14T10:10:00Z", checkout_capability: true });
  vi.mocked(listCheckoutLocationCourts).mockResolvedValue([Object.assign(new CourtEntity(), { id, name: "Court", slug: "court", surface: "clay", environment: "outdoor", hasLighting: false })]);
  vi.mocked(listCheckoutCourtCoverage).mockResolvedValue([]);
  vi.mocked(reservations.listReservationOpeningHours).mockResolvedValue([{ id, location_id: id, weekday: 3,
    opens_at_minute: 0, closes_at_minute: 1440, created_at: "2099-10-14T10:00:00Z", updated_at: "2099-10-14T10:00:00Z" }]);
  vi.mocked(listCheckoutPricing).mockResolvedValue([Object.assign(new LocationPricingRuleEntity(), {
    id, ruleSetId: id, locationId: id, courtId: id, courtState: "outdoor", weekday: 3,
    startsAtMinute: 0, endsAtMinute: 1440, startsOn: null, endsOn: null, pricePerHourMinor: 5000,
    createdAt: new Date("2099-10-14T10:00:00Z"), updatedAt: new Date("2099-10-14T10:00:00Z"),
  })]);
  vi.mocked(reservations.findReservationResourceFacts).mockResolvedValue({ court_id: id, court_name: "Court", court_active: true,
    location_id: id, location_name: "Club", location_timezone: "UTC", location_active: true, archived_at: null });
  vi.mocked(reservations.readReservationClockTime).mockResolvedValue("2099-10-14T10:00:00Z");
  vi.mocked(hasOccupancyConflict).mockResolvedValue(false);
  vi.mocked(payments.updateSettlementAttempt).mockResolvedValue(true);
  vi.mocked(reservations.updateCustomerReservationSchedule).mockResolvedValue(true);
  vi.mocked(payments.insertProviderEventReceipt).mockResolvedValue(true);
});
afterEach(() => { vi.restoreAllMocks(); });

const advancedRevision = () => vi.mocked(revisions.advanceRevision).mock.calls.at(-1)![1].revision;

test("first payment confirmation writes the confirmed revision snapshot inside one transaction callback", async () => {
  expect(await processOnlinePaymentEvent(event)).toBe("succeeded");
  expect(committed).toBe(true);
  expect(inTransaction).toHaveBeenCalledTimes(1);
  expect(revisions.advanceRevision).toHaveBeenCalledWith(manager, expect.objectContaining({ status:"confirmed",previousId:id }));
  expect(advancedRevision()).toMatchObject({ kind: "confirmed", bookingState: "confirmed", customerEmail: "snapshot@example.test" });
});
test("failed commit propagates without confirming", async () => {
  vi.mocked(inTransaction).mockImplementation(async work => { await work(manager); throw new Error("Commit failed"); });
  await expect(processOnlinePaymentEvent(event)).rejects.toThrow("Commit failed");
  expect(committed).toBe(false);
});
test.each(["failed", "cancelled", "retryable_failed"] as const)("%s payment does not confirm the booking", async outcome => {
  await processOnlinePaymentEvent({ ...event, outcome });
  expect(revisions.advanceRevision).not.toHaveBeenCalledWith(manager, expect.objectContaining({ status: "confirmed" }));
});
test("duplicate webhook receipt returns success without another revision", async () => {
  await processOnlinePaymentEvent(event);
  vi.mocked(payments.findProviderEventReceipt).mockResolvedValue({ provider: "stripe", event_id: event.eventId,
    attempt_id: id, capture_receipt_id:id, provider_capture_id:"pi_test", provider_payment_id: "pi_test", outcome: "succeeded", amount_minor: 5000, currency: "RON",
    settlement_result: "succeeded", reconciliation_required: false });
  expect(await processOnlinePaymentEvent(event)).toBe("succeeded");
  expect(revisions.advanceRevision).toHaveBeenCalledOnce();
});

async function confirmedBooking() {
  vi.mocked(bookings.discoverBookingLocation).mockResolvedValue({ location_id: id, coach_user_id: null });
  vi.mocked(lockLocations).mockResolvedValue([Object.assign(new LocationEntity(), {
    id, name: "Club", timezone: "UTC", currency: "RON", isActive: true, archivedAt: null,
  })]);
  vi.mocked(bookings.findBookingForUpdate).mockResolvedValue({ id, reservation_id: id, account_user_id: id,
    status: "confirmed", customer_name: "Customer", customer_email: "snapshot@example.test", customer_phone: "123",
    total_amount_minor: 5000, currency: "RON", payment_method: "pay_at_club", cancellation_notice_minutes: 0, updated_at: "2099-10-14T10:00:00Z", token_matches: true,current_revision_id:id,revision:revisionFixture("pay_at_club",0,"confirmed") });
  const reservation = await reservations.findReservationForUpdate(manager, id);
  if (!reservation) throw new Error("Missing test reservation");
  vi.mocked(reservations.findReservationForUpdate).mockResolvedValue({ ...reservation, status: "active", hold_expires_at: null, token_matches: true });
  vi.mocked(lockReservationActorFacts).mockResolvedValue({ status: "active", roles: ["admin"] });
}
test.each(["owner", "admin"] as const)("%s cancellation preserves the recipient in the committed revision", async scope => {
  await confirmedBooking();
  expect(await cancelCustomerBookingCommand(id, id, scope)).toEqual({ outcome: "cancelled", refundIds: [] });
  expect(committed).toBe(true);
  expect(advancedRevision()).toMatchObject({ kind: "cancelled", customerEmail: "snapshot@example.test",
    cancellationCause: scope === "admin" ? "admin_cancelled" : "owner_cancelled" });
});
test("booking commit failure propagates the cancellation error", async () => {
  await confirmedBooking();
  vi.mocked(inTransaction).mockImplementation(async work => { await work(manager); throw new Error("Commit failed"); });
  await expect(cancelCustomerBookingCommand(id, id, "owner")).rejects.toThrow("Commit failed");
  expect(committed).toBe(false);
});
test.each(["owner", "admin"] as const)("%s cancellation returns every refund obligation on creation and replay", async scope => {
  await confirmedBooking();
  const booking = await bookings.findBookingForUpdate(manager, id);
  const financial = await bookingFinancials(manager, id, true);
  if (!booking) throw new Error("Missing booking fixture");
  vi.mocked(bookings.findBookingForUpdate).mockResolvedValue({ ...booking, payment_method: "online" });
  vi.mocked(bookingFinancials).mockResolvedValue({ ...financial, refundable: 7500 });
  const refundIds = [id, "00000000-0000-4000-8000-000000000002"];
  vi.mocked(allocateBookingRefund).mockResolvedValue(refundIds);
  const adjustment = Object.assign(new BookingAdjustmentEntity(), { id, bookingId: id, kind: "cancellation", status: "pending" });
  vi.mocked(adjustments.insertAdjustment).mockResolvedValue(adjustment);
  const result = await cancelCustomerBookingCommand(id, id, scope);
  expect(result).toEqual({ outcome: "cancellation_pending", adjustmentId: id, refundIds });
  vi.mocked(adjustments.findPendingAdjustment).mockResolvedValue(adjustment);
  vi.mocked(bookingFinancials).mockResolvedValue({ ...financial, refunds: refundIds.map(refundId =>
    Object.assign(new PaymentRefundEntity(), { id: refundId, operationKey: id, adjustmentId: id })) });
  expect(await cancelCustomerBookingCommand(id, id, scope)).toEqual(result);
  expect(allocateBookingRefund).toHaveBeenCalledOnce();
  expect(adjustments.insertAdjustment).toHaveBeenCalledOnce();
  expect(revisions.advanceRevision).not.toHaveBeenCalled();
  expect(reservations.updateCustomerReservationCancellation).not.toHaveBeenCalled();
});
test("cancellation runs its writes inside one transaction callback", async () => {
  await confirmedBooking();
  expect(await cancelCustomerBookingCommand(id, id, "owner")).toEqual({ outcome: "cancelled", refundIds: [] });
  expect(committed).toBe(true); expect(inTransaction).toHaveBeenCalledTimes(1);
  expect(revisions.advanceRevision).toHaveBeenCalledWith(manager, expect.objectContaining({ previousId:id,status:"cancelled" }));
});
test.each(["owner"] as const)("%s rescheduling commits the new schedule; quotes and unchanged saves commit nothing", async () => {
  await confirmedBooking();
  vi.mocked(expirePaymentHoldsAtLocation).mockResolvedValue(0);
  vi.mocked(listCheckoutLocationCourts).mockResolvedValue([Object.assign(new CourtEntity(), { id, name: "Court", environment: "outdoor" })]);
  vi.mocked(reservations.listReservationOpeningHours).mockResolvedValue([{ id, location_id: id, weekday: 3,
    opens_at_minute: 0, closes_at_minute: 1440, created_at: "2099-10-14T10:00:00Z", updated_at: "2099-10-14T10:00:00Z" }]);
  vi.mocked(listCheckoutCourtCoverage).mockResolvedValue([]);
  vi.mocked(listCheckoutPricing).mockResolvedValue([Object.assign(new LocationPricingRuleEntity(), {
    id, ruleSetId: id, locationId: id, courtId: id, courtState: "outdoor", weekday: 3,
    startsAtMinute: 0, endsAtMinute: 1440, startsOn: null, endsOn: null, pricePerHourMinor: 5000,
    createdAt: new Date("2099-10-14T10:00:00Z"), updatedAt: new Date("2099-10-14T10:00:00Z"),
  })]);
  const edit = { id, expectedUpdatedAt: "2099-10-14T10:00:00Z", expectedRevisionId: id,
    courtId: id, date: "2099-10-15", startMinute: 720, endMinute: 780, save: false, expectedTotal: 5000, priceAcknowledged: true };
  expect(await rescheduleCustomerBookingCommand(edit, id)).toEqual({ ok: true, totalAmountMinor: 5000 });
  expect(await rescheduleCustomerBookingCommand({ ...edit, save: true, startMinute: 600, endMinute: 660 }, id))
    .toEqual({ ok: true, totalAmountMinor: 5000 });
  expect(revisions.advanceRevision).not.toHaveBeenCalled();
  expect(await rescheduleCustomerBookingCommand({ ...edit, save: true }, id)).toEqual({ ok: true, totalAmountMinor: 5000 });
  expect(revisions.advanceRevision).toHaveBeenCalledOnce();
  expect(advancedRevision()).toMatchObject({ kind: "rescheduled", bookingDate: "2099-10-15", startMinute: 720, endMinute: 780, courtName: "Court" });
});

const edit = { id, expectedUpdatedAt: "2099-10-14T10:00:00Z", expectedRevisionId: id,
  courtId: id, date: "2099-10-15", startMinute: 720, endMinute: 780, save: true,
  expectedTotal: 5000, priceAcknowledged: true };

async function renameResources() {
  const [location] = await lockLocations(manager, [id]);
  vi.mocked(lockLocations).mockResolvedValue([Object.assign(new LocationEntity(), location, { name: "Renamed Club" })]);
  const resource = await reservations.findReservationResourceFacts(manager, id);
  if (!resource) throw new Error("Missing resource fixture");
  vi.mocked(reservations.findReservationResourceFacts).mockResolvedValue({ ...resource, court_name: "Renamed Court", location_name: "Renamed Club" });
  const [court] = await listCheckoutLocationCourts(manager, id);
  vi.mocked(listCheckoutLocationCourts).mockResolvedValue([Object.assign(new CourtEntity(), court, { name: "Renamed Court" })]);
}
test("online confirmation preserves revision names after resource renames", async () => {
  await renameResources();
  expect(await processOnlinePaymentEvent(event)).toBe("succeeded");
  expect(revisions.advanceRevision).toHaveBeenCalledWith(manager, expect.objectContaining({ revision: expect.objectContaining({
    locationName: "Club", courtName: "Court", timezone: "UTC", bookingDate: "2099-10-15", startMinute: 600, endMinute: 660,
  }) }));
});
test.each(["owner", "admin"] as const)("%s cancellation preserves historical revision names after renames", async scope => {
  await confirmedBooking(); await renameResources();
  expect(await cancelCustomerBookingCommand(id, id, scope)).toMatchObject({ outcome: "cancelled" });
  expect(advancedRevision()).toMatchObject({ locationName: "Club", courtName: "Court", bookingDate: "2099-10-15", startMinute: 600, endMinute: 660 });
});
test("rescheduling records the accepted revision after renames", async () => {
  await confirmedBooking(); await renameResources();
  expect(await rescheduleCustomerBookingCommand(edit, id)).toMatchObject({ ok: true });
  expect(revisions.advanceRevision).toHaveBeenCalledWith(manager, expect.objectContaining({ revision: expect.objectContaining({
    locationName: "Renamed Club", courtName: "Renamed Court", startMinute: 720, endMinute: 780,
  }) }));
});
test("replayed cancellation and applied reschedule commit no duplicate revision", async () => {
  await confirmedBooking();
  await cancelCustomerBookingCommand(id, id, "owner");
  const booking = await bookings.findBookingForUpdate(manager, id);
  if (!booking) throw new Error("Missing booking fixture");
  const revision = buildBookingRevision(booking.revision, { ...booking.revision, kind: "cancelled", bookingState: "cancelled",
    cancellationCause: "owner_cancelled" }, booking.revision);
  vi.mocked(bookings.findBookingForUpdate).mockResolvedValue({ ...booking, status: "cancelled", revision });
  await cancelCustomerBookingCommand(id, id, "owner");
  expect(revisions.advanceRevision).toHaveBeenCalledOnce();
  await confirmedBooking();
  await rescheduleCustomerBookingCommand(edit, id);
  expect(revisions.advanceRevision).toHaveBeenCalledTimes(2);
  vi.mocked(revisions.findRevisionOperation).mockResolvedValue(advancedRevision());
  await rescheduleCustomerBookingCommand(edit, id);
  expect(revisions.advanceRevision).toHaveBeenCalledTimes(2);
});
test("duplicate confirmation under a different event ID commits no second revision", async () => {
  await processOnlinePaymentEvent(event);
  const booking = await bookings.findBookingForUpdate(manager, id);
  const reservation = await reservations.findReservationForUpdate(manager, id);
  const attempt = await payments.lockSettlementAttempt(manager, id);
  if (!booking || !reservation || !attempt) throw new Error("Missing settlement fixture");
  vi.mocked(bookings.findBookingForUpdate).mockResolvedValue({ ...booking, status: "confirmed" });
  vi.mocked(reservations.findReservationForUpdate).mockResolvedValue({ ...reservation, status: "active", hold_expires_at: null });
  vi.mocked(payments.lockSettlementAttempt).mockResolvedValue({ ...attempt, status: "succeeded" });
  expect(await processOnlinePaymentEvent({ ...event, eventId: "evt_another" })).toBe("succeeded");
  expect(revisions.advanceRevision).toHaveBeenCalledOnce();
});
test("rejected cancellation and conflicting reschedule commit nothing", async () => {
  await confirmedBooking();
  vi.mocked(lockReservationActorFacts).mockResolvedValue({ status: "suspended", roles: [] });
  expect(await cancelCustomerBookingCommand(id, id, "owner")).toMatchObject({ outcome: "inactive" });
  expect(await rescheduleCustomerBookingCommand(edit, id)).toMatchObject({ ok: false });
  vi.mocked(lockReservationActorFacts).mockResolvedValue({ status: "active", roles: ["admin"] });
  vi.mocked(hasOccupancyConflict).mockResolvedValue(true);
  expect(await rescheduleCustomerBookingCommand(edit, id)).toMatchObject({ ok: false });
  expect(revisions.advanceRevision).not.toHaveBeenCalled();
});
test.each(["commit", "revision"])("failed reschedule %s propagates", async failure => {
  await confirmedBooking();
  if (failure === "commit") vi.mocked(inTransaction).mockImplementation(async work => { await work(manager); throw new Error("Commit failed"); });
  else vi.mocked(revisions.advanceRevision).mockRejectedValue(new Error("Revision failed"));
  await expect(rescheduleCustomerBookingCommand(edit, id)).rejects.toThrow(failure === "commit" ? "Commit failed" : "Revision failed");
  expect(committed).toBe(false);
});

async function paidAdjustment() {
  await confirmedBooking();
  const booking = await bookings.findBookingForUpdate(manager, id);
  if (!booking) throw new Error("Missing booking fixture");
  vi.mocked(bookings.findBookingForUpdate).mockResolvedValue({ ...booking, payment_method: "online", revision: revisionFixture("online", 0, "confirmed") });
  const [price] = await listCheckoutPricing(manager, id, 3, edit.date);
  vi.mocked(listCheckoutPricing).mockResolvedValue([Object.assign(new LocationPricingRuleEntity(), price, { pricePerHourMinor: 7500 })]);
  const adjustment = Object.assign(new BookingAdjustmentEntity(), { id, bookingId: id, baseRevisionId: id, actorId: id,
    scope: "owner" as const, requestKey: "adjustment", target: { courtId: id, date: edit.date, startMinute: 720, endMinute: 780,
      expectedUpdatedAt: edit.expectedUpdatedAt }, originalTotal: 5000, newTotal: 7500, currency: "RON", status: "pending" as const,
    expiresAt: new Date("2099-10-14T10:10:00Z") });
  vi.mocked(adjustments.findAdjustment).mockResolvedValue(adjustment);
  vi.mocked(adjustments.insertAdjustment).mockResolvedValue(adjustment);
  vi.mocked(bookingFinancials).mockResolvedValue({ payments: [], refunds: [], captures: [],
    captured: 5000, refunded: 0, obligated: 0, netPaid: 5000, refundable: 5000 });
  const attempt = await payments.lockSettlementAttempt(manager, id);
  if (!attempt) throw new Error("Missing attempt fixture");
  vi.mocked(payments.lockSettlementAttempt).mockResolvedValue({ ...attempt, adjustment_id: id, amount_minor: 2500 });
  vi.mocked(payments.lockCheckoutAttempt).mockResolvedValue(Object.assign(new PaymentAttemptEntity(), {
    id, bookingId: id, adjustmentId: id, status: "succeeded", amountMinor: 2500, currency: "RON",
  }));
  vi.mocked(bookingFinancials).mockClear();
  return { adjustment, event: { ...event, amountMinor: 2500 } };
}
test("pending paid reschedule does not commit an unapplied revision", async () => {
  await paidAdjustment();
  expect(await rescheduleCustomerBookingCommand({ ...edit, expectedTotal: 7500 }, id)).toMatchObject({ ok: true, adjustmentStatus: "pending" });
  expect(revisions.advanceRevision).not.toHaveBeenCalled();
});
test.each(["failed", "retryable_failed", "cancelled"] as const)("%s paid adjustment commits no reschedule", async outcome => {
  const fixture = await paidAdjustment();
  await processOnlinePaymentEvent({ ...fixture.event, outcome });
  expect(revisions.advanceRevision).not.toHaveBeenCalled();
});
test("successful paid adjustment commits the accepted revision once; replay commits nothing", async () => {
  const fixture = await paidAdjustment(); await renameResources();
  expect(await processOnlinePaymentEvent(fixture.event)).toBe("succeeded");
  expect(revisions.advanceRevision).toHaveBeenCalledWith(manager, expect.objectContaining({ revision: expect.objectContaining({
    kind: "rescheduled", adjustmentId: id, totalAmountMinor: 7500, courtName: "Renamed Court",
  }) }));
  vi.mocked(adjustments.findAdjustment).mockResolvedValue(Object.assign(new BookingAdjustmentEntity(), fixture.adjustment, { status: "applied" }));
  expect(await processOnlinePaymentEvent({ ...fixture.event, eventId: "evt_adjustment_replay" })).toBe("succeeded");
  expect(revisions.advanceRevision).toHaveBeenCalledOnce();
});
test.each(["commit", "occupancy"])("paid adjustment %s failure commits no successful reschedule", async failure => {
  const fixture = await paidAdjustment();
  if (failure === "commit") vi.mocked(inTransaction).mockImplementation(async work => { await work(manager); throw new Error("Commit failed"); });
  else vi.mocked(reservations.updateCustomerReservationSchedule).mockResolvedValue(false);
  if (failure === "commit") await expect(processOnlinePaymentEvent(fixture.event)).rejects.toThrow("Commit failed");
  else {
    expect(await processOnlinePaymentEvent(fixture.event)).toBe("expired");
    expect(revisions.advanceRevision).not.toHaveBeenCalled();
  }
});
