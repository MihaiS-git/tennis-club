import "server-only";

import type { EntityManager } from "typeorm";
import { z } from "zod";

import { localMinute, localToday } from "@/lib/courts/local-time";
import { listPublicLocationsWithCourts, type PublicLocation } from "@/lib/courts/public";
import { readPublicDayConfiguration, readPublicDayReservations } from "@/lib/courts/public-calendar";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { readIndependently } from "@/lib/db/transaction";
import { listCoachDayAvailability } from "@/lib/db/repositories/coach-availability.repository";
import { readPublicCoachingFacts } from "@/lib/db/repositories/coaching.repository";
import { listCoachDayOccupancy } from "@/lib/db/repositories/reservations.repository";
import { logger } from "@/lib/logger";
import type { LocationCurrency } from "@/lib/pricing/money";
import type { CoachingEvidence } from "@/lib/bookings/revision";
import { listCoachingLessonOffers, listCoachingRescheduleOffers, type CoachingLessonDay, type CoachingLessonQuote } from "./lesson-quote";
import { projectPublicCoachProfile } from "./public";
import { isOnlineCoachingProgramType } from "./validation";

const coachingLessonAvailabilitySchema = z.object({
  locationId: z.uuid(), programId: z.uuid(), coachId: z.uuid(), date: z.iso.date(),
});

type PublicLessonCourt = {
  id: string; name: string; coachingAmountMinor: number; courtAmountMinor: number; totalAmountMinor: number;
};
// One starting time and every court on which the whole lesson can take place.
export type PublicLessonStart = { startMinute: number; endMinute: number; startsAt: string; endsAt: string; courts: PublicLessonCourt[] };
export type PublicCoachingLessonAvailability = {
  location: { id: string; name: string; timezone: string };
  coach: { id: string; displayName: string };
  program: { id: string; name: string; participantCount: 1 | 2; courtRentalIncluded: boolean };
  date: string;
  currency: LocationCurrency;
  // Priced lesson durations on the court grid; empty starts means nothing is free that day.
  durations: { durationMinutes: number; starts: PublicLessonStart[] }[];
};

// Every fact of one lesson date at one public location. Unlocked here; coaching
// booking creation reloads the same facts with this function inside its booking
// transaction, after its locks, and requotes before creating any hold. Reads run
// concurrently only on the pooled manager, never on a transaction's connection.
// excludeReservationId leaves that lesson out of both court and coach occupancy so
// it does not conflict with itself. Only rescheduling passes it, for its own
// reservation, after authorizing the booking's owner and eligibility under its
// locks; public reads never accept it.
export async function readCoachingLessonDay(manager: EntityManager, location: PublicLocation, coachUserId: string,
  date: string, now: Date, excludeReservationId?: string): Promise<CoachingLessonDay | null> {
  const [coaching, configuration, courtOccupancy, schedule, coachOccupancy] = await readIndependently(manager, [
    () => readPublicCoachingFacts(manager),
    () => readPublicDayConfiguration(manager, location, date),
    () => readPublicDayReservations(manager, location, date, excludeReservationId),
    () => listCoachDayAvailability(manager, coachUserId, date),
    () => listCoachDayOccupancy(manager, coachUserId, date, excludeReservationId),
  ]);
  if (!configuration || !courtOccupancy) return null;
  return {
    location, date, today: localToday(location.timezone, now), currentMinute: localMinute(location.timezone, now),
    ...configuration, courtOccupancy, coaching,
    coach: { userId: coachUserId.toLowerCase(), weekly: schedule.weekly, exceptions: schedule.exceptions, occupancy: coachOccupancy },
  };
}

