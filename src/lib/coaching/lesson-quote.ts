import type { OpeningInterval } from "@/lib/admin/opening-hours-validation";
import { capturePricingEvidence, lessonPricingEvidence, type CoachingEvidence, type PricingEvidence } from "@/lib/bookings/revision";
import { buildCourtDay, type CalendarReservation } from "@/lib/courts/calendar";
import type { CoveragePeriod } from "@/lib/courts/coverage-validation";
import { getCalendarSelection } from "@/lib/courts/interval-selection";
import { localStartInstant } from "@/lib/courts/local-time";
import type { PublicLocation } from "@/lib/courts/public";
import { getCourtStateForDate } from "@/lib/courts/state";
import type { PublicCoachingFacts } from "@/lib/db/repositories/coaching.repository";
import type { LocationCurrency } from "@/lib/pricing/money";
import type { PricingRule } from "@/lib/pricing/validation";
import { resolveCoachAvailability, type AvailabilityException, type WeeklyAvailabilityInterval } from "./availability-schedule";
import type { ResolvedCoachingPrice } from "./pricing";
import { projectPublicCoachProfile } from "./public";
import { isOnlineCoachingProgramType } from "./validation";

const maxAmountMinor = 2147483647;

// A held or active court reservation occupying the coach, at any court or location.
// Compared in local wall time on its date, as court_reservation_coach_no_overlap does.
type CoachOccupancy = Pick<CalendarReservation, "booking_date" | "starts_at_minute" | "ends_at_minute">;

// Facts of one local date at one location. The caller supplies a publicly eligible
// location (isPubliclyEligible) with its active courts, the public coaching facts
// (active programs; public coaches whose account is active and holds the coach role),
// and occupancy that already excludes expired holds. Nothing here reads or locks.
export type CoachingLessonDay = {
  location: Pick<PublicLocation, "id" | "name" | "timezone" | "currency" | "courts">;
  date: string;
  today: string;
  currentMinute: number;
  hours: readonly OpeningInterval[];
  coverage: readonly CoveragePeriod[];
  pricing: readonly PricingRule[];
  courtOccupancy: readonly CalendarReservation[];
  coaching: PublicCoachingFacts;
  coach: {
    userId: string;
    weekly: readonly WeeklyAvailabilityInterval[];
    exceptions: readonly AvailabilityException[];
    occupancy: readonly CoachOccupancy[];
  };
};

export type CoachingLessonRequest = { programId: string; courtId: string; startMinute: number; durationMinutes: number };

export type CoachingLessonQuote = {
  location: { id: string; name: string; timezone: string };
  court: { id: string; name: string };
  coach: { userId: string; displayName: string };
  program: { id: string; name: string; type: "private" | "semi_private"; participantCount: 1 | 2; courtRentalIncluded: boolean };
  date: string;
  startMinute: number;
  endMinute: number;
  durationMinutes: number;
  startsAt: string;
  endsAt: string;
  coachingAmountMinor: number;
  // Zero when the program includes court rental; the court is still occupied.
  courtAmountMinor: number;
  totalAmountMinor: number;
  currency: LocationCurrency;
  evidence: {
    coachingPrice: ResolvedCoachingPrice & { programId: string; durationMinutes: number; coachUserId: string };
    // The court's rental value under the existing court pricing, charged or not.
    courtRentalMinor: number;
    courtPricing: PricingEvidence;
  };
};

export type CoachingLessonUnavailableReason =
  | "invalid-time" | "not-offered" | "invalid-duration" | "unpriced"
  | "coach-unavailable" | "coach-booked" | "court-unavailable";

export type CoachingLessonResult = { ok: true; quote: CoachingLessonQuote } | { ok: false; reason: CoachingLessonUnavailableReason };

// Lessons use the court grid: 30-minute starts, at least 60 minutes in 30-minute steps.
function isLessonInterval(startMinute: number, durationMinutes: number) {
  return Number.isInteger(startMinute) && Number.isInteger(durationMinutes) && startMinute >= 0
    && startMinute % 30 === 0 && durationMinutes >= 60 && durationMinutes % 30 === 0 && startMinute + durationMinutes <= 1440;
}

