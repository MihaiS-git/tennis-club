import { expect, test } from "vitest";
import { toCalendarCoveragePeriod, toCalendarPricingRule } from "@/lib/courts/calendar-projections";

const createdAt = new Date("2026-10-25T03:30:00.123+03:00");
const updatedAt = new Date("2026-10-25T03:30:00.987+02:00");
const pricing: Parameters<typeof toCalendarPricingRule>[0] = {
  id: "pricing-id", ruleSetId: "rule-set-id", locationId: "location-id", courtId: "court-id",
  courtState: "covered", weekday: 6, startsAtMinute: 570, endsAtMinute: 1440,
  startsOn: "2026-10-25", endsOn: "2027-03-28", pricePerHourMinor: 12345,
  createdAt, updatedAt,
};

test.each([
  { startsOn: "2026-10-25", endsOn: "2027-03-28" },
  { startsOn: null, endsOn: "2027-03-28" },
  { startsOn: "2026-10-25", endsOn: null },
  { startsOn: null, endsOn: null },
])("maps every pricing field and preserves date bounds: %j", (dates) => {
  expect(toCalendarPricingRule({ ...pricing, ...dates })).toEqual({
    id: "pricing-id", rule_set_id: "rule-set-id", location_id: "location-id", court_id: "court-id",
    court_state: "covered", weekday: 6, starts_at_minute: 570, ends_at_minute: 1440,
    starts_on: dates.startsOn, ends_on: dates.endsOn, price_per_hour_minor: 12345,
    created_at: "2026-10-25T00:30:00.123Z", updated_at: "2026-10-25T01:30:00.987Z",
  });
});

const coverage: Parameters<typeof toCalendarCoveragePeriod>[0] = {
  id: "coverage-id", courtId: "court-id", startsOn: "2026-10-25", endsOn: "2027-03-28",
  createdAt, updatedAt,
};

test("maps every coverage field, retaining local dates and serializing instants to UTC", () => {
  expect(toCalendarCoveragePeriod(coverage)).toEqual({
    id: "coverage-id", court_id: "court-id", starts_on: "2026-10-25", ends_on: "2027-03-28",
    created_at: "2026-10-25T00:30:00.123Z", updated_at: "2026-10-25T01:30:00.987Z",
  });
});

test.each(["createdAt", "updatedAt"] as const)("preserves toISOString failure for invalid %s", (field) => {
  expect(() => toCalendarPricingRule({ ...pricing, [field]: new Date(NaN) })).toThrow(RangeError);
  expect(() => toCalendarCoveragePeriod({ ...coverage, [field]: new Date(NaN) })).toThrow(RangeError);
});
