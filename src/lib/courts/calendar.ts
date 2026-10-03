import type { OpeningInterval } from "@/lib/admin/opening-hours-validation";
import { getCourtStateForDate } from "@/lib/courts/state";
import type { CoveragePeriod } from "@/lib/courts/coverage-validation";
import { mondayWeekday, resolvePricingRule } from "@/lib/pricing/resolution";
import { courtStateLabels, type PricingRule } from "@/lib/pricing/validation";
import type { PublicCourt } from "@/lib/courts/public";

export type CalendarCellState = "available" | "booked" | "closed" | "unavailable" | "past";
export type CalendarReservation = {
  court_id: string; booking_date: string; starts_at_minute: number; ends_at_minute: number;
};
export type CourtDay = {
  court: PublicCourt;
  cells: CalendarCellState[];
  hourlyPrices: (number | null)[];
  stateLabel: string;
};

export { localMinute, localToday } from "./local-time";

export function buildCourtDay(input: {
  date: string; today: string; currentMinute: number; courts: readonly PublicCourt[];
  hours: readonly OpeningInterval[]; coverage: readonly CoveragePeriod[]; pricing: readonly PricingRule[];
  reservations: readonly CalendarReservation[];
}): { times: number[]; courts: CourtDay[] } {
  const dayHours = input.hours.filter((row) => row.weekday === mondayWeekday(input.date));
  if (!dayHours.length) return { times: [], courts: input.courts.map((court) => ({ court, cells: [], hourlyPrices: [], stateLabel: "Closed" })) };
  const first = Math.floor(Math.min(...dayHours.map((row) => row.opens_at_minute)) / 30) * 30;
  const last = Math.ceil(Math.max(...dayHours.map((row) => row.closes_at_minute)) / 30) * 30;
  const times = Array.from({ length: (last - first) / 30 }, (_, index) => first + index * 30);
  const courts = input.courts.map((court) => {
    const courtState = getCourtStateForDate(court.environment, input.coverage.filter((row) => row.court_id === court.id), input.date);
    const reservations = input.reservations.filter((row) => row.court_id === court.id && row.booking_date === input.date);
    const pricing = input.pricing.filter((row) => row.court_id === court.id);
    const slots = times.map((minute): { state: CalendarCellState; hourlyPrice: number | null } => {
      if (!dayHours.some((row) => row.opens_at_minute <= minute && minute + 30 <= row.closes_at_minute)) return { state: "closed", hourlyPrice: null };
      if (input.date < input.today || (input.date === input.today && minute < input.currentMinute)) return { state: "past", hourlyPrice: null };
      if (reservations.some((row) => row.starts_at_minute < minute + 30 && minute < row.ends_at_minute)) return { state: "booked", hourlyPrice: null };
      const rule = resolvePricingRule(pricing, { court_id: court.id, court_state: courtState, date: input.date, minute });
      return rule && minute + 30 <= rule.ends_at_minute
        ? { state: "available", hourlyPrice: rule.price_per_hour_minor }
        : { state: "unavailable", hourlyPrice: null };
    });
    return { court, cells: slots.map((slot) => slot.state), hourlyPrices: slots.map((slot) => slot.hourlyPrice), stateLabel: courtStateLabels[courtState] };
  });
  return { times, courts };
}
