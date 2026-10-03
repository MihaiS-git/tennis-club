import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "vitest";

import { listPublicLocationsWithCourts } from "../../../src/lib/courts/public";
import { localFixtureClient } from "../auth-fixtures";

test("public discovery includes only published, configured locations and orders their courts", async () => {
  const service = localFixtureClient();
  const ids: string[] = Array.from({ length: 6 }, () => randomUUID());
  const courtIds: string[] = Array.from({ length: 9 }, () => randomUUID());
  const anonymous = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  try {
    expect((await service.from("locations").insert(ids.map((id, index) => ({
      id, slug: `test-${id}`, name: ["Zulu", "Beta", "Alpha", "Empty", "Hidden", "Only inactive"][index],
      timezone: "Europe/Bucharest", display_order: index === 0 ? 0 : 1, is_active: index !== 4,
      is_public: index !== 3,
    })))).error).toBeNull();
    expect((await service.from("courts").insert(courtIds.map((id, index) => ({
      id, location_id: [ids[0], ids[0], ids[0], ids[0], ids[0], ids[4], ids[1], ids[2], ids[5]][index], slug: `test-${id}`,
      name: ["Zulu", "Beta", "Alpha", "Alpha", "Inactive", "Hidden by location", "Beta court", "Alpha court", "Inactive only"][index],
      surface: "clay", environment: index === 2 ? "indoor" : "outdoor",
      is_active: index !== 4 && index !== 8,
    })))).error).toBeNull();

    expect((await service.from("location_opening_hours").insert([0, 1, 2, 5].map((index) => ({
      location_id: ids[index], weekday: 0, opens_at_minute: 480, closes_at_minute: 1200,
    })))).error).toBeNull();
    const ruleSetIds = [0, 1, 2].map(() => randomUUID());
    expect((await service.from("pricing_rule_sets").insert(ruleSetIds.map((id, index) => ({
      id, location_id: ids[index],
    })))).error).toBeNull();
    expect((await service.from("location_pricing_rules").insert([0, 1, 2, 3, 6, 7].map((index) => ({
      location_id: index < 4 ? ids[0] : index === 6 ? ids[1] : ids[2],
      rule_set_id: index < 4 ? ruleSetIds[0] : index === 6 ? ruleSetIds[1] : ruleSetIds[2],
      court_id: courtIds[index], court_state: index === 2 ? "indoor" : "outdoor",
      weekday: 0, starts_at_minute: 480, ends_at_minute: 1200, price_per_hour_minor: 5000,
    })))).error).toBeNull();

    const read = await listPublicLocationsWithCourts(anonymous);
    const locations = read.filter((location) => ids.includes(location.id));
    expect(locations.map((location) => location.id)).toEqual([ids[0], ids[2], ids[1]]);
    expect(locations[0].courts.map((court) => court.id)).toEqual([
      ...[courtIds[2], courtIds[3]].sort(), courtIds[1], courtIds[0],
    ]);
    expect(locations.slice(1).map((location) => location.courts.map((court) => court.id))).toEqual([[courtIds[7]], [courtIds[6]]]);
    expect(locations[0]).toEqual({
      id: ids[0], name: "Zulu", slug: `test-${ids[0]}`, timezone: "Europe/Bucharest",
      address_line1: null, address_line2: null, city: null, postal_code: null, country_code: null, currency: "EUR",
      courts: locations[0].courts,
    });
    const firstAlphaId = [courtIds[2], courtIds[3]].sort()[0];
    expect(locations[0].courts[0]).toEqual({
      id: firstAlphaId, name: "Alpha", slug: `test-${firstAlphaId}`, surface: "clay",
      environment: firstAlphaId === courtIds[2] ? "indoor" : "outdoor", has_lighting: false,
    });
    expect(locations[0].courts.find((court) => court.id === courtIds[1])).toMatchObject({
      environment: "outdoor",
    });
    expect(locations[0].courts.find((court) => court.id === courtIds[2])).toMatchObject({
      environment: "indoor",
    });
    expect(locations[1].courts[0]).toMatchObject({
      environment: "outdoor",
    });
    for (const location of locations) for (const court of location.courts) {
      expect(court).not.toHaveProperty("supports_balloon");
      expect(court).not.toHaveProperty("balloon_installed");
    }
    expect(await listPublicLocationsWithCourts(anonymous)).toEqual(read);
  } finally {
    expect((await service.from("location_pricing_rules").delete().in("location_id", ids)).error).toBeNull();
    expect((await service.from("pricing_rule_sets").delete().in("location_id", ids)).error).toBeNull();
    expect((await service.from("location_opening_hours").delete().in("location_id", ids)).error).toBeNull();
    expect((await service.from("courts").delete().in("location_id", ids)).error).toBeNull();
    expect((await service.from("locations").delete().in("id", ids)).error).toBeNull();
  }
});
