import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { listAdminOpeningHours, mutateAdminOpeningHours } from "../../../src/lib/admin/opening-hours";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

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
    expect((await listAdminOpeningHours(admin)).filter((row) => row.location_id === location_id && row.weekday === 5)).toEqual([]);

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
    expect((await listAdminOpeningHours(admin)).filter((row) => row.location_id === location_id && row.opens_at_minute === 420)
      .every((row) => row.closes_at_minute === 720)).toBe(true);

    const removed = await mutateAdminOpeningHours({ location_id, weekdays: days,
      replace_ids: edited.intervals.filter((row) => row.opens_at_minute === 720).map((row) => row.id), intervals: [] }, admin);
    assert.ok(removed.ok);
    expect(removed.intervals).toHaveLength(5);
    expect(removed.intervals.every((row) => row.closes_at_minute === 720)).toBe(true);

    await expect(mutateAdminOpeningHours({ location_id, weekdays: [6], replace_ids: [], intervals: [{ opens_at: "08:00", closes_at: "22:00" }] }, member)).rejects.toThrow();
    expect((await member.rpc("commit_location_opening_hours", { p_actor: userIds[1], p_revision: 0, p_applicable_rule_ids: [], p_location_id: location_id, p_weekdays: [6], p_replace_ids: [], p_opens_at_minutes: [480], p_closes_at_minutes: [1320] })).error?.code).toBe("42501");
  } finally {
    if (locationIds.length) {
      assert.strictEqual((await service.from("location_opening_hours").delete().in("location_id", locationIds)).error, null);
      assert.strictEqual((await service.from("locations").delete().in("id", locationIds)).error, null);
    }
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);
