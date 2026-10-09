import "server-only";

import type { EntityManager } from "typeorm";
import { z } from "zod";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { instantMicroseconds } from "./domain";

// Caller holds this location FOR UPDATE. Occupancy writers use blocking cleanup
// before their own row locks; polling skips busy aggregates and retries next poll.
export async function expirePaymentHoldsAtLocation(manager: EntityManager, locationId: string, input: {
  courtId?: string; excludeReservationId?: string; skipLocked?: boolean; limit?: number;
} = {}): Promise<number> {
  const skipLocked = input.skipLocked ?? false;
  const candidates = await payments.lockExpiredHoldBookings(manager, locationId, { ...input, skipLocked });
  let expired = 0;
  for (const candidate of candidates) {
    const booking = await bookings.lockSettlementBooking(manager, candidate.id);
    const reservation = await reservations.findReservationForUpdate(manager, candidate.reservation_id, undefined, skipLocked);
    if (!booking || !reservation || booking.reservation_id !== reservation.id
      || booking.status !== "pending_payment" || reservation.status !== "held" || !reservation.hold_expires_at) continue;
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
    if (instantMicroseconds(reservation.hold_expires_at) > instantMicroseconds(now)) continue;
    await bookings.updateSettlementBookingStatus(manager, booking.id, "expired");
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
