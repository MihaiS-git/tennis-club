import type { LocationPricingRuleEntity } from "@/lib/db/entities/location-pricing-rule.entity";
import type { LocationOpeningHoursEntity } from "@/lib/db/entities/location-opening-hours.entity";
import { pricingHasFutureOccurrence } from "./resolution";

type Interval = { start: number; end: number };
export type DatedOpeningHours = Pick<LocationOpeningHoursEntity, "locationId" | "weekday" | "opensAtMinute" | "closesAtMinute"> & { startsOn: string; endsOn: string | null };
export type ReconciledPrice = Pick<LocationPricingRuleEntity,
  "courtId" | "courtState" | "weekday" | "startsAtMinute" | "endsAtMinute" | "startsOn" | "endsOn" | "pricePerHourMinor">;

function subtract(interval: Interval, others: readonly Interval[]): Interval[] {
  return others.reduce<Interval[]>((pieces, other) => pieces.flatMap((piece) => {
    if (other.end <= piece.start || other.start >= piece.end) return [piece];
    return [...(piece.start < other.start ? [{ start: piece.start, end: other.start }] : []),
      ...(other.end < piece.end ? [{ start: other.end, end: piece.end }] : [])];
  }), [interval]);
}

function joinAdjacent(intervals: Interval[]): Interval[] {
  const joined: Interval[] = [];
  for (const interval of intervals.sort((a,b) => a.start-b.start)) {
    const previous = joined.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end,interval.end);
    else joined.push({ ...interval });
  }
  return joined;
}
const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const previousDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const applies = (value: { startsOn?: string | null; endsOn?: string | null }, date: string) =>
  (!value.startsOn || value.startsOn <= date) && (!value.endsOn || date <= value.endsOn);
const samePrice = (a: ReconciledPrice, b: ReconciledPrice) => a.courtId === b.courtId && a.courtState === b.courtState
  && a.weekday === b.weekday && a.startsAtMinute === b.startsAtMinute && a.endsAtMinute === b.endsAtMinute
  && a.pricePerHourMinor === b.pricePerHourMinor;

function mergeDates(rows: ReconciledPrice[]): ReconciledPrice[] {
  const merged: ReconciledPrice[] = [];
  for (const row of rows.sort((a,b) => (a.startsOn ?? "").localeCompare(b.startsOn ?? ""))) {
    const previous = merged.find((other) => samePrice(row, other) && other.endsOn !== null
      && row.startsOn === nextDate(other.endsOn));
    if (previous) previous.endsOn = row.endsOn;
    else merged.push({ ...row });
  }
  return merged;
}

/** Partition by playing date before reconciling time intervals. Historical and
 * unchanged slices are retained; prices never cross court/state/day/season scopes. */
