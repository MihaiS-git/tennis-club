import "server-only";
import type { PublicLocation } from "@/lib/courts/public";
import { localToday } from "@/lib/courts/local-time";
import { getDataSource } from "@/lib/db/data-source";
import { listCoachingSelectorAvailability } from "@/lib/db/repositories/coach-availability.repository";
import type { PublicCoaching } from "./public";
import { hasConfiguredLesson } from "./selector-availability";
import { isOnlineCoachingProgramType } from "./validation";

export async function readCoachingBookingOptions(data: PublicCoaching, location: PublicLocation, now: Date) {
  const coaches = data.coaches.filter(coach => coach.locations.some(item => item.id === location.id));
  if (!coaches.length) return [];
  const facts = await listCoachingSelectorAvailability((await getDataSource()).manager, coaches.map(coach => coach.id), location.id, localToday(location.timezone, now));
  // Compute working-duration eligibility once per coach, shared across programs.
  return coaches.map(coach => {
    const schedule = {
      weekly: facts.weekly.filter(row => row.coachUserId === coach.id).map(row => ({ location_id: row.locationId,
        weekday: row.weekday, start_minute: row.startMinute, end_minute: row.endMinute, valid_from: row.validFrom, valid_until: row.validUntil })),
      exceptions: facts.exceptions.filter(row => row.coachUserId === coach.id).map(row => ({ date: row.exceptionDate, until_date: row.untilDate,
        kind: row.kind, location_id: row.locationId, start_minute: row.startMinute, end_minute: row.endMinute })),
      schedules: facts.schedules.map(row => ({ id: row.id, starts_on: row.startsOn, ends_on: row.endsOn })),
      hours: facts.hours.map(row => ({ schedule_id: row.scheduleId, weekday: row.weekday, opens_at_minute: row.opensAtMinute, closes_at_minute: row.closesAtMinute })),
    };
    const working = new Map<number, boolean>();
    const programs = data.programs.filter(program => isOnlineCoachingProgramType(program.type) && coach.programs.some(item => item.id === program.id))
      .map(program => ({ id: program.id, durations: program.durations.filter(duration => {
        if (duration < 60 || duration % 30 !== 0 || ![...coach.rates.filter(rate => rate.programId === program.id), ...program.prices]
          .some(price => price.locationId === location.id && price.currency === location.currency && price.durationMinutes === duration)) return false;
        if (!working.has(duration)) working.set(duration, hasConfiguredLesson({ ...schedule, locationId: location.id, timezone: location.timezone, durationMinutes: duration, now }));
        return working.get(duration);
      }) })).filter(program => program.durations.length);
    return { coach, programs };
  }).filter(option => option.programs.length);
}
