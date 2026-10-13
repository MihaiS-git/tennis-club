import { expect, it } from "vitest";
import { isPubliclyEligible, isStructurallyReady, publicationReadiness, publicationHoursSchema, publicationPricingSchema, type PublicationConfiguration } from "@/lib/locations/publication";

const ready: PublicationConfiguration = {
  name: "RIVUS", slug: "rivus", timezone: "Europe/Bucharest", currency: "RON",
  is_active: true, is_public: true, archived_at: null,
  location_opening_hours: [{ id: "c7000000-0000-4000-8000-000000000011", weekday: 0, starts_on: "0001-01-01", ends_on: null, opens_at_minute: 480, closes_at_minute: 1200 }],
  courts: [{ id: "court", environment: "outdoor", location_pricing_rules: [{ court_state: "outdoor", weekday: 0, starts_on: null, ends_on: null, starts_at_minute: 480, ends_at_minute: 1200 }] }],
};
const today = "2026-10-02";

it("exposes a published, active, configured location", () => {
  expect(publicationReadiness(ready, today)).toEqual([]);
  expect(isPubliclyEligible(ready, today)).toBe(true);
});

it.each([
  ["inactive", { is_active: false }],
  ["archived", { archived_at: "2026-10-01T00:00:00Z" }],
])("excludes %s locations", (_label, change) => {
  expect(isPubliclyEligible({ ...ready, ...change }, today)).toBe(false);
});

it("requires opening hours, an active court, and pricing for each active court", () => {
  expect(publicationReadiness({ ...ready, location_opening_hours: [] }, today)).toContain("opening hours");
  expect(publicationReadiness({ ...ready, courts: [] }, today)).toContain("an active court");
  expect(publicationReadiness({ ...ready, courts: [{ ...ready.courts[0], location_pricing_rules: [] }] }, today))
    .toContain("pricing for every active court");
  expect(publicationReadiness({ ...ready, courts: [{ ...ready.courts[0], location_pricing_rules: [{ ...ready.courts[0].location_pricing_rules[0], ends_on: "2026-10-01" }] }] }, today))
    .toContain("pricing for every active court");
});

it("separates structural readiness from publication", () => {
  expect(isStructurallyReady({ ...ready, is_public: false }, today)).toBe(true);
  expect(isPubliclyEligible({ ...ready, is_public: false }, today)).toBe(false);
  for (const change of [{ is_active: false }, { archived_at: "2026-10-01T00:00:00Z" },
    { location_opening_hours: [] }, { courts: [] },
    { courts: [{ ...ready.courts[0], location_pricing_rules: [] }] }]) {
    expect(isStructurallyReady({ ...ready, ...change }, today)).toBe(false);
    expect(isPubliclyEligible({ ...ready, ...change }, today)).toBe(false);
  }
  expect(isStructurallyReady(ready, today)).toBe(true);
  expect(isPubliclyEligible(ready, today)).toBe(true);
});

it("rejects incomplete publication facts before evaluating readiness", () => {
  const hour = ready.location_opening_hours[0];
  const rule = ready.courts[0].location_pricing_rules[0];
  expect(publicationHoursSchema.safeParse(hour).success).toBe(true);
  expect(publicationPricingSchema.safeParse(rule).success).toBe(true);
  for (const field of ["weekday", "starts_on", "ends_on", "opens_at_minute", "closes_at_minute"]) {
    expect(publicationHoursSchema.safeParse({ ...hour, [field]: undefined }).success).toBe(false);
  }
  for (const field of ["weekday", "starts_on", "ends_on", "starts_at_minute", "ends_at_minute"]) {
    expect(publicationPricingSchema.safeParse({ ...rule, [field]: undefined }).success).toBe(false);
  }
});