export function reconcileOpeningHoursPricing(rules: readonly LocationPricingRuleEntity[],
  before: readonly DatedOpeningHours[], after: readonly DatedOpeningHours[], today: string, periods?: readonly { startsOn: string; endsOn: string | null }[],
  requiredScopes: readonly Pick<ReconciledPrice, "courtId" | "courtState">[] = []) {
  const boundaries = [...new Set([today, ...[...rules, ...before, ...after, ...(periods ?? [])].flatMap((r) =>
    [r.startsOn, r.endsOn ? nextDate(r.endsOn) : null]).filter((d): d is string => Boolean(d))])].sort();
  const dates: (string | null)[] = [null, ...boundaries, null];
  const retained = new Map<string, ReconciledPrice[]>();
  const inherited = new Map<string, ReconciledPrice[]>();
  let missingPricing = false;
  for (let i = 0; i < dates.length - 1; i++) {
    const startsOn = dates[i], endsOn = dates[i + 1] ? previousDate(dates[i + 1]!) : null;
    const date = startsOn ?? "0001-01-01";
    const active = rules.filter((r) => applies(r, date));
    for (let weekday = 0; weekday < 7; weekday++) {
      const hours = (rows: readonly DatedOpeningHours[]) => rows.filter((h) => h.weekday === weekday && applies(h, date))
        .map((h) => ({ start: h.opensAtMinute, end: h.closesAtMinute })).sort((a,b) => a.start-b.start);
      const oldHours = hours(before), newHours = hours(after);
      const changed = date >= today && (periods === undefined || periods.some((p) => applies(p, date))) && JSON.stringify(oldHours) !== JSON.stringify(newHours);
      const dayRules = active.filter((r) => r.weekday === weekday);
      for (const rule of dayRules) {
        const pieces = changed ? newHours.flatMap((hour) => {
          const start = Math.max(hour.start, rule.startsAtMinute), end = Math.min(hour.end, rule.endsAtMinute);
          return start < end ? [{ start, end }] : [];
        }) : [{ start: rule.startsAtMinute, end: rule.endsAtMinute }];
        const rows = retained.get(rule.id) ?? [];
        rows.push(...pieces.map((piece) => ({ courtId: rule.courtId, courtState: rule.courtState,
          weekday, pricePerHourMinor: rule.pricePerHourMinor, startsOn, endsOn,
          startsAtMinute: piece.start, endsAtMinute: piece.end })));
        retained.set(rule.id, rows);
      }
      if (!changed || !pricingHasFutureOccurrence({ weekday, starts_on: startsOn, ends_on: endsOn }, today)) continue;
      // Adjacent intervals can be entered together as one continuous extension.
      // Resolve inheritance across that extension, then restore interval boundaries.
      const opened = joinAdjacent(newHours.flatMap((hour) => subtract(hour, oldHours)));
      if (opened.length && !dayRules.length) missingPricing = true;
      if (opened.length && requiredScopes.some((s) => !dayRules.some((r) => r.courtId === s.courtId && r.courtState === s.courtState))) missingPricing = true;
      const scopes = new Map<string, LocationPricingRuleEntity[]>();
      for (const rule of dayRules) {
        const key = `${rule.courtId}:${rule.courtState}`;
        scopes.set(key, [...(scopes.get(key) ?? []), rule]);
      }
      for (const scope of scopes.values()) for (const interval of opened) {
        for (const gap of subtract(interval, scope.map((r) => ({ start: r.startsAtMinute, end: r.endsAtMinute })))) {
          const left = scope.find((r) => r.endsAtMinute === gap.start);
          const right = scope.find((r) => r.startsAtMinute === gap.end);
          const source = left ?? right;
          if (!source) { missingPricing = true; continue; }
          const key = scope.map((rule) => rule.id).sort().join(":");
          const inheritedRows = inherited.get(key) ?? [];
          for (const hour of newHours) {
            const start = Math.max(gap.start,hour.start), end = Math.min(gap.end,hour.end);
            if (start < end) inheritedRows.push({ courtId: source.courtId, courtState: source.courtState, weekday, startsOn, endsOn,
              startsAtMinute: start, endsAtMinute: end,
              pricePerHourMinor: Math.max(left?.pricePerHourMinor ?? 0, right?.pricePerHourMinor ?? 0) });
          }
          inherited.set(key, inheritedRows);
        }
      }
    }
  }
  const changed: string[] = [], additions: ReconciledPrice[] = [];
  for (const rule of rules) {
    const pieces = mergeDates(retained.get(rule.id) ?? []);
    if (pieces.length === 1 && samePrice(pieces[0], rule) && pieces[0].startsOn === rule.startsOn && pieces[0].endsOn === rule.endsOn) continue;
    changed.push(rule.id);
    additions.push(...pieces);
  }
  for (const rows of inherited.values()) additions.push(...mergeDates(rows));
  return { changed, additions, missingPricing };
}

// Definitions must remain rectangular court × weekday groups for the Admin editor.
function groupCourtWeekdays<T extends { courtId: string; weekday: number }>(rows: readonly T[]): T[][] {
  const courtDays = new Map<string, number[]>();
  for (const row of rows) courtDays.set(row.courtId, [...(courtDays.get(row.courtId) ?? []), row.weekday]);
  const signatures = new Map([...courtDays].map(([courtId, days]) => [courtId, days.sort((a, b) => a - b).join(",")]));
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = signatures.get(row.courtId)!;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()];
}

/** Decide definition deletions, retained-row moves and new definitions without persistence. */
export function planOpeningHoursPricing(rules: readonly LocationPricingRuleEntity[],
  reconciliation: Pick<ReturnType<typeof reconcileOpeningHoursPricing>, "changed" | "additions">) {
  const changed = new Set(reconciliation.changed);
  const removeRuleSetIds: string[] = [];
  const moveRuleIds: string[][] = [];
  for (const setId of new Set(rules.filter((row) => changed.has(row.id)).map((row) => row.ruleSetId))) {
    const remaining = rules.filter((row) => row.ruleSetId === setId && !changed.has(row.id));
    if (!remaining.length) removeRuleSetIds.push(setId);
    else moveRuleIds.push(...groupCourtWeekdays(remaining).slice(1).map((group) => group.map((row) => row.id)));
  }
  const slices = new Map<string, ReconciledPrice[]>();
  for (const row of reconciliation.additions) {
    const key = JSON.stringify([row.courtState, row.startsAtMinute, row.endsAtMinute, row.startsOn, row.endsOn, row.pricePerHourMinor]);
    slices.set(key, [...(slices.get(key) ?? []), row]);
  }
  return { deleteRuleIds: [...changed], removeRuleSetIds, moveRuleIds,
    newRuleSets: [...slices.values()].flatMap(groupCourtWeekdays) };
}

export type OpeningHoursPricingPlan = ReturnType<typeof planOpeningHoursPricing>;
