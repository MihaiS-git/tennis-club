import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { listAdminLocations, saveAdminLocation } from "../../../src/lib/admin/locations";
import { listActiveLocationsWithCourts } from "../../../src/lib/courts/public";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

test("admin location workflow uses real authorization, RLS and persistence", async () => {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const userIds: string[] = [];
  const locationIds: string[] = [];
  const password = "locations-integration-password-123";
  const publicClient = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  async function account(role?: "admin" | "coach") {
    const email = `locations-${randomUUID()}@example.test`;
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(error, null); assert.ok(data.user);
    userIds.push(data.user.id);
    if (role) assert.strictEqual((await service.from("user_roles").insert({ user_id: data.user.id, role_code: role })).error, null);
    const client = publicClient();
    assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
    return { client, id: data.user.id };
  }
  const fields = { name: `Location ${randomUUID()}`, address_line1: "Street 1", address_line2: "", city: "Cluj",
    postal_code: "400000", country_code: "RO", timezone: "Europe/Bucharest", currency: "EUR", is_active: true, display_order: 1 };
  try {
    const admin = await account("admin");
    const member = await account();
    const coach = await account("coach");
    const result = await saveAdminLocation({ fields }, admin.client);
    assert.ok(result.ok); locationIds.push(result.id);
    const original = (await listAdminLocations(admin.client)).find((row) => row.id === result.id);
    assert.ok(original);
    expect(original).toMatchObject({ name: fields.name, currency: "EUR", address_line2: null });

    expect(await saveAdminLocation({ fields }, admin.client)).toEqual({ ok: false, reason: "duplicate-slug" });
    expect(await saveAdminLocation({ fields: { ...fields, currency: "CAD" } }, admin.client)).toMatchObject({ ok: false, reason: "invalid-input" });

    // An old timestamp makes the application update contract deterministic.
    assert.strictEqual((await service.from("locations").update({ updated_at: "2000-01-01T00:00:00Z" }).eq("id", result.id)).error, null);
    for (const is_active of [false, true]) {
      expect(await saveAdminLocation({ id: result.id, fields: { ...fields, name: "Renamed location", currency: "RON", display_order: 4, is_active } }, admin.client))
        .toEqual({ ok: true, id: result.id });
      const saved = (await listAdminLocations(admin.client)).find((row) => row.id === result.id);
      expect(saved).toMatchObject({ name: "Renamed location", slug: original.slug, currency: "RON", display_order: 4, is_active });
      expect(Date.parse(saved!.updated_at)).toBeGreaterThan(Date.parse("2000-01-01T00:00:00Z"));
      const visible = await publicClient().from("locations").select("id").eq("id", result.id);
      expect(visible.error).toBeNull(); expect(visible.data).toEqual(is_active ? [{ id: result.id }] : []);
    }

    for (const session of [member.client, coach.client, publicClient()]) {
      await expect(saveAdminLocation({ fields }, session)).rejects.toThrow();
      await expect(saveAdminLocation({ id: result.id, fields }, session)).rejects.toThrow();
      await expect(listAdminLocations(session)).rejects.toThrow();
      expect((await session.from("locations").insert({ name: "Spoof", slug: `spoof-${randomUUID()}`, timezone: "UTC" })).error?.code).toBe("42501");
    }
    const suspended = await account("admin");
    assert.strictEqual((await service.from("users").update({ status: "suspended" }).eq("id", suspended.id)).error, null);
    await expect(saveAdminLocation({ id: result.id, fields }, suspended.client)).rejects.toThrow();

    // Public discovery still requires an active court, even for an active admin.
    expect((await listActiveLocationsWithCourts(admin.client)).some((row) => row.id === result.id)).toBe(false);
    const court = await service.from("courts").insert({ location_id: result.id, name: "Public fixture court",
      slug: "public-fixture", surface: "clay", environment: "outdoor" });
    assert.strictEqual(court.error, null);
    expect((await listActiveLocationsWithCourts(publicClient())).some((row) => row.id === result.id)).toBe(true);
    expect(await saveAdminLocation({ id: result.id, fields: { ...fields, is_active: false } }, admin.client)).toEqual({ ok: true, id: result.id });
    for (const session of [publicClient(), admin.client]) {
      expect((await listActiveLocationsWithCourts(session)).some((row) => row.id === result.id)).toBe(false);
    }
  } finally {
    if (locationIds.length) {
      assert.strictEqual((await service.from("courts").delete().in("location_id", locationIds)).error, null);
      assert.strictEqual((await service.from("locations").delete().in("id", locationIds)).error, null);
    }
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);
