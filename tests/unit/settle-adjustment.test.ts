import { QueryFailedError, type EntityManager } from "typeorm";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findAdjustment: vi.fn(), releaseAdjustmentHolds: vi.fn(), updateAdjustment: vi.fn(), resetAdjustmentLease: vi.fn(),
  updateSettlementAttempt: vi.fn(), readReservationClockTime: vi.fn(), applyCapturedBookingAdjustment: vi.fn(),
  allocateBookingRefund: vi.fn(), recordBookingFinancialException: vi.fn(), findBookingCancellationNotice: vi.fn(),
}));
vi.mock("@/lib/db/repositories/booking-adjustments.repository", () => ({ findAdjustment: mocks.findAdjustment,
  releaseAdjustmentHolds: mocks.releaseAdjustmentHolds, updateAdjustment: mocks.updateAdjustment, resetAdjustmentLease: mocks.resetAdjustmentLease }));
vi.mock("@/lib/db/repositories/payments.repository", () => ({ updateSettlementAttempt: mocks.updateSettlementAttempt }));
vi.mock("@/lib/db/repositories/reservations.repository", () => ({ readReservationClockTime: mocks.readReservationClockTime }));
vi.mock("@/lib/bookings/commands", () => ({ applyCapturedBookingAdjustment: mocks.applyCapturedBookingAdjustment }));
vi.mock("@/lib/payments/financials", () => ({ allocateBookingRefund: mocks.allocateBookingRefund }));
vi.mock("@/lib/notifications/events", () => ({ recordBookingFinancialException: mocks.recordBookingFinancialException }));
vi.mock("@/lib/db/repositories/bookings.repository", () => ({ findBookingCancellationNotice: mocks.findBookingCancellationNotice }));
import { settleAdjustment } from "@/lib/payments/settle-adjustment";

// A verified capture whose change cannot be applied (here: the lesson's coach is
// already booked at the target time) keeps the capture, refunds it and records
// the exception, instead of aborting the settlement transaction.
const id = "ca000000-0000-4000-8000-000000000001";
const query = vi.fn();
const manager = { query } as unknown as EntityManager;
const attempt = { id, booking_id: id, adjustment_id: id, status: "pending", amount_minor: 2000, checkout_capability: null } as never;
const exclusion = (constraint: string) => new QueryFailedError("UPDATE", [], Object.assign(new Error("private"), { code: "23P01", constraint }));
const settle = () => settleAdjustment(manager, { attempt, event: null, outcome: "succeeded", providerPaymentId: "pi_test", mismatch: false });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findAdjustment.mockResolvedValue({ id, bookingId: id, status: "pending", captureAcceptedAt: null,
    expiresAt: new Date("2099-10-15T10:00:00Z"), baseRevisionId: id });
  mocks.readReservationClockTime.mockResolvedValue("2099-10-15T09:00:00Z");
  mocks.allocateBookingRefund.mockResolvedValue(["refund-1"]);
  mocks.findBookingCancellationNotice.mockResolvedValue({ id });
});

test.each(["court_reservation_coach_no_overlap", "court_reservation_no_overlap"])(
  "a %s conflict during apply keeps the capture and compensates it", async (constraint) => {
    mocks.applyCapturedBookingAdjustment.mockRejectedValue(exclusion(constraint));
    expect(await settle()).toEqual({ result: "expired", refundIds: ["refund-1"], abandonProviderPayment: false });
    expect(mocks.updateSettlementAttempt).toHaveBeenCalledWith(manager, id, { status: "succeeded", providerPaymentId: "pi_test", deadline: null });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(["SAVEPOINT booking_adjustment_apply",
      "ROLLBACK TO SAVEPOINT booking_adjustment_apply", "RELEASE SAVEPOINT booking_adjustment_apply"]);
    expect(mocks.updateAdjustment).toHaveBeenCalledWith(manager, id, "unsuccessful");
    expect(mocks.allocateBookingRefund).toHaveBeenCalledWith(manager, expect.objectContaining({
      amount: 2000, onlyAttemptId: id, reason: "failed_adjustment_compensation" }));
    expect(mocks.recordBookingFinancialException).toHaveBeenCalledWith(manager, expect.objectContaining({ kind: "surcharge_unapplied" }));
  });

test("other database failures still abort the settlement transaction", async () => {
  mocks.applyCapturedBookingAdjustment.mockRejectedValue(exclusion("some_other_exclusion"));
  await expect(settle()).rejects.toBeInstanceOf(QueryFailedError);
  expect(mocks.allocateBookingRefund).not.toHaveBeenCalled();
});
