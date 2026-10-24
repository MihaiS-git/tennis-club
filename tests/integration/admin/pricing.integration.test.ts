import { insertOpeningHoursFixture } from "../opening-hours-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, assert, expect, test, vi } from "vitest";
import { z } from "zod";
import type { QueryRunner } from "typeorm";
import { getDataSource } from "../../../src/lib/db/data-source";
import * as pricing from "../../../src/lib/db/repositories/pricing.repository";
import * as clubs from "../../../src/lib/db/repositories/clubs.repository";
import { listAdminPricingRules, saveAdminPricingRule, removeAdminPricingRule } from "../../../src/lib/admin/pricing";
import { mutateAdminOpeningHours } from "../../../src/lib/admin/opening-hours";
import { localToday } from "../../../src/lib/courts/local-time";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

beforeAll(() => { vi.stubEnv("DATABASE_POOL_MAX", "6"); });
afterAll(async () => {
  try {
    await (await getDataSource()).destroy();
  } finally {
    vi.unstubAllEnvs();
  }
});

async function revision(locationId: string, setId: string, admin: Parameters<typeof listAdminPricingRules>[1]) {
  return (await listAdminPricingRules(locationId,admin)).find((r) => r.rule_set_id === setId)?.revision ?? "missing";
}

test("multi-court rule-set lifecycle is atomic and scoped to active admins", async () => {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const userIds: string[] = [];
  let location_id: string | undefined;
  const password = "pricing-integration-password-123";
  async function account(admin = false) {
    const email = `pricing-${randomUUID()}@example.test`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(created.error, null); assert.ok(created.data.user); userIds.push(created.data.user.id);
    if (admin) assert.strictEqual((await service.from("user_roles").insert({ user_id: created.data.user.id, role_code: "admin" })).error, null);
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
    return client;
  }
  try {
    const admin = await account(true); const member = await account();
    const location = await service.from("locations").insert({ name: "Pricing fixture", slug: `pricing-${randomUUID()}`, timezone: "Europe/Bucharest", currency: "RON" }).select("id").single();
    assert.strictEqual(location.error, null); assert.ok(location.data); location_id = location.data.id;
    const pricingLocationId = location.data.id;
    const courtRows = ["One", "Two", "Three"].map((name) => ({ location_id, name, slug: `${name.toLowerCase()}-${randomUUID()}`, surface: "clay", environment: "outdoor" }));
    const createdCourts = await service.from("courts").insert(courtRows).select("id, name");
    assert.strictEqual(createdCourts.error, null); assert.ok(createdCourts.data);
    const courtIds = new Map(createdCourts.data.map((court) => [court.name, court.id]));
    const court1 = courtIds.get("One")!; const court2 = courtIds.get("Two")!; const court3 = courtIds.get("Three")!;
    const hours = await insertOpeningHoursFixture(service, [0, 1, 2, 3, 4, 5, 6].map((weekday) =>
      ({ location_id, weekday, opens_at_minute: 420, closes_at_minute: 1440 })));
    assert.strictEqual(hours.error, null);
    const base = { location_id, court_ids: [court1, court2], court_state: "outdoor", weekdays: [0, 1, 2, 3, 4],
      starts_at: "07:00", ends_at: "16:00", starts_on: "", ends_on: "", price_per_hour: "12.00" };
    const created = await saveAdminPricingRule(base, admin); assert.ok(created.ok);
    const setId = created.id;
    const parent = await service.from("pricing_rule_sets").select("id, location_id, created_at").eq("id", setId).single();
    assert.strictEqual(parent.error, null); assert.ok(parent.data);
    const originalChildren = await service.from("location_pricing_rules").select("id").eq("rule_set_id", setId);
    assert.strictEqual(originalChildren.error, null); expect(originalChildren.data).toHaveLength(10);
    let atomic = await service.from("location_pricing_rules").select("court_id, weekday, starts_at_minute, ends_at_minute").eq("rule_set_id", setId);
    assert.strictEqual(atomic.error, null); expect(atomic.data).toHaveLength(10);
    expect(await listAdminPricingRules(pricingLocationId, admin)).toMatchObject([{ rule_set_id: setId, revision: await revision(pricingLocationId,setId,admin), court_ids: [court1, court2].sort(), weekdays: [0, 1, 2, 3, 4] }]);
    expect(await saveAdminPricingRule({ ...base, rule_set_id: setId, revision: await revision(pricingLocationId,setId,admin), weekdays: [0, 1, 2, 3], court_ids: [court1, court3], ends_at: "20:00" }, admin))
      .toEqual({ ok: true, id: setId });
    atomic = await service.from("location_pricing_rules").select("court_id, weekday, starts_at_minute, ends_at_minute").eq("rule_set_id", setId);
    assert.strictEqual(atomic.error, null); expect(atomic.data).toHaveLength(8);
    expect((await listAdminPricingRules(pricingLocationId, admin)).find((row) => row.rule_set_id === setId))
      .toMatchObject({ location_id: pricingLocationId, court_ids: [court1, court3].sort(), weekdays: [0, 1, 2, 3], ends_at_minute: 1200 });
    expect(new Set(atomic.data!.map((row) => row.court_id))).toEqual(new Set([court1, court3]));
    expect(new Set(atomic.data!.map((row) => row.weekday))).toEqual(new Set([0, 1, 2, 3]));
    expect((await service.from("pricing_rule_sets").select("id, location_id, created_at").eq("id", setId).single()).data).toEqual(parent.data);
    const replacementChildren = await service.from("location_pricing_rules").select("id").eq("rule_set_id", setId);
    assert.strictEqual(replacementChildren.error, null); assert.ok(replacementChildren.data);
    expect(replacementChildren.data.every((row) => !originalChildren.data!.some((old) => old.id === row.id))).toBe(true);
    const replacementIds = replacementChildren.data.map((row) => row.id).sort();
    // A distinct court can have exactly the same schedule; adjacent intervals on one court also work.
    const sameOtherCourt = await saveAdminPricingRule({ ...base, court_ids: [court2], weekdays: [0], ends_at: "20:00" }, admin);
    assert.ok(sameOtherCourt.ok);
    const adjacent = await saveAdminPricingRule({ ...base, court_ids: [court1], weekdays: [0], starts_at: "20:00", ends_at: "24:00" }, admin);
    assert.ok(adjacent.ok);
    const conflict = await saveAdminPricingRule({ ...base, court_ids: [court1], weekdays: [0], starts_at: "19:59", ends_at: "21:00" }, admin);
    expect(conflict).toEqual({ ok: false, reason: "overlap" });
    const writer = vi.spyOn(pricing, "insertPricingRules");
    const competing = await Promise.all([
      saveAdminPricingRule({ ...base, court_ids: [court2], weekdays: [6], starts_at: "07:00", ends_at: "12:00" }, admin),
      saveAdminPricingRule({ ...base, court_ids: [court2], weekdays: [6], starts_at: "08:00", ends_at: "13:00" }, admin),
    ]);
    expect(competing.filter((result) => result.ok)).toHaveLength(1);
    expect(competing.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "overlap" }]);
    expect(writer).toHaveBeenCalledTimes(1);
    writer.mockRestore();
    const parents = await service.from("pricing_rule_sets").select("id").eq("location_id", location_id);
    const children = await service.from("location_pricing_rules").select("rule_set_id").eq("location_id", location_id);
    assert.strictEqual(parents.error, null); assert.strictEqual(children.error, null);
    expect(parents.data!.map((row) => row.id).sort()).toEqual([...new Set(children.data!.map((row) => row.rule_set_id))].sort());
    const beforeConflict = atomic.data;
    expect(await saveAdminPricingRule({ ...base, rule_set_id: setId, revision: await revision(pricingLocationId,setId,admin), court_ids: [court1, court3], weekdays: [0, 1, 2, 3, 4], ends_at: "21:00" }, admin))
      .toEqual({ ok: false, reason: "overlap" });
    const afterConflict = await service.from("location_pricing_rules").select("court_id, weekday, starts_at_minute, ends_at_minute").eq("rule_set_id", setId);
    assert.strictEqual(afterConflict.error, null); expect(afterConflict.data).toEqual(beforeConflict);
    expect((await service.from("location_pricing_rules").select("id").eq("rule_set_id", setId)).data?.map((row) => row.id).sort()).toEqual(replacementIds);
    expect((await service.from("pricing_rule_sets").select("id, location_id, created_at").eq("id", setId).single()).data).toEqual(parent.data);
    // Opening hours take priority; deletion removes only Monday pricing.
    const [schedule] = await clubs.listOpeningHoursSchedules((await getDataSource()).manager, pricingLocationId);
    const deletionHours = await service.from("location_opening_hours").select("id").eq("location_id", location_id).eq("weekday", 0);
    assert.strictEqual(deletionHours.error, null); assert.ok(deletionHours.data);
    expect(await mutateAdminOpeningHours({ operation: "update", schedule_id: schedule.id, revision: schedule.revision, location_id,
      replace_ids: deletionHours.data.map((row) => row.id), rows: [] }, admin))
      .toMatchObject({ ok: true, pricingAdjusted: true });
    expect((await service.from("location_opening_hours").select("weekday").eq("location_id", location_id).eq("weekday", 0)).data).toHaveLength(0);
    const afterHours = await service.from("location_pricing_rules").select("court_id, weekday, starts_at_minute, ends_at_minute").eq("rule_set_id", setId);
    expect(afterHours.data).toEqual(beforeConflict!.filter((r) => r.weekday !== 0));
    const sundayHours = await service.from("location_opening_hours").select("id").eq("location_id", location_id).eq("weekday", 6).single();
    assert.strictEqual(sundayHours.error, null); assert.ok(sundayHours.data);
    const [updatedSchedule] = await clubs.listOpeningHoursSchedules((await getDataSource()).manager, pricingLocationId);
    const [hoursRace, pricingRace] = await Promise.all([
      mutateAdminOpeningHours({ operation: "update", schedule_id: updatedSchedule.id, revision: updatedSchedule.revision, location_id, replace_ids: [sundayHours.data.id],
        rows: [{ weekdays: [6], opens_at: "07:00", closes_at: "20:00" }] }, admin),
      saveAdminPricingRule({ ...base, court_ids: [court3], weekdays: [6], starts_at: "18:00", ends_at: "21:00" }, admin),
    ]);
    expect(hoursRace.ok).toBe(true);
    if (!pricingRace.ok) expect(pricingRace).toMatchObject({ reason: "invalid-input", fieldErrors: { ends_at: expect.any(String) } });
    const sundayClose = (await service.from("location_opening_hours").select("closes_at_minute").eq("location_id", location_id).eq("weekday", 6).single()).data?.closes_at_minute;
    const sundayPrice = (await service.from("location_pricing_rules").select("ends_at_minute,ends_on").eq("location_id", location_id)
      .eq("weekday", 6).eq("court_id", court3).eq("starts_at_minute", 1080)).data ?? [];
    expect(sundayClose).toBe(1200);
    // A pricing save that won the race is trimmed from the location's today; the slice ending
    // yesterday is retained history. Use the location date, not UTC, which can lag it.
    const today = localToday("Europe/Bucharest", new Date());
    expect(sundayPrice.filter((row) => !row.ends_on || row.ends_on >= today).every((row) => row.ends_at_minute <= 1200)).toBe(true);
    await expect(listAdminPricingRules(pricingLocationId, member)).rejects.toThrow();
    await expect(saveAdminPricingRule(base, member)).rejects.toThrow();
    await expect(removeAdminPricingRule({ location_id, rule_set_id: setId, revision: await revision(pricingLocationId,setId,admin) }, member)).rejects.toThrow();
    expect(await removeAdminPricingRule({ location_id: randomUUID(), rule_set_id: setId, revision: "missing" }, admin)).toEqual({ ok: false, reason: "not-found" });
    expect(await removeAdminPricingRule({ location_id, rule_set_id: setId, revision: await revision(pricingLocationId,setId,admin) }, admin)).toEqual({ ok: true, id: setId });
    expect((await service.from("location_pricing_rules").select("id").eq("rule_set_id", setId)).data).toEqual([]);
    expect((await service.from("pricing_rule_sets").select("id").eq("id", setId)).data).toEqual([]);
    expect((await listAdminPricingRules(pricingLocationId, admin)).some((row) => row.rule_set_id === setId)).toBe(false);
    expect(await removeAdminPricingRule({ location_id, rule_set_id: setId, revision: await revision(pricingLocationId,setId,admin) }, admin)).toEqual({ ok: false, reason: "not-found" });
  } finally {
    if (location_id) {
      assert.strictEqual((await service.from("pricing_rule_sets").delete().eq("location_id", location_id)).error, null);
      assert.strictEqual((await service.from("location_opening_hours").delete().eq("location_id", location_id)).error, null);
      assert.strictEqual((await service.from("courts").delete().eq("location_id", location_id)).error, null);
      assert.strictEqual((await service.from("locations").delete().eq("id", location_id)).error, null);
    }
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);

