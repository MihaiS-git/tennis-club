import "server-only";

import type { EntityManager } from "typeorm";
import type { z } from "zod";
import { lockReservationActorFacts } from "@/lib/db/repositories/accounts.repository";
import { lockConfigurationForRead, lockLocations } from "@/lib/db/repositories/clubs.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { expirePaymentHoldsAtLocation } from "@/lib/payments/hold-expiry";
import { hasOccupancyConflict } from "./occupancy";
import { inTransaction } from "@/lib/db/transaction";
import { localMinute, localStartInstant, localToday } from "@/lib/courts/local-time";
import { fitsOpeningHours, reservationEditSchema, reservationInputSchema } from "./domain";
import type { AdminEditResult, ReservationResult } from "./service";

type Reservation = NonNullable<Awaited<ReturnType<typeof reservations.findReservationForUpdate>>>;
type Resource = NonNullable<Awaited<ReturnType<typeof reservations.findReservationResourceFacts>>>;
type Scope = "admin" | "owner";
type Edit = z.infer<typeof reservationEditSchema>;
type Input = z.infer<typeof reservationInputSchema>;

const unavailableEdit = { ok: false as const, message: "This reservation is no longer available to edit." };
const unavailableCancel = { ok: false as const, message: "This reservation is no longer available to cancel." };
class ReservationParentChanged extends Error {}

function activeResource(resource: Resource) {
  return resource.court_active && resource.location_active && resource.archived_at === null;
}
function hasNotEnded(row: Reservation, timezone: string, now: Date) {
  const today = localToday(timezone, now);
  return row.booking_date > today || row.booking_date === today && row.ends_at_minute > localMinute(timezone, now);
}
function hasStarted(row: Reservation, timezone: string, now: Date) {
  const today = localToday(timezone, now);
  return row.booking_date < today || row.booking_date === today && row.starts_at_minute <= localMinute(timezone, now);
}
function permittedActor(actor: Awaited<ReturnType<typeof lockReservationActorFacts>>, scope?: Scope) {
  return actor?.status === "active" && (scope === "admin" ? actor.roles.includes("admin") : actor.roles.length > 0);
}

function directReservationTargetEligibility(input: Input,
  facts: Awaited<ReturnType<typeof reservations.findDirectReservationTargetFacts>>, now: Date): ReservationResult {
  const resource = facts.resource;
  if (!resource || !activeResource(resource) || resource.location_id !== input.locationId) {
    return { ok: false, message: "That court is not available at the selected location." };
  }
  const today = localToday(resource.location_timezone, now);
  if (input.date < today || input.date === today && input.startMinute < localMinute(resource.location_timezone, now)) {
    return { ok: false, message: "Choose a future time at this location." };
  }
  if (!fitsOpeningHours(facts.hours, input.date, input.startMinute, input.endMinute)) {
    return { ok: false, message: "Choose an interval within one opening-hours period." };
  }
  return { ok: true };
}

export async function createDirectReservationCommand(input: Input, actorId: string, now: Date): Promise<ReservationResult> {
  return inTransaction(async (manager) => {
    await lockConfigurationForRead(manager);
    await lockLocations(manager, [input.locationId]);
    if (!permittedActor(await lockReservationActorFacts(manager, actorId))) {
      return { ok: false, message: "Unable to reserve this court. Try again." };
    }
    const facts = await reservations.findDirectReservationTargetFacts(manager, input.locationId, input.courtId, input.date);
    const eligible = directReservationTargetEligibility(input, facts, now);
    if (!eligible.ok) return eligible;
    if (await hasOccupancyConflict(manager, input, input.locationId)) return { ok: false,
      message: "That court is no longer available for the selected time. Choose another interval." };
    await reservations.insertDirectReservation(manager, { ...input, actorId });
    return { ok: true };
  });
}

// A changed parent exits the transaction before retrying. Never lock a second
// aggregate after a reservation, or retry a failed PostgreSQL statement in place.
async function withLockedReservation<T>(id: string, expectedUpdatedAt: string | undefined, configuration: boolean,
  unavailable: T, work: (manager: EntityManager, row: Reservation, resource: Resource) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await inTransaction(async (manager) => {
        if (configuration) await lockConfigurationForRead(manager);
        const parent = await reservations.findReservationParent(manager, id);
        if (!parent) return unavailable;
        await lockLocations(manager, [parent.location_id]);
        if (configuration) await expirePaymentHoldsAtLocation(manager, parent.location_id);
        const row = await reservations.findReservationForUpdate(manager, id, expectedUpdatedAt);
        if (!row) return unavailable;
        const resource = await reservations.findReservationResourceFacts(manager, row.court_id);
        if (!resource || resource.location_id !== parent.location_id) throw new ReservationParentChanged();
        return work(manager, row, resource);
      });
    } catch (error: unknown) {
      if (!(error instanceof ReservationParentChanged)) throw error;
    }
  }
  return unavailable;
}

