import "server-only";

import { z } from "zod";
import { readClubTimezoneError } from "@/lib/club/timezone-policy";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { requireActiveCoach } from "@/lib/coaching/authorization";
import { operationalSchedule } from "@/lib/coaching/lesson-quote";
import { buildCourtDay } from "@/lib/courts/calendar";
import { localStartInstant } from "@/lib/courts/local-time";
import { inReadSnapshot } from "@/lib/db/transaction";
import { findAdminBookingDetails, findAdminBookingEditTokens, findBookingReservationId } from "@/lib/db/repositories/bookings.repository";
import { findAccountById } from "@/lib/db/repositories/accounts.repository";
import { findAdminLocation } from "@/lib/db/repositories/clubs.repository";
import { findCoachProfile } from "@/lib/db/repositories/coaching.repository";
import { readReservationClockTime } from "@/lib/db/repositories/reservations.repository";
import { readOperationalDay } from "./operational";
import type { OperationalCapacity } from "./operational-policy";

const dayInput = z.strictObject({ id: z.uuid(), locationId: z.uuid(), date: z.iso.date(), coachUserId: z.uuid().optional() });

// Informational staff availability only. Preview/save retain their locked authorization,
// stale-token checks, financial policy and final scheduling validation.
class AvailabilityError extends Error {}

async function readOperationalBookingDay(input: unknown, capacity: OperationalCapacity) {
  const actor = capacity === "admin" ? await requireActiveAdmin() : await requireActiveCoach();
  const requested = dayInput.parse(input);
  return inReadSnapshot(async manager => {
    const booking = await findAdminBookingDetails(manager, requested.id, capacity === "coach" ? actor.userId : undefined);
    const now = new Date(await readReservationClockTime(manager));
    if (!booking || booking.status !== "confirmed" || (capacity === "coach" && (!booking.coaching || booking.coach_user_id !== actor.userId))
      || Date.parse(localStartInstant(booking.location_timezone, booking.booking_date, booking.starts_at_minute)) <= now.getTime())
      throw new AvailabilityError("This booking is no longer available to edit.");
    if (await readClubTimezoneError(manager)) throw new AvailabilityError("The club timezone configuration needs attention.");
    const tokens = await findAdminBookingEditTokens(manager, requested.id);
    const reservationId = await findBookingReservationId(manager, requested.id);
    const location = await findAdminLocation(manager, requested.locationId);
    if (!tokens || !reservationId || !location?.isActive || location.archivedAt) throw new AvailabilityError("This destination is no longer available.");
    if (location.currency !== booking.currency) throw new AvailabilityError("Bookings cannot move between currencies.");
    const coachUserId = booking.includes_coaching ? requested.coachUserId ?? booking.coach_user_id : null;
    if (requested.coachUserId && !booking.includes_coaching) throw new AvailabilityError("This booking has no Coach.");
    const coach = coachUserId ? await findCoachProfile(manager, coachUserId) : null;
    const account = coachUserId ? await findAccountById(manager, coachUserId) : null;
    if (coachUserId && (!coach || account?.user.status !== "active" || !account.roleCodes.includes("coach"))) throw new AvailabilityError("Choose an active Coach.");
    const policy = capacity === "admin" || coachUserId === actor.userId ? "override" : "enforce";
    const facts = await readOperationalDay(manager, location, coachUserId, requested.date, reservationId, now);
    if (requested.date < facts.today) throw new AvailabilityError("Choose today or a future date at this location.");
    const day = buildCourtDay({ ...facts, timezone: location.timezone, courts: facts.location.courts, reservations: facts.courtOccupancy });
    const schedule = operationalSchedule(facts, policy);
    const duration = booking.ends_at_minute - booking.starts_at_minute;
    const starts = day.courts.flatMap(({ court }) => day.times.filter(startMinute =>
      (!coach || policy === "override" || coach.locationIds.includes(location.id))
      && schedule({ courtId: court.id, startMinute, endMinute: startMinute + duration }).ok)
      .map(startMinute => ({ courtId: court.id, startMinute })));
    // Return only generic cell states and permitted starts; no unrelated identities,
    // Coach schedules, contacts, reasons or booking details cross this boundary.
    return { date: requested.date, today: facts.today, location: { id: location.id, timezone: location.timezone, currency: location.currency }, tokens,
      day: { times: day.times, courts: day.courts.map(({ court, cells }) => ({ court: { id: court.id, name: court.name }, cells })) }, starts };
  });
}
export type OperationalBookingDay = Awaited<ReturnType<typeof readOperationalBookingDay>>;
export async function loadOperationalBookingDay(input: unknown, capacity: OperationalCapacity) {
  try { return await readOperationalBookingDay(input, capacity); }
  catch (error: unknown) {
    if (error instanceof AvailabilityError) return { ok: false as const, message: error.message };
    throw error;
  }
}
