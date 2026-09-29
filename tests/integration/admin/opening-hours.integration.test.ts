import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { listAdminOpeningHours, saveAdminOpeningHours, removeAdminOpeningHours } from "../../../src/lib/admin/opening-hours";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

test("opening hours add/edit/remove, concurrency protection and authorization use real persistence", async () => {
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
    const input = { location_id, weekday: 0, opens_at: "07:00", closes_at: "24:00" };
    expect((await listAdminOpeningHours(admin)).filter((row) => row.location_id === location_id)).toEqual([]);
    const saved = await saveAdminOpeningHours(input, admin); assert.ok(saved.ok);
    expect((await listAdminOpeningHours(admin)).find((row) => row.id === saved.id)).toMatchObject({ opens_at_minute: 420, closes_at_minute: 1440 });
    expect(await saveAdminOpeningHours({ ...input, opens_at: "08:00", closes_at: "09:00" }, admin)).toEqual({ ok: false, reason: "overlap" });
    assert.strictEqual((await service.from("location_opening_hours").update({ updated_at: "2000-01-01T00:00:00Z" }).eq("id", saved.id)).error, null);
    expect(await saveAdminOpeningHours({ ...input, id: saved.id, closes_at: "12:00" }, admin)).toEqual({ ok: true, id: saved.id });
    const updated = (await listAdminOpeningHours(admin)).find((row) => row.id === saved.id);
    expect(updated?.closes_at_minute).toBe(720);
    expect(Date.parse(updated!.updated_at)).toBeGreaterThan(Date.parse("2000-01-01T00:00:00Z"));
    const adjacent = await saveAdminOpeningHours({ ...input, opens_at: "12:00" }, admin); assert.ok(adjacent.ok);
    // Two competing requests cannot both reserve overlapping configuration intervals.
    const competing = await Promise.all([
      saveAdminOpeningHours({ ...input, weekday: 1 }, admin),
      saveAdminOpeningHours({ ...input, weekday: 1, opens_at: "08:00" }, admin),
    ]);
    expect(competing.filter((result) => result.ok)).toHaveLength(1);
    expect(competing.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "overlap" }]);
    for (const session of [member, publicClient()]) {
      await expect(listAdminOpeningHours(session)).rejects.toThrow();
      await expect(saveAdminOpeningHours(input, session)).rejects.toThrow();
      await expect(removeAdminOpeningHours({ location_id, id: saved.id }, session)).rejects.toThrow();
      expect((await session.from("location_opening_hours").insert({ location_id, weekday: 5, opens_at_minute: 420, closes_at_minute: 1440 })).error?.code).toBe("42501");
    }
    expect(await removeAdminOpeningHours({ location_id: randomUUID(), id: saved.id }, admin)).toEqual({ ok: false, reason: "not-found" });
    expect(await removeAdminOpeningHours({ location_id, id: saved.id }, admin)).toEqual({ ok: true, id: saved.id });
    expect((await listAdminOpeningHours(admin)).some((row) => row.id === saved.id)).toBe(false);
    expect(await removeAdminOpeningHours({ location_id, id: adjacent.id }, admin)).toEqual({ ok: true, id: adjacent.id });
    expect((await listAdminOpeningHours(admin)).filter((row) => row.location_id === location_id && row.weekday === 0)).toEqual([]);
  } finally {
    if (locationIds.length) {
      assert.strictEqual((await service.from("location_opening_hours").delete().in("location_id", locationIds)).error, null);
      assert.strictEqual((await service.from("locations").delete().in("id", locationIds)).error, null);
    }
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);
