import { cleanupBookingFixtures } from "../checkout-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, assert, expect, test, vi } from "vitest";
import type { QueryRunner } from "typeorm";
import { z } from "zod";
import { listAdminLocationOpeningHours, mutateAdminOpeningHours } from "../../../src/lib/admin/opening-hours";
import { saveAdminPricingRule } from "../../../src/lib/admin/pricing";
import { getDataSource } from "../../../src/lib/db/data-source";
import * as clubs from "../../../src/lib/db/repositories/clubs.repository";
import { listAdminPricingRules } from "../../../src/lib/admin/pricing";
import { listAdminLocationsWithReadiness } from "../../../src/lib/admin/locations";
import { localToday } from "../../../src/lib/courts/local-time";
import { mondayWeekday } from "../../../src/lib/pricing/resolution";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

beforeAll(() => { vi.stubEnv("DATABASE_POOL_MAX", "6"); });
afterAll(async () => {
  await (await getDataSource()).destroy();
  vi.unstubAllEnvs();
});

function scheduleUpdate(result: Awaited<ReturnType<typeof mutateAdminOpeningHours>>) {
  assert.ok(result.ok);
  const schedule = result.schedules?.find((row) => row.id === result.scheduleId);
  assert.ok(schedule);
  return { operation: "update" as const, schedule_id: schedule.id, revision: schedule.revision };
}

test("weekly opening hours create, conflict rollback, grouped replace/remove, and authorization", async () => {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const userIds: string[] = [];
  const locationIds: string[] = [];
  const password = "opening-hours-integration-password-123";
  const publicClient = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  async function account(admin = false) {
    const email = `hours-${randomUUID()}@example.test`;
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(error, null); assert.ok(data.user); userIds.push(data.user.id);
    if (admin) assert.strictEqual((await service.from("user_roles").insert({ user_id: data.user.id, role_code: "admin" })).error, null);
    const client = publicClient();
    assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
    return client;
  }
  try {
    const admin = await account(true);
    const member = await account();
    const location = await service.from("locations").insert({ name: "Opening hours fixture", slug: `hours-${randomUUID()}`, timezone: "Europe/Bucharest" }).select("id").single();
    assert.strictEqual(location.error, null); assert.ok(location.data); locationIds.push(location.data.id);
    const location_id = location.data.id;
    const days = [0, 1, 2, 3, 4];
    const created = await mutateAdminOpeningHours({ operation: "create", starts_on: "0001-01-01", location_id, replace_ids: [], rows: [{ weekdays: days, opens_at: "07:00", closes_at: "24:00" }] }, admin);
    assert.ok(created.ok);
    expect(created.intervals.map((row) => row.weekday)).toEqual(days);
    expect(created.intervals.every((row) => row.opens_at_minute === 420 && row.closes_at_minute === 1440)).toBe(true);

    const conflict = await mutateAdminOpeningHours({ ...scheduleUpdate(created), location_id, replace_ids: [], rows: [{ weekdays: [1, 5], opens_at: "08:00", closes_at: "12:00" }] }, admin);
    expect(conflict).toEqual({ ok: false, reason: "overlap", weekdays: [1] });
    expect((await listAdminLocationOpeningHours(location_id, admin)).filter((row) => row.location_id === location_id && row.weekday === 5)).toEqual([]);

    const edited = await mutateAdminOpeningHours({ ...scheduleUpdate(created), location_id, replace_ids: created.intervals.map((row) => row.id),
      rows: [{ weekdays: days, opens_at: "07:00", closes_at: "12:00" }, { weekdays: days, opens_at: "12:00", closes_at: "20:00" }] }, admin);
    assert.ok(edited.ok);
    expect(edited.intervals).toHaveLength(10);
    for (const day of days) expect(edited.intervals.filter((row) => row.weekday === day).map((row) => [row.opens_at_minute, row.closes_at_minute]))
      .toEqual([[420, 720], [720, 1200]]);

    const blockedEdit = await mutateAdminOpeningHours({ ...scheduleUpdate(edited), location_id,
      replace_ids: edited.intervals.filter((row) => row.opens_at_minute === 420).map((row) => row.id),
      rows: [{ weekdays: days, opens_at: "07:00", closes_at: "13:00" }] }, admin);
    expect(blockedEdit).toEqual({ ok: false, reason: "overlap", weekdays: days });
    expect((await listAdminLocationOpeningHours(location_id, admin)).filter((row) => row.location_id === location_id && row.opens_at_minute === 420)
      .every((row) => row.closes_at_minute === 720)).toBe(true);

    const removed = await mutateAdminOpeningHours({ ...scheduleUpdate(edited), location_id,
      replace_ids: edited.intervals.filter((row) => row.opens_at_minute === 720).map((row) => row.id), rows: [] }, admin);
    assert.ok(removed.ok);
    expect(removed.intervals).toHaveLength(5);
    expect(removed.intervals.every((row) => row.closes_at_minute === 720)).toBe(true);

    expect(await listAdminLocationOpeningHours(location_id, admin)).toEqual(removed.intervals);
    const change = { ...scheduleUpdate(removed), location_id, replace_ids: [], rows: [{ weekdays: [6], opens_at: "08:00", closes_at: "22:00" }] };
    expect(await mutateAdminOpeningHours({ ...change, replace_ids: [randomUUID()] }, admin)).toEqual({ ok: false, reason: "not-found" });
    expect(await mutateAdminOpeningHours({ ...change, location_id: randomUUID() }, admin)).toEqual({ ok: false, reason: "not-found" });
    expect(await mutateAdminOpeningHours({ ...change, rows: [{ weekdays: [], opens_at: "08:00", closes_at: "22:00" }] }, admin)).toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { weekdays: "Select at least one day." } });
    assert.strictEqual((await service.from("locations").update({ archived_at: new Date().toISOString(), is_active: false }).eq("id", location_id)).error, null);
    expect(await mutateAdminOpeningHours(change, admin)).toEqual({ ok: false, reason: "archived" });

    await expect(mutateAdminOpeningHours({ ...scheduleUpdate(removed), location_id, replace_ids: [], rows: [{ weekdays: [6], opens_at: "08:00", closes_at: "22:00" }] }, member)).rejects.toThrow();
  } finally {
    if (locationIds.length) {
      assert.strictEqual((await service.from("location_opening_hours").delete().in("location_id", locationIds)).error, null);
      assert.strictEqual((await service.from("locations").delete().in("id", locationIds)).error, null);
    }
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);