async function pricingLockFixture() {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const database = await getDataSource();
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(process.env.DATABASE_URL!).hostname);
  const email = `pricing-lock-${randomUUID()}@example.test`;
  const password = "pricing-lock-password-123";
  const actor = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.strictEqual(actor.error, null); assert.ok(actor.data.user);
  const userId = actor.data.user.id;
  const location_id = randomUUID(); const otherLocationId = randomUUID(); const courtId = randomUUID();
  const cleanup = async () => {
    assert.strictEqual((await service.from("pricing_rule_sets").delete().eq("location_id", location_id)).error, null);
    assert.strictEqual((await service.from("location_opening_hours").delete().eq("location_id", location_id)).error, null);
    assert.strictEqual((await service.from("courts").delete().eq("id", courtId)).error, null);
    assert.strictEqual((await service.from("locations").delete().in("id", [location_id, otherLocationId])).error, null);
    await cleanupAuthFixtures(service, [userId]);
  };
  try {
    assert.strictEqual((await service.from("user_roles").insert({ user_id: userId, role_code: "admin" })).error, null);
    const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    assert.strictEqual((await admin.auth.signInWithPassword({ email, password })).error, null);
    assert.strictEqual((await service.from("locations").insert([location_id, otherLocationId].map((id) => ({
      id, name: "Pricing lock", slug: `pricing-lock-${id}`, timezone: "UTC", is_active: false,
    })))).error, null);
    assert.strictEqual((await service.from("courts").insert({ id: courtId, location_id, name: "Pricing lock court",
      slug: `pricing-lock-${courtId}`, surface: "clay", environment: "outdoor", is_active: false })).error, null);
    assert.strictEqual((await insertOpeningHoursFixture(service, { location_id, weekday: 0, opens_at_minute: 420, closes_at_minute: 1440 })).error, null);
    assert.strictEqual((await service.from("locations").update({ archived_at: new Date().toISOString() }).eq("id", location_id)).error, null);
    const definition = { location_id, court_ids: [courtId], court_state: "outdoor", weekdays: [0], starts_at: "07:00", ends_at: "12:00",
      starts_on: "2099-01-01", ends_on: "2099-12-31", price_per_hour: "12.34" };
    return { service, database, admin, userId, location_id, otherLocationId, definition, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function pricingBackendPid(runner: QueryRunner) {
  const rows: unknown = await runner.query("SELECT pg_backend_pid() AS pid");
  return z.array(z.object({ pid: z.number().int() })).length(1).parse(rows)[0].pid;
}

test("creating and editing Covered pricing preserves Outdoor rules for the same court and schedule", async () => {
  const fixture = await pricingLockFixture();
  const { admin, location_id, definition } = fixture;
  try {
    const outdoor = await saveAdminPricingRule(definition, admin); assert.ok(outdoor.ok);
    const original = (await listAdminPricingRules(location_id, admin)).find((rule) => rule.rule_set_id === outdoor.id);
    assert.ok(original);
    const covered = await saveAdminPricingRule({ ...definition, court_state: "covered", price_per_hour: "25.00" }, admin);
    assert.ok(covered.ok);
    expect(covered.id).not.toBe(outdoor.id);
    const rules = await listAdminPricingRules(location_id, admin);
    expect(rules).toHaveLength(2);
    expect(rules.find((rule) => rule.rule_set_id === outdoor.id)).toEqual(original);
    const winter = rules.find((rule) => rule.rule_set_id === covered.id); assert.ok(winter);
    expect(winter).toMatchObject({ court_ids: original.court_ids, court_state: "covered", price_per_hour_minor: 2500 });
    expect(await saveAdminPricingRule({ ...definition, rule_set_id: winter.rule_set_id, revision: winter.revision,
      court_state: "covered", price_per_hour: "30.00" }, admin)).toEqual({ ok: true, id: covered.id });
    const updated = await listAdminPricingRules(location_id, admin);
    expect(updated.find((rule) => rule.rule_set_id === outdoor.id)).toEqual(original);
    expect(updated.find((rule) => rule.rule_set_id === covered.id)).toMatchObject({ court_state: "covered", price_per_hour_minor: 3000 });
  } finally { await fixture.cleanup(); }
}, 30000);

async function waitForPricingWriter(observer: QueryRunner, blocker: number, queryPart: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows: unknown = await observer.query("SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [blocker]);
    const blocked = z.array(z.object({ query: z.string() })).parse(rows);
    if (blocked.some((row) => row.query.includes(queryPart))) return;
  }
  throw new Error("Expected pricing writer lock wait was not observed.");
}

test.each(["create", "remove"] as const)("pricing %s waits for its location aggregate and preserves existing resource eligibility", async (kind) => {
  const fixture = await pricingLockFixture();
  const { database, admin, location_id, definition } = fixture;
  const blocker = database.createQueryRunner(); const observer = database.createQueryRunner();
  await blocker.connect(); await observer.connect();
  let operation: Promise<unknown> | undefined;
  try {
    const initial = kind === "create" ? null : await saveAdminPricingRule(definition, admin);
    if (initial) assert.ok(initial.ok);
    const setId = initial?.ok ? initial.id : undefined;
    if (setId) expect(await removeAdminPricingRule({ location_id: fixture.otherLocationId, rule_set_id: setId, revision: "missing" }, admin)).toEqual({ ok: false, reason: "not-found" });
    await blocker.startTransaction();
    // Parent-only probe permits the writer to acquire global before waiting here.
    await clubs.lockLocations(blocker.manager, [location_id]);
    operation = kind === "remove"
      ? removeAdminPricingRule({ location_id, rule_set_id: setId, revision: await revision(location_id,setId!,admin) }, admin)
      : saveAdminPricingRule({ ...definition, ...(setId ? { rule_set_id: setId, revision: await revision(location_id,setId,admin), ends_at: "13:00" } : {}) }, admin);
    await waitForPricingWriter(observer, await pricingBackendPid(blocker), "locations");
    await blocker.commitTransaction();
    expect(await operation).toMatchObject({ ok: true, ...(setId ? { id: setId } : {}) });
    const listed = await listAdminPricingRules(location_id, admin);
    if (kind === "remove") expect(listed).toEqual([]);
    else expect(listed).toMatchObject([{ starts_on: "2099-01-01", ends_on: "2099-12-31", price_per_hour_minor: 1234,
      ends_at_minute: 720 }]);
  } finally {
    if (blocker.isTransactionActive) await blocker.rollbackTransaction();
    if (operation) await Promise.allSettled([operation]);
    await blocker.release(); await observer.release();
    await fixture.cleanup();
  }
}, 30000);

test("pricing rejects an Admin whose role was removed after initial authorization", async () => {
  const fixture = await pricingLockFixture();
  const { database, admin, definition, userId } = fixture;
  const blocker = database.createQueryRunner(); const observer = database.createQueryRunner();
  await blocker.connect(); await observer.connect();
  let operation: Promise<unknown> | undefined;
  try {
    await blocker.startTransaction();
    await clubs.lockConfigurationForWrite(blocker.manager);
    operation = saveAdminPricingRule(definition, admin);
    const rejected = expect(operation).rejects.toThrow("Unable to change pricing rules.");
    await waitForPricingWriter(observer, await pricingBackendPid(blocker), "pg_advisory_xact_lock");
    expect((await fixture.service.from("user_roles").delete().eq("user_id", userId).eq("role_code", "admin")).error).toBeNull();
    await blocker.commitTransaction(); await rejected;
    expect((await fixture.service.from("pricing_rule_sets").select("id").eq("location_id", fixture.location_id)).data).toEqual([]);
  } finally {
    if (blocker.isTransactionActive) await blocker.rollbackTransaction();
    if (operation) await Promise.allSettled([operation]);
    await blocker.release(); await observer.release();
    await fixture.cleanup();
  }
}, 30000);

test("concurrent pricing edits and stale removal cannot overwrite the winning definition", async () => {
  const fixture = await pricingLockFixture();
  const { admin,location_id,definition } = fixture;
  try {
    const created = await saveAdminPricingRule(definition,admin); assert.ok(created.ok);
    const original = (await listAdminPricingRules(location_id,admin)).find((r) => r.rule_set_id === created.id)!;
    const intent = { ...definition,rule_set_id:created.id,revision:original.revision };
    const results = await Promise.all([saveAdminPricingRule({ ...intent,price_per_hour:"15.00" },admin),saveAdminPricingRule({ ...intent,price_per_hour:"20.00" },admin)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok:false,reason:"stale" });
    const winner = await listAdminPricingRules(location_id,admin);
    expect(winner).toHaveLength(1);
    expect([1500,2000]).toContain(winner[0].price_per_hour_minor);
    expect(await removeAdminPricingRule({ location_id,rule_set_id:created.id,revision:original.revision },admin)).toEqual({ ok:false,reason:"stale" });
    expect(await listAdminPricingRules(location_id,admin)).toEqual(winner);
  } finally { await fixture.cleanup(); }
},30000);
