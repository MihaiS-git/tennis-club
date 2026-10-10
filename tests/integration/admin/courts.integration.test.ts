import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test, vi } from "vitest";
import * as clubs from "../../../src/lib/db/repositories/clubs.repository";
import { listAdminCourts, saveAdminCourt } from "../../../src/lib/admin/courts";
import { selectLocationCourts } from "../../../src/app/admin/courts/inventory";
import { listPublicLocationsWithCourts } from "../../../src/lib/courts/public";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

test("court administration persists edits, moves and status with real authorization and RLS", async () => {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const userIds: string[] = [];
  const locationIds: string[] = Array.from({ length: 3 }, () => randomUUID());
  const password = "courts-integration-password-123";
  const publicClient = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  async function account(role?: "admin" | "coach") {
    const email = `courts-${randomUUID()}@example.test`;
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(error, null); assert.ok(data.user);
    userIds.push(data.user.id);
    if (role) assert.strictEqual((await service.from("user_roles").insert({ user_id: data.user.id, role_code: role })).error, null);
    const client = publicClient();
    assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
    return { client, id: data.user.id };
  }
  const fields = { location_id: locationIds[0], name: "Court One", surface: "clay", environment: "outdoor",
    has_lighting: false, is_active: true };
  try {
    assert.strictEqual((await service.from("locations").insert(locationIds.map((id, index) => ({ id,
      name: `Court fixture ${index}`, slug: `court-fixture-${id}`, timezone: "UTC", is_active: index !== 1 })))).error, null);
    const admin = await account("admin");
    const member = await account();
    const coach = await account("coach");
    const result = await saveAdminCourt({ fields }, admin.client);
    assert.ok(result.ok);
    const original = (await listAdminCourts(admin.client)).find((row) => row.id === result.id);
    assert.ok(original); expect(original.slug).toBe("court-one");
    expect(original).not.toHaveProperty("supports_balloon"); expect(original).not.toHaveProperty("balloon_installed");
    expect(await saveAdminCourt({ fields }, admin.client)).toEqual({ ok: false, reason: "duplicate-slug" });
    const sameSlug = await saveAdminCourt({ fields: { ...fields, location_id: locationIds[1].toUpperCase() } }, admin.client);
    assert.ok(sameSlug.ok);
    expect((await listAdminCourts(admin.client)).find((row) => row.id === sameSlug.id)?.slug).toBe(original.slug);
    expect(await saveAdminCourt({ fields: { ...fields, surface: "sand" } }, admin.client)).toMatchObject({ ok: false, reason: "invalid-input" });
    expect(await saveAdminCourt({ fields: { ...fields, environment: "covered" } }, admin.client)).toMatchObject({ ok: false, reason: "invalid-input" });
    expect(await saveAdminCourt({ fields: { ...fields, location_id: randomUUID() } }, admin.client)).toEqual({ ok: false, reason: "invalid-location" });

    assert.strictEqual((await service.from("courts").update({ updated_at: "2000-01-01T00:00:00Z" }).eq("id", result.id)).error, null);
    const edited = { ...fields, name: "Renamed", location_id: locationIds[2], surface: "hard", environment: "indoor", has_lighting: true };
    for (const is_active of [false, true]) {
      expect(await saveAdminCourt({ id: result.id, fields: { ...edited, is_active } }, admin.client)).toEqual({ ok: true, id: result.id });
      const saved = (await listAdminCourts(admin.client)).find((row) => row.id === result.id);
      assert.ok(saved);
      expect(saved).toMatchObject({ ...edited, slug: original.slug, is_active });
      const inventory = await listAdminCourts(admin.client);
      const options = { sort: "name", dir: "asc" } as const;
      expect(selectLocationCourts(inventory, locationIds[0], options).some((row) => row.id === result.id)).toBe(false);
      expect(selectLocationCourts(inventory, locationIds[2], options).find((row) => row.id === result.id))
        .toMatchObject({ name: "Renamed", is_active });
      expect(Date.parse(saved.updated_at)).toBeGreaterThan(Date.parse("2000-01-01T00:00:00Z"));
      const visible = (await listPublicLocationsWithCourts(publicClient())).filter((row) => locationIds.includes(row.id));
      expect(visible).toEqual([]);
    }
    expect(await saveAdminCourt({ id: result.id, fields: { ...edited, location_id: locationIds[1] } }, admin.client))
      .toEqual({ ok: false, reason: "duplicate-slug" });
    expect((await listAdminCourts(admin.client)).find((row) => row.id === result.id)?.location_id).toBe(locationIds[2]);
    // The TypeScript relationship checks reject before UPDATE; SQL FKs remain.
    const hours = await service.from("location_opening_hours").insert({ location_id: locationIds[2], weekday: 0,
      opens_at_minute: 480, closes_at_minute: 1200 });
    assert.strictEqual(hours.error, null);
    const ruleSet = await service.from("pricing_rule_sets").insert({ location_id: locationIds[2] }).select("id").single();
    assert.strictEqual(ruleSet.error, null); assert.ok(ruleSet.data);
    assert.strictEqual((await service.from("location_pricing_rules").insert({ rule_set_id: ruleSet.data.id,
      location_id: locationIds[2], court_id: result.id, court_state: "indoor", weekday: 0,
      starts_at_minute: 480, ends_at_minute: 1200, price_per_hour_minor: 1200 })).error, null);
    const writer = vi.spyOn(clubs, "updateCourt");
    expect(await saveAdminCourt({ id: result.id, fields: { ...edited, location_id: locationIds[0] } }, admin.client))
      .toEqual({ ok: false, reason: "has-pricing" });
    expect(await saveAdminCourt({ id: result.id, fields: { ...edited, environment: "outdoor" } }, admin.client))
      .toEqual({ ok: false, reason: "has-pricing" });
    expect(writer).not.toHaveBeenCalled();
    writer.mockRestore();
    expect((await listAdminCourts(admin.client)).find((row) => row.id === result.id))
      .toMatchObject({ location_id: locationIds[2], environment: "indoor" });
    expect(await saveAdminCourt({ id: randomUUID(), fields }, admin.client)).toEqual({ ok: false, reason: "not-found" });
    expect((await admin.client.from("courts").delete().eq("id", result.id)).error?.code).toBe("42501");

    for (const session of [member.client, coach.client, publicClient()]) {
      await expect(saveAdminCourt({ fields }, session)).rejects.toThrow();
      await expect(saveAdminCourt({ id: result.id, fields }, session)).rejects.toThrow();
      await expect(listAdminCourts(session)).rejects.toThrow();
      expect((await session.from("courts").insert({ ...fields, slug: `spoof-${randomUUID()}` })).error?.code).toBe("42501");
    }
    for (const session of [member.client, coach.client]) {
      const denied = await session.from("courts").update({ name: "Spoof" }).eq("id", result.id).select("id");
      expect(denied.error?.code).toBe("42501");
    }
    const suspended = await account("admin");
    assert.strictEqual((await service.from("users").update({ status: "suspended" }).eq("id", suspended.id)).error, null);
    await expect(saveAdminCourt({ id: result.id, fields }, suspended.client)).rejects.toThrow();
    await expect(listAdminCourts(suspended.client)).rejects.toThrow();
    assert.strictEqual((await service.from("courts").update({ is_active: false }).eq("id", result.id)).error, null);
    expect((await listPublicLocationsWithCourts(admin.client)).some((row) => locationIds.includes(row.id))).toBe(false);
  } finally {
    assert.strictEqual((await service.from("pricing_rule_sets").delete().in("location_id", locationIds)).error, null);
    assert.strictEqual((await service.from("location_opening_hours").delete().in("location_id", locationIds)).error, null);
    assert.strictEqual((await service.from("courts").delete().in("location_id", locationIds)).error, null);
    assert.strictEqual((await service.from("locations").delete().in("id", locationIds)).error, null);
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);