async function hoursFixture() {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const database = await getDataSource();
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(process.env.DATABASE_URL!).hostname);
  const email = `hours-transaction-${randomUUID()}@example.test`;
  const password = "hours-transaction-password-123";
  const actor = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.strictEqual(actor.error, null); assert.ok(actor.data.user);
  const userId = actor.data.user.id;
  assert.strictEqual((await service.from("user_roles").insert({ user_id: userId, role_code: "admin" })).error, null);
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  assert.strictEqual((await admin.auth.signInWithPassword({ email, password })).error, null);
  const location_id = randomUUID(); const courtId = randomUUID();
  assert.strictEqual((await service.from("locations").insert({ id: location_id, name: "Hours transaction", slug: `hours-${location_id}`, timezone: "Pacific/Kiritimati" })).error, null);
  assert.strictEqual((await service.from("courts").insert({ id: courtId, location_id, name: "Hours court", slug: `hours-${courtId}`, surface: "clay", environment: "outdoor" })).error, null);
  const hours = await mutateAdminOpeningHours({ operation: "create", starts_on: "0001-01-01", location_id, replace_ids: [], rows: [{ weekdays: [0, 1, 2, 3, 4, 5, 6], opens_at: "07:00", closes_at: "24:00" }] }, admin);
  assert.ok(hours.ok); assert.ok(hours.scheduleId);
  const scheduleId = hours.scheduleId;
  const price = { location_id, court_ids: [courtId], court_state: "outdoor", weekdays: [0],
    starts_at: "10:00", ends_at: "14:00", starts_on: "", ends_on: "", price_per_hour: "12.00" };
  return { service, database, admin, userId, location_id, courtId, hours: hours.intervals, price,
    updateFields: async () => {
      const schedule = (await clubs.listOpeningHoursSchedules(database.manager, location_id)).find((row) => row.id === scheduleId);
      assert.ok(schedule);
      return { operation: "update" as const, schedule_id: schedule.id, revision: schedule.revision };
    },
    cleanup: async () => {
      assert.strictEqual((await service.from("pricing_rule_sets").delete().eq("location_id", location_id)).error, null);
      assert.strictEqual((await service.from("location_opening_hours").delete().eq("location_id", location_id)).error, null);
      assert.strictEqual((await service.from("courts").delete().eq("id", courtId)).error, null);
      assert.strictEqual((await service.from("locations").delete().eq("id", location_id)).error, null);
      await cleanupAuthFixtures(service, [userId]);
    },
  };
}

test("adding a second Daily interval retains all saved intervals and revisions after database reload", async () => {
  const fixture = await hoursFixture();
  const { admin, database, location_id } = fixture;
  const weekdays = [0,1,2,3,4,5,6];
  try {
    const morning = await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id,
      replace_ids: fixture.hours.map((h) => h.id), rows: [{ weekdays, opens_at: "08:00", closes_at: "12:00" }] }, admin);
    assert.ok(morning.ok);
    const before = morning.schedules!.find((s) => s.id === morning.scheduleId)!;
    const added = await mutateAdminOpeningHours({ ...scheduleUpdate(morning), location_id,
      starts_on: before.starts_on, ends_on: before.ends_on, replace_ids: [], rows: [{ weekdays, opens_at: "13:00", closes_at: "22:00" }] }, admin);
    assert.ok(added.ok);
    expect(added.intervals).toHaveLength(14);
    expect(added.intervals.filter((h) => h.opens_at_minute === 480)).toEqual(morning.intervals);
    expect(added.schedules).toEqual([{ ...before, revision: before.revision + 1 }]);
    expect(await listAdminLocationOpeningHours(location_id, admin)).toEqual(added.intervals);
    const runner = database.createQueryRunner();
    await runner.connect();
    try {
      const raw: unknown = await runner.query("SELECT weekday,opens_at_minute,closes_at_minute FROM public.location_opening_hours WHERE location_id=$1 ORDER BY weekday,opens_at_minute", [location_id]);
      expect(raw).toEqual(weekdays.flatMap((weekday) => [
        { weekday, opens_at_minute: 480, closes_at_minute: 720 },
        { weekday, opens_at_minute: 780, closes_at_minute: 1320 },
      ]));
    } finally { await runner.release(); }
    expect(await mutateAdminOpeningHours({ ...scheduleUpdate(morning), location_id, replace_ids: [],
      rows: [{ weekdays, opens_at: "22:00", closes_at: "24:00" }] }, admin)).toEqual({ ok: false, reason: "stale" });
    const removed = await mutateAdminOpeningHours({ ...scheduleUpdate(added), location_id,
      replace_ids: added.intervals.filter((h) => h.opens_at_minute === 780).map((h) => h.id), rows: [] }, admin);
    assert.ok(removed.ok);
    expect(await listAdminLocationOpeningHours(location_id, admin)).toEqual(morning.intervals);
  } finally { await fixture.cleanup(); }
}, 30000);

test("editing 07:00–22:00 persists new times, preserves unchecked days and unrelated intervals, and rejects no-ops", async () => {
  const fixture = await hoursFixture();
  const { admin, database, location_id } = fixture;
  try {
    const initial = await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id,
      replace_ids: fixture.hours.map((interval) => interval.id), rows: [{ weekdays: [0, 1, 2, 3, 4], opens_at: "07:00", closes_at: "22:00" }] }, admin);
    assert.ok(initial.ok);
    const extra = await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id, replace_ids: [],
      rows: [{ weekdays: [5], opens_at: "10:00", closes_at: "12:00" }] }, admin);
    assert.ok(extra.ok);
    const unchangedRows = extra.intervals.filter((interval) => interval.weekday >= 4);
    const edited = await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id,
      replace_ids: initial.intervals.filter((interval) => interval.weekday < 4).map((interval) => interval.id),
      rows: [{ weekdays: [0, 1, 2, 3, 6], opens_at: "08:17", closes_at: "24:00" }] }, admin);
    assert.ok(edited.ok);
    // Read actual committed PostgreSQL rows on a separate connection, independent
    // of the mutation response and the application read model.
    const runner = database.createQueryRunner();
    await runner.connect();
    try {
      const raw: unknown = await runner.query(
        "SELECT weekday, opens_at_minute, closes_at_minute FROM public.location_opening_hours WHERE location_id = $1 ORDER BY weekday, opens_at_minute", [location_id]);
      const rows = z.array(z.object({ weekday: z.number(), opens_at_minute: z.number(), closes_at_minute: z.number() })).parse(raw);
      expect(rows).toEqual([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday,
        opens_at_minute: weekday === 4 ? 420 : weekday === 5 ? 600 : 497,
        closes_at_minute: weekday === 4 ? 1320 : weekday === 5 ? 720 : 1440,
      })));
    } finally { await runner.release(); }
    const reloaded = await listAdminLocationOpeningHours(location_id, admin);
    expect(reloaded).toEqual(edited.intervals);
    expect(reloaded.filter((interval) => interval.weekday >= 4 && interval.weekday <= 5)).toEqual(unchangedRows);
    const selected = reloaded.filter((interval) => interval.weekday < 4 || interval.weekday === 6);
    expect(await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id,
      replace_ids: selected.map((interval) => interval.id), rows: [{ weekdays: [6, 3, 2, 1, 0], opens_at: "08:17", closes_at: "24:00" }] }, admin))
      .toEqual({ ok: false, reason: "unchanged" });
    expect(await listAdminLocationOpeningHours(location_id, admin)).toEqual(reloaded);
  } finally { await fixture.cleanup(); }
}, 30000);

async function persistedPricing(fixture: Awaited<ReturnType<typeof hoursFixture>>) {
  const runner = fixture.database.createQueryRunner();
  await runner.connect();
  try {
    const raw: unknown = await runner.query("SELECT id, rule_set_id, court_id, court_state, weekday, starts_at_minute, ends_at_minute, starts_on::text, ends_on::text, price_per_hour_minor FROM public.location_pricing_rules WHERE location_id=$1 ORDER BY court_id, court_state, weekday, starts_on NULLS FIRST, starts_at_minute", [fixture.location_id]);
    return z.array(z.object({ id: z.string(), rule_set_id: z.string(), court_id: z.string(), court_state: z.string(), weekday: z.number(),
      starts_at_minute: z.number(), ends_at_minute: z.number(), starts_on: z.string().nullable(), ends_on: z.string().nullable(), price_per_hour_minor: z.number() })).parse(raw);
  } finally { await runner.release(); }
}

