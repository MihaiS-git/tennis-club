import { beforeEach, expect, it, vi } from "vitest";

const facts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: {} }) }));
vi.mock("@/lib/db/repositories/clubs.repository", () => ({ listPublicLocationFacts: facts }));

import { listPublicLocationsWithCourts } from "@/lib/courts/public";

const hour = (weekday: number, opens: number, closes: number, starts_on: string, ends_on: string | null) => ({
  id: crypto.randomUUID(), weekday, opens_at_minute: opens, closes_at_minute: closes, starts_on, ends_on,
});
const price = (weekday: number) => ({ court_state: "outdoor", weekday, starts_on: null, ends_on: null, starts_at_minute: 0, ends_at_minute: 1440 });
const location = (timezone: string, hours: ReturnType<typeof hour>[]) => ({
  id: crypto.randomUUID(), name: "Club", slug: "club", address_line1: null, address_line2: null, city: null, postal_code: null,
  country_code: null, timezone, currency: "RON", allow_pay_at_club: false, is_active: true, is_public: true, archived_at: null,
  location_opening_hours: hours,
  courts: [{ id: crypto.randomUUID(), name: "Court", slug: "court", surface: "clay", environment: "outdoor", has_lighting: false, is_active: true,
    location_pricing_rules: [0, 1, 2, 3, 4, 5, 6].map(price) }],
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T22:30:00Z"));
});

it("resolves today's opening hours from the effective schedule in each location's timezone", async () => {
  const hours = [
    hour(3, 780, 1200, "2026-01-01", "2026-10-15"), hour(3, 480, 720, "2026-01-01", "2026-10-15"),
    hour(2, 420, 1320, "2026-01-01", "2026-10-15"), hour(3, 600, 900, "2026-10-16", null), hour(2, 600, 900, "2026-10-16", null),
  ];
  facts.mockResolvedValue([location("Europe/Bucharest", hours), location("America/Los_Angeles", hours)]);
  const [east, west] = await listPublicLocationsWithCourts();
  // Bucharest is already Thursday 2026-10-15; Los Angeles is still Wednesday 2026-10-14.
  expect(east.todayOpeningHours).toEqual([{ opens_at_minute: 480, closes_at_minute: 720 }, { opens_at_minute: 780, closes_at_minute: 1200 }]);
  expect(west.todayOpeningHours).toEqual([{ opens_at_minute: 420, closes_at_minute: 1320 }]);
});

it("reports no hours on a weekday without configured intervals", async () => {
  facts.mockResolvedValue([location("Europe/Bucharest", [hour(2, 480, 1200, "2026-01-01", null)])]);
  expect((await listPublicLocationsWithCourts())[0].todayOpeningHours).toEqual([]);
});