// Schedule facts shared by new lessons and rescheduled ones: the coach's windows at
// this location, the coach's other lessons anywhere, and the court day.
function lessonSchedule(day: Omit<CoachingLessonDay, "coaching">) {
  const key = (id: string) => id.toLowerCase();
  const locationId = key(day.location.id);
  // Coach windows at this location only; contiguous windows form one interval.
  const windows = resolveCoachAvailability({ date: day.date, weekly: day.coach.weekly, exceptions: day.coach.exceptions,
    timezones: new Map([[locationId, day.location.timezone]]) })
    .filter((window) => key(window.location_id) === locationId)
    .reduce<{ start: number; end: number }[]>((merged, window) => {
      const last = merged.at(-1);
      if (last && last.end >= window.start_minute) last.end = Math.max(last.end, window.end_minute);
      else merged.push({ start: window.start_minute, end: window.end_minute });
      return merged;
    }, []);
  const coachBusy = day.coach.occupancy.filter((row) => row.booking_date === day.date);
  const courtDay = buildCourtDay({ date: day.date, today: day.today, currentMinute: day.currentMinute, courts: day.location.courts,
    hours: day.hours, coverage: day.coverage, pricing: day.pricing, reservations: day.courtOccupancy });

  return (request: Omit<CoachingLessonRequest, "programId">) => {
    const { startMinute, durationMinutes } = request;
    if (!isLessonInterval(startMinute, durationMinutes)) return { ok: false as const, reason: "invalid-time" as const };
    const endMinute = startMinute + durationMinutes;
    const startsAt = localStartInstant(day.location.timezone, day.date, startMinute);
    const endsAt = localStartInstant(day.location.timezone, day.date, endMinute);
    // A lesson across a clock change would not last its priced duration.
    if (Date.parse(endsAt) - Date.parse(startsAt) !== durationMinutes * 60_000) return { ok: false as const, reason: "invalid-time" as const };
    if (!windows.some((window) => window.start <= startMinute && endMinute <= window.end))
      return { ok: false as const, reason: "coach-unavailable" as const };
    if (coachBusy.some((row) => row.starts_at_minute < endMinute && startMinute < row.ends_at_minute))
      return { ok: false as const, reason: "coach-booked" as const };

    // The court must be bookable under the existing court rules (open, priced,
    // unoccupied, not past) even when the program includes its rental.
    const court = courtDay.courts.find((candidate) => candidate.court.id === key(request.courtId));
    const selection = court && getCalendarSelection({ courtId: court.court.id, times: courtDay.times, cells: court.cells,
      hourlyPrices: court.hourlyPrices }, courtDay.times.indexOf(startMinute), courtDay.times.indexOf(endMinute - 30) + 1);
    if (!court || !selection || selection.startMinute !== startMinute || selection.endMinute !== endMinute)
      return { ok: false as const, reason: "court-unavailable" as const };
    const courtPricing = capturePricingEvidence(day.pricing, { courtId: court.court.id, date: day.date, startMinute, endMinute,
      total: selection.priceMinor, courtState: getCourtStateForDate(court.court.environment,
        day.coverage.filter((row) => row.court_id === court.court.id), day.date) });
    return { ok: true as const, slot: { court: { id: court.court.id, name: court.court.name }, startMinute, endMinute, startsAt, endsAt,
      courtRentalMinor: selection.priceMinor, courtPricing } };
  };
}

function lessonDay(day: CoachingLessonDay) {
  const key = (id: string) => id.toLowerCase();
  const locationId = key(day.location.id);
  // Eligibility and coaching price resolution reuse the public coach projection.
  const profile = projectPublicCoachProfile(day.coaching,
    [{ id: locationId, name: day.location.name, currency: day.location.currency }], key(day.coach.userId));
  const schedule = lessonSchedule(day);

  return (request: CoachingLessonRequest): CoachingLessonResult => {
    const { startMinute, durationMinutes } = request;
    if (!isLessonInterval(startMinute, durationMinutes)) return { ok: false, reason: "invalid-time" };
    const program = profile?.programs.find((candidate) => candidate.id === key(request.programId));
    if (!profile || !program || !isOnlineCoachingProgramType(program.type) || !profile.locations.some((location) => location.id === locationId))
      return { ok: false, reason: "not-offered" };
    // Club-wide price in the location's currency; a lesson without one never reaches payment.
    const lesson = profile.lessons.find((candidate) => candidate.currency === day.location.currency
      && candidate.programId === program.id && candidate.durationMinutes === durationMinutes);
    if (!lesson) return { ok: false, reason: "invalid-duration" };
    if (!lesson.price) return { ok: false, reason: "unpriced" };
    const scheduled = schedule(request);
    if (!scheduled.ok) return scheduled;
    const { slot } = scheduled;

    const courtAmountMinor = program.courtRentalIncluded ? 0 : slot.courtRentalMinor;
    const totalAmountMinor = lesson.price.amountMinor + courtAmountMinor;
    if (totalAmountMinor > maxAmountMinor) return { ok: false, reason: "unpriced" };
    return { ok: true, quote: {
      location: { id: locationId, name: day.location.name, timezone: day.location.timezone },
      court: slot.court,
      coach: { userId: profile.id, displayName: profile.displayName },
      program: { id: program.id, name: program.name, type: program.type, participantCount: program.type === "semi_private" ? 2 : 1,
        courtRentalIncluded: program.courtRentalIncluded },
      date: day.date, startMinute, endMinute: slot.endMinute, durationMinutes, startsAt: slot.startsAt, endsAt: slot.endsAt,
      coachingAmountMinor: lesson.price.amountMinor, courtAmountMinor, totalAmountMinor, currency: lesson.price.currency,
      evidence: {
        coachingPrice: { ...lesson.price, programId: program.id, durationMinutes, coachUserId: profile.id },
        courtRentalMinor: slot.courtRentalMinor, courtPricing: slot.courtPricing,
      },
    } };
  };
}

