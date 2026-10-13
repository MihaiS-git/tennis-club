import { z } from "zod";
import { minuteToTime, weekdays, type OpeningInterval } from "@/lib/admin/opening-hours-validation";
import { courtStates, type PricingRule, type PricingRuleSet } from "./validation";

export function mondayWeekday(date: string): number {
  z.iso.date().parse(date);
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export function pricingHasFutureOccurrence(rule: Pick<PricingRule, "weekday" | "starts_on" | "ends_on">, today: string) {
  const first = rule.starts_on && rule.starts_on > today ? rule.starts_on : today;
  const next = new Date(`${first}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + (rule.weekday - mondayWeekday(first) + 7) % 7);
  return !rule.ends_on || rule.ends_on >= next.toISOString().slice(0, 10);
}

const selectorSchema = z.strictObject({
  court_id: z.uuid(), court_state: z.enum(courtStates),
  date: z.iso.date(), minute: z.number().int().min(0).max(1439),
});
export function resolvePricingRule(rules: readonly PricingRule[], input: z.infer<typeof selectorSchema>): PricingRule | null {
  const selector = selectorSchema.parse(input);
  const weekday = mondayWeekday(selector.date);
  const matches = rules.filter((rule) => rule.court_id === selector.court_id
    && rule.court_state === selector.court_state && rule.weekday === weekday
    && (!rule.starts_on || rule.starts_on <= selector.date) && (!rule.ends_on || selector.date <= rule.ends_on)
    && rule.starts_at_minute <= selector.minute && selector.minute < rule.ends_at_minute);
  if (matches.length > 1) throw new Error("Ambiguous pricing configuration.");
  return matches[0] ?? null;
}

export function fitsOpeningHours(
  intervals: readonly Pick<OpeningInterval, "location_id" | "weekday" | "opens_at_minute" | "closes_at_minute">[],
  rule: Pick<PricingRule, "location_id" | "weekday" | "starts_at_minute" | "ends_at_minute">,
): boolean {
  return intervals.some((interval) => interval.location_id === rule.location_id && interval.weekday === rule.weekday
    && interval.opens_at_minute <= rule.starts_at_minute && rule.ends_at_minute <= interval.closes_at_minute);
}

type HoursInterval = Pick<OpeningInterval, "location_id" | "weekday" | "opens_at_minute" | "closes_at_minute">
  & { starts_on: string; ends_on: string | null };

function dayNames(days: readonly number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length > 1 && sorted.every((day, index) => day === sorted[0] + index)) {
    return `${weekdays[sorted[0]]}–${weekdays[sorted.at(-1)!]}`;
  }
  return sorted.map((day) => weekdays[day]).join(", ");
}

export function pricingOpeningHoursError(
  intervals: readonly HoursInterval[],
  input: { location_id: string; weekdays: readonly number[]; starts_at_minute: number; ends_at_minute: number; starts_on?: string | null; ends_on?: string | null },
  today: string,
): string | null {
  if (input.ends_on && input.ends_on < today) return null;
  const locationHours = intervals.filter((interval) => interval.location_id === input.location_id);
  if (!locationHours.length) return "Configure this location's opening hours before saving pricing.";
  const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const first = input.starts_on && input.starts_on > today ? input.starts_on : today;
  const boundaries = [...new Set([first, ...locationHours.flatMap((h) => [h.starts_on, h.ends_on ? nextDate(h.ends_on) : undefined])
    .filter((d): d is string => d !== undefined && d > first && (!input.ends_on || d <= input.ends_on))])].sort();
  for (const [index, date] of boundaries.entries()) {
    const next = boundaries[index + 1];
    const until = next ? new Date(Date.parse(`${next}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : input.ends_on ?? null;
    const applicable = locationHours.filter((h) => (h.starts_on <= date) && (!h.ends_on || date <= h.ends_on));
    const invalid = input.weekdays.filter((weekday) => pricingHasFutureOccurrence({ weekday, starts_on: date, ends_on: until }, date)
      && !fitsOpeningHours(applicable, { ...input, weekday }));
    if (invalid.length) {
      const message = openingHoursTimeError(applicable, { ...input, weekdays: invalid });
      return date === "0001-01-01" ? message : `${message} Check pricing validity from ${date}.`;
    }
  }
  return null;
}

function openingHoursTimeError(locationHours: readonly HoursInterval[], input: Parameters<typeof pricingOpeningHoursError>[1]): string {
  const grouped = new Map<string, { days: number[]; hours: HoursInterval[] }>();
  for (const day of input.weekdays) {
    const hours = locationHours.filter((interval) => interval.weekday === day)
      .sort((a, b) => a.opens_at_minute - b.opens_at_minute);
    const key = hours.map((interval) => `${interval.opens_at_minute}-${interval.closes_at_minute}`).join(",");
    const group = grouped.get(key);
    if (group) group.days.push(day);
    else grouped.set(key, { days: [day], hours });
  }
  const selectedTime = `${minuteToTime(input.starts_at_minute)}–${minuteToTime(input.ends_at_minute)}`;
  return [...grouped.values()].map(({ days, hours }) => {
    const label = dayNames(days);
    if (!hours.length) return `${label} ${days.length === 1 ? "is" : "are"} closed. Remove ${days.length === 1 ? label : "those days"} or change the location's opening hours.`;
    const schedule = hours.map((interval) => `${minuteToTime(interval.opens_at_minute)}–${minuteToTime(interval.closes_at_minute)}`);
    const crossesGap = hours.some((interval) => interval.opens_at_minute <= input.starts_at_minute && input.starts_at_minute < interval.closes_at_minute)
      && hours.some((interval) => interval.opens_at_minute < input.ends_at_minute && input.ends_at_minute <= interval.closes_at_minute);
    if (crossesGap) return `The selected time ${selectedTime} crosses a closed period. ${label} ${days.length === 1 ? "is" : "are"} open ${schedule.join(" and ")}.`;
    return `The selected time ${selectedTime} is outside ${label} opening hours (${schedule.join(", ")}).`;
  }).join(" ");
}

// Group by persisted identity, never by coincidentally equal display values.
export function groupPricingRuleSets(rows: readonly PricingRule[]): PricingRuleSet[] {
  const groups = new Map<string, PricingRule[]>();
  for (const row of rows) {
    const group = groups.get(row.rule_set_id) ?? [];
    group.push(row); groups.set(row.rule_set_id, group);
  }
  return [...groups.values()].map((group) => {
    const { id, court_id, weekday, ...definition } = group[0];
    void id; void court_id; void weekday;
    const court_ids = [...new Set(group.map((row) => row.court_id))].sort();
    const weekdays = [...new Set(group.map((row) => row.weekday))].sort((a, b) => a - b);
    if (group.length !== court_ids.length * weekdays.length || group.some((row) =>
      row.location_id !== definition.location_id || row.court_state !== definition.court_state
      || row.starts_at_minute !== definition.starts_at_minute || row.ends_at_minute !== definition.ends_at_minute
      || row.starts_on !== definition.starts_on || row.ends_on !== definition.ends_on
      || row.price_per_hour_minor !== definition.price_per_hour_minor)
      || new Set(group.map((row) => `${row.court_id}:${row.weekday}`)).size !== group.length) {
      throw new Error("Inconsistent pricing rule set.");
    }
    return { ...definition, court_ids, weekdays, revision: pricingRuleSetRevision(group) };
  }).sort((a, b) => courtStates.indexOf(a.court_state) - courtStates.indexOf(b.court_state)
    || a.weekdays[0] - b.weekdays[0] || a.starts_at_minute - b.starts_at_minute
    || (a.starts_on ?? "").localeCompare(b.starts_on ?? "") || a.rule_set_id.localeCompare(b.rule_set_id));
}

// Child identities change on replacement. Include all rows, so partial automatic
// reconciliation also invalidates an editor opened against the previous definition.
export function pricingRuleSetRevision(rows: readonly Pick<PricingRule, "id" | "updated_at">[]) {
  return JSON.stringify(rows.map((row) => [row.id, row.updated_at]).sort((a, b) => a[0].localeCompare(b[0])));
}

export function formatWeekdays(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return "All days";
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  if (sorted.length > 1 && sorted.every((day, index) => day === sorted[0] + index)) {
    return `${names[sorted[0]]}–${names[sorted[sorted.length - 1]]}`;
  }
  return sorted.map((day) => names[day]).join(", ");
}
