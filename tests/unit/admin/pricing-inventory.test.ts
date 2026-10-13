import { expect, it } from "vitest";
import { pricingInventorySchema, selectPricingRules } from "../../../src/app/admin/pricing/inventory";
import type { PricingRuleSet } from "../../../src/lib/pricing/validation";

const court2 = "c7000000-0000-4000-8000-000000000002";
const court10 = "c7000000-0000-4000-8000-000000000010";
const courts = [{ id: court10, name: "Court 10" }, { id: court2, name: "Court 2" }];
function rule(id: string, overrides: Partial<PricingRuleSet> = {}): PricingRuleSet {
  return { revision: "fixture-revision", rule_set_id: id, location_id: "location", court_ids: [court2], court_state: "outdoor", weekdays: [0],
    starts_at_minute: 480, ends_at_minute: 600, starts_on: null, ends_on: null, price_per_hour_minor: 1000,
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...overrides };
}
const multi = rule("multi", { court_ids: [court10, court2], weekdays: [6, 0], starts_on: "2026-10-01", ends_on: "2026-10-31" });
const indoor = rule("indoor", { court_ids: [court10], court_state: "indoor", weekdays: [1] });
const all = [multi, indoor];
function ids(rules: PricingRuleSet[], input: Record<string, string> = {}) {
  return selectPricingRules(rules, courts, pricingInventorySchema.parse(input)).map(({ item }) => item.rule_set_id);
}

it.each([
  [{ pricingCourt: court2 }, ["multi"]],
  [{ pricingCourt: court10 }, ["multi", "indoor"]],
  [{ pricingState: "indoor" }, ["indoor"]],
  [{ pricingDay: "6" }, ["multi"]],
  [{ pricingDay: "0" }, ["multi"]],
  [{ pricingDate: "2026-10-01" }, ["multi", "indoor"]],
  [{ pricingDate: "2026-10-31" }, ["multi", "indoor"]],
  [{ pricingDate: "2026-09-30" }, ["indoor"]],
  [{ pricingDate: "2026-11-01" }, ["indoor"]],
  [{ pricingCourt: court10, pricingState: "outdoor", pricingDay: "6", pricingDate: "2026-10-15" }, ["multi"]],
  [{ pricingCourt: court2, pricingState: "indoor" }, []],
] as const)("filters rule sets by %j", (input, expected) => {
  expect(ids(all, input)).toEqual(expected);
});

it("treats either missing validity bound as open and includes single-day ranges", () => {
  const rules = [rule("from", { starts_on: "2026-10-10" }), rule("until", { ends_on: "2026-10-10" }),
    rule("day", { starts_on: "2026-10-10", ends_on: "2026-10-10" })];
  expect(ids(rules, { pricingDate: "2026-10-09" })).toEqual(["until"]);
  expect(ids(rules, { pricingDate: "2026-10-10" })).toEqual(["from", "until", "day"]);
  expect(ids(rules, { pricingDate: "2026-10-11" })).toEqual(["from"]);
});

it.each([
  ["price", { price_per_hour_minor: 900 }, { price_per_hour_minor: 10000 }],
  ["time", { starts_at_minute: 540 }, { starts_at_minute: 1080 }],
  ["time", { ends_at_minute: 540 }, { ends_at_minute: 1080 }],
  ["courts", { court_ids: [court2] }, { court_ids: [court10] }],
  ["days", { weekdays: [0, 6] }, { weekdays: [1] }],
  ["days", { weekdays: [2, 0] }, { weekdays: [6, 0] }],
  ["validity", { starts_on: "2026-01-01" }, { starts_on: "2026-11-01" }],
  ["validity", { ends_on: "2026-01-01" }, { ends_on: null }],
  ["validity", { starts_on: null }, { starts_on: "2026-01-01" }],
  ["state", { court_state: "covered" }, { court_state: "outdoor" }],
] satisfies [string, Partial<PricingRuleSet>, Partial<PricingRuleSet>][])("sorts %s by its data type in both directions", (pricingSort, first, second) => {
  const rules = [rule("second", second), rule("first", first)];
  expect(ids(rules, { pricingSort })).toEqual(["first", "second"]);
  expect(ids(rules, { pricingSort, pricingDir: "desc" })).toEqual(["second", "first"]);
});

it("defaults to Court → State → Start time → Weekday, preserving equal rows", () => {
  const rules = [rule("court10", { court_ids: [court10] }), rule("late", { starts_at_minute: 960 }),
    rule("tuesday", { weekdays: [1] }), rule("first"), rule("equal"), rule("covered", { court_state: "covered" })];
  expect(ids(rules)).toEqual(["covered", "first", "equal", "tuesday", "late", "court10"]);
  for (const pricingSort of ["price", "state", "days", "time", "validity", "courts"]) {
    expect(ids([rule("first"), rule("second")], { pricingSort, pricingDir: "desc" })).toEqual(["first", "second"]);
  }
});

it("normalizes multi-court/day comparisons without changing any input arrays or records", () => {
  const original = structuredClone(all);
  const rows = selectPricingRules(all, courts, pricingInventorySchema.parse({}));
  expect(rows[0].courtNames).toBe("Court 2, Court 10");
  expect(all).toEqual(original);
  expect(rows[0].item).toBe(multi);
});

it("ignores malformed URL inputs", () => {
  expect(pricingInventorySchema.parse({ pricingCourt: "other", pricingState: "bad", pricingDay: "7", pricingDate: "2026-02-30", pricingSort: "bad", pricingDir: "bad" }))
    .toEqual({ pricingSort: "courts", pricingDir: "asc" });
});
