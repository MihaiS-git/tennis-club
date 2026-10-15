import { expect, test } from "vitest";
import { weeklyHoursMutationSchema, scheduleStatus, planOpeningHoursPeriod } from "@/lib/admin/opening-hours-validation";
import { planOpeningHoursPricing, reconcileOpeningHoursPricing, type DatedOpeningHours } from "@/lib/pricing/opening-hours-reconciliation";
import { LocationPricingRuleEntity } from "@/lib/db/entities/location-pricing-rule.entity";
import { pricingOpeningHoursError } from "@/lib/pricing/resolution";
import { publicationReadiness, type PublicationConfiguration } from "@/lib/locations/publication";
import { buildReservationDay } from "@/lib/reservations/domain";

const locationId = "ac000000-0000-4000-8000-000000000001";
const courtId = "ac000000-0000-4000-8000-000000000002";
const price = (start: number, end: number, amount = 5017, startsOn: string | null = null, endsOn: string | null = null) =>
  Object.assign(new LocationPricingRuleEntity(), { id: `${start}-${end}-${startsOn}`, courtId, locationId, ruleSetId: "set", courtState: "outdoor" as const,
    weekday: 0, startsAtMinute: start, endsAtMinute: end, pricePerHourMinor: amount, startsOn, endsOn });
const hour = (start: number, end: number, startsOn = "0001-01-01", endsOn: string | null = null): DatedOpeningHours =>
  ({ locationId, weekday: 0, opensAtMinute: start, closesAtMinute: end, startsOn, endsOn });

