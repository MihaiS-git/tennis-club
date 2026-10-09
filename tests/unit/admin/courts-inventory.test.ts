import { expect, it } from "vitest";
import type { AdminCourt } from "../../../src/lib/admin/courts";
import { courtInventorySchema, selectLocationCourts } from "../../../src/app/admin/courts/inventory";

const location = "c3000000-0000-4000-8000-000000000001";
const base: AdminCourt = {
  id: "c3000000-0000-4000-8000-000000000002", location_id: location,
  name: "Court", slug: "court", surface: "clay", environment: "outdoor",
  has_lighting: false, is_active: true,
  created_at: "2026-09-29T10:00:00Z", updated_at: "2026-09-29T10:00:00Z",
};
const courts: AdminCourt[] = [
  { ...base, id: "d", name: "Zeta", surface: "hard", environment: "indoor", has_lighting: true, is_active: false },
  { ...base, id: "b", name: "Alpha", surface: "clay" },
  { ...base, id: "a", name: "Alpha", surface: "grass" },
  { ...base, id: "c", name: "Beta", surface: "hard", environment: "outdoor", has_lighting: true },
  { ...base, id: "other", name: "Aardvark", location_id: "other" },
];
function names(input: AdminCourt[]) { return input.map((court) => court.id); }

it("defaults to name ascending with a stable ID tie break", () => {
  expect(names(selectLocationCourts(courts, location, courtInventorySchema.parse({})))).toEqual(["a", "b", "c", "d"]);
});

it("combines status, surface and environment filters", () => {
  const options = courtInventorySchema.parse({ status: "active", surface: "hard", environment: "outdoor" });
  expect(names(selectLocationCourts(courts, location, options))).toEqual(["c"]);
  expect(courtInventorySchema.parse({ status: "bad", surface: ["hard"], environment: "bad", sort: "bad", dir: "bad" }))
    .toEqual({ status: undefined, surface: undefined, environment: undefined, sort: "name", dir: "asc" });
});
