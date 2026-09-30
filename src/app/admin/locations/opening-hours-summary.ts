import { groupedWeeklySchedule, minuteToTime, weekdayGroupLabel, type OpeningInterval } from "@/lib/admin/opening-hours-validation";

export function openingHoursSummary(locationId: string, intervals: readonly OpeningInterval[]) {
  const openGroups = groupedWeeklySchedule(locationId, intervals).filter((group) => group.intervals.length > 0);
  if (openGroups.length === 0) return "Not configured";
  if (openGroups.length === 1) {
    const group = openGroups[0];
    const label = weekdayGroupLabel(group.weekdays);
    if (group.intervals.length === 1) {
      const interval = group.intervals[0];
      return `${label} · ${minuteToTime(interval.opens_at_minute)}–${minuteToTime(interval.closes_at_minute)}`;
    }
    return `${label} · ${group.intervals.length} intervals`;
  }
  return `Custom · ${openGroups.length} schedules`;
}
