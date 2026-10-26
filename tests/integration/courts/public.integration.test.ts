import { insertOpeningHoursFixture } from "../opening-hours-fixtures";
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { z } from "zod";

import { getPublicCourtDay, listPublicLocationsToday } from "@/lib/courts/public-calendar";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { hourlyStartPreview, summarizeClubCourts } from "@/lib/courts/summary";
import { getDataSource } from "@/lib/db/data-source";
import { listPublicLocationFacts, listPublicLocationFactsForLocation } from "@/lib/db/repositories/clubs.repository";
import { isPubliclyEligible, publicationHoursSchema, publicationPricingSchema, publicationReadiness, publicationToday } from "@/lib/locations/publication";
import { addDays } from "@/lib/courts/local-time";
import { findPublicLocationWithCourts, listPublicLocationsWithCourts } from "../../../src/lib/courts/public";
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
      customer_cancellation_notice_minutes: 1440,
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
    const now = new Date();
    const query = vi.spyOn(manager, "query");
    try {
      expect(await findPublicLocationWithCourts(manager, ids[0].toUpperCase(), now)).toEqual(locations[0]);
      expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("AND l.id=$1"), [ids[0].toUpperCase(), addDays(now.toISOString().slice(0, 10), -1)]);
    } finally {
      query.mockRestore();
    }
    expect(await listPublicLocationFactsForLocation(manager, ids[0])).toEqual([expect.objectContaining({
      id: ids[0], location_opening_hours: expect.any(Array), courts: expect.any(Array),
    })]);
    expect(await listPublicLocationFacts(manager)).toEqual(expect.arrayContaining(
      [ids[0], ids[1], ids[2]].map((id) => expect.objectContaining({ id })),
    ));
    const unknownId = randomUUID();
    expect(await listPublicLocationFactsForLocation(manager, unknownId)).toEqual([]);
    for (const id of [unknownId, "unknown", ids[3], ids[4], ids[5]]) {
      expect(await findPublicLocationWithCourts(manager, id, now)).toBeNull();
    }
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
      expect(await findPublicLocationWithCourts(manager, selected.id, now)).toBeNull();
      await manager.query("UPDATE public.locations SET is_active=true,is_public=true,archived_at=NULL WHERE id=$1", [selected.id]);
    }
    await manager.query("UPDATE public.courts SET is_active=false WHERE id=$1", [courtIds[0]]);
    expect(await listPublicDayOccupancy(manager, selected.id, [courtIds[0]], date)).toEqual([]);
    await manager.query("DELETE FROM public.court_reservations WHERE id=ANY($1::uuid[])", [intervalIds]);

    await manager.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [ids[1]]);
    expect(await findPublicLocationWithCourts(manager, ids[1], now)).toBeNull();
    await manager.query("DELETE FROM public.location_pricing_rules WHERE location_id=$1", [ids[2]]);
    expect(await findPublicLocationWithCourts(manager, ids[2], now)).toBeNull();

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

