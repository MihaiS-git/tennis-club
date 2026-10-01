import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { listAdminPricingRules, saveAdminPricingRule, removeAdminPricingRule } from "../../../src/lib/admin/pricing";
import { mutateAdminOpeningHours } from "../../../src/lib/admin/opening-hours";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

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
    const hours = await service.from("location_opening_hours").insert([0, 1, 2, 3, 4, 5, 6].map((weekday) =>
      ({ location_id, weekday, opens_at_minute: 420, closes_at_minute: 1440 })));
    assert.strictEqual(hours.error, null);
    const base = { location_id, court_ids: [court1, court2], court_state: "outdoor", weekdays: [0, 1, 2, 3, 4],
      starts_at: "07:00", ends_at: "16:00", starts_on: "", ends_on: "", price_per_hour: "12.00" };
    const created = await saveAdminPricingRule(base, admin); assert.ok(created.ok);
    const setId = created.id;
    const mondayHours = await service.from("location_opening_hours").select("id").eq("location_id", location_id).eq("weekday", 0).single();
    assert.strictEqual(mondayHours.error, null); assert.ok(mondayHours.data);
    expect(await mutateAdminOpeningHours({ location_id, weekdays: [0], replace_ids: [mondayHours.data.id],
      intervals: [{ opens_at: "07:00", closes_at: "15:00" }] }, admin)).toMatchObject({
      ok: false, reason: "pricing-conflict", message: expect.stringContaining("Monday (07:00–16:00)"),
    });
    expect((await service.from("location_opening_hours").select("closes_at_minute").eq("id", mondayHours.data.id).single()).data?.closes_at_minute)
      .toBe(1440);
    let atomic = await service.from("location_pricing_rules").select("court_id, weekday, starts_at_minute, ends_at_minute").eq("rule_set_id", setId);
    assert.strictEqual(atomic.error, null); expect(atomic.data).toHaveLength(10);
    expect(await listAdminPricingRules(pricingLocationId, admin)).toMatchObject([{ rule_set_id: setId, court_ids: [court1, court2].sort(), weekdays: [0, 1, 2, 3, 4] }]);
    expect(await saveAdminPricingRule({ ...base, rule_set_id: setId, weekdays: [0, 1, 2, 3], court_ids: [court1, court3], ends_at: "20:00" }, admin))
      .toEqual({ ok: true, id: setId });
    atomic = await service.from("location_pricing_rules").select("court_id, weekday, starts_at_minute, ends_at_minute").eq("rule_set_id", setId);
    assert.strictEqual(atomic.error, null); expect(atomic.data).toHaveLength(8);
    expect(new Set(atomic.data!.map((row) => row.court_id))).toEqual(new Set([court1, court3]));
    expect(new Set(atomic.data!.map((row) => row.weekday))).toEqual(new Set([0, 1, 2, 3]));
    // A distinct court can have exactly the same schedule; adjacent intervals on one court also work.
    const sameOtherCourt = await saveAdminPricingRule({ ...base, court_ids: [court2], weekdays: [0], ends_at: "20:00" }, admin);
    assert.ok(sameOtherCourt.ok);
    const adjacent = await saveAdminPricingRule({ ...base, court_ids: [court1], weekdays: [0], starts_at: "20:00", ends_at: "24:00" }, admin);
    assert.ok(adjacent.ok);
    const conflict = await saveAdminPricingRule({ ...base, court_ids: [court1], weekdays: [0], starts_at: "19:59", ends_at: "21:00" }, admin);
    expect(conflict).toEqual({ ok: false, reason: "overlap" });
    const competing = await Promise.all([
      saveAdminPricingRule({ ...base, court_ids: [court2], weekdays: [6], starts_at: "07:00", ends_at: "12:00" }, admin),
      saveAdminPricingRule({ ...base, court_ids: [court2], weekdays: [6], starts_at: "08:00", ends_at: "13:00" }, admin),
    ]);
    expect(competing.filter((result) => result.ok)).toHaveLength(1);
    expect(competing.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "overlap" }]);
    const beforeConflict = atomic.data;
    expect(await saveAdminPricingRule({ ...base, rule_set_id: setId, court_ids: [court1, court3], weekdays: [0, 1, 2, 3, 4], ends_at: "21:00" }, admin))
      .toEqual({ ok: false, reason: "overlap" });
    const afterConflict = await service.from("location_pricing_rules").select("court_id, weekday, starts_at_minute, ends_at_minute").eq("rule_set_id", setId);
    assert.strictEqual(afterConflict.error, null); expect(afterConflict.data).toEqual(beforeConflict);
    // Existing applicable pricing prevents deleting its opening day.
    expect((await service.from("location_opening_hours").delete().eq("location_id", location_id).eq("weekday", 0)).error?.message)
      .toBe("opening_hours_pricing_conflict");
    expect((await service.from("location_opening_hours").select("weekday").eq("location_id", location_id).eq("weekday", 0)).data).toHaveLength(1);
    const afterHours = await service.from("location_pricing_rules").select("court_id, weekday, starts_at_minute, ends_at_minute").eq("rule_set_id", setId);
    expect(afterHours.data).toEqual(beforeConflict);
    const sundayHours = await service.from("location_opening_hours").select("id").eq("location_id", location_id).eq("weekday", 6).single();
    assert.strictEqual(sundayHours.error, null); assert.ok(sundayHours.data);
    const [hoursRace, pricingRace] = await Promise.all([
      mutateAdminOpeningHours({ location_id, weekdays: [6], replace_ids: [sundayHours.data.id],
        intervals: [{ opens_at: "07:00", closes_at: "20:00" }] }, admin),
      saveAdminPricingRule({ ...base, court_ids: [court3], weekdays: [6], starts_at: "18:00", ends_at: "21:00" }, admin),
    ]);
    expect(Number(hoursRace.ok) + Number(pricingRace.ok)).toBe(1);
    if (!hoursRace.ok) expect(hoursRace.reason).toBe("pricing-conflict");
    if (!pricingRace.ok) expect(pricingRace).toMatchObject({ reason: "invalid-input", fieldErrors: { ends_at: expect.any(String) } });
    const sundayClose = (await service.from("location_opening_hours").select("closes_at_minute").eq("location_id", location_id).eq("weekday", 6).single()).data?.closes_at_minute;
    const sundayPrice = (await service.from("location_pricing_rules").select("id").eq("location_id", location_id)
      .eq("weekday", 6).eq("court_id", court3).eq("starts_at_minute", 1080)).data ?? [];
    expect(sundayPrice.length === 0 || sundayClose === 1440).toBe(true);
    await expect(listAdminPricingRules(pricingLocationId, member)).rejects.toThrow();
    await expect(saveAdminPricingRule(base, member)).rejects.toThrow();
    await expect(removeAdminPricingRule({ location_id, rule_set_id: setId }, member)).rejects.toThrow();
    expect(await removeAdminPricingRule({ location_id: randomUUID(), rule_set_id: setId }, admin)).toEqual({ ok: false, reason: "not-found" });
    expect(await removeAdminPricingRule({ location_id, rule_set_id: setId }, admin)).toEqual({ ok: true, id: setId });
    expect((await service.from("location_pricing_rules").select("id").eq("rule_set_id", setId)).data).toEqual([]);
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
