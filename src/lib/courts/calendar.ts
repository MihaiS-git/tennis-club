import type { OpeningInterval } from "@/lib/admin/opening-hours-validation";
import { getCourtStateForDate } from "@/lib/courts/state";
import type { CoveragePeriod } from "@/lib/courts/coverage-validation";
import { mondayWeekday, resolvePricingRule } from "@/lib/pricing/resolution";
import { courtStateLabels, type PricingRule } from "@/lib/pricing/validation";
import type { PublicCourt } from "@/lib/courts/public";

export type CalendarCellState =
  | "available"
  | "booked"
  | "closed"
  | "unavailable"
  | "past";
export type CalendarReservation = {
  court_id: string;
  booking_date: string;
  starts_at_minute: number;
  ends_at_minute: number;
};
export type CourtDay = {
  court: PublicCourt;
  cells: CalendarCellState[];
  hourlyPrices: (number | null)[];
  // Applicable hourly rate of every open, priced slot regardless of occupancy;
  // displayed as price bands only. Selection quotes use hourlyPrices.
  rates: (number | null)[];
  stateLabel: string;
};

// The one slot-rate resolution shared by public booking and customer edit
// timetables: court, derived surface state, date, weekday and minute.
export function courtSlotRates(input: {
  court: Pick<PublicCourt, "id" | "environment">; date: string; times: readonly number[];
  hours: readonly OpeningInterval[]; coverage: readonly CoveragePeriod[]; pricing: readonly PricingRule[];
}) {
  const dayHours = input.hours.filter((row) => row.weekday === mondayWeekday(input.date));
  const courtState = getCourtStateForDate(input.court.environment,
    input.coverage.filter((row) => row.court_id === input.court.id), input.date);
  const pricing = input.pricing.filter((row) => row.court_id === input.court.id);
  return { courtState, rates: input.times.map((minute) => {
    if (!dayHours.some((row) => row.opens_at_minute <= minute && minute + 30 <= row.closes_at_minute)) return null;
    const rule = resolvePricingRule(pricing, { court_id: input.court.id, court_state: courtState, date: input.date, minute });
    return rule && minute + 30 <= rule.ends_at_minute ? rule.price_per_hour_minor : null;
  }) };
}

export { localMinute, localToday } from "./local-time";

export function buildCourtDay(input: {
  date: string;
  today: string;
  currentMinute: number;
  courts: readonly PublicCourt[];
  hours: readonly OpeningInterval[];
  coverage: readonly CoveragePeriod[];
  pricing: readonly PricingRule[];
  reservations: readonly CalendarReservation[];
}): { times: number[]; courts: CourtDay[] } {
  const dayHours = input.hours.filter(
    (row) => row.weekday === mondayWeekday(input.date),
  );
  const reservationsForDate = input.reservations.filter((r) => r.booking_date === input.date && input.courts.some((c) => c.id === r.court_id));
  const starts = [...dayHours.map((h) => h.opens_at_minute), ...reservationsForDate.map((r) => r.starts_at_minute)];
  const ends = [...dayHours.map((h) => h.closes_at_minute), ...reservationsForDate.map((r) => r.ends_at_minute)];
  const first = starts.length ? Math.floor(Math.min(...starts) / 30) * 30 : 0;
  const last = ends.length ? Math.ceil(Math.max(...ends) / 30) * 30 : 0;
  const times = Array.from(
    { length: (last - first) / 30 },
    (_, index) => first + index * 30,
  );
  const courts = input.courts.map((court) => {
    const { courtState, rates } = courtSlotRates({ court, date: input.date, times,
      hours: input.hours, coverage: input.coverage, pricing: input.pricing });
    const reservations = input.reservations.filter(
      (row) => row.court_id === court.id && row.booking_date === input.date,
    );
    const slots = times.map(
      (minute, index): { state: CalendarCellState; hourlyPrice: number | null } => {
        if (reservations.some((row) => row.starts_at_minute < minute + 30 && minute < row.ends_at_minute))
          return { state: "booked", hourlyPrice: null };
        if (!dayHours.some((row) => row.opens_at_minute <= minute && minute + 30 <= row.closes_at_minute))
          return { state: "closed", hourlyPrice: null };
        if (input.date < input.today || (input.date === input.today && minute < input.currentMinute))
          return { state: "past", hourlyPrice: null };
        const rate = rates[index];
        return rate === null ? { state: "unavailable", hourlyPrice: null } : { state: "available", hourlyPrice: rate };
      },
    );
    return {
      court,
      cells: slots.map((slot) => slot.state),
      hourlyPrices: slots.map((slot) => slot.hourlyPrice),
      rates,
      stateLabel: courtStateLabels[courtState],
    };
  });
  return { times, courts };
}
