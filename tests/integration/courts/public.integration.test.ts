import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "vitest";

import { getPublicCourtDay } from "@/lib/courts/public-calendar";
import { getDataSource } from "@/lib/db/data-source";
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
      allow_pay_at_club: false,
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
    const manager = (await getDataSource()).manager;
    const selected = locations[0], date = "2099-10-12";
    // Test privileged SQL visibility even when passed a stale discovered parent.
    const intervalIds = [randomUUID(), randomUUID(), randomUUID()];
    await manager.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at)
      VALUES($1,$4,$5,480,540,'active',NULL),($2,$4,$5,540,600,'held',clock_timestamp()+interval '1 hour'),
      ($3,$4,$5,600,660,'released',NULL)`, [...intervalIds, courtIds[0],date]);
    const expiryId = randomUUID(); intervalIds.push(expiryId);
    await manager.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at)
      VALUES($1,$2,$3,660,720,'held',clock_timestamp()+interval '1 hour')`, [expiryId,courtIds[0],date]);
    await manager.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expiryId]);
    const { listPublicDayOccupancy } = await import("@/lib/db/repositories/reservations.repository");
    expect(await listPublicDayOccupancy(manager, selected.id, [courtIds[0]], date)).toEqual(expect.arrayContaining([
      expect.objectContaining({ starts_at_minute: 480 }), expect.objectContaining({ starts_at_minute: 540 }),
    ]));
    expect(await manager.query("SELECT status FROM public.court_reservations WHERE id=$1", [expiryId])).toEqual([{ status: "held" }]);
    for (const mutation of ["is_public=false", "is_active=false", "is_active=false,archived_at=clock_timestamp()"] ) {
      await manager.query(`UPDATE public.locations SET ${mutation} WHERE id=$1`, [selected.id]);
      expect(await listPublicDayOccupancy(manager, selected.id, [courtIds[0]], date)).toEqual([]);
      const day = await getPublicCourtDay(selected, date, date, new Date(`${date}T00:00:00Z`), anonymous);
      expect(day.times).toEqual([]);
      expect((await listPublicLocationsWithCourts(anonymous)).map((row) => row.id)).not.toContain(selected.id);
      await manager.query("UPDATE public.locations SET is_active=true,is_public=true,archived_at=NULL WHERE id=$1", [selected.id]);
    }
    await manager.query("UPDATE public.courts SET is_active=false WHERE id=$1", [courtIds[0]]);
    expect(await listPublicDayOccupancy(manager, selected.id, [courtIds[0]], date)).toEqual([]);
    await manager.query("DELETE FROM public.court_reservations WHERE id=ANY($1::uuid[])", [intervalIds]);

  } finally {
    expect((await service.from("court_reservations").delete().in("court_id", courtIds)).error).toBeNull();
    expect((await service.from("location_pricing_rules").delete().in("location_id", ids)).error).toBeNull();
    expect((await service.from("pricing_rule_sets").delete().in("location_id", ids)).error).toBeNull();
    expect((await service.from("location_opening_hours").delete().in("location_id", ids)).error).toBeNull();
    expect((await service.from("courts").delete().in("location_id", ids)).error).toBeNull();
    expect((await service.from("locations").delete().in("id", ids)).error).toBeNull();
  }
});