const boundaries = [
  ["extension", "06:00", "23:00", [[360,420],[420,1320],[1320,1380]]],
  ["reduction", "08:00", "20:00", [[480,1200]]],
  ["deletion", "", "", []],
] as const;
test.each(boundaries)("reconciles %s and preserves unaffected rows", async (_label, opens_at, closes_at, expected) => {
  const fixture = await hoursFixture();
  const { admin, location_id, courtId } = fixture;
  try {
    const initial = await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id, replace_ids: fixture.hours.filter((h) => h.weekday === 0).map((h) => h.id), rows: [{ weekdays: [0], opens_at: "07:00", closes_at: "22:00" }] }, admin); assert.ok(initial.ok);
    assert.ok((await saveAdminPricingRule({ ...fixture.price, weekdays: [0,1], starts_at: "07:00", ends_at: "22:00", price_per_hour: "50.17" }, admin)).ok);
    const before = await persistedPricing(fixture);
    const result = await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id, replace_ids: initial.intervals.filter((h) => h.weekday === 0).map((h) => h.id), rows: opens_at ? [{ weekdays: [0], opens_at, closes_at }] : [] }, admin);
    expect(result).toMatchObject({ ok: true, pricingAdjusted: true });
    const rows = await persistedPricing(fixture);
    const today = localToday("Pacific/Kiritimati", await clubs.readOpeningHoursConfigurationTime(fixture.database.manager));
    expect(rows.filter((r) => r.weekday === 0 && (!r.ends_on || r.ends_on >= today)).map((r) => [r.starts_at_minute,r.ends_at_minute]).sort((a,b) => a[0]-b[0])).toEqual(expected);
    if (opens_at !== "06:00" && closes_at !== "23:00") expect(rows.find((r) => r.weekday === 0 && r.ends_on && r.ends_on < today))
      .toMatchObject({ starts_at_minute: 420, ends_at_minute: 1320, price_per_hour_minor: 5017 });
    expect(rows.every((r) => r.price_per_hour_minor === 5017 && r.court_id === courtId)).toBe(true);
    expect(rows.filter((r) => r.weekday === 1)).toEqual(before.filter((r) => r.weekday === 1));
    expect(await listAdminPricingRules(location_id, admin)).toHaveLength(new Set(rows.map((r) => r.rule_set_id)).size);
    const runner = fixture.database.createQueryRunner(); await runner.connect();
    try { expect(await runner.query("SELECT id FROM public.pricing_rule_sets s WHERE location_id=$1 AND NOT EXISTS (SELECT 1 FROM public.location_pricing_rules p WHERE p.rule_set_id=s.id)", [location_id])).toEqual([]); }
    finally { await runner.release(); }
  } finally { await fixture.cleanup(); }
}, 30000);

test("interior gap uses maximum adjacent price across courts, states, weekdays and seasons", async () => {
  const fixture = await hoursFixture();
  const { admin, location_id, courtId, service } = fixture;
  const secondCourt = randomUUID();
  try {
    expect((await service.from("courts").insert({ id: secondCourt, location_id, name: "Second", slug: `second-${secondCourt}`, environment: "outdoor", surface: "clay" })).error).toBeNull();
    const initial = await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id, replace_ids: fixture.hours.filter((h) => h.weekday < 2).map((h) => h.id), rows: [{ weekdays: [0,1], opens_at: "07:00", closes_at: "10:00" }, { weekdays: [0,1], opens_at: "12:00", closes_at: "22:00" }] }, admin); assert.ok(initial.ok);
    for (const court_state of ["outdoor", "covered"] as const) for (const [starts_on, ends_on, left, right] of [["", "2029-12-31", "40.17", "50.29"], ["2030-01-01", "2030-12-31", "80.11", "60.22"]]) {
      for (const court of [courtId, secondCourt]) {
        const offset = court === secondCourt ? 10 : 0;
        for (const [starts_at, ends_at, price] of [["07:00", "10:00", left], ["12:00", "22:00", right]]) {
          assert.ok((await saveAdminPricingRule({ ...fixture.price, court_ids: [court], court_state, weekdays: [0,1], starts_at, ends_at, starts_on, ends_on,
            price_per_hour: (Number(price) + offset).toFixed(2) }, admin)).ok);
        }
      }
    }
    const before = await persistedPricing(fixture);
    const filled = await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id, replace_ids: initial.intervals.filter((h) => h.weekday === 0).map((h) => h.id), rows: [{ weekdays: [0], opens_at: "07:00", closes_at: "22:00" }] }, admin);
    expect(filled).toMatchObject({ ok: true, pricingAdjusted: true });
    const after = await persistedPricing(fixture);
    expect(after.filter((r) => before.some((b) => b.id === r.id))).toEqual(before);
    const added = after.filter((r) => !before.some((b) => b.id === r.id));
    expect(added).toHaveLength(8);
    expect(added.every((r) => r.weekday === 0 && r.starts_at_minute === 600 && r.ends_at_minute === 720)).toBe(true);
    for (const row of added) expect(row.price_per_hour_minor).toBe((row.starts_on === "2030-01-01" ? 8011 : 5029) + (row.court_id === secondCourt ? 1000 : 0));
    expect(await listAdminPricingRules(location_id, admin)).toHaveLength(new Set(after.map((r) => r.rule_set_id)).size);
  } finally {
    await service.from("pricing_rule_sets").delete().eq("location_id", location_id);
    await service.from("courts").delete().eq("id", secondCourt);
    await fixture.cleanup();
  }
}, 30000);

test("date-limited gap pricing uses only simultaneous adjacent prices and isolates indoor courts", async () => {
  const fixture = await hoursFixture();
  const { admin, location_id, service } = fixture;
  const indoorCourt = randomUUID();
  try {
    expect((await service.from("courts").insert({ id: indoorCourt, location_id, name: "Indoor", slug: `indoor-${indoorCourt}`, environment: "indoor", surface: "hard" })).error).toBeNull();
    const initial = await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id, replace_ids: fixture.hours.filter((h) => h.weekday === 0).map((h) => h.id), rows: [{ weekdays: [0], opens_at: "07:00", closes_at: "10:00" }, { weekdays: [0], opens_at: "12:00", closes_at: "22:00" }] }, admin); assert.ok(initial.ok);
    assert.ok((await saveAdminPricingRule({ ...fixture.price, starts_at: "07:00", ends_at: "10:00", starts_on: "2028-01-01", ends_on: "2029-12-31", price_per_hour: "40.17" }, admin)).ok);
    assert.ok((await saveAdminPricingRule({ ...fixture.price, starts_at: "12:00", ends_at: "22:00", starts_on: "2029-01-01", ends_on: "2030-12-31", price_per_hour: "80.29" }, admin)).ok);
    assert.ok((await saveAdminPricingRule({ ...fixture.price, court_ids: [indoorCourt], court_state: "indoor", starts_at: "07:00", ends_at: "10:00", starts_on: "", ends_on: "", price_per_hour: "91.23" }, admin)).ok);
    assert.ok((await saveAdminPricingRule({ ...fixture.price, starts_at: "07:00", ends_at: "10:00", starts_on: "2000-01-01", ends_on: "2001-12-31", price_per_hour: "12.34" }, admin)).ok);
    const before = await persistedPricing(fixture);
    expect(await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id, replace_ids: initial.intervals.filter((h) => h.weekday === 0).map((h) => h.id), rows: [{ weekdays: [0], opens_at: "07:00", closes_at: "22:00" }] }, admin)).toMatchObject({ ok: true });
    const after = await persistedPricing(fixture);
    expect(after.filter((r) => before.some((b) => r.id === b.id))).toEqual(before);
    const added = after.filter((r) => !before.some((b) => r.id === b.id));
    expect(added.filter((r) => r.court_state === "outdoor").map((r) => [r.starts_on,r.ends_on,r.price_per_hour_minor])).toEqual([
      ["2028-01-01","2028-12-31",4017], ["2029-01-01","2029-12-31",8029], ["2030-01-01","2030-12-31",8029],
    ]);
    expect(added.find((r) => r.court_state === "indoor")).toMatchObject({ court_id: indoorCourt, starts_on: localToday("Pacific/Kiritimati", await clubs.readOpeningHoursConfigurationTime(fixture.database.manager)), ends_on: null, price_per_hour_minor: 9123, starts_at_minute: 600, ends_at_minute: 720 });
  } finally {
    await service.from("pricing_rule_sets").delete().eq("location_id",location_id);
    await service.from("courts").delete().eq("id",indoorCourt);
    await fixture.cleanup();
  }
}, 30000);