export async function editDirectReservationCommand(edit: Edit, actorId: string, scope: Scope, now: Date): Promise<AdminEditResult> {
  return withLockedReservation<AdminEditResult>(edit.id, edit.expectedUpdatedAt, edit.kind === "schedule", unavailableEdit,
    async (manager, row, resource) => {
      const actor = await lockReservationActorFacts(manager, actorId);
      const databaseNow = new Date(await reservations.readReservationTransactionTime(manager));
      if (!permittedActor(actor, scope) || row.status !== "active"
        || scope === "owner" && row.created_by_user_id !== actorId
        || await reservations.hasCustomerBookingLink(manager, row.id)
        || scope === "admin" && !activeResource(resource)
        || !hasNotEnded(row, resource.location_timezone, databaseNow)
        || !hasNotEnded(row, resource.location_timezone, now)) return unavailableEdit;
      // Lifecycle wins over a stale token, including cancellation while waiting.
      if (!row.token_matches) return { ok: false, stale: true, message: scope === "admin"
        ? "This reservation has changed since you opened it. Refresh and try again."
        : "This reservation has changed since you opened it. Refresh the details and try again." };
      if (edit.kind === "schedule") {
        if (hasStarted(row, resource.location_timezone, now)) return { ok: false,
          message: "An in-progress reservation can only change its reason." };
        if (hasStarted(row, resource.location_timezone, databaseNow)) return unavailableEdit;
        const input = { ...edit.schedule, locationId: resource.location_id };
        const facts = await reservations.findDirectReservationTargetFacts(manager, resource.location_id, input.courtId, input.date);
        const eligible = directReservationTargetEligibility(input, facts, now);
        if (!eligible.ok) return eligible;
        if (!directReservationTargetEligibility(input, facts, databaseNow).ok) return unavailableEdit;
        if (await hasOccupancyConflict(manager, input, resource.location_id, row.id)) return { ok: false,
          message: scope === "admin"
            ? "That court is no longer available for the selected time. The existing reservation has not been changed."
            : "That court is no longer available for the selected time. Your existing reservation has not been changed." };
        await reservations.updateDirectReservationSchedule(manager, row.id, edit.schedule);
      } else {
        // Owner reason-only edits deliberately do not require active resources.
        await reservations.updateDirectReservationReason(manager, row.id, edit.reason);
      }
      return { ok: true, reservation: edit.kind === "schedule"
        ? { court_id: edit.schedule.courtId, booking_date: edit.schedule.date,
          starts_at_minute: edit.schedule.startMinute, ends_at_minute: edit.schedule.endMinute, reason: edit.schedule.reason }
        : { court_id: row.court_id, booking_date: row.booking_date,
          starts_at_minute: row.starts_at_minute, ends_at_minute: row.ends_at_minute, reason: edit.reason } };
    });
}

export async function cancelDirectReservationCommand(id: string, actorId: string, scope: Scope): Promise<ReservationResult> {
  return withLockedReservation<ReservationResult>(id, undefined, false, unavailableCancel, async (manager, row, resource) => {
    const actor = await lockReservationActorFacts(manager, actorId);
    if (!permittedActor(actor, scope) || row.status !== "active" || !activeResource(resource)
      || scope === "owner" && row.created_by_user_id !== actorId
      || await reservations.hasCustomerBookingLink(manager, row.id)) return unavailableCancel;
    const checkedAt = scope === "admin" ? await reservations.readReservationClockTime(manager)
      : await reservations.readReservationTransactionTime(manager);
    const checkedDate = new Date(checkedAt);
    if (scope === "admin") {
      if (checkedDate.getTime() >= Date.parse(localStartInstant(resource.location_timezone, row.booking_date, row.starts_at_minute))) {
        return unavailableCancel;
      }
    } else if (!hasNotEnded(row, resource.location_timezone, checkedDate)) return unavailableCancel;
    await reservations.cancelDirectReservation(manager, row.id, actorId, checkedAt);
    return { ok: true };
  });
}
