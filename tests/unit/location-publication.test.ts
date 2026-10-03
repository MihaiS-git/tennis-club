import { expect, it } from "vitest";
import { isPubliclyEligible, isStructurallyReady, publicationReadiness, type PublicationConfiguration } from "@/lib/locations/publication";

const ready: PublicationConfiguration = {
  name: "RIVUS", slug: "rivus", timezone: "Europe/Bucharest", currency: "RON",
  is_active: true, is_public: true, archived_at: null,
  location_opening_hours: [{ id: "hours" }],
  courts: [{ id: "court", environment: "outdoor", location_pricing_rules: [{ court_state: "outdoor", ends_on: null }] }],
};
const today = "2026-10-02";

it("exposes a published, active, configured location", () => {
  expect(publicationReadiness(ready, today)).toEqual([]);
  expect(isPubliclyEligible(ready, today)).toBe(true);
});

it.each([
  ["private", { is_public: false }],
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
  expect(publicationReadiness({ ...ready, courts: [{ ...ready.courts[0], location_pricing_rules: [{ court_state: "outdoor", ends_on: "2026-10-01" }] }] }, today))
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

it("omits an incomplete Central Club-style location from both option lists", () => {
  const central = { ...ready, name: "Central Club", is_public: false,
    courts: [{ ...ready.courts[0], location_pricing_rules: [] }] };
  const candidates = [ready, central];
  expect(candidates.filter((location) => isStructurallyReady(location, today)).map((location) => location.name)).toEqual(["RIVUS"]);
  expect(candidates.filter((location) => isPubliclyEligible(location, today)).map((location) => location.name)).toEqual(["RIVUS"]);
});