test("splits partial multi-court and weekday definitions without losing associations", async () => {
  const fixture = await hoursFixture();
  const { admin, location_id, courtId, service } = fixture;
  const secondCourt = randomUUID();
  try {
    expect((await service.from("courts").insert({ id: secondCourt, location_id, name: "Second", slug: `second-${secondCourt}`, environment: "outdoor", surface: "clay" })).error).toBeNull();
    assert.ok((await saveAdminPricingRule({ ...fixture.price, court_ids: [courtId, secondCourt], weekdays: [0,1], starts_at: "07:00", ends_at: "22:00" }, admin)).ok);
    const before = await persistedPricing(fixture);
    expect(await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id, replace_ids: fixture.hours.filter((h) => h.weekday === 0).map((h) => h.id), rows: [{ weekdays: [0], opens_at: "08:00", closes_at: "10:00" }, { weekdays: [0], opens_at: "12:00", closes_at: "20:00" }] }, admin)).toMatchObject({ ok: true });
    const after = await persistedPricing(fixture);
    expect(after.filter((r) => r.weekday === 1)).toEqual(before.filter((r) => r.weekday === 1));
    expect(after.filter((r) => r.weekday === 0 && r.court_id === courtId && r.ends_on === null).map((r) => [r.starts_at_minute,r.ends_at_minute])).toEqual([[480,600],[720,1200]]);
    expect(await listAdminPricingRules(location_id, admin)).toHaveLength(new Set(after.map((r) => r.rule_set_id)).size);
  } finally {
    await service.from("pricing_rule_sets").delete().eq("location_id", location_id);
    await service.from("courts").delete().eq("id", secondCourt);
    await fixture.cleanup();
  }
}, 30000);

test("missing adjacent pricing remains missing and publication readiness reports it", async () => {
  const fixture = await hoursFixture();
  const { admin, location_id } = fixture;
  try {
    assert.ok((await saveAdminPricingRule({ ...fixture.price, weekdays: [0,1,2,3,4,5,6], starts_at: "10:00", ends_at: "14:00" }, admin)).ok);
    const before = await persistedPricing(fixture);
    const result = await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id, replace_ids: fixture.hours.filter((h) => h.weekday === 0).map((h) => h.id), rows: [{ weekdays: [0], opens_at: "06:00", closes_at: "24:00" }] }, admin);
    expect(result).toMatchObject({ ok: true, missingPricing: true, pricingAdjusted: false });
    expect(await persistedPricing(fixture)).toEqual(before);
    expect((await listAdminLocationsWithReadiness("current", location_id, admin))[0].missing).toContain("pricing for every active court");
  } finally { await fixture.cleanup(); }
}, 30000);

test("retained historical prices cannot block an extension", async () => {
  const fixture = await hoursFixture();
  const { admin, location_id } = fixture;
  try {
    assert.ok((await saveAdminPricingRule({ ...fixture.price, starts_at: "07:00", ends_at: "08:00", starts_on: "2000-01-01", ends_on: "2001-12-31" }, admin)).ok);
    assert.ok((await saveAdminPricingRule({ ...fixture.price, starts_at: "08:00", ends_at: "24:00", price_per_hour: "50.17" }, admin)).ok);
    const original = await persistedPricing(fixture);
    const trimmed = await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id, replace_ids: fixture.hours.filter((h) => h.weekday === 0).map((h) => h.id), rows: [{ weekdays: [0], opens_at: "08:00", closes_at: "24:00" }] }, admin); assert.ok(trimmed.ok);
    expect(await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id, replace_ids: trimmed.intervals.filter((h) => h.weekday === 0).map((h) => h.id), rows: [{ weekdays: [0], opens_at: "07:00", closes_at: "24:00" }] }, admin)).toMatchObject({ ok: true, pricingAdjusted: true });
    const rows = await persistedPricing(fixture);
    expect(rows.filter((r) => original.some((b) => b.id === r.id))).toEqual(original);
    expect(rows.find((r) => !original.some((b) => b.id === r.id))).toMatchObject({ starts_on: localToday("Pacific/Kiritimati", await clubs.readOpeningHoursConfigurationTime(fixture.database.manager)), ends_on: null, starts_at_minute: 420, ends_at_minute: 480, price_per_hour_minor: 5017 });
  } finally { await fixture.cleanup(); }
}, 30000);

test("fully covered opening hours remain ready after trimming and extending", async () => {
  const fixture = await hoursFixture();
  const { admin, location_id } = fixture;
  try {
    assert.ok((await saveAdminPricingRule({ ...fixture.price, weekdays: [0,1,2,3,4,5,6], starts_at: "07:00", ends_at: "24:00" }, admin)).ok);
    expect((await listAdminLocationsWithReadiness("current", location_id, admin))[0].missing).toEqual([]);
    const trimmed = await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id, replace_ids: fixture.hours.filter((h) => h.weekday < 2).map((h) => h.id), rows: [{ weekdays: [0,1], opens_at: "08:00", closes_at: "20:00" }] }, admin); assert.ok(trimmed.ok);
    expect((await listAdminLocationsWithReadiness("current", location_id, admin))[0].missing).toEqual([]);
    assert.ok((await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id, replace_ids: trimmed.intervals.filter((h) => h.weekday < 2).map((h) => h.id), rows: [{ weekdays: [0,1], opens_at: "06:00", closes_at: "23:00" }] }, admin)).ok);
    expect((await persistedPricing(fixture)).filter((r) => r.weekday === 0 && r.ends_on === null)).toHaveLength(3);
    expect((await listAdminLocationsWithReadiness("current", location_id, admin))[0].missing).toEqual([]);
  } finally { await fixture.cleanup(); }
}, 30000);

test("pricing and opening hours both roll back on a failure after reconciliation", async () => {
  const fixture = await hoursFixture();
  const { admin, location_id, database } = fixture;
  try {
    assert.ok((await saveAdminPricingRule({ ...fixture.price, starts_at: "07:00", ends_at: "24:00" }, admin)).ok);
    const before = await persistedPricing(fixture);
    const reload = clubs.listLocationOpeningHours;
    const spy = vi.spyOn(clubs, "listLocationOpeningHours").mockImplementationOnce(reload).mockRejectedValueOnce(new Error("Injected refresh failure"));
    try { await expect(mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id, replace_ids: fixture.hours.filter((h) => h.weekday === 0).map((h) => h.id), rows: [{ weekdays: [0], opens_at: "08:00", closes_at: "20:00" }] }, admin)).rejects.toThrow("Unable to refresh opening hours."); }
    finally { spy.mockRestore(); }
    expect(await persistedPricing(fixture)).toEqual(before);
    const observer = database.createQueryRunner(); await observer.connect();
    try { expect(await clubs.listLocationOpeningHours(observer.manager, location_id)).toHaveLength(7); }
    finally { await observer.release(); }
  } finally { await fixture.cleanup(); }
}, 30000);

