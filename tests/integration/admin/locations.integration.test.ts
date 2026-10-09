import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { listAdminLocations, listAdminLocationsWithReadiness, saveAdminLocation, setAdminLocationArchived, setAdminLocationPublication } from "../../../src/lib/admin/locations";
import { listPublicLocationsWithCourts } from "../../../src/lib/courts/public";
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
    postal_code: "400000", country_code: "RO", timezone: "Europe/Bucharest", currency: "EUR", is_active: true, is_public: false, display_order: 1, customer_cancellation_notice_minutes: 1440 };
  try {
    const admin = await account("admin");
    const member = await account();
    const coach = await account("coach");
    const result = await saveAdminLocation({ fields: { ...fields, is_public: true } }, admin.client);
    assert.ok(result.ok); locationIds.push(result.id);
    const original = (await listAdminLocations(admin.client)).find((row) => row.id === result.id);
    assert.ok(original);
    expect(original).toMatchObject({ name: fields.name, is_public: false, currency: "EUR", address_line2: null, customer_cancellation_notice_minutes: 1440 });

    expect(await saveAdminLocation({ fields }, admin.client)).toEqual({ ok: false, reason: "duplicate-slug" });
    expect(await saveAdminLocation({ fields: { ...fields, currency: "CAD" } }, admin.client)).toMatchObject({ ok: false, reason: "invalid-input" });

    for (const notice of [-1, 43201, 1.5]) {
      expect(await saveAdminLocation({ id: result.id, fields: { ...fields,
        customer_cancellation_notice_minutes: notice } }, admin.client)).toMatchObject({ ok: false, reason: "invalid-input" });
    }
    const selected = await saveAdminLocation({ fields: { ...fields, name: `Selected ${randomUUID()}`,
      customer_cancellation_notice_minutes: 0 } }, admin.client);
    assert.ok(selected.ok); locationIds.push(selected.id);
    expect((await listAdminLocations(admin.client)).find((row) => row.id === selected.id))
      .toMatchObject({ customer_cancellation_notice_minutes: 0 });

    // An old timestamp makes the application update contract deterministic.
    assert.strictEqual((await service.from("locations").update({ updated_at: "2000-01-01T00:00:00Z" }).eq("id", result.id)).error, null);
    for (const is_active of [false, true]) {
      expect(await saveAdminLocation({ id: result.id, fields: { ...fields, name: "Renamed location", currency: "RON", display_order: 4, customer_cancellation_notice_minutes: 120, is_active } }, admin.client))
        .toEqual({ ok: true, id: result.id });
      const saved = (await listAdminLocations(admin.client)).find((row) => row.id === result.id);
      expect(saved).toMatchObject({ name: "Renamed location", slug: original.slug, currency: "RON", display_order: 4, customer_cancellation_notice_minutes: 120, is_active });
      expect(Date.parse(saved!.updated_at)).toBeGreaterThan(Date.parse("2000-01-01T00:00:00Z"));
      const visible = await publicClient().from("locations").select("id").eq("id", result.id);
      expect(visible.error?.code).toBe("42501");
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

    expect((await listAdminLocationsWithReadiness("current", result.id, admin.client))[0].missing)
      .toEqual(["opening hours", "an active court"]);
    expect(await setAdminLocationPublication({ id: result.id, is_public: true }, admin.client))
      .toMatchObject({ ok: false, reason: "not-ready", message: expect.stringContaining("opening hours") });
    await expect(setAdminLocationPublication({ id: result.id, is_public: true }, member.client)).rejects.toThrow();

    // Public discovery still requires an active court, even for an active admin.
    expect((await listPublicLocationsWithCourts(admin.client)).some((row) => row.id === result.id)).toBe(false);
    expect(await saveAdminLocation({ id: result.id, fields: { ...fields, is_public: true } }, admin.client))
      .toMatchObject({ ok: false, reason: "not-ready", message: expect.stringContaining("opening hours") });
    const court = await service.from("courts").insert({ location_id: result.id, name: "Public fixture court",
      slug: "public-fixture", surface: "clay", environment: "outdoor" }).select("id").single();
    assert.strictEqual(court.error, null);
    expect((await service.from("location_opening_hours").insert({ location_id: result.id, weekday: 0,
      opens_at_minute: 480, closes_at_minute: 1200 })).error).toBeNull();
    expect(await saveAdminLocation({ id: result.id, fields: { ...fields, is_public: true } }, admin.client))
      .toMatchObject({ ok: false, reason: "not-ready", message: expect.stringContaining("pricing") });
    const ruleSet = await service.from("pricing_rule_sets").insert({ location_id: result.id }).select("id").single();
    assert.strictEqual(ruleSet.error, null);
    expect((await service.from("location_pricing_rules").insert({ location_id: result.id, rule_set_id: ruleSet.data!.id,
      court_id: court.data!.id, court_state: "outdoor", weekday: 0, starts_at_minute: 480,
      ends_at_minute: 1200, price_per_hour_minor: 5000 })).error).toBeNull();
    expect((await listAdminLocationsWithReadiness("current", result.id, admin.client))[0].missing).toEqual([]);
    expect(await setAdminLocationPublication({ id: result.id, is_public: true }, admin.client)).toEqual({ ok: true, id: result.id });
    expect((await listAdminLocations(admin.client)).find((row) => row.id === result.id))
      .toMatchObject({ name: "Renamed location", currency: "RON", is_public: true, customer_cancellation_notice_minutes: 120 });
    expect((await listPublicLocationsWithCourts(publicClient())).some((row) => row.id === result.id)).toBe(true);
    expect(await saveAdminLocation({ id: result.id, fields: { ...fields, is_public: false } }, admin.client)).toEqual({ ok: true, id: result.id });
    expect((await listPublicLocationsWithCourts(publicClient())).some((row) => row.id === result.id)).toBe(false);
    expect(await saveAdminLocation({ id: result.id, fields: { ...fields, is_public: true, currency: "GBP" } }, admin.client)).toEqual({ ok: true, id: result.id });
    expect((await listAdminLocations(admin.client)).find((row) => row.id === result.id)?.currency).toBe("GBP");
    expect(await setAdminLocationArchived({ id: result.id, archived: true }, admin.client)).toEqual({ ok: true, id: result.id });
    expect((await listAdminLocations(admin.client)).some((row) => row.id === result.id)).toBe(false);
    expect((await listAdminLocations(admin.client, "archived")).find((row) => row.id === result.id)).toMatchObject({ is_active: false, archived_at: expect.any(String) });
    expect((await service.from("locations").select("id, is_active, archived_at").eq("id", result.id).single()).data)
      .toMatchObject({ id: result.id, is_active: false, archived_at: expect.any(String) });
    expect((await publicClient().from("locations").select("id").eq("id", result.id)).error?.code).toBe("42501");
    expect((await publicClient().from("courts").select("id").eq("location_id", result.id)).error?.code).toBe("42501");
    expect((await listPublicLocationsWithCourts(publicClient())).some((row) => row.id === result.id)).toBe(false);
    expect(await setAdminLocationArchived({ id: result.id, archived: false }, admin.client)).toEqual({ ok: true, id: result.id });
    expect((await listAdminLocations(admin.client)).find((row) => row.id === result.id)).toMatchObject({ is_active: false, archived_at: null });
    expect((await listAdminLocations(admin.client, "archived")).some((row) => row.id === result.id)).toBe(false);
    for (const session of [member.client, coach.client, publicClient()]) {
      await expect(setAdminLocationArchived({ id: result.id, archived: true }, session)).rejects.toThrow();
    }
    expect(await saveAdminLocation({ id: result.id, fields: { ...fields, is_active: false } }, admin.client)).toEqual({ ok: true, id: result.id });
    for (const session of [publicClient(), admin.client]) {
      expect((await listPublicLocationsWithCourts(session)).some((row) => row.id === result.id)).toBe(false);
    }
  } finally {
    if (locationIds.length) {
      assert.strictEqual((await service.from("location_pricing_rules").delete().in("location_id", locationIds)).error, null);
      assert.strictEqual((await service.from("pricing_rule_sets").delete().in("location_id", locationIds)).error, null);
      assert.strictEqual((await service.from("location_opening_hours").delete().in("location_id", locationIds)).error, null);
      assert.strictEqual((await service.from("courts").delete().in("location_id", locationIds)).error, null);
      assert.strictEqual((await service.from("locations").delete().in("id", locationIds)).error, null);
    }
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);