test("schedule statuses use inclusive calendar dates", () => {
  const schedule = { starts_on: "2026-11-01", ends_on: "2026-11-30" };
  expect(scheduleStatus(schedule, "2026-10-31")).toBe("Scheduled");
  expect(scheduleStatus(schedule, "2026-11-01")).toBe("Current");
  expect(scheduleStatus(schedule, "2026-11-30")).toBe("Current");
  expect(scheduleStatus(schedule, "2026-12-01")).toBe("History");
});
test("future reduction splits date coverage, retains history and unaffected future seasons", () => {
  const rules = [price(420,1320), Object.assign(price(420,1320,8000,"2027-04-01",null), { courtId: "other" })];
  const result = reconcileOpeningHoursPricing(rules, [hour(420,1320)],
    [hour(420,1320,"0001-01-01","2026-10-31"), hour(480,1200,"2026-11-01","2027-03-31"), hour(420,1320,"2027-04-01")], "2026-10-10");
  expect(result.changed).toEqual([rules[0].id]);
  expect(result.additions.map((p) => [p.startsOn,p.endsOn,p.startsAtMinute,p.endsAtMinute,p.pricePerHourMinor])).toEqual([
    [null,"2026-10-31",420,1320,5017], ["2026-11-01","2027-03-31",480,1200,5017], ["2027-04-01",null,420,1320,5017],
  ]);
});
test("future extension borrows simultaneous adjacent prices, taking the maximum across a gap", () => {
  const rules = [price(480,600,4017),price(720,1200,8029)];
  const before = [hour(480,600),hour(720,1200)];
  const after = [hour(480,600,"0001-01-01","2026-10-31"),hour(720,1200,"0001-01-01","2026-10-31"),hour(420,1440,"2026-11-01")];
  const result = reconcileOpeningHoursPricing(rules,before,after,"2026-10-10");
  expect(result.changed).toEqual([]);
  expect(result.additions.map((p) => [p.startsOn,p.startsAtMinute,p.endsAtMinute,p.pricePerHourMinor])).toEqual([
    ["2026-11-01",420,480,4017], ["2026-11-01",600,720,8029], ["2026-11-01",1200,1440,8029],
  ]);
});
test("missing adjacent pricing stays missing and historical rules remain untouched", () => {
  const rules = [price(600,720),price(420,480,1234,"2000-01-01","2001-12-31")];
  const result = reconcileOpeningHoursPricing(rules,[hour(420,1320)],[hour(360,1440)],"2026-10-10");
  expect(result).toEqual({ changed: [], additions: [], missingPricing: true });
});
test("pricing validity must fit every applicable schedule and cannot bridge a closed period", () => {
  const hours = [hour(420,1320,"0001-01-01","2026-10-31"),hour(480,1200,"2026-11-01","2026-11-30")]
    .map((h) => ({ location_id: h.locationId, weekday: h.weekday, opens_at_minute: h.opensAtMinute, closes_at_minute: h.closesAtMinute, starts_on: h.startsOn, ends_on: h.endsOn }));
  const input = { location_id: locationId, weekdays: [0], starts_at_minute: 420, ends_at_minute: 480, starts_on: "2026-10-01", ends_on: "2026-10-31" };
  expect(pricingOpeningHoursError(hours,input,"2026-10-10")).toBeNull();
  expect(pricingOpeningHoursError(hours,{ ...input, ends_on: "2026-11-30" },"2026-10-10")).toContain("outside");
  expect(pricingOpeningHoursError(hours,{ ...input, starts_at_minute: 480, ends_at_minute: 600, ends_on: "2026-12-31" },"2026-10-10")).toContain("closed");
});
test("readiness never pairs future hours with pricing from an unrelated validity period", () => {
  const location: PublicationConfiguration = { name: "Club", slug: "club", timezone: "Europe/Bucharest", currency: "RON", is_active: true, is_public: true, archived_at: null,
    location_opening_hours: [{ id: locationId, weekday: 0, opens_at_minute: 480, closes_at_minute: 1200, starts_on: "2026-11-01", ends_on: "2026-11-30" }],
    courts: [{ id: courtId, environment: "outdoor", location_pricing_rules: [{ court_state: "outdoor", weekday: 0, starts_at_minute: 480, ends_at_minute: 1200, starts_on: null, ends_on: "2026-10-31" }] }] };
  expect(publicationReadiness(location,"2026-10-10")).toContain("pricing for every active court");
  location.courts[0].location_pricing_rules[0].ends_on = "2026-11-30";
  expect(publicationReadiness(location,"2026-10-10")).toEqual([]);
  expect(publicationReadiness(location,"2026-12-01")).toContain("opening hours");
});
test("closed days still display grandfathered occupancy without making it selectable", () => {
  const day = buildReservationDay({ date: "2026-11-02", today: "2026-10-10", currentMinute: 0, courts: [{ id: courtId,name: "Court" }], hours: [],
    reservations: [{ court_id: courtId, starts_at_minute: 420, ends_at_minute: 480 }] });
  expect(day.times).toEqual([420,450]);
  expect(day.courts[0].cells).toEqual(["booked","booked"]);
});
test("24:00 and multiple intervals remain valid; reversed validity and time overlaps fail", () => {
  const input = { operation: "create", location_id: locationId, starts_on: "2026-11-01", ends_on: "2026-11-30", replace_ids: [],
    rows: [{ weekdays: [0,1], opens_at: "08:00", closes_at: "12:00" }, { weekdays: [0,1], opens_at: "13:00", closes_at: "24:00" }] };
  expect(weeklyHoursMutationSchema.safeParse(input).success).toBe(true);
  expect(weeklyHoursMutationSchema.safeParse({ ...input, ends_on: "2026-10-31" }).success).toBe(false);
  expect(weeklyHoursMutationSchema.safeParse({ ...input, rows: [...input.rows,{ weekdays: [0,1], opens_at: "11:00", closes_at: "14:00" }] }).success).toBe(false);
});