test.each(["active", "held"] as const)("%s future reservations survive reductions and closure without changing persisted data", async (status) => {
  const fixture = await hoursFixture();
  const { admin, location_id, courtId, service, database } = fixture;
  const reservationId = randomUUID();
  try {
    const now = await clubs.readOpeningHoursConfigurationTime(database.manager);
    const date = new Date(`${localToday("Pacific/Kiritimati", now)}T00:00:00Z`); date.setUTCDate(date.getUTCDate()+7);
    const booking_date = date.toISOString().slice(0,10), weekday = mondayWeekday(booking_date);
    assert.ok((await saveAdminPricingRule({ ...fixture.price, weekdays: [weekday], starts_at: "07:00", ends_at: "24:00" }, admin)).ok);
    expect((await service.from("court_reservations").insert({ id: reservationId, court_id: courtId, booking_date, starts_at_minute: 420, ends_at_minute: 480, reason: "Keep me", status, hold_expires_at: status === "held" ? new Date(now.getTime()+3600000).toISOString() : null })).error).toBeNull();
    const change = { ...await fixture.updateFields(), location_id, replace_ids: fixture.hours.filter((h) => h.weekday === weekday).map((h) => h.id), rows: [{ weekdays: [weekday], opens_at: "08:00", closes_at: "24:00" }] };
    const reduced = await mutateAdminOpeningHours(change, admin); assert.ok(reduced.ok);
    expect(await mutateAdminOpeningHours({ ...change, ...scheduleUpdate(reduced), replace_ids: reduced.intervals.filter((h) => h.weekday === weekday).map((h) => h.id), rows: [] }, admin)).toMatchObject({ ok: true });
    const observer = database.createQueryRunner(); await observer.connect();
    try { expect(await observer.query("SELECT status::text, reason, starts_at_minute FROM public.court_reservations WHERE id=$1", [reservationId])).toEqual([{ status, reason: "Keep me", starts_at_minute: 420 }]); }
    finally { await observer.release(); }
  } finally { await service.from("court_reservations").delete().eq("id",reservationId); await fixture.cleanup(); }
}, 30000);

async function backendPid(runner: QueryRunner) {
  const rows: unknown = await runner.query("SELECT pg_backend_pid() AS pid");
  return z.array(z.object({ pid: z.number().int() })).length(1).parse(rows)[0].pid;
}

async function waitForWriter(observer: QueryRunner, blocker: number, queryPart: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows: unknown = await observer.query(
      "SELECT pid, query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [blocker]);
    const blocked = z.array(z.object({ pid: z.number().int(), query: z.string() })).parse(rows);
    const writer = blocked.find((row) => row.query.includes(queryPart));
    if (writer) return writer.pid;
  }
  throw new Error("Expected configuration writer lock wait was not observed.");
}

test("hours-first pricing race rejects incompatible pricing after the hours commit", async () => {
  const fixture = await hoursFixture();
  const { database, admin, location_id, hours, price } = fixture;
  const blocker = database.createQueryRunner(); const observer = database.createQueryRunner();
  await blocker.connect(); await observer.connect();
  const pending: Promise<unknown>[] = [];
  try {
    await blocker.startTransaction();
    // Parent-only probe: the first writer acquires global, then blocks here.
    await clubs.lockLocations(blocker.manager, [location_id]);
    const changeHours = async () => mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id,
      replace_ids: hours.filter((row) => row.weekday === 0).map((row) => row.id),
      rows: [{ weekdays: [0], opens_at: "07:00", closes_at: "12:00" }] }, admin);
    const changePricing = () => saveAdminPricingRule(price, admin);
    const firstOperation = changeHours(); pending.push(firstOperation);
    const firstPid = await waitForWriter(observer, await backendPid(blocker), "locations");
    const secondOperation = changePricing(); pending.push(secondOperation);
    await waitForWriter(observer, firstPid, "pg_advisory_xact_lock");
    await blocker.commitTransaction();
    const firstResult = await firstOperation; const secondResult = await secondOperation;
    expect(firstResult).toMatchObject({ ok: true });
    expect(secondResult).toMatchObject({ ok: false, reason: "invalid-input" });
    const savedHours = await listAdminLocationOpeningHours(location_id, admin);
    expect(savedHours.find((row) => row.weekday === 0)?.closes_at_minute).toBe(720);
    const rules = await fixture.service.from("location_pricing_rules").select("id").eq("location_id", location_id);
    assert.strictEqual(rules.error, null);
    expect(rules.data).toHaveLength(0);
  } finally {
    if (blocker.isTransactionActive) await blocker.rollbackTransaction();
    await Promise.allSettled(pending);
    await blocker.release(); await observer.release();
    await fixture.cleanup();
  }
}, 30000);

test("transaction-time Admin recheck rejects suspension after initial authorization", async () => {
  const fixture = await hoursFixture();
  const { database, admin, location_id, userId } = fixture;
  const blocker = database.createQueryRunner(); const observer = database.createQueryRunner();
  await blocker.connect(); await observer.connect();
  let operation: Promise<unknown> | undefined;
  try {
    await blocker.startTransaction();
    await clubs.lockConfigurationForWrite(blocker.manager);
    operation = mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id, replace_ids: [], rows: [{ weekdays: [0], opens_at: "00:00", closes_at: "06:00" }] }, admin);
    // Attach a rejection observer before releasing the transaction fence.
    const rejected = expect(operation).rejects.toThrow("Unable to change opening hours.");
    await waitForWriter(observer, await backendPid(blocker), "pg_advisory_xact_lock");
    expect((await fixture.service.from("users").update({ status: "suspended" }).eq("id", userId)).error).toBeNull();
    await blocker.commitTransaction();
    await rejected;
    expect((await fixture.service.from("location_opening_hours").select("id").eq("location_id", location_id)).data).toHaveLength(7);
  } finally {
    if (blocker.isTransactionActive) await blocker.rollbackTransaction();
    if (operation) await Promise.allSettled([operation]);
    await blocker.release(); await observer.release();
    await fixture.cleanup();
  }
}, 30000);

