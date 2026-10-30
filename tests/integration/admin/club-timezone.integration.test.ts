import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { saveAdminLocation, setAdminLocationArchived } from "@/lib/admin/locations";
import { readClubTimezoneError } from "@/lib/club/timezone-policy";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { lockConfigurationForWrite } from "@/lib/db/repositories/clubs.repository";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";
import { bounded, deferred, settled } from "../concurrency";

test("club timezone configuration is canonical, serialized, and cannot be bypassed by activation or restoration", async () => {
  const database = await getDataSource(), service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const marker = randomUUID(), password = "club-timezone-password-123", email = `timezone-${marker}@example.test`;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.strictEqual(created.error, null); assert.ok(created.data.user);
  const actor = created.data.user.id, ids: string[] = [];
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const fields = { name: `Timezone ${marker}`, address_line1: "", address_line2: "", city: "", postal_code: "", country_code: "US",
    timezone: "America/New_York", currency: "USD", is_active: true, is_public: false, display_order: 0, customer_cancellation_notice_minutes: 120 };
  let sequence = 0;
  const create = async (timezone: string) => {
    const result = await saveAdminLocation({ fields: { ...fields, name: `${fields.name} ${sequence++}`, timezone } }, admin);
    if (result.ok) ids.push(result.id);
    return result;
  };
  const edit = (id: string, changes: Partial<typeof fields>) => saveAdminLocation({ id, fields: { ...fields, ...changes } }, admin);
  const row = async (id: string) => (await database.query("SELECT name,timezone,is_active,archived_at FROM public.locations WHERE id=$1", [id]))[0];
  const mismatch = { ok: false, reason: "invalid-input", fieldErrors: { timezone: expect.stringContaining("same IANA timezone") } };
  const gate = deferred(), fenced = deferred();
  let writer: Promise<unknown> | undefined;
  try {
    assert.strictEqual((await service.from("user_roles").insert({ user_id: actor, role_code: "admin" })).error, null);
    assert.strictEqual((await admin.auth.signInWithPassword({ email, password })).error, null);
    // No hardcoded zone: the first operational location establishes New York.
    const first = await create("US/Eastern"); assert.ok(first.ok);
    expect((await row(first.id)).timezone).toBe("America/New_York");
    expect(await edit(first.id, { is_active: false })).toEqual({ ok: true, id: first.id });
    expect(await create("America/Chicago")).toEqual(mismatch);
    expect(await edit(first.id, {})).toEqual({ ok: true, id: first.id });
    const second = await create("America/New_York"); assert.ok(second.ok);
    expect(await create("America/Chicago")).toEqual(mismatch);
    const before = await row(first.id);
    expect(await edit(first.id, { timezone: "America/Chicago", name: "Rejected rename" })).toEqual(mismatch);
    expect(await row(first.id)).toEqual(before);
    expect(await edit(first.id, { city: "Updated city" })).toEqual({ ok: true, id: first.id });
    expect(await edit(first.id, { timezone: "US/Eastern" })).toEqual({ ok: true, id: first.id });

    // Privileged fixture represents an old incompatible inactive location.
    await database.query("UPDATE public.locations SET is_active=false,timezone='Europe/London' WHERE id=$1", [second.id]);
    const inactive = await row(second.id);
    expect(await edit(second.id, { timezone: "Europe/London", is_active: true })).toEqual(mismatch);
    expect(await row(second.id)).toEqual(inactive);
    expect(await edit(second.id, { timezone: "Europe/London", is_active: false, city: "Still editable" })).toEqual({ ok: true, id: second.id });
    expect(await setAdminLocationArchived({ id: second.id, archived: true }, admin)).toEqual({ ok: true, id: second.id });
    const archived = await row(second.id);
    expect(await readClubTimezoneError(database.manager)).toBeNull();
    expect(await setAdminLocationArchived({ id: second.id, archived: false }, admin)).toMatchObject({
      ok: false, message: expect.stringContaining("Europe/London"),
    });
    expect(await row(second.id)).toEqual(archived);

    // Legacy active disagreement is actionable, but unrelated details remain editable.
    await database.query("UPDATE public.locations SET is_active=true,archived_at=NULL WHERE id=$1", [second.id]);
    const diagnostic = await readClubTimezoneError(database.manager);
    expect(diagnostic).toContain(first.id); expect(diagnostic).toContain(second.id);
    expect(diagnostic).toContain("America/New_York"); expect(diagnostic).toContain("Europe/London");
    expect(await edit(first.id, { city: "Management still available" })).toEqual({ ok: true, id: first.id });
    // Reconcile an empty legacy location explicitly; never rewrite it automatically.
    expect(await edit(second.id, {})).toEqual({ ok: true, id: second.id });
    expect(await readClubTimezoneError(database.manager)).toBeNull();

    // Both creators queue behind the exclusive fence, then see the winner's zone.
    for (const id of ids) expect(await setAdminLocationArchived({ id, archived: true }, admin)).toEqual({ ok: true, id });
    writer = inTransaction(async (manager) => {
      await lockConfigurationForWrite(manager); fenced.resolve(); await gate.promise;
    });
    await bounded(fenced.promise, "configuration fence");
    const race = settled([create("Asia/Tokyo"), create("America/New_York")]);
    let finished = false;
    void race.then(() => { finished = true; }, () => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(finished).toBe(false);
    gate.resolve(); await bounded(writer, "configuration commit");
    const results = await bounded(race, "location creations");
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([mismatch]);
    expect(await readClubTimezoneError(database.manager)).toBeNull();
  } finally {
    gate.resolve(); await writer?.catch(() => {});
    await database.query("DELETE FROM public.locations WHERE id=ANY($1::uuid[])", [ids]);
    await cleanupAuthFixtures(service, [actor]);
  }
}, 30000);
