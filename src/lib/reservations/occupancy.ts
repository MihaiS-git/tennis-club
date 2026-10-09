import "server-only";
import type { EntityManager } from "typeorm";
import { expirePaymentHoldsAtLocation } from "@/lib/payments/hold-expiry";
import { readReservationClockTime, findCheckoutOccupancy } from "@/lib/db/repositories/reservations.repository";
import { reservationIntervalsOverlap, type ReservationInterval } from "./domain";

// Capture the database clock BEFORE cleanup. Holds expired by this cutoff are
// explicitly released; holds crossing it afterwards still block this decision.
export async function readOccupancyForMutation(manager: EntityManager, locationId: string,
  courtId: string, date: string, excludeId?: string) {
  const checkedAt = await readReservationClockTime(manager);
  await expirePaymentHoldsAtLocation(manager, locationId, { courtId, excludeReservationId: excludeId });
  return findCheckoutOccupancy(manager, courtId, date, excludeId, checkedAt);
}

// The command must hold the authoritative location FOR UPDATE through commit.
export async function hasOccupancyConflict(manager: EntityManager, input: ReservationInterval, locationId: string, excludeId?: string) {
  const occupied = await readOccupancyForMutation(manager, locationId, input.courtId, input.date, excludeId);
  return occupied.some(row => reservationIntervalsOverlap(input, {
    courtId: row.court_id, date: row.booking_date, startMinute: row.starts_at_minute, endMinute: row.ends_at_minute,
  }));
}