function groupByStart<Offer extends Omit<PublicLessonStart, "courts">>(offers: readonly Offer[],
  court: (offer: Offer) => PublicLessonCourt): PublicLessonStart[] {
  const starts = new Map<number, PublicLessonStart>();
  for (const offer of offers) {
    const start = starts.get(offer.startMinute) ?? { startMinute: offer.startMinute, endMinute: offer.endMinute,
      startsAt: offer.startsAt, endsAt: offer.endsAt, courts: [] };
    start.courts.push(court(offer));
    starts.set(offer.startMinute, start);
  }
  return [...starts.values()];
}
const quotedCourt = (offer: CoachingLessonQuote): PublicLessonCourt => ({ id: offer.court.id, name: offer.court.name,
  coachingAmountMinor: offer.coachingAmountMinor, courtAmountMinor: offer.courtAmountMinor, totalAmountMinor: offer.totalAmountMinor });

// The starts at which a purchased lesson can be moved on the day, in the public
// lesson shape: the agreed coaching fee plus each court's current rental component.
export function projectCoachingRescheduleStarts(day: CoachingLessonDay, coaching: CoachingEvidence): PublicLessonStart[] {
  return groupByStart(listCoachingRescheduleOffers(day, coaching), (offer) => ({ id: offer.court.id, name: offer.court.name,
    coachingAmountMinor: coaching.amountMinor, courtAmountMinor: offer.pricingEvidence.coaching?.courtAmountMinor ?? 0,
    totalAmountMinor: offer.totalAmountMinor }));
}

// Public projection of one coach's online lessons on the day. Null unless the
// coach publicly offers the program at this location. Pricing evidence
// stays server-side; only names, times and quoted amounts are exposed.
export function projectCoachingLessonAvailability(day: CoachingLessonDay, programId: string): PublicCoachingLessonAvailability | null {
  const locationId = day.location.id.toLowerCase();
  const profile = projectPublicCoachProfile(day.coaching,
    [{ id: locationId, name: day.location.name, currency: day.location.currency }], day.coach.userId);
  const program = profile?.programs.find((candidate) => candidate.id === programId.toLowerCase());
  if (!profile || !program || !isOnlineCoachingProgramType(program.type) || !profile.locations.some((location) => location.id === locationId)) return null;
  const durations = program.durations.filter((durationMinutes) => durationMinutes >= 60 && durationMinutes % 30 === 0
    && profile.lessons.some((lesson) => lesson.currency === day.location.currency && lesson.programId === program.id
      && lesson.durationMinutes === durationMinutes && lesson.price !== null));
  return {
    location: { id: locationId, name: day.location.name, timezone: day.location.timezone },
    coach: { id: profile.id, displayName: profile.displayName },
    program: { id: program.id, name: program.name, participantCount: program.type === "semi_private" ? 2 : 1,
      courtRentalIncluded: program.courtRentalIncluded },
    date: day.date, currency: day.location.currency,
    durations: durations.map((durationMinutes) => ({ durationMinutes,
      starts: groupByStart(listCoachingLessonOffers(day, { programId: program.id, durationMinutes }), quotedCourt) })),
  };
}

// Advisory public availability, the same for visitors and members. Unknown,
// malformed and ineligible locations, programs and coaches all resolve to null.
export async function readPublicCoachingLessonAvailability(input: unknown, now = new Date()): Promise<PublicCoachingLessonAvailability | null> {
  const parsed = coachingLessonAvailabilitySchema.safeParse(input);
  if (!parsed.success) return null;
  const { locationId, programId, coachId, date } = parsed.data;
  const location = (await listPublicLocationsWithCourts()).find((candidate) => candidate.id === locationId.toLowerCase());
  if (!location) return null;
  try {
    const day = await readCoachingLessonDay((await getDataSource()).manager, location, coachId, date, now);
    if (!day) throw new Error("Malformed public court day.");
    return projectCoachingLessonAvailability(day, programId);
  } catch (error: unknown) {
    logger.error({ event: "coaching.lesson_availability_read_failed", code: normalizeDatabaseError(error).sqlState },
      "Failed to load lesson availability");
    throw new Error("Unable to load lesson availability.");
  }
}