test("effective schedules persist inclusive periods, reject overlaps and stale edits, and close uncovered dates", async () => {
  const fixture = await hoursFixture();
  const { admin, location_id, database } = fixture;
  try {
    const [baseline] = await clubs.listOpeningHoursSchedules(database.manager, location_id);
    expect(baseline.startsOn).toBe("0001-01-01"); expect(baseline.endsOn).toBeNull();
    const period = { operation: "update", location_id, replace_ids: [], rows: [], schedule_id: baseline.id, revision: baseline.revision,
      starts_on: baseline.startsOn, ends_on: "2030-10-31" };
    expect(await mutateAdminOpeningHours(period, admin)).toMatchObject({ ok: true });
    expect(await mutateAdminOpeningHours({ ...period, ends_on: "2030-10-30" }, admin)).toMatchObject({ ok: false, reason: "stale" });
    const create = { operation: "create", location_id, starts_on: "2030-11-01", ends_on: "2031-03-31", replace_ids: [],
      rows: [{ weekdays: [0,1,2,3,4], opens_at: "08:00", closes_at: "12:00" }, { weekdays: [0,1,2,3,4], opens_at: "13:00", closes_at: "24:00" }] };
    const future = await mutateAdminOpeningHours(create, admin); assert.ok(future.ok); assert.ok(future.scheduleId);
    const { insertOpeningHoursFixture } = await import("../opening-hours-fixtures");
    await expect(insertOpeningHoursFixture(fixture.service, { location_id, weekday: 6, opens_at_minute: 480, closes_at_minute: 720 }))
      .rejects.toThrow("requires an explicit schedule_id");
    expect(await mutateAdminOpeningHours({ ...create, starts_on: "2030-10-31" }, admin)).toMatchObject({ ok: false, reason: "period-overlap" });
    expect(await mutateAdminOpeningHours({ ...create, starts_on: "2031-03-31", ends_on: null }, admin)).toMatchObject({ ok: false, reason: "period-overlap" });
    const { listReservationOpeningHours } = await import("@/lib/db/repositories/reservations.repository");
    expect(await listReservationOpeningHours(database.manager,location_id,"2030-10-31")).toHaveLength(1);
    expect(await listReservationOpeningHours(database.manager,location_id,"2030-11-01")).toHaveLength(2);
    expect(await listReservationOpeningHours(database.manager,location_id,"2030-11-02")).toEqual([]); // Saturday
    expect(await listReservationOpeningHours(database.manager,location_id,"2031-03-31")).toHaveLength(2);
    expect(await listReservationOpeningHours(database.manager,location_id,"2031-04-01")).toEqual([]);
    const saved = future.schedules!.find((s) => s.id === future.scheduleId)!;
    expect(await mutateAdminOpeningHours({ location_id, operation: "delete", schedule_id: baseline.id, revision: baseline.revision }, admin)).toMatchObject({ ok: false, reason: "stale" });
    const edit = await mutateAdminOpeningHours({ ...create, operation: "update", schedule_id: saved.id, revision: saved.revision,
      replace_ids: future.intervals.filter((h) => h.schedule_id === saved.id).map((h) => h.id), rows: [{ weekdays: [0,1,2,3,4], opens_at: "09:00", closes_at: "20:00" }] }, admin);
    assert.ok(edit.ok);
    expect((await listReservationOpeningHours(database.manager,location_id,"2030-11-01"))[0].opens_at_minute).toBe(540);
    const baselineAfter = await clubs.listLocationOpeningHours(database.manager, location_id, "2030-10-31");
    expect(baselineAfter.map((h) => h.id).sort()).toEqual(fixture.hours.map((h) => h.id).sort());
    const latest = edit.schedules!.find((s) => s.id === saved.id)!;
    expect(await mutateAdminOpeningHours({ location_id, operation: "delete", schedule_id: latest.id, revision: latest.revision }, admin)).toMatchObject({ ok: true });
    expect(await listReservationOpeningHours(database.manager,location_id,"2030-11-01")).toEqual([]);
  } finally { await fixture.cleanup(); }
}, 30000);

test("future schedule reconciles only its dates and preserves confirmed guest contracts and occupancy", async () => {
  const fixture = await hoursFixture();
  const { admin, service, database, courtId, location_id } = fixture;
  const { createCustomerBooking } = await import("@/lib/bookings/service");
  const { listInternalLocations, getReservationDay } = await import("@/lib/reservations/service");
  const { getPublicCourtDay } = await import("@/lib/courts/public-calendar");
  const { listPublicLocationsWithCourts } = await import("@/lib/courts/public");
  const guest = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  const date = "2030-11-20";
  const intent = { paymentMethod: "pay_at_club", courtId, date, startMinute: 420, endMinute: 480, customerName: "Guest",
    customerEmail: "guest@example.test", customerPhone: "123", expectedTotalAmountMinor: 5017, expectedCurrency: "RON" };
  try {
    expect((await service.from("locations").update({ is_public: true, allow_pay_at_club: true, currency: "RON" }).eq("id", location_id)).error).toBeNull();
    assert.ok((await saveAdminPricingRule({ ...fixture.price, weekdays: [0,1,2,3,4,5,6], starts_at: "07:00", ends_at: "24:00", price_per_hour: "50.17" }, admin)).ok);
    const original = await createCustomerBooking(intent,guest); assert.ok(original.ok, JSON.stringify(original));
    const contracts = () => database.query(`SELECT to_jsonb(b) AS booking,to_jsonb(r) AS reservation,
      coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.payment_attempts p WHERE p.booking_id=b.id),'[]'::jsonb) AS payments,
      coalesce((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM public.payment_refunds f WHERE f.booking_id=b.id),'[]'::jsonb) AS refunds
      FROM public.bookings b
      JOIN public.court_reservations r ON r.id=b.reservation_id WHERE b.id=$1`,[original.bookingId]);
    const before = await contracts();
    const [baseline] = await clubs.listOpeningHoursSchedules(database.manager,location_id);
    const originalHours = await clubs.listLocationOpeningHours(database.manager,location_id);
    const future = await mutateAdminOpeningHours({ operation: "create", location_id, starts_on: "2030-11-01", ends_on: "2031-03-31",
      replace_ids: [], rows: [{ weekdays: [0,1,2,3,4,5,6], opens_at: "08:00", closes_at: "20:00" }] }, admin); assert.ok(future.ok);
    expect(future.schedules!.find((s) => s.id === baseline.id)).toMatchObject({ ends_on: "2030-10-31", revision: baseline.revision + 1 });
    expect(await clubs.listLocationOpeningHours(database.manager,location_id,"2030-10-31")).toEqual(originalHours);
    const prices = await persistedPricing(fixture);
    expect(prices.filter((p) => p.weekday === 2).map((p) => [p.starts_on,p.ends_on,p.starts_at_minute,p.ends_at_minute])).toEqual([
      [null,"2030-10-31",420,1440],["2030-11-01","2031-03-31",480,1200],["2031-04-01",null,420,1440],
    ]);
    expect(await contracts()).toEqual(before);
    expect(await createCustomerBooking(intent,guest)).toMatchObject({ ok: false, availabilityChanged: true });
    const newBooking = await createCustomerBooking({ ...intent,startMinute: 480,endMinute: 540 },guest); assert.ok(newBooking.ok,JSON.stringify(newBooking));
    const location = (await listPublicLocationsWithCourts()).find((l) => l.id === location_id)!;
    const publicDay = await getPublicCourtDay(location,date,localToday(location.timezone,new Date()),new Date());
    expect(publicDay.times[0]).toBe(420); expect(publicDay.courts[0].cells.slice(0,4)).toEqual(["booked","booked","booked","booked"]);
    const internalLocation = (await listInternalLocations(admin)).find((l) => l.id === location_id)!;
    const internalDay = await getReservationDay(internalLocation,date,new Date(),admin);
    expect(internalDay.times[0]).toBe(420); expect(internalDay.courts[0].cells[0]).toBe("booked");
    const definition = (await listAdminPricingRules(location_id,admin)).find((p) => p.starts_on === "2030-11-01" && p.weekdays.includes(2))!;
    assert.ok((await saveAdminPricingRule({ ...fixture.price, rule_set_id: definition.rule_set_id, revision: definition.revision, weekdays: definition.weekdays,
      starts_at: "08:00", ends_at: "20:00", starts_on: definition.starts_on, ends_on: definition.ends_on, price_per_hour: "70.29" },admin)).ok);
    expect(await createCustomerBooking({ ...intent,startMinute: 540,endMinute: 600 },guest)).toMatchObject({ ok: false,reason: "price_changed",totalAmountMinor: 7029 });
    expect(await createCustomerBooking({ ...intent,startMinute: 540,endMinute: 600,expectedTotalAmountMinor: 7029 },guest)).toMatchObject({ ok: true });
    expect(await contracts()).toEqual(before);
    const overlap = await database.query("SELECT id FROM public.court_reservations WHERE court_id=$1 AND status='active'",[courtId]);
    expect(overlap).toHaveLength(3);
    const latest = future.schedules!.find((s) => s.id === future.scheduleId)!;
    const reload = clubs.listLocationOpeningHours;
    const failed = vi.spyOn(clubs,"listLocationOpeningHours").mockImplementationOnce(reload).mockRejectedValueOnce(new Error("Injected refresh failure"));
    try { await expect(mutateAdminOpeningHours({ operation: "update", location_id,schedule_id: latest.id,revision: latest.revision,starts_on: latest.starts_on,ends_on: latest.ends_on,
      replace_ids: future.intervals.filter((h) => h.schedule_id === latest.id && h.weekday === 2).map((h) => h.id),rows: [{ weekdays: [2], opens_at: "09:00", closes_at: "18:00" }] },admin)).rejects.toThrow("Unable to refresh opening hours."); }
    finally { failed.mockRestore(); }
    expect((await clubs.listOpeningHoursSchedules(database.manager,location_id)).find((s) => s.id === latest.id)?.revision).toBe(latest.revision);
    expect(await contracts()).toEqual(before);
    expect((await service.from("locations").update({ allow_pay_at_club: false,customer_cancellation_notice_minutes: 300,is_public: false }).eq("id",location_id)).error).toBeNull();
    expect(await contracts()).toEqual(before);
  } finally {
    await cleanupBookingFixtures({ courtIds: [courtId] });
    await database.query("DELETE FROM public.court_reservations WHERE court_id=$1",[courtId]);
    await fixture.cleanup();
  }
}, 30000);