test("mutations require explicit operations and existing schedule identities and revisions", () => {
  const fields = { location_id: locationId, replace_ids: [], rows: [{ weekdays: [0], opens_at: "08:00", closes_at: "20:00" }] };
  expect(weeklyHoursMutationSchema.safeParse(fields).success).toBe(false);
  for (const operation of ["update", "delete"] as const) {
    const input = operation === "delete" ? { location_id: locationId, operation } : { ...fields, operation };
    expect(weeklyHoursMutationSchema.safeParse(input).success).toBe(false);
    expect(weeklyHoursMutationSchema.safeParse({ ...input, schedule_id: courtId }).success).toBe(false);
    expect(weeklyHoursMutationSchema.safeParse({ ...input, revision: 1 }).success).toBe(false);
    expect(weeklyHoursMutationSchema.safeParse({ ...input, schedule_id: courtId, revision: 1 }).success).toBe(true);
  }
  expect(weeklyHoursMutationSchema.safeParse({ ...fields, operation: "create", starts_on: "2027-01-01", schedule_id: courtId, revision: 1 }).success).toBe(false);
});

test.each([
  ["earlier opening", 360, 1320, [[360,420],[420,1320]]],
  ["later opening", 480, 1320, [[480,1320]]],
  ["earlier closing", 420, 1200, [[420,1200]]],
  ["later closing", 420, 1380, [[420,1320],[1320,1380]]],
  ["both extended", 360, 1380, [[360,420],[420,1320],[1320,1380]]],
  ["both reduced", 480, 1200, [[480,1200]]],
  ["deletion", 0, 0, []],
] as const)("reconciliation handles %s without PostgreSQL fixtures", (_label, start, end, expected) => {
  const today = "2026-10-10";
  const rule = price(420, 1320);
  const result = reconcileOpeningHoursPricing([rule], [hour(420,1320)], end ? [hour(start,end)] : [], today);
  const future = [...(result.changed.length ? result.additions : [rule, ...result.additions])]
    .filter((row) => row.endsOn === null || row.endsOn >= today);
  expect(future.map((row) => [row.startsAtMinute,row.endsAtMinute]).sort((a,b) => a[0]-b[0])).toEqual(expected);
  expect(future.every((row) => row.pricePerHourMinor === 5017)).toBe(true);
  if (result.changed.length) expect(result.additions.find((row) => row.endsOn === "2026-10-09"))
    .toMatchObject({ startsOn: null, startsAtMinute: 420, endsAtMinute: 1320, pricePerHourMinor: 5017 });
});

test("pricing planning preserves retained identities and groups rectangular definitions", () => {
  const row = (id: string, courtId: string, weekday: number, ruleSetId = "set") =>
    Object.assign(price(420,1320), { id, courtId, weekday, ruleSetId });
  const rules = [row("a0","a",0),row("a1","a",1),row("b0","b",0),row("b1","b",1),row("c0","c",0,"removed")];
  const before = rules.map((rule) => ({ ...rule }));
  const additions = [row("new-a0","a",0),row("new-a1","a",1),row("new-b0","b",0)];
  const plan = planOpeningHoursPricing(rules, { changed: ["a0","c0"], additions });
  expect(plan).toEqual({ deleteRuleIds: ["a0","c0"], removeRuleSetIds: ["removed"], moveRuleIds: [["b0","b1"]],
    newRuleSets: [[additions[0],additions[1]],[additions[2]]] });
  expect(rules.map((rule) => ({ ...rule }))).toEqual(before);
});


test("future creation cuts off only the current policy and preserves history", () => {
  const current = { id: locationId, location_id: locationId, starts_on: "2026-10-10", ends_on: null, revision: 3 };
  const history = { ...current, id: courtId, starts_on: "2026-01-01", ends_on: "2026-10-09" };
  const before = structuredClone([history, current]);
  const plan = planOpeningHoursPeriod([history, current], "2026-10-31", null, "2026-10-10");
  expect(plan).toEqual({ ok: true, adjustment: { ...current, ends_on: "2026-10-30" } });
  expect([history, current]).toEqual(before);
  if (!plan.ok || !plan.adjustment) throw new Error("Expected adjustment");
  const next = { ...current, starts_on: "2026-10-31" };
  expect([plan.adjustment, next].map((s) => scheduleStatus(s, "2026-10-30"))).toEqual(["Current", "Scheduled"]);
  expect([plan.adjustment, next].map((s) => scheduleStatus(s, "2026-10-31"))).toEqual(["History", "Current"]);
});