// Whether one lesson can be offered: coach, program, location, duration and
// price eligibility, the coach's availability and bookings, and the court's
// availability and price. Authoritative for a future checkout only when the caller
// supplies facts read under the booking locks.
export function quoteCoachingLesson(day: CoachingLessonDay, request: CoachingLessonRequest): CoachingLessonResult {
  return lessonDay(day)(request);
}

// Every offerable start of one program duration on the day, on every available court
// (in the supplied court order), each court and start once. Offers at one start are
// alternatives for a single lesson; courts may quote different prices.
export function listCoachingLessonOffers(day: CoachingLessonDay, request: Omit<CoachingLessonRequest, "courtId" | "startMinute">): CoachingLessonQuote[] {
  const quote = lessonDay(day);
  const courtIds = [...new Set(day.location.courts.map((court) => court.id.toLowerCase()))];
  const offers: CoachingLessonQuote[] = [];
  for (let startMinute = 0; startMinute + request.durationMinutes <= 1440; startMinute += 30) {
    for (const courtId of courtIds) {
      const result = quote({ ...request, courtId, startMinute });
      if (result.ok) offers.push(result.quote);
    }
  }
  return offers;
}

export type CoachingRescheduleQuote = {
  court: { id: string; name: string }; startMinute: number; endMinute: number; startsAt: string; endsAt: string;
  totalAmountMinor: number; pricingEvidence: PricingEvidence;
};
export type CoachingRescheduleResult = { ok: true; quote: CoachingRescheduleQuote }
  | { ok: false; reason: "invalid-time" | "coach-unavailable" | "coach-booked" | "court-unavailable" | "unpriced" };

// A purchased lesson at another time or court: the same coach, location, duration
// and agreed coaching fee, never repriced; only the court rental follows the
// current court pricing (and stays uncharged when the program includes it).
// The caller supplies the operational day, the coach's own facts and occupancy
// that already excludes the lesson's own reservation.
export function quoteCoachingReschedule(day: Omit<CoachingLessonDay, "coaching">, coaching: CoachingEvidence,
  request: { courtId: string; startMinute: number }): CoachingRescheduleResult {
  return rescheduleDay(day, coaching)(request);
}

// Every start of the purchased lesson's duration on the day, on every available court.
export function listCoachingRescheduleOffers(day: Omit<CoachingLessonDay, "coaching">, coaching: CoachingEvidence): CoachingRescheduleQuote[] {
  const quote = rescheduleDay(day, coaching);
  const courtIds = [...new Set(day.location.courts.map((court) => court.id.toLowerCase()))];
  const offers: CoachingRescheduleQuote[] = [];
  for (let startMinute = 0; startMinute + coaching.durationMinutes <= 1440; startMinute += 30) {
    for (const courtId of courtIds) {
      const result = quote({ courtId, startMinute });
      if (result.ok) offers.push(result.quote);
    }
  }
  return offers;
}

function rescheduleDay(day: Omit<CoachingLessonDay, "coaching">, coaching: CoachingEvidence) {
  const schedule = lessonSchedule(day);
  return (request: { courtId: string; startMinute: number }): CoachingRescheduleResult => {
    const scheduled = schedule({ ...request, durationMinutes: coaching.durationMinutes });
    if (!scheduled.ok) return scheduled;
    const { slot } = scheduled;
    const pricingEvidence = lessonPricingEvidence(slot.courtPricing, coaching, slot.courtRentalMinor);
    const totalAmountMinor = coaching.amountMinor + (pricingEvidence.coaching?.courtAmountMinor ?? 0);
    if (totalAmountMinor > maxAmountMinor) return { ok: false, reason: "unpriced" };
    return { ok: true, quote: { court: slot.court, startMinute: slot.startMinute, endMinute: slot.endMinute,
      startsAt: slot.startsAt, endsAt: slot.endsAt, totalAmountMinor, pricingEvidence } };
  };
}