test("public overview batches locations whose local dates differ at the same instant", async () => {
  const service = localFixtureClient();
  const [eastId, westId] = [randomUUID(), randomUUID()], [eastCourt, westCourt] = [randomUUID(), randomUUID()];
  const ruleSetIds = [randomUUID(), randomUUID()];
  // 22:30 UTC: Thursday 2099-10-15 (weekday 3) in Bucharest, still Wednesday 2099-10-14 (weekday 2) in Los Angeles.
  const instant = new Date("2099-10-14T22:30:00Z");
  try {
    expect((await service.from("locations").insert([[eastId, "Europe/Bucharest"], [westId, "America/Los_Angeles"]].map(([id, timezone]) => ({
      id, name: `Batch ${timezone}`, slug: `test-${id}`, timezone, currency: "EUR", is_public: true, is_active: true,
    })))).error).toBeNull();
    expect((await service.from("courts").insert([[eastCourt, eastId], [westCourt, westId]].map(([id, location_id]) => ({
      id, location_id, slug: `test-${id}`, name: "Court", surface: "clay", environment: "outdoor", is_active: true,
    })))).error).toBeNull();
    expect((await insertOpeningHoursFixture(service, [
      { location_id: eastId, weekday: 3, opens_at_minute: 480, closes_at_minute: 600 },
      { location_id: eastId, weekday: 2, opens_at_minute: 0, closes_at_minute: 1440 },
      { location_id: westId, weekday: 2, opens_at_minute: 660, closes_at_minute: 780 },
      { location_id: westId, weekday: 3, opens_at_minute: 0, closes_at_minute: 1440 },
    ])).error).toBeNull();
    expect((await service.from("pricing_rule_sets").insert([eastId, westId].map((location_id, index) => ({
      id: ruleSetIds[index], location_id,
    })))).error).toBeNull();
    expect((await service.from("location_pricing_rules").insert(([
      [0, 3, "outdoor", 5000], [0, 3, "covered", 7000], [0, 2, "outdoor", 100], [0, 2, "covered", 150],
      [1, 2, "outdoor", 6000], [1, 2, "covered", 9000], [1, 3, "outdoor", 1], [1, 3, "covered", 2],
    ] as const).map(([index, weekday, court_state, price_per_hour_minor]) => ({
      location_id: [eastId, westId][index], court_id: [eastCourt, westCourt][index], rule_set_id: ruleSetIds[index],
      court_state, weekday, starts_at_minute: 0, ends_at_minute: 1440, price_per_hour_minor,
    })))).error).toBeNull();
    // Coverage of the Bucharest date only: applies to the east court, not yet to the west court.
    expect((await service.from("court_coverage_periods").insert([eastCourt, westCourt].map((court_id) => ({
      court_id, starts_on: "2099-10-15", ends_on: "2099-10-15",
    })))).error).toBeNull();

    const queryLog = vi.spyOn((await getDataSource()).logger, "logQuery");
    let overview;
    try {
      overview = await listPublicLocationsToday(instant);
      expect(queryLog).toHaveBeenCalledTimes(4);
    } finally { queryLog.mockRestore(); }
    const east = overview.find((row) => row.id === eastId), west = overview.find((row) => row.id === westId);
    expect(east).toMatchObject({ openingHours: [{ opens_at_minute: 480, closes_at_minute: 600 }], startingRateMinor: 7000 });
    expect(west).toMatchObject({ openingHours: [{ opens_at_minute: 660, closes_at_minute: 780 }], startingRateMinor: 6000 });

    const eastDay = await getPublicCourtDay(east!, "2099-10-15", "2099-10-15", instant);
    expect(eastDay.times).toEqual([480, 510, 540, 570]);
    expect(eastDay.courts[0].cells).toEqual(Array(4).fill("available"));
    expect(eastDay.courts[0].rates).toEqual(Array(4).fill(7000));
    const westDay = await getPublicCourtDay(west!, "2099-10-14", "2099-10-14", instant);
    expect(westDay.times).toEqual([660, 690, 720, 750]);
    expect(westDay.courts[0].cells).toEqual(Array(4).fill("past")); // 15:30 local in Los Angeles.
    expect(westDay.courts[0].rates).toEqual(Array(4).fill(6000));
  } finally {
    expect((await service.from("court_coverage_periods").delete().in("court_id", [eastCourt, westCourt])).error).toBeNull();
    expect((await service.from("location_pricing_rules").delete().in("location_id", [eastId, westId])).error).toBeNull();
    expect((await service.from("pricing_rule_sets").delete().in("location_id", [eastId, westId])).error).toBeNull();
    expect((await service.from("location_opening_hours").delete().in("location_id", [eastId, westId])).error).toBeNull();
    expect((await service.from("opening_hours_schedules").delete().in("location_id", [eastId, westId])).error).toBeNull();
    expect((await service.from("courts").delete().in("location_id", [eastId, westId])).error).toBeNull();
    expect((await service.from("locations").delete().in("id", [eastId, westId])).error).toBeNull();
  }
});

