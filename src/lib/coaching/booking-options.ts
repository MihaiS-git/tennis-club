import "server-only";

import type { PublicLocation } from "@/lib/courts/public";
import { localMinute, localToday } from "@/lib/courts/local-time";
import { getDataSource } from "@/lib/db/data-source";
import { listLocationCoachBookingAvailability } from "@/lib/db/repositories/coach-availability.repository";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { coachingLessonAmount, resolveCoachingPrice, type ResolvedCoachingPrice } from "./pricing";
import type { PublicCoaching } from "./public";
import {
  coachingParticipantCounts, coachingParticipantRange, isCoachingDuration, isOnlineCoachingProgramType, type OnlineCoachingProgramType,
} from "./validation";

// Coaching lesson total of each permitted participant count for one duration in the location's
// currency: that exact count's price/person (coach override ?? club default) times the count;
// null means unpriced (no checkout). No count's price is derived from another.
export type CoachingDurationOption = {
  durationMinutes: number;
  prices: { participantCount: number; price: ResolvedCoachingPrice | null }[];
};
export function coachingDurationPrice(option: CoachingDurationOption | undefined, participantCount: number) {
  return option?.prices.find((item) => item.participantCount === participantCount)?.price ?? null;
}
type CoachingProgramOption = {
  id: string; name: string; type: OnlineCoachingProgramType; courtRentalIncluded: boolean;
  // The participant counts one booking may name, from the program's explicit configuration.
  participants: { min: number; max: number };
  durations: CoachingDurationOption[];
};
type CoachingCoachOption = { id: string; displayName: string; programs: CoachingProgramOption[] };

// Public facts already enforce active account, Coach role/profile and active programs.
// The selector additionally requires a priced online lesson and current/future working
// hours here. Occupancy and date-specific absences remain the timetable's responsibility.
export async function coachingBookingOptions(data: PublicCoaching, location: Pick<PublicLocation, "id" | "currency" | "timezone">, now = new Date()): Promise<CoachingCoachOption[]> {
  const locationId = location.id.toLowerCase();
  const programs = new Map(data.programs.map(program => [program.id, program]));
  const options = data.coaches.filter(coach => coach.locations.some(item => item.id.toLowerCase() === locationId)).map(coach => ({
    id: coach.id, displayName: coach.displayName,
    // Only Private/Semi-private programs with valid participant limits are bookable online;
    // Group/Junior programs are organized by the coach or club and are not offered here.
    programs: coach.programs.flatMap(({ id }) => programs.get(id) ?? []).flatMap(program => {
      const participants = coachingParticipantRange(program);
      const { type } = program;
      return participants && isOnlineCoachingProgramType(type) ? [{ ...program, type, participants }] : [];
    }).map(program => ({
      id: program.id, name: program.name, type: program.type, courtRentalIncluded: program.courtRentalIncluded,
      participants: program.participants,
      // Only canonical lesson durations are offered, each count with its own resolved price.
      durations: program.durations.filter(isCoachingDuration).map((durationMinutes): CoachingDurationOption => {
        const records = [...program.prices.map(price => ({ ...price, programId: program.id, coachUserId: null })),
          ...coach.rates.filter(rate => rate.programId === program.id).map(rate => ({ ...rate, coachUserId: coach.id }))];
        return { durationMinutes, prices: coachingParticipantCounts(program.participants).map(participantCount => ({ participantCount,
          price: (() => { const price = resolveCoachingPrice(records, { programId: program.id, durationMinutes, participantCount, currency: location.currency, coachUserId: coach.id });
            return price ? { ...price, amountMinor: coachingLessonAmount(price.amountMinor, participantCount) } : null; })() })) };
      }),
    })),
  })).filter(coach => coach.programs.some(program => program.durations.some(duration => duration.prices.some(item => item.price))));
  if (!options.length) return [];
  const today = localToday(location.timezone, now);
  const minute = localMinute(location.timezone, now);
  const schedule = await listLocationCoachBookingAvailability((await getDataSource()).manager, locationId, options.map(coach => coach.id), today);
  const eligible = new Set(schedule.extra.filter(row => row.exceptionDate > today
    || (row.exceptionDate === today && row.endMinute !== null && row.endMinute > minute)).map(row => row.coachUserId));
  for (const row of schedule.weekly) {
    // Compute the first remaining occurrence directly; never search dates or lesson slots.
    const from = row.validFrom > today ? row.validFrom : today;
    let offset = (row.weekday - mondayWeekday(from) + 7) % 7;
    if (from === today && offset === 0 && row.endMinute <= minute) offset = 7;
    const occurrence = new Date(`${from}T00:00:00Z`);
    occurrence.setUTCDate(occurrence.getUTCDate() + offset);
    if (row.validUntil === null || occurrence.toISOString().slice(0, 10) <= row.validUntil) eligible.add(row.coachUserId);
  }
  return options.filter(coach => eligible.has(coach.id));
}
