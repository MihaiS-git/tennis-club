import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, assert, expect, test, vi } from "vitest";
import type { QueryRunner } from "typeorm";
import { z } from "zod";
import { listAdminLocationOpeningHours, mutateAdminOpeningHours } from "../../../src/lib/admin/opening-hours";
import { saveAdminPricingRule } from "../../../src/lib/admin/pricing";
import { getDataSource } from "../../../src/lib/db/data-source";
import * as clubs from "../../../src/lib/db/repositories/clubs.repository";
import { localToday } from "../../../src/lib/courts/local-time";
import { mondayWeekday } from "../../../src/lib/pricing/resolution";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

beforeAll(() => { vi.stubEnv("DATABASE_POOL_MAX", "6"); });
afterAll(async () => {
  await (await getDataSource()).destroy();
  vi.unstubAllEnvs();
});

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
    const created = await mutateAdminOpeningHours({ location_id, weekdays: days, replace_ids: [], intervals: [{ opens_at: "07:00", closes_at: "24:00" }] }, admin);
    assert.ok(created.ok);
    expect(created.intervals.map((row) => row.weekday)).toEqual(days);
    expect(created.intervals.every((row) => row.opens_at_minute === 420 && row.closes_at_minute === 1440)).toBe(true);

    const conflict = await mutateAdminOpeningHours({ location_id, weekdays: [1, 5], replace_ids: [], intervals: [{ opens_at: "08:00", closes_at: "12:00" }] }, admin);
    expect(conflict).toEqual({ ok: false, reason: "overlap", weekdays: [1] });
    expect((await listAdminLocationOpeningHours(location_id, admin)).filter((row) => row.location_id === location_id && row.weekday === 5)).toEqual([]);

    const edited = await mutateAdminOpeningHours({ location_id, weekdays: days, replace_ids: created.intervals.map((row) => row.id),
      intervals: [{ opens_at: "07:00", closes_at: "12:00" }, { opens_at: "12:00", closes_at: "20:00" }] }, admin);
    assert.ok(edited.ok);
    expect(edited.intervals).toHaveLength(10);
    for (const day of days) expect(edited.intervals.filter((row) => row.weekday === day).map((row) => [row.opens_at_minute, row.closes_at_minute]))
      .toEqual([[420, 720], [720, 1200]]);

    const blockedEdit = await mutateAdminOpeningHours({ location_id, weekdays: days,
      replace_ids: edited.intervals.filter((row) => row.opens_at_minute === 420).map((row) => row.id),
      intervals: [{ opens_at: "07:00", closes_at: "13:00" }] }, admin);
    expect(blockedEdit).toEqual({ ok: false, reason: "overlap", weekdays: days });
    expect((await listAdminLocationOpeningHours(location_id, admin)).filter((row) => row.location_id === location_id && row.opens_at_minute === 420)
      .every((row) => row.closes_at_minute === 720)).toBe(true);

    const removed = await mutateAdminOpeningHours({ location_id, weekdays: days,
      replace_ids: edited.intervals.filter((row) => row.opens_at_minute === 720).map((row) => row.id), intervals: [] }, admin);
    assert.ok(removed.ok);
    expect(removed.intervals).toHaveLength(5);
    expect(removed.intervals.every((row) => row.closes_at_minute === 720)).toBe(true);

    expect(await listAdminLocationOpeningHours(location_id, admin)).toEqual(removed.intervals);
    const change = { location_id, weekdays: [6], replace_ids: [], intervals: [{ opens_at: "08:00", closes_at: "22:00" }] };
    expect(await mutateAdminOpeningHours({ ...change, replace_ids: [randomUUID()] }, admin)).toEqual({ ok: false, reason: "not-found" });
    expect(await mutateAdminOpeningHours({ ...change, location_id: randomUUID() }, admin)).toEqual({ ok: false, reason: "not-found" });
    expect(await mutateAdminOpeningHours({ ...change, intervals: [] }, admin)).toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { intervals: "Add an interval." } });
    assert.strictEqual((await service.from("locations").update({ archived_at: new Date().toISOString(), is_active: false }).eq("id", location_id)).error, null);
    expect(await mutateAdminOpeningHours(change, admin)).toEqual({ ok: false, reason: "archived" });

    await expect(mutateAdminOpeningHours({ location_id, weekdays: [6], replace_ids: [], intervals: [{ opens_at: "08:00", closes_at: "22:00" }] }, member)).rejects.toThrow();
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
  const hours = await mutateAdminOpeningHours({ location_id, weekdays: [0, 1, 2, 3, 4, 5, 6], replace_ids: [], intervals: [{ opens_at: "07:00", closes_at: "24:00" }] }, admin);
  assert.ok(hours.ok);
  const price = { location_id, court_ids: [courtId], court_state: "outdoor", weekdays: [0],
    starts_at: "10:00", ends_at: "14:00", starts_on: "", ends_on: "", price_per_hour: "12.00" };
  return { service, database, admin, userId, location_id, courtId, hours: hours.intervals, price,
    cleanup: async () => {
      assert.strictEqual((await service.from("pricing_rule_sets").delete().eq("location_id", location_id)).error, null);
      assert.strictEqual((await service.from("location_opening_hours").delete().eq("location_id", location_id)).error, null);
      assert.strictEqual((await service.from("courts").delete().eq("id", courtId)).error, null);
      assert.strictEqual((await service.from("locations").delete().eq("id", location_id)).error, null);
      await cleanupAuthFixtures(service, [userId]);
    },
  };
}