test("public facts prune expired history without changing local-date readiness or future schedules", async () => {
  const source = await getDataSource(), runner = source.createQueryRunner();
  await runner.startTransaction();
  const manager = runner.manager;
  const periods = [
    { start: "2016-01-01", end: "2026-10-12", opens: 420 },
    { start: "2026-10-13", end: "2026-10-13", opens: 450 },
    { start: "2026-10-14", end: "2026-10-15", opens: 480 },
    { start: "2026-10-16", end: null, opens: 600 },
  ];
  const fixtures = [
    { id: randomUUID(), timezone: "Europe/Bucharest", periods, pricing: "dated" },
    { id: randomUUID(), timezone: "America/Los_Angeles", periods, pricing: "unbounded" },
    { id: randomUUID(), timezone: "Pacific/Kiritimati", periods: periods.slice(3), pricing: "dated" },
    { id: randomUUID(), timezone: "Pacific/Pago_Pago", periods, pricing: "dated" },
    { id: randomUUID(), timezone: "UTC", periods: periods.slice(0, 1), pricing: "dated" },
    { id: randomUUID(), timezone: "Europe/Bucharest", periods, pricing: "missing" },
    { id: randomUUID(), timezone: "Invalid/Timezone", periods, pricing: "dated" },
  ];
  const factsSchema = z.array(z.object({
    id: z.uuid(), name: z.string(), slug: z.string(), timezone: z.string(), currency: z.string(),
    is_active: z.boolean(), is_public: z.boolean(), archived_at: z.string().nullable(),
    location_opening_hours: z.array(publicationHoursSchema),
    courts: z.array(z.object({ id: z.uuid(), environment: z.enum(["indoor", "outdoor"]),
      location_pricing_rules: z.array(publicationPricingSchema) })),
  }));
  try {
    for (const fixture of fixtures) {
      await manager.query(`INSERT INTO public.locations(id,name,slug,timezone,is_public)
        VALUES($1,'History boundary',$2,$3,true)`, [fixture.id, fixture.id, fixture.timezone]);
      await manager.query(`INSERT INTO public.courts(location_id,name,slug,surface,environment,is_active)
        SELECT $1,'Court '||n,'court-'||n,'clay',CASE WHEN n=2 THEN 'indoor' ELSE 'outdoor' END,n<3
        FROM generate_series(1,3) n`, [fixture.id]);
      const ruleSetId = randomUUID();
      await manager.query("INSERT INTO public.pricing_rule_sets(id,location_id) VALUES($1,$2)", [ruleSetId, fixture.id]);
      for (const period of fixture.periods) {
        const scheduleId = randomUUID();
        await manager.query(`INSERT INTO public.opening_hours_schedules(id,location_id,starts_on,ends_on)
          VALUES($1,$2,$3,$4)`, [scheduleId, fixture.id, period.start, period.end]);
        await manager.query(`INSERT INTO public.location_opening_hours(location_id,schedule_id,weekday,opens_at_minute,closes_at_minute)
          SELECT $1,$2,day,$3,1200 FROM generate_series(0,6) day`, [fixture.id, scheduleId, period.opens]);
        if (fixture.pricing !== "dated") continue;
        await manager.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,
          weekday,starts_at_minute,ends_at_minute,price_per_hour_minor,starts_on,ends_on)
          SELECT c.location_id,$2,c.id,c.environment,day,$3,1200,5000,$4,$5
          FROM public.courts c CROSS JOIN generate_series(0,6) day WHERE c.location_id=$1 AND c.is_active`,
        [fixture.id, ruleSetId, period.opens, period.start, period.end]);
      }
      if (fixture.pricing === "unbounded") {
        await manager.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,
          weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
          SELECT c.location_id,$2,c.id,c.environment,day,0,1440,5000
          FROM public.courts c CROSS JOIN generate_series(0,6) day WHERE c.location_id=$1 AND c.is_active`, [fixture.id, ruleSetId]);
      }
    }
    const fixtureIds = new Set<string>(fixtures.map(row => row.id));
    // This earlier reference includes every fixture period, matching the old unscoped projection.
    const full = factsSchema.parse(await listPublicLocationFacts(manager, new Date("2009-01-01T00:00:00Z")))
      .filter(row => fixtureIds.has(row.id));
    const instant = new Date("2026-10-14T22:30:00Z");
    const queries = vi.spyOn(source.logger, "logQuery");
    let current;
    try {
      current = factsSchema.parse(await listPublicLocationFacts(manager, instant)).filter(row => fixtureIds.has(row.id));
      expect(queries).toHaveBeenCalledTimes(1);
    } finally { queries.mockRestore(); }
    const east = current.find(row => row.id === fixtures[0].id)!;
    expect(east.courts).toHaveLength(2); // The inactive court never affects readiness.
    expect(east.location_opening_hours).toHaveLength(21);
    expect(east.location_opening_hours.some(hour => hour.ends_on === "2026-10-12")).toBe(false);
    expect(east.location_opening_hours.some(hour => hour.ends_on === "2026-10-13")).toBe(true); // Inclusive date guard.
    expect(east.courts.every(court => court.location_pricing_rules.length === 21)).toBe(true);
    expect(await manager.query("SELECT count(*)::integer AS count FROM public.location_opening_hours WHERE location_id=$1", [east.id]))
      .toEqual([{ count: 28 }]); // Historical records remain stored.
    expect(await manager.query("SELECT count(*)::integer AS count FROM public.location_pricing_rules WHERE location_id=$1", [east.id]))
      .toEqual([{ count: 56 }]);
    for (const time of [new Date("2026-10-14T00:00:00Z"), instant, new Date("2026-10-15T20:59:59Z"), new Date("2026-10-15T21:00:00Z"),
      new Date("2026-10-16T07:00:00Z"), new Date("2026-10-25T01:30:00Z"), new Date("2030-06-01T12:00:00Z")]) {
      for (const original of full) {
        const [scoped] = factsSchema.parse(await listPublicLocationFactsForLocation(manager, original.id, time));
        const today = publicationToday(original.timezone, time);
        expect(publicationReadiness(scoped, today)).toEqual(publicationReadiness(original, today));
        // Discovery today and the visitor's coming week, including a scheduled transition.
        for (let offset = 0; offset < 7; offset++) {
          const date = addDays(today, offset);
          const effective = (location: typeof original) => location.location_opening_hours
            .filter(hour => hour.weekday === mondayWeekday(date) && hour.starts_on <= date && (!hour.ends_on || hour.ends_on >= date))
            .map(hour => [hour.opens_at_minute, hour.closes_at_minute]).sort((a, b) => a[0] - b[0]);
          expect(effective(scoped)).toEqual(effective(original));
        }
        const projected = await findPublicLocationWithCourts(manager, original.id, time);
        expect(projected !== null).toBe(isPubliclyEligible(original, today));
        if (projected) {
          expect(projected.todayOpeningHours).toEqual(original.location_opening_hours
            .filter(hour => hour.weekday === mondayWeekday(today) && hour.starts_on <= today && (!hour.ends_on || hour.ends_on >= today))
            .map(({ opens_at_minute, closes_at_minute }) => ({ opens_at_minute, closes_at_minute }))
            .sort((a, b) => a.opens_at_minute - b.opens_at_minute));
        }
      }
    }
    expect((await findPublicLocationWithCourts(manager, fixtures[0].id, instant))?.todayOpeningHours)
      .toEqual([{ opens_at_minute: 480, closes_at_minute: 1200 }]);
    expect((await findPublicLocationWithCourts(manager, fixtures[1].id, instant))?.todayOpeningHours)
      .toEqual([{ opens_at_minute: 480, closes_at_minute: 1200 }]);
    expect((await findPublicLocationWithCourts(manager, fixtures[2].id, instant))?.todayOpeningHours).toEqual([]);
    expect((await findPublicLocationWithCourts(manager, fixtures[3].id, new Date("2026-10-14T00:00:00Z")))?.todayOpeningHours)
      .toEqual([{ opens_at_minute: 450, closes_at_minute: 1200 }]);
    expect(await findPublicLocationWithCourts(manager, fixtures[4].id, instant)).toBeNull();
    expect(await findPublicLocationWithCourts(manager, fixtures[5].id, instant)).toBeNull();
    expect(await findPublicLocationWithCourts(manager, fixtures[6].id, instant)).toBeNull();
  } finally { await runner.rollbackTransaction(); await runner.release(); }
});
