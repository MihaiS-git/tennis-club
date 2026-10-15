import { insertOpeningHoursFixture } from "../opening-hours-fixtures";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";

import { getPublicCourtDay, listPublicLocationsToday } from "@/lib/courts/public-calendar";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { hourlyStartPreview, summarizeClubCourts } from "@/lib/courts/summary";
import { getDataSource } from "@/lib/db/data-source";
import { publicationToday } from "@/lib/locations/publication";
import { listPublicLocationsWithCourts } from "../../../src/lib/courts/public";
import { localFixtureClient } from "../auth-fixtures";

test("public discovery includes only published, configured locations and orders their courts", async () => {
  const service = localFixtureClient();
  const ids: string[] = Array.from({ length: 6 }, () => randomUUID());
  const courtIds: string[] = Array.from({ length: 9 }, () => randomUUID());
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

    expect((await insertOpeningHoursFixture(service, [0, 1, 2, 5].map((index) => ({
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

    const read = await listPublicLocationsWithCourts();
    const locations = read.filter((location) => ids.includes(location.id));
    expect(locations.map((location) => location.id)).toEqual([ids[0], ids[2], ids[1]]);
    expect(locations[0].courts.map((court) => court.id)).toEqual([
      ...[courtIds[2], courtIds[3]].sort(), courtIds[1], courtIds[0],
    ]);
    expect(locations.slice(1).map((location) => location.courts.map((court) => court.id))).toEqual([[courtIds[7]], [courtIds[6]]]);
    expect(summarizeClubCourts(locations)).toEqual({ locationCount: 3, courtCount: 6,
      surfaces: [{ surface: "clay", count: 6 }] });
    expect(locations[0]).toEqual({
      id: ids[0], name: "Zulu", slug: `test-${ids[0]}`, timezone: "Europe/Bucharest",
      address_line1: null, address_line2: null, city: null, postal_code: null, country_code: null, currency: "EUR",
      allow_pay_at_club: false,
      courts: locations[0].courts,
      todayOpeningHours: mondayWeekday(publicationToday("Europe/Bucharest")) === 0
        ? [{ opens_at_minute: 480, closes_at_minute: 1200 }] : [],
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
    expect(await listPublicLocationsWithCourts()).toEqual(read);
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
    const occupancy = await listPublicDayOccupancy(manager, selected.id, [courtIds[0]], date);
    expect(occupancy).toEqual(expect.arrayContaining([
      { court_id: courtIds[0], booking_date: date, starts_at_minute: 480, ends_at_minute: 540 },
      { court_id: courtIds[0], booking_date: date, starts_at_minute: 540, ends_at_minute: 600 },
    ]));
    expect(occupancy).toHaveLength(2); // Released rows and expired holds must be absent.
    const preview = hourlyStartPreview(await getPublicCourtDay(selected, date, date, new Date(`${date}T00:00:00Z`)));
    expect(preview.courts.find(({ court }) => court.id === courtIds[0])?.starts).toEqual([600, 630, 660]);
    expect(await manager.query("SELECT status FROM public.court_reservations WHERE id=$1", [expiryId])).toEqual([{ status: "held" }]);
    for (const mutation of ["is_public=false", "is_active=false", "is_active=false,archived_at=clock_timestamp()"] ) {
      await manager.query(`UPDATE public.locations SET ${mutation} WHERE id=$1`, [selected.id]);
      expect(await listPublicDayOccupancy(manager, selected.id, [courtIds[0]], date)).toEqual([]);
      const day = await getPublicCourtDay(selected, date, date, new Date(`${date}T00:00:00Z`));
      expect(day.times).toEqual([]);
      expect((await listPublicLocationsWithCourts()).map((row) => row.id)).not.toContain(selected.id);
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

test("public overview isolates effective schedules and prices, including closed dates and covered-state fallback", async () => {
  const service = localFixtureClient();
  const locationId = randomUUID(), courtId = randomUUID(), ruleSetId = randomUUID();
  const scheduleIds = [randomUUID(), randomUUID(), randomUUID()];
  const weekday = mondayWeekday("2099-10-15");
  try {
    expect((await service.from("locations").insert({ id: locationId, name: "Overview validation", slug: `test-${locationId}`,
      timezone: "Europe/Bucharest", currency: "RON", is_public: true, is_active: true })).error).toBeNull();
    expect((await service.from("courts").insert({ id: courtId, location_id: locationId, slug: `test-${courtId}`,
      name: "Covered clay", surface: "clay", environment: "outdoor", is_active: true, has_lighting: true })).error).toBeNull();
    expect((await service.from("opening_hours_schedules").insert(scheduleIds.map((id, index) => ({
      id, location_id: locationId, starts_on: ["2099-10-01", "2099-10-15", "2099-10-22"][index],
      ends_on: ["2099-10-14", "2099-10-21", "2099-10-28"][index],
    })))).error).toBeNull();
    expect((await insertOpeningHoursFixture(service, [
      { schedule_id: scheduleIds[0], opens_at_minute: 0, closes_at_minute: 1440 },
      { schedule_id: scheduleIds[1], opens_at_minute: 660, closes_at_minute: 780 },
      { schedule_id: scheduleIds[1], opens_at_minute: 480, closes_at_minute: 600 },
      { schedule_id: scheduleIds[2], opens_at_minute: 0, closes_at_minute: 1440 },
    ].map((row) => ({ ...row, location_id: locationId, weekday })))).error).toBeNull();
    expect((await service.from("pricing_rule_sets").insert({ id: ruleSetId, location_id: locationId })).error).toBeNull();
    expect((await service.from("location_pricing_rules").insert([
      { starts_on: "2099-10-01", ends_on: "2099-10-14", starts_at_minute: 0, ends_at_minute: 1440, price_per_hour_minor: 100 },
      { starts_on: "2099-10-22", ends_on: "2099-10-28", starts_at_minute: 0, ends_at_minute: 1440, price_per_hour_minor: 200 },
      { starts_on: "2099-10-15", ends_on: "2099-10-21", starts_at_minute: 0, ends_at_minute: 1440, price_per_hour_minor: 5000 },
      ...[[0, 480, 1], [480, 600, 7000], [600, 660, 2], [660, 780, 9000], [780, 1440, 3]].map(([start, end, amount]) => ({
        starts_on: "2099-10-15", ends_on: "2099-10-21", court_state: "covered",
        starts_at_minute: start, ends_at_minute: end, price_per_hour_minor: amount,
      })),
    ].map((row) => ({ court_state: "outdoor", ...row, court_id: courtId, location_id: locationId, rule_set_id: ruleSetId, weekday })))).error).toBeNull();
    expect((await service.from("court_coverage_periods").insert({ court_id: courtId, starts_on: "2099-10-15", ends_on: "2099-10-21" })).error).toBeNull();

    const overview = async (instant: string) => (await listPublicLocationsToday(new Date(instant))).find((row) => row.id === locationId);
    // UTC Wednesday is already Thursday locally: the new schedule applies on its inclusive first date.
    expect(await overview("2099-10-14T22:30:00Z")).toMatchObject({
      openingHours: [{ opens_at_minute: 480, closes_at_minute: 600 }, { opens_at_minute: 660, closes_at_minute: 780 }],
      startingRateMinor: 7000, courts: [{ id: courtId, has_lighting: true, surface: "clay", environment: "outdoor" }],
    });
    expect(await overview("2099-10-08T09:00:00Z")).toMatchObject({
      openingHours: [{ opens_at_minute: 0, closes_at_minute: 1440 }], startingRateMinor: 100,
    });
    expect(await overview("2099-10-22T09:00:00Z")).toMatchObject({
      openingHours: [{ opens_at_minute: 0, closes_at_minute: 1440 }], startingRateMinor: 200,
    });
    for (const date of ["2099-10-16", "2099-10-29"]) {
      expect(await overview(`${date}T09:00:00Z`)).toMatchObject({ openingHours: [], startingRateMinor: null });
    }
    // Base-state readiness permits publication; missing today's covered price uses the overview fallback.
    expect((await service.from("location_pricing_rules").delete().eq("location_id", locationId).eq("court_state", "covered")).error).toBeNull();
    expect(await overview("2099-10-15T09:00:00Z")).toMatchObject({ startingRateMinor: null });
  } finally {
    expect((await service.from("court_coverage_periods").delete().eq("court_id", courtId)).error).toBeNull();
    expect((await service.from("location_pricing_rules").delete().eq("location_id", locationId)).error).toBeNull();
    expect((await service.from("pricing_rule_sets").delete().eq("location_id", locationId)).error).toBeNull();
    expect((await service.from("location_opening_hours").delete().eq("location_id", locationId)).error).toBeNull();
    expect((await service.from("opening_hours_schedules").delete().eq("location_id", locationId)).error).toBeNull();
    expect((await service.from("courts").delete().eq("location_id", locationId)).error).toBeNull();
    expect((await service.from("locations").delete().eq("id", locationId)).error).toBeNull();
  }
});