test("concurrent schedule creation has one winner and PostgreSQL independently excludes inclusive overlaps", async () => {
  const fixture = await hoursFixture();
  const { admin, location_id, database } = fixture;
  try {
    const [baseline] = await clubs.listOpeningHoursSchedules(database.manager,location_id);
    const input = { operation: "create",location_id,starts_on: "2030-11-01",ends_on: "2030-11-30",replace_ids: [],rows: [{ weekdays: [0], opens_at: "08:00", closes_at: "24:00" }] };
    const results = await Promise.all([mutateAdminOpeningHours(input,admin),mutateAdminOpeningHours(input,admin)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({ ok: false,reason: "period-overlap" });
    await expect(database.query("INSERT INTO public.opening_hours_schedules(location_id,starts_on,ends_on) VALUES($1,'2030-11-30','2030-12-31')",[location_id]))
      .rejects.toMatchObject({ driverError: { code: "23P01",constraint: "opening_hours_schedules_no_overlap" } });
    const schedules = await clubs.listOpeningHoursSchedules(database.manager,location_id);
    expect(schedules).toHaveLength(2);
    expect(schedules.find((s) => s.id === baseline.id)).toMatchObject({ endsOn: "2030-10-31", revision: baseline.revision + 1 });
    expect(await mutateAdminOpeningHours({ operation: "update", location_id, schedule_id: baseline.id, revision: baseline.revision,
      starts_on: baseline.startsOn, ends_on: "2030-10-30", replace_ids: [], rows: [] },admin)).toEqual({ ok: false, reason: "stale" });
    const winner = results.find((result) => result.ok);
    assert.ok(winner?.ok);
    const edit = { ...scheduleUpdate(winner), location_id,
      replace_ids: winner.intervals.filter((hour) => hour.schedule_id === winner.scheduleId).map((hour) => hour.id),
      rows: [{ weekdays: [0], opens_at: "09:00", closes_at: "20:00" }] };
    const edits = await Promise.all([mutateAdminOpeningHours(edit,admin),mutateAdminOpeningHours(edit,admin)]);
    expect(edits.filter((result) => result.ok)).toHaveLength(1);
    expect(edits.find((result) => !result.ok)).toEqual({ ok: false,reason: "stale" });
  } finally { await fixture.cleanup(); }
},30000);

test.each(["hours","price","cancellation","publication"] as const)("pending captured checkout revalidates %s before confirmation without changing its quoted amount",async policy => {
  const fixture = await hoursFixture();
  const { service,admin,location_id,courtId,database } = fixture;
  const { insertCheckoutFixture } = await import("../checkout-fixtures");
  const { processOnlinePaymentEvent } = await import("@/lib/payments/service");
  const date = "2030-11-20", weekday = mondayWeekday(date);
  try {
    expect((await service.from("locations").update({ is_public: true,currency: "RON" }).eq("id",location_id)).error).toBeNull();
    assert.ok((await saveAdminPricingRule({ ...fixture.price,weekdays: [0,1,2,3,4,5,6],starts_at: "07:00",ends_at: "24:00",price_per_hour: "50.17" },admin)).ok);
    const inserted = await insertCheckoutFixture(service,{ p_court_id: courtId,p_booking_date: date,p_starts_at_minute: 420,p_ends_at_minute: 480,
      p_account_user_id: null,p_customer_name: "Pending",p_customer_email: "pending@example.test",p_customer_phone: "123",
      p_total_amount_minor: 5017,p_currency: "RON",p_payment_method: "online",p_provider: "stripe",p_hold_seconds: 600 });
    assert.strictEqual(inserted.error,null); const held = inserted.data[0];
    expect((await service.from("payment_attempts").update({ provider_payment_id: "pi_policy_test" }).eq("id",held.payment_attempt_id)).error).toBeNull();
    if (policy === "hours") assert.ok((await mutateAdminOpeningHours({ ...await fixture.updateFields(), location_id,replace_ids: fixture.hours.filter((h) => h.weekday === weekday).map((h) => h.id),rows: [{ weekdays: [weekday], opens_at: "08:00", closes_at: "24:00" }] },admin)).ok);
    if (policy === "price") {
      const [rule] = await listAdminPricingRules(location_id,admin);
      assert.ok((await saveAdminPricingRule({ ...fixture.price,rule_set_id: rule.rule_set_id,revision: rule.revision,weekdays: rule.weekdays,starts_at: "07:00",ends_at: "24:00",price_per_hour: "70.29" },admin)).ok);
    }
    if (policy === "cancellation") expect((await service.from("locations").update({ customer_cancellation_notice_minutes: 300 }).eq("id",location_id)).error).toBeNull();
    if (policy === "publication") expect((await service.from("locations").update({ is_public: false }).eq("id",location_id)).error).toBeNull();
    expect(await processOnlinePaymentEvent({ attemptId: held.payment_attempt_id,provider: "stripe",providerPaymentId: "pi_policy_test",eventId: `evt_${held.payment_attempt_id}`,
      amountMinor: 5017,currency: "RON",outcome: "succeeded" })).toBe("expired");
    expect(await database.query("SELECT b.status::text,v.total_amount_minor,v.cancellation_notice_minutes FROM public.bookings b JOIN public.booking_revisions v ON v.id=b.current_revision_id WHERE b.id=$1",[held.booking_id]))
      .toEqual([{ status: "expired",total_amount_minor: 5017,cancellation_notice_minutes: 1440 }]);
    expect(await database.query("SELECT status::text FROM public.court_reservations WHERE id=$1",[held.reservation_id])).toEqual([{ status: "released" }]);
    expect(await database.query("SELECT reconciliation_required FROM public.payment_provider_events WHERE attempt_id=$1",[held.payment_attempt_id])).toEqual([{ reconciliation_required: true }]);
  } finally {
    await cleanupBookingFixtures({ courtIds: [courtId] });
    await database.query("DELETE FROM public.court_reservations WHERE court_id=$1",[courtId]);
    await fixture.cleanup();
  }
},30000);


test("automatic schedule cutoff rolls back with pricing failure and rejects a stale preview", async () => {
  const fixture = await hoursFixture();
  const { admin, location_id, database } = fixture;
  const pricingRepository = await import("@/lib/db/repositories/pricing.repository");
  try {
    const [initial] = await clubs.listOpeningHoursSchedules(database.manager,location_id);
    assert.ok((await mutateAdminOpeningHours({ operation: "update", location_id, schedule_id: initial.id, revision: initial.revision,
      starts_on: "0002-01-01", ends_on: null, replace_ids: [], rows: [] },admin)).ok);
    assert.ok((await mutateAdminOpeningHours({ operation: "create", location_id, starts_on: "0001-01-01", ends_on: "0001-12-31",
       replace_ids: [], rows: [{ weekdays: [0], opens_at: "09:00", closes_at: "12:00" }] },admin)).ok);
    const before = await clubs.listOpeningHoursSchedules(database.manager,location_id);
    const baseline = before.find((s) => s.id === initial.id)!;
    const hours = await clubs.listLocationOpeningHours(database.manager,location_id);
    assert.ok((await saveAdminPricingRule({ ...fixture.price, starts_on: "2026-01-01", starts_at: "07:00", ends_at: "24:00" },admin)).ok);
    const prices = await persistedPricing(fixture);
    const input = { operation: "create", location_id, starts_on: "2030-11-01", ends_on: null,
      adjustment: { id: baseline.id, revision: baseline.revision }, replace_ids: [],
      rows: [{ weekdays: [0], opens_at: "08:00", closes_at: "20:00" }] };
    const applyPricing = pricingRepository.applyOpeningHoursPricing;
    const failure = vi.spyOn(pricingRepository,"applyOpeningHoursPricing").mockImplementationOnce(async (...args) => {
      await applyPricing(...args);
      throw new Error("Injected failure after pricing writes");
    });
    try { await expect(mutateAdminOpeningHours(input,admin)).rejects.toThrow("Unable to change opening hours."); }
    finally { failure.mockRestore(); }
    expect(await clubs.listOpeningHoursSchedules(database.manager,location_id)).toEqual(before);
    expect(await clubs.listLocationOpeningHours(database.manager,location_id)).toEqual(hours);
    expect(await persistedPricing(fixture)).toEqual(prices);
    assert.ok((await mutateAdminOpeningHours({ operation: "update", location_id, schedule_id: baseline.id, revision: baseline.revision,
      starts_on: "0003-01-01", ends_on: null, replace_ids: [], rows: [] },admin)).ok);
    expect(await mutateAdminOpeningHours(input,admin)).toEqual({ ok: false, reason: "stale" });
    const latest = await clubs.listOpeningHoursSchedules(database.manager,location_id);
    expect(latest).toHaveLength(2);
    expect(latest.find((s) => s.id !== baseline.id)).toEqual(before.find((s) => s.id !== baseline.id));
    const created = await mutateAdminOpeningHours({ ...input, adjustment: { id: baseline.id, revision: baseline.revision + 1 } },admin);
    assert.ok(created.ok);
    expect((await clubs.listOpeningHoursSchedules(database.manager,location_id)).find((s) => s.id !== baseline.id && s.id !== created.scheduleId))
      .toEqual(before.find((s) => s.id !== baseline.id));
    expect((await clubs.listLocationOpeningHours(database.manager,location_id)).filter((h) => h.scheduleId !== created.scheduleId)).toEqual(hours);
  } finally { await fixture.cleanup(); }
},30000);

test("pending holds use their playing-date policy after future schedule creation", async () => {
  const fixture = await hoursFixture();
  const { service,admin,location_id,courtId,database } = fixture;
  const { insertCheckoutFixture } = await import("../checkout-fixtures");
  const { processOnlinePaymentEvent } = await import("@/lib/payments/service");
  try {
    expect((await service.from("locations").update({ is_public:true,currency:"RON" }).eq("id",location_id)).error).toBeNull();
    assert.ok((await saveAdminPricingRule({ ...fixture.price, weekdays:[0,1,2,3,4,5,6],starts_at:"07:00",ends_at:"24:00",price_per_hour:"50.17" },admin)).ok);
    const held = [];
    for (const date of ["2030-10-20","2030-11-20"]) {
      const created = await insertCheckoutFixture(service,{ p_court_id:courtId,p_booking_date:date,p_starts_at_minute:420,p_ends_at_minute:480,
        p_account_user_id:null,p_customer_name:"Pending policy",p_customer_email:"pending@example.test",p_customer_phone:"123",
        p_total_amount_minor:5017,p_currency:"RON",p_payment_method:"online",p_provider:"stripe",p_hold_seconds:600 });
      assert.strictEqual(created.error,null); held.push(created.data[0]);
    }
    assert.ok((await mutateAdminOpeningHours({ operation:"create",location_id,starts_on:"2030-11-01",ends_on:null,
      replace_ids:[],rows: [{ weekdays: [0,1,2,3,4,5,6], opens_at:"08:00", closes_at:"20:00" }] },admin)).ok);
    for (const [index,hold] of held.entries()) {
      const providerPaymentId = `pi_effective_${hold.payment_attempt_id}`;
      expect((await service.from("payment_attempts").update({ provider_payment_id:providerPaymentId }).eq("id",hold.payment_attempt_id)).error).toBeNull();
      const event = { attemptId:hold.payment_attempt_id,provider:"stripe",providerPaymentId,eventId:`evt_effective_${hold.payment_attempt_id}`,amountMinor:5017,currency:"RON",outcome:"succeeded" } as const;
      expect(await processOnlinePaymentEvent(event)).toBe(index === 0 ? "succeeded" : "expired");
      expect(await processOnlinePaymentEvent(event)).toBe(index === 0 ? "succeeded" : "expired");
      expect(await database.query("SELECT b.status::text,v.total_amount_minor FROM public.bookings b JOIN public.booking_revisions v ON v.id=b.current_revision_id WHERE b.id=$1",[hold.booking_id]))
        .toEqual([{ status:index === 0 ? "confirmed" : "expired",total_amount_minor:5017 }]);
      expect(await database.query("SELECT status::text FROM public.court_reservations WHERE id=$1",[hold.reservation_id]))
        .toEqual([{ status:index === 0 ? "active" : "released" }]);
      expect(await database.query("SELECT reconciliation_required FROM public.payment_provider_events WHERE attempt_id=$1",[hold.payment_attempt_id]))
        .toEqual([{ reconciliation_required:index === 1 }]);
    }
  } finally {
    await cleanupBookingFixtures({ courtIds: [courtId] });
    await database.query("DELETE FROM public.court_reservations WHERE court_id=$1",[courtId]);
    await fixture.cleanup();
  }
},30000);
