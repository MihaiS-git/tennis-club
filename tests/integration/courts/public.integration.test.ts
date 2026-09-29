import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "vitest";

import { listActiveLocationsWithCourts } from "../../../src/lib/courts/public";
import { localFixtureClient } from "../auth-fixtures";

test("public discovery excludes inactive resources and locations without active courts and orders locations and courts", async () => {
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
    })))).error).toBeNull();
    expect((await service.from("courts").insert(courtIds.map((id, index) => ({
      id, location_id: [ids[0], ids[0], ids[0], ids[0], ids[0], ids[4], ids[1], ids[2], ids[5]][index], slug: `test-${id}`,
      name: ["Zulu", "Beta", "Alpha", "Alpha", "Inactive", "Hidden by location", "Beta court", "Alpha court", "Inactive only"][index],
      surface: "clay", environment: index === 2 ? "indoor" : "outdoor", display_order: index === 0 ? 0 : 1,
      supports_balloon: index === 0 || index === 1, balloon_installed: index === 0,
      is_active: index !== 4 && index !== 8,
    })))).error).toBeNull();

    const read = await listActiveLocationsWithCourts(anonymous);
    const locations = read.filter((location) => ids.includes(location.id));
    expect(locations.map((location) => location.id)).toEqual([ids[0], ids[2], ids[1]]);
    expect(locations[0].courts.map((court) => court.id)).toEqual([
      courtIds[0], ...[courtIds[2], courtIds[3]].sort(), courtIds[1],
    ]);
    expect(locations.slice(1).map((location) => location.courts.map((court) => court.id))).toEqual([[courtIds[7]], [courtIds[6]]]);
    expect(locations[0]).toEqual({
      id: ids[0], name: "Zulu", slug: `test-${ids[0]}`, timezone: "Europe/Bucharest",
      address_line1: null, address_line2: null, city: null, postal_code: null, country_code: null,
      courts: locations[0].courts,
    });
    expect(locations[0].courts[0]).toEqual({
      id: courtIds[0], name: "Zulu", slug: `test-${courtIds[0]}`, surface: "clay",
      environment: "outdoor", supports_balloon: true, balloon_installed: true, has_lighting: false,
    });
    expect(locations[0].courts.find((court) => court.id === courtIds[1])).toMatchObject({
      environment: "outdoor", supports_balloon: true, balloon_installed: false,
    });
    expect(locations[0].courts.find((court) => court.id === courtIds[2])).toMatchObject({
      environment: "indoor", supports_balloon: false, balloon_installed: false,
    });
    expect(locations[1].courts[0]).toMatchObject({
      environment: "outdoor", supports_balloon: false, balloon_installed: false,
    });
    expect(await listActiveLocationsWithCourts(anonymous)).toEqual(read);
  } finally {
    expect((await service.from("courts").delete().in("location_id", ids)).error).toBeNull();
    expect((await service.from("locations").delete().in("id", ids)).error).toBeNull();
  }
});
