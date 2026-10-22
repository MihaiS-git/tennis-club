import type { PublicLocation } from "@/lib/courts/public";
import type { LocationCurrency } from "@/lib/pricing/money";
import type { PublicCoaching } from "./public";
import { isOnlineCoachingProgramType, type CoachingProgramType } from "./validation";

// Effective coaching amount for one duration in the location's currency:
// the coach's override ?? the club default; null means unpriced (no checkout).
export type CoachingDurationOption = {
  durationMinutes: number;
  price: { amountMinor: number; currency: LocationCurrency; source: "coach" | "club" } | null;
};
type CoachingProgramOption = {
  id: string; name: string; type: CoachingProgramType; courtRentalIncluded: boolean;
  // Private and Semi-private lessons are booked online; other assigned programs are listed but not selectable.
  bookable: boolean;
  durations: CoachingDurationOption[];
};
type CoachingCoachOption = { id: string; displayName: string; programs: CoachingProgramOption[] };

// Booking selector options at one location: every public eligible coach assigned
// to it (coach_locations), each with their own program assignments (coach_programs).
// Deliberately independent of dates, working hours, occupancy and prices, which only
// decide the lesson starts offered on the timetable.
export function coachingBookingOptions(data: PublicCoaching, location: Pick<PublicLocation, "id" | "currency">): CoachingCoachOption[] {
  const locationId = location.id.toLowerCase();
  const programs = new Map(data.programs.map(program => [program.id, program]));
  return data.coaches.filter(coach => coach.locations.some(item => item.id.toLowerCase() === locationId)).map(coach => ({
    id: coach.id, displayName: coach.displayName,
    programs: coach.programs.flatMap(({ id }) => programs.get(id) ?? []).map(program => ({
      id: program.id, name: program.name, type: program.type, courtRentalIncluded: program.courtRentalIncluded,
      bookable: isOnlineCoachingProgramType(program.type),
      // Lessons use the court grid: at least 60 minutes in 30-minute steps.
      durations: program.durations.filter(duration => duration >= 60 && duration % 30 === 0).map(durationMinutes => {
        const matches = (price: { durationMinutes: number; currency: LocationCurrency }) =>
          price.durationMinutes === durationMinutes && price.currency === location.currency;
        const override = coach.rates.find(rate => rate.programId === program.id && matches(rate));
        const club = program.prices.find(matches);
        const price = override ? { ...override, source: "coach" as const } : club ? { ...club, source: "club" as const } : null;
        return { durationMinutes, price: price && { amountMinor: price.amountMinor, currency: price.currency, source: price.source } };
      }),
    })),
  }));
}
