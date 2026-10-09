import { expect, it } from "vitest";
import { pricingMutationSchema, type PricingRule } from "../../src/lib/pricing/validation";
import { resolvePricingRule, fitsOpeningHours } from "../../src/lib/pricing/resolution";

const location_id = "c7000000-0000-4000-8000-000000000011";
const court_id = "c7000000-0000-4000-8000-000000000031";
const otherCourt = "c7000000-0000-4000-8000-000000000032";
const rule: PricingRule = { id: "c7000000-0000-4000-8000-000000000021", rule_set_id: "c7000000-0000-4000-8000-000000000041", location_id, court_id, court_state: "covered", weekday: 0,
  starts_at_minute: 420, ends_at_minute: 960, starts_on: null, ends_on: null, price_per_hour_minor: 1250,
  created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z" };
const input = { location_id, court_ids: [court_id], court_state: "covered", weekdays: [0], starts_at: "07:00", ends_at: "24:00", starts_on: "", ends_on: "", price_per_hour: "12.50" };

it("validates multi-court, multi-day forms and half-open time boundaries", () => {
  expect(pricingMutationSchema.parse(input)).toMatchObject({ price_per_hour: 1250, court_ids: [court_id], weekdays: [0] });
  for (const changes of [{ court_ids: [] }, { court_ids: [court_id, court_id] }, { weekdays: [] }, { weekdays: [0, 0] },
    { weekdays: [7] }, { starts_at: "24:00" }, { ends_at: "07:00" },
    { starts_on: "2027-04-15", ends_on: "2026-10-15" }, { surface: "clay" }, { currency: "EUR" }]) {
    expect(pricingMutationSchema.safeParse({ ...input, ...changes }).success).toBe(false);
  }
});
it("resolves by court/state/date/day and includes 16:00 only in the second adjacent interval", () => {
  const next = { ...rule, id: "c7000000-0000-4000-8000-000000000022", starts_at_minute: 960, ends_at_minute: 1200 };
  const selector = { court_id, court_state: "covered" as const, date: "2026-10-12", minute: 960 };
  expect(resolvePricingRule([rule, next], { ...selector, minute: 959 })).toBe(rule);
  expect(resolvePricingRule([rule, next], selector)).toBe(next);
  expect(resolvePricingRule([rule, next], { ...selector, court_id: otherCourt })).toBeNull();
  expect(resolvePricingRule([rule, next], { ...selector, court_state: "outdoor" })).toBeNull();
  expect(resolvePricingRule([rule, next], { ...selector, date: "2026-10-13" })).toBeNull();
  expect(resolvePricingRule([rule, next], { ...selector, minute: 1200 })).toBeNull();
  expect(() => resolvePricingRule([rule, rule], { ...selector, minute: 420 })).toThrow("Ambiguous pricing configuration.");
});

it("requires containment within one opening interval for the same location and day", () => {
  const hours = { location_id, weekday: 0, opens_at_minute: 420, closes_at_minute: 1440 };
  expect(fitsOpeningHours([hours], rule)).toBe(true);
  expect(fitsOpeningHours([], rule)).toBe(false);
  expect(fitsOpeningHours([{ ...hours, weekday: 1 }], rule)).toBe(false);
  expect(fitsOpeningHours([hours], { ...rule, starts_at_minute: 419 })).toBe(false);
  expect(fitsOpeningHours([{ ...hours, closes_at_minute: 600 }, { ...hours, opens_at_minute: 600 }], rule)).toBe(false);
});
