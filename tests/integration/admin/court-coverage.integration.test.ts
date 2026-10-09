import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test, vi } from "vitest";
import { listAdminCourtCoverage, saveAdminCourtCoverage, removeAdminCourtCoverage } from "@/lib/admin/court-coverage";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import { saveAdminCourt } from "@/lib/admin/courts";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

test("coverage services preserve dates, court scope, FK restrictions, overlap and authorization", async () => {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const userIds: string[] = [];
  const locationId = randomUUID();
  const courtIds = [randomUUID(), randomUUID(), randomUUID()];
  const password = "coverage-integration-password-123";
  async function account(role?: "admin" | "coach") {
    const email = `coverage-${randomUUID()}@example.test`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(created.error, null); assert.ok(created.data.user);
    const id = created.data.user.id; userIds.push(id);
    if (role) assert.strictEqual((await service.from("user_roles").insert({ user_id: id, role_code: role })).error, null);
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
    return { id, client };
  }
  try {
    const admin = await account("admin");
    const member = await account();
    const coach = await account("coach");
    assert.strictEqual((await service.from("locations").insert({
      id: locationId, name: "Coverage fixture", slug: `coverage-${locationId}`, timezone: "UTC",
    })).error, null);
    assert.strictEqual((await service.from("courts").insert(courtIds.map((id, index) => ({
      id, location_id: locationId, name: `Court ${index}`, slug: `court-${index}`,
      surface: "clay", environment: index === 2 ? "indoor" : "outdoor",
    })))).error, null);
    const input = { court_id: courtIds[0], dates: { starts_on: "2099-01-01", ends_on: "2099-01-31" } };
    const created = await saveAdminCourtCoverage(input, admin.client);
    assert.ok(created.ok);
    expect((await listAdminCourtCoverage(admin.client)).find((row) => row.id === created.id))
      .toMatchObject({ court_id: courtIds[0], ...input.dates, created_at: expect.any(String), updated_at: expect.any(String) });
    expect(await saveAdminCourtCoverage({ ...input, dates: { starts_on: "2099-01-31", ends_on: "2099-02-01" } }, admin.client))
      .toEqual({ ok: false, reason: "overlap" });
    const ownUpdate = await saveAdminCourtCoverage({ ...input, id: created.id }, admin.client);
    expect(ownUpdate).toEqual({ ok: true, id: created.id });
    const writer = vi.spyOn(clubs, "insertCourtCoverage");
    try {
      const competing = await Promise.all([
        saveAdminCourtCoverage({ court_id: courtIds[1], dates: input.dates }, admin.client),
        saveAdminCourtCoverage({ court_id: courtIds[1], dates: { starts_on: "2099-01-15", ends_on: "2099-02-15" } }, admin.client),
      ]);
      expect(competing.filter((row) => row.ok)).toHaveLength(1);
      expect(competing.filter((row) => !row.ok)).toEqual([{ ok: false, reason: "overlap" }]);
      // The loser never reaches INSERT: this proves the TypeScript safeguard.
      expect(writer).toHaveBeenCalledTimes(1);
    } finally { writer.mockRestore(); }
    const adjacent = await saveAdminCourtCoverage({ ...input, dates: { starts_on: "2099-02-01", ends_on: "2099-02-01" } }, admin.client);
    assert.ok(adjacent.ok);
    expect(await saveAdminCourtCoverage({ ...input, court_id: courtIds[2] }, admin.client))
      .toEqual({ ok: false, reason: "outdoor-only" });
    expect(await saveAdminCourtCoverage({ ...input, court_id: randomUUID() }, admin.client))
      .toEqual({ ok: false, reason: "not-found" });
    expect(await saveAdminCourtCoverage({ ...input, dates: { starts_on: "2099-02-01", ends_on: "2099-01-01" } }, admin.client))
      .toMatchObject({ ok: false, reason: "invalid-input" });
    expect(await saveAdminCourtCoverage({ ...input, id: created.id, court_id: courtIds[1] }, admin.client))
      .toEqual({ ok: false, reason: "not-found" });
    expect(await removeAdminCourtCoverage({ court_id: courtIds[1], id: created.id }, admin.client))
      .toEqual({ ok: false, reason: "not-found" });
    expect(await saveAdminCourtCoverage({ ...input, id: created.id, dates: { starts_on: "2099-01-02", ends_on: "2099-01-30" } }, admin.client))
      .toEqual({ ok: true, id: created.id });
    const courtWriter = vi.spyOn(clubs, "updateCourt");
    expect(await saveAdminCourt({ id: courtIds[0], fields: {
      location_id: locationId, name: "Court 0", surface: "clay", environment: "indoor", has_lighting: false, is_active: true,
    } }, admin.client)).toEqual({ ok: false, reason: "has-coverage" });
    expect(courtWriter).not.toHaveBeenCalled();
    courtWriter.mockRestore();
    for (const client of [member.client, coach.client]) {
      await expect(listAdminCourtCoverage(client)).rejects.toThrow();
      await expect(saveAdminCourtCoverage(input, client)).rejects.toThrow();
      await expect(removeAdminCourtCoverage({ court_id: courtIds[0], id: created.id }, client)).rejects.toThrow();
    }
    assert.strictEqual((await service.from("users").update({ status: "suspended" }).eq("id", admin.id)).error, null);
    await expect(saveAdminCourtCoverage(input, admin.client)).rejects.toThrow();
    assert.strictEqual((await service.from("users").update({ status: "active" }).eq("id", admin.id)).error, null);
    expect(await removeAdminCourtCoverage({ court_id: courtIds[0], id: created.id }, admin.client)).toEqual({ ok: true, id: created.id });
    expect(await removeAdminCourtCoverage({ court_id: courtIds[0], id: created.id }, admin.client)).toEqual({ ok: false, reason: "not-found" });
  } finally {
    assert.strictEqual((await service.from("court_coverage_periods").delete().in("court_id", courtIds)).error, null);
    assert.strictEqual((await service.from("courts").delete().in("id", courtIds)).error, null);
    assert.strictEqual((await service.from("locations").delete().eq("id", locationId)).error, null);
    await cleanupAuthFixtures(service, userIds);
  }
}, 30000);