test("hours preserve pricing containment, future local occurrences, selected scope and atomic rollback", async () => {
  const fixture = await hoursFixture();
  const { admin, service, database, location_id, price, hours } = fixture;
  try {
    const applicable = await saveAdminPricingRule(price, admin); assert.ok(applicable.ok);
    const expired = await saveAdminPricingRule({ ...price, weekdays: [1], starts_on: "2000-01-01", ends_on: "2000-01-07" }, admin); assert.ok(expired.ok);
    const now = await clubs.readOpeningHoursConfigurationTime(database.manager);
    const today = localToday("Pacific/Kiritimati", now);
    const noOccurrenceDay = (mondayWeekday(today) + 1) % 7;
    const noOccurrence = await saveAdminPricingRule({ ...price, weekdays: [noOccurrenceDay], court_state: "covered", starts_on: today, ends_on: today }, admin); assert.ok(noOccurrence.ok);
    const change = { location_id, weekdays: [0], replace_ids: hours.filter((row) => row.weekday === 0).map((row) => row.id),
      intervals: [{ opens_at: "07:00", closes_at: "12:00" }, { opens_at: "12:00", closes_at: "24:00" }] };
    expect(await mutateAdminOpeningHours(change, admin)).toMatchObject({ ok: false, reason: "pricing-conflict",
      message: "These opening hours conflict with existing pricing on Monday (10:00–14:00). Update or remove the conflicting pricing rule before changing the opening hours." });
    expect(await listAdminLocationOpeningHours(location_id, admin)).toEqual(hours);
    expect(await mutateAdminOpeningHours({ ...change, replace_ids: [], intervals: [{ opens_at: "08:00", closes_at: "12:00" }] }, admin))
      .toEqual({ ok: false, reason: "overlap", weekdays: [0] });
    expect(await listAdminLocationOpeningHours(location_id, admin)).toEqual(hours);

    // A failure after deletion must roll back all earlier writes.
    const reload = clubs.listLocationOpeningHours;
    const spy = vi.spyOn(clubs, "listLocationOpeningHours").mockImplementationOnce(reload)
      .mockRejectedValueOnce(new Error("Injected transaction reload failure"));
    try {
      await expect(mutateAdminOpeningHours({ ...change, intervals: [{ opens_at: "08:00", closes_at: "20:00" }] }, admin))
        .rejects.toThrow("Unable to refresh opening hours.");
    } finally { spy.mockRestore(); }
    expect(await listAdminLocationOpeningHours(location_id, admin)).toEqual(hours);

    // Exercise the retained PostgreSQL overlap invariant after candidate validation.
    const insert = clubs.insertOpeningHours;
    const failedInsert = vi.spyOn(clubs, "insertOpeningHours").mockImplementationOnce((manager, rows) =>
      insert(manager, [...rows, ...rows]));
    try {
      expect(await mutateAdminOpeningHours({ ...change, intervals: [{ opens_at: "07:00", closes_at: "20:00" }] }, admin))
        .toMatchObject({ ok: false, reason: "overlap" });
    } finally { failedInsert.mockRestore(); }
    expect(await listAdminLocationOpeningHours(location_id, admin)).toEqual(hours);

    const days = [...new Set([1, noOccurrenceDay])].filter((day) => day !== 0);
    const edited = await mutateAdminOpeningHours({ location_id, weekdays: days,
      replace_ids: hours.filter((row) => days.includes(row.weekday)).map((row) => row.id),
      intervals: [{ opens_at: "07:00", closes_at: "09:00" }] }, admin);
    assert.ok(edited.ok);
    expect(edited.intervals.filter((row) => days.includes(row.weekday)).every((row) => row.closes_at_minute === 540)).toBe(true);
    const applicableRows = await service.from("location_pricing_rules").select("id").eq("rule_set_id", applicable.id);
    assert.strictEqual(applicableRows.error, null);
    expect((await service.from("location_pricing_rules").select("id").eq("location_id", location_id)).data).toHaveLength(3);
    expect((await service.from("locations").select("is_public").eq("id", location_id).single()).data?.is_public).toBe(false);
  } finally { await fixture.cleanup(); }
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

test.each(["hours"] as const)("%s-first hours/pricing race commits exactly one coherent configuration", async (first) => {
  const fixture = await hoursFixture();
  const { database, admin, location_id, hours, price } = fixture;
  const blocker = database.createQueryRunner(); const observer = database.createQueryRunner();
  await blocker.connect(); await observer.connect();
  const pending: Promise<unknown>[] = [];
  try {
    await blocker.startTransaction();
    // Parent-only probe: the first writer acquires global, then blocks here.
    await clubs.lockLocations(blocker.manager, [location_id]);
    const changeHours = () => mutateAdminOpeningHours({ location_id, weekdays: [0],
      replace_ids: hours.filter((row) => row.weekday === 0).map((row) => row.id),
      intervals: [{ opens_at: "07:00", closes_at: "12:00" }] }, admin);
    const changePricing = () => saveAdminPricingRule(price, admin);
    const firstOperation = first === "hours" ? changeHours() : changePricing(); pending.push(firstOperation);
    const firstPid = await waitForWriter(observer, await backendPid(blocker), "locations");
    const secondOperation = first === "hours" ? changePricing() : changeHours(); pending.push(secondOperation);
    await waitForWriter(observer, firstPid, "pg_advisory_xact_lock");
    await blocker.commitTransaction();
    const firstResult = await firstOperation; const secondResult = await secondOperation;
    expect(firstResult).toMatchObject({ ok: true });
    expect(secondResult).toMatchObject({ ok: false, reason: first === "hours" ? "invalid-input" : "pricing-conflict" });
    const savedHours = await listAdminLocationOpeningHours(location_id, admin);
    expect(savedHours.find((row) => row.weekday === 0)?.closes_at_minute).toBe(first === "hours" ? 720 : 1440);
    const rules = await fixture.service.from("location_pricing_rules").select("id").eq("location_id", location_id);
    assert.strictEqual(rules.error, null);
    expect(rules.data).toHaveLength(first === "hours" ? 0 : 1);
  } finally {
    if (blocker.isTransactionActive) await blocker.rollbackTransaction();
    await Promise.allSettled(pending);
    await blocker.release(); await observer.release();
    await fixture.cleanup();
  }
}, 30000);

test.each(["suspension"] as const)("transaction-time Admin recheck rejects %s after initial authorization", async (change) => {
  const fixture = await hoursFixture();
  const { database, admin, location_id, userId } = fixture;
  const blocker = database.createQueryRunner(); const observer = database.createQueryRunner();
  await blocker.connect(); await observer.connect();
  let operation: Promise<unknown> | undefined;
  try {
    await blocker.startTransaction();
    await clubs.lockConfigurationForWrite(blocker.manager);
    operation = mutateAdminOpeningHours({ location_id, weekdays: [0], replace_ids: [], intervals: [{ opens_at: "00:00", closes_at: "06:00" }] }, admin);
    // Attach a rejection observer before releasing the transaction fence.
    const rejected = expect(operation).rejects.toThrow("Unable to change opening hours.");
    await waitForWriter(observer, await backendPid(blocker), "pg_advisory_xact_lock");
    if (change === "suspension") {
      expect((await fixture.service.from("users").update({ status: "suspended" }).eq("id", userId)).error).toBeNull();
    } else {
      expect((await fixture.service.from("user_roles").delete().eq("user_id", userId).eq("role_code", "admin")).error).toBeNull();
    }
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
