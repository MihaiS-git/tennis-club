import { expect, test } from "vitest";
import { coveragePeriodsOverlap } from "@/lib/courts/coverage-validation";
import { pricingRulesOverlap } from "@/lib/pricing/validation";

const coverage = { starts_on: "2099-01-10", ends_on: "2099-01-20" };
test.each([
  ["partial", "2099-01-15", "2099-01-25", true],
  ["contained", "2099-01-12", "2099-01-18", true],
  ["adjacent dates", "2099-01-21", "2099-01-25", false],
] as const)("coverage %s", (_, starts_on, ends_on, expected) => {
  const other = { starts_on, ends_on };
  expect(coveragePeriodsOverlap(coverage, other)).toBe(expected);
  expect(coveragePeriodsOverlap(other, coverage)).toBe(expected);
});
const rule = { courtId: "court", courtState: "outdoor", weekday: 0,
  startsAtMinute: 540, endsAtMinute: 600, startsOn: null, endsOn: null };
test.each([
  [{ startsAtMinute: 600, endsAtMinute: 660 }, false],
  [{ startsAtMinute: 599 }, true],
  [{ courtId: "other" }, false],
  [{ courtState: "covered" }, false],
  [{ startsOn: "2099-01-01", endsOn: "2099-01-31" }, true],
])("pricing dimensions and half-open times %j", (changes, expected) => {
  expect(pricingRulesOverlap(rule, { ...rule, ...changes })).toBe(expected);
});
test("pricing inclusive dates and unbounded endpoints", () => {
  const dated = { ...rule, startsOn: "2099-01-10", endsOn: "2099-01-20" };
  expect(pricingRulesOverlap(dated, { ...rule, startsOn: "2099-01-20" })).toBe(true);
  expect(pricingRulesOverlap(dated, { ...rule, startsOn: "2099-01-21" })).toBe(false);
  expect(pricingRulesOverlap(dated, { ...rule, endsOn: "2099-01-09" })).toBe(false);
  expect(pricingRulesOverlap(dated, { ...dated, startsOn: "2099-01-12", endsOn: "2099-01-18" })).toBe(true);
});
