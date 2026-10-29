import "server-only";

import * as adjustments from "@/lib/db/repositories/booking-adjustments.repository";
import type { EntityManager } from "typeorm";
import { z } from "zod";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { timestampToEpochMicroseconds } from "@/lib/precise-time";
import { lockLocations } from "@/lib/db/repositories/clubs.repository";
import { localStartInstant } from "@/lib/courts/local-time";

// Caller holds this location FOR UPDATE. Occupancy writers use blocking cleanup
// before their own row locks; polling skips busy aggregates and retries next poll.
export async function expirePaymentHoldsAtLocation(manager: EntityManager, locationId: string, input: {
  courtId?: string; excludeReservationId?: string; skipLocked?: boolean; limit?: number;
} = {}): Promise<number> {
  const skipLocked = input.skipLocked ?? false;
  await expireAdjustmentsAtLocation(manager, locationId);
  const candidates = await payments.lockExpiredHoldBookings(manager, locationId, { ...input, skipLocked });
  let expired = 0;
  for (const candidate of candidates) {
    const booking = await bookings.findBookingForUpdate(manager, candidate.id);
    const reservation = await reservations.findReservationForUpdate(manager, candidate.reservation_id, undefined, skipLocked);
    if (!booking || !reservation || booking.reservation_id !== reservation.id
      || !["pending_payment", "cancelled", "failed"].includes(booking.status) || reservation.status !== "held" || !reservation.hold_expires_at) continue;
    const resource = await reservations.findReservationResourceFacts(manager, reservation.court_id);
    if (resource?.location_id !== locationId) continue;
    const attempts = await payments.lockHoldExpiryAttempts(manager, booking.id, skipLocked);
    const total = attempts[0]?.total ?? await payments.countBookingPaymentAttempts(manager, booking.id);
    if (attempts.length !== total) continue;
    if (attempts.some(p => p.status === "succeeded")) {
      // An inconsistent captured/held aggregate needs reconciliation, never
      // automatic release or replacement occupancy over a successful payment.
      if (!skipLocked) throw new Error("Captured payment still owns a held reservation");
      continue;
    }
    const now = await reservations.readReservationClockTime(manager);
    if (timestampToEpochMicroseconds(reservation.hold_expires_at) > timestampToEpochMicroseconds(now)) continue;
    if (booking.status === "pending_payment") await bookings.updateSettlementBookingStatus(manager, booking.id, "expired");
    for (const attempt of attempts) if (attempt.status === "pending") await payments.expirePendingAttempt(manager, attempt.id);
    await reservations.updateSettlementReservationStatus(manager, reservation.id, "released");
    expired++;
  }
  return expired;
}

const expiryScopeSchema = z.strictObject({ courtId: z.uuid().optional(), locationId: z.uuid().optional() });
export async function expirePaymentHolds(scope: payments.HoldExpiryScope = {}, batchSize = 100): Promise<number> {
  const parsed = expiryScopeSchema.parse(scope);
  z.number().int().min(1).max(1000).parse(batchSize);
  const locations = await payments.discoverExpiredHoldLocations((await getDataSource()).manager, parsed, batchSize);
  let expired = 0;
  // Each transaction owns one parent only; never acquire a location after rows.
  for (const { location_id } of locations) {
    expired += await inTransaction(async manager => {
      if (!await payments.lockHoldExpiryLocation(manager, location_id)) return 0;
      return expirePaymentHoldsAtLocation(manager, location_id, { courtId: parsed.courtId,
        skipLocked: true, limit: batchSize - expired });
    });
    if (expired >= batchSize) break;
  }
  return expired;
}

// Verified evidence that a submitted modification payment is processing keeps
// its target blocked until the payment resolves, bounded by the target start.
export async function extendLiveAdjustmentHold(attemptId: string, providerPaymentId: string) {
  const parent = await payments.discoverSettlementParent((await getDataSource()).manager, attemptId);
  if (!parent) return;
  await inTransaction(async manager => {
    await lockLocations(manager, [parent.location_id]);
    await bookings.lockCheckoutBooking(manager, parent.booking_id);
    const attempt = await payments.lockCheckoutAttempt(manager, attemptId);
    if (!attempt?.adjustmentId || attempt.bookingId !== parent.booking_id || attempt.status !== "pending"
      || attempt.providerPaymentId !== providerPaymentId) return;
    const adjustment = await adjustments.findAdjustment(manager, attempt.adjustmentId);
    if (adjustment?.status !== "pending") return;
    const { timezone, date, startMinute } = adjustment.target;
    await adjustments.extendAdjustmentLease(manager, adjustment.id, localStartInstant(timezone, date, startMinute));
  });
}

// Caller holds the existing location mutex; expiry decisions stay in TypeScript.
// Candidates are adjustments whose occupancy lease (attempt deadline) passed.
export async function expireAdjustmentsAtLocation(manager: EntityManager, locationId: string) {
  const candidates = await adjustments.listExpiredAdjustmentCandidates(manager, locationId);
  for (const row of candidates) {
    await bookings.lockCheckoutBooking(manager, row.booking_id);
    const current = await adjustments.findAdjustment(manager, row.id);
    if (!current || !["pending", "cancelled"].includes(current.status)) continue;
    if (current.status === "pending") await adjustments.updateAdjustment(manager, row.id, "expired");
    const attempt = await adjustments.adjustmentAttempt(manager, row.id);
    if (attempt) await payments.expirePendingAttempt(manager, attempt.id);
    await adjustments.releaseAdjustmentHolds(manager, row.id);
  }
  return candidates.length;
}