test("automatic cutoff uses calendar arithmetic across leap days", () => {
  const current = { id: locationId, location_id: locationId, starts_on: "2028-01-01", ends_on: null, revision: 1 };
  expect(planOpeningHoursPeriod([current], "2028-03-01", null, "2028-02-01"))
    .toMatchObject({ ok: true, adjustment: { ends_on: "2028-02-29" } });
});

test("independently scheduled policies and nonfuture overlaps require explicit edits", () => {
  const current = { id: locationId, location_id: locationId, starts_on: "2026-01-01", ends_on: "2026-11-30", revision: 1 };
  const future = { ...current, id: courtId, starts_on: "2026-12-01", ends_on: null };
  expect(planOpeningHoursPeriod([current, future], "2026-10-31", null, "2026-10-10")).toEqual({ ok: false });
  expect(planOpeningHoursPeriod([current, future], "2027-01-01", null, "2026-10-10")).toEqual({ ok: false });
  expect(planOpeningHoursPeriod([current], "2026-10-10", null, "2026-10-10")).toEqual({ ok: false });
  expect(planOpeningHoursPeriod([current], "2026-10-31", null, "2026-10-10", false)).toEqual({ ok: false });
  expect(planOpeningHoursPeriod([current, future], "2026-10-31", "2026-11-30", "2026-10-10"))
    .toMatchObject({ ok: true, adjustment: { id: current.id, ends_on: "2026-10-30" } });
});


test("missing newly opened pricing is checked for every active court scope, never inherited across courts", () => {
  const rule = price(480,1200);
  const other = { courtId: "other", courtState: "outdoor" as const };
  const result = reconcileOpeningHoursPricing([rule],[hour(480,1200)],[hour(420,1200)],"2026-10-10",undefined,[{ courtId,courtState: "outdoor" },other]);
  expect(result.missingPricing).toBe(true);
  expect(result.additions.every((r) => r.courtId === courtId)).toBe(true);
  expect(result.additions.map((r) => [r.startsAtMinute,r.endsAtMinute,r.pricePerHourMinor])).toEqual([[420,480,5017]]);
});

test.each([
  { label:"forward extension", before:[hour(480,720)], after:[hour(480,720),hour(720,780),hour(780,840)], rules:[price(480,720)], expected:[[720,780,5017],[780,840,5017]] },
  { label:"backward extension", before:[hour(480,720)], after:[hour(360,420),hour(420,480),hour(480,720)], rules:[price(480,720)], expected:[[360,420,5017],[420,480,5017]] },
  { label:"split interior gap", before:[hour(480,600),hour(720,840)], after:[hour(480,600),hour(600,660),hour(660,720),hour(720,840)], rules:[price(480,600,4017),price(720,840,8029)], expected:[[600,660,8029],[660,720,8029]] },
])("simultaneously added adjacent intervals inherit through the whole $label without losing boundaries", ({ before,after,rules,expected }) => {
  const result = reconcileOpeningHoursPricing(rules,before,after,"2026-10-10");
  expect(result.changed).toEqual([]);
  expect(result.missingPricing).toBe(false);
  expect(result.additions.map((r) => [r.startsAtMinute,r.endsAtMinute,r.pricePerHourMinor])).toEqual(expected);
});

test("adjacent inheritance never bridges previously open but unpriced time", () => {
  const result = reconcileOpeningHoursPricing([price(480,720)],[hour(480,720),hour(780,840)],
    [hour(480,720),hour(720,780),hour(780,840),hour(840,900)],"2026-10-10");
  expect(result.missingPricing).toBe(true);
  expect(result.additions.map((r) => [r.startsAtMinute,r.endsAtMinute])).toEqual([[720,780]]);
});
