import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, vi } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { readAdminPaymentSettings, selectActivePaymentProvider } from "@/lib/payments/settings";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";

// Real service authorization and persistence; singleton/audit are restored after
// each case. No mocked repository calls or production configuration changes.
test("provider settings preserve stored selection, reject non-Admins/configuration, no-op and audit atomically", async () => {
  const db = await getDataSource(), fixture = localFixtureClient();
  const previous = await db.query("SELECT active_provider,updated_by_user_id,updated_at::text FROM public.payment_provider_settings WHERE id");
  const users: string[] = [];
  async function actor(admin: boolean) {
    const email = `settings-${randomUUID()}@example.test`, password = "settings-password-123";
    const created = await fixture.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull(); if (!created.data.user) throw new Error("Missing actor");
    const id = created.data.user.id; users.push(id);
    if (admin) expect((await fixture.from("user_roles").insert({ user_id: id, role_code: "admin" })).error).toBeNull();
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    return { id, client };
  }
  try {
    const admin = await actor(true), member = await actor(false);
    vi.stubEnv("STRIPE_SECRET_KEY", ""); vi.stubEnv("STRIPE_PUBLISHABLE_KEY", ""); vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    await expect(readAdminPaymentSettings(member.client)).rejects.toThrow();
    await expect(selectActivePaymentProvider({ provider: null }, member.client)).rejects.toThrow();
    expect((await selectActivePaymentProvider({ provider: "stripe" }, admin.client)).ok).toBe(false);
    await db.query("UPDATE public.payment_provider_settings SET active_provider='stripe' WHERE id");
    expect((await readAdminPaymentSettings(admin.client)).activeProvider).toBe("stripe");
    expect(await selectActivePaymentProvider({ provider: null }, admin.client)).toEqual({ ok: true, activeProvider: null });
    const snapshot = await db.query("SELECT active_provider,updated_by_user_id,updated_at::text FROM public.payment_provider_settings WHERE id");
    const audit = await db.query("SELECT previous_provider,active_provider,changed_by_user_id FROM public.payment_provider_changes WHERE changed_by_user_id=$1", [admin.id]);
    expect(snapshot[0]).toMatchObject({ active_provider: null, updated_by_user_id: admin.id });
    expect(audit).toEqual([{ previous_provider: "stripe", active_provider: null, changed_by_user_id: admin.id }]);
    expect(await selectActivePaymentProvider({ provider: null }, admin.client)).toEqual({ ok: true, activeProvider: null });
    expect(await db.query("SELECT active_provider,updated_by_user_id,updated_at::text FROM public.payment_provider_settings WHERE id")).toEqual(snapshot);
    expect(await db.query("SELECT previous_provider,active_provider,changed_by_user_id FROM public.payment_provider_changes WHERE changed_by_user_id=$1", [admin.id])).toEqual(audit);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fixture"); vi.stubEnv("STRIPE_PUBLISHABLE_KEY", "pk_test_fixture"); vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_fixture");
    // Concurrent same-value selections serialize; exactly one changes/audits.
    expect(await Promise.all([selectActivePaymentProvider({ provider: "stripe" }, admin.client),
      selectActivePaymentProvider({ provider: "stripe" }, admin.client)])).toEqual([
      { ok: true, activeProvider: "stripe" }, { ok: true, activeProvider: "stripe" }]);
    expect(await db.query("SELECT count(*)::integer AS count FROM public.payment_provider_changes WHERE changed_by_user_id=$1", [admin.id])).toEqual([{ count: 2 }]);
    // Force the audit INSERT to fail via a conflicting table lock and statement
    // timeout on this transaction's connection; the UPDATE must roll back too.
    const { inTransaction } = await import("@/lib/db/transaction");
    const { lockProviderSelection, writeProviderSelection } = await import("@/lib/db/repositories/payments.repository");
    const { lockReservationActorFacts } = await import("@/lib/db/repositories/accounts.repository");
    const blocker = db.createQueryRunner(); await blocker.connect(); await blocker.startTransaction();
    await blocker.query("LOCK TABLE public.payment_provider_changes IN SHARE MODE");
    try {
      await expect(inTransaction(async (manager) => {
        await manager.query("SET LOCAL statement_timeout='300ms'");
        expect((await lockReservationActorFacts(manager, admin.id))?.roles).toContain("admin");
        const stored = await lockProviderSelection(manager);
        await writeProviderSelection(manager, stored, null, admin.id);
      })).rejects.toThrow();
    } finally { await blocker.rollbackTransaction(); await blocker.release(); }
    expect((await readAdminPaymentSettings(admin.client)).activeProvider).toBe("stripe");
    // Actor fencing keeps authoritative facts stable until commit.
    const fence = db.createQueryRunner(); await fence.connect(); await fence.startTransaction();
    try {
      await lockReservationActorFacts(fence.manager, admin.id);
      const removal = db.createQueryRunner(); await removal.connect(); await removal.startTransaction();
      try {
        await removal.query("SET LOCAL statement_timeout='300ms'");
        await expect(removal.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code='admin'", [admin.id])).rejects.toThrow();
      } finally { await removal.rollbackTransaction(); await removal.release(); }
    } finally { await fence.rollbackTransaction(); await fence.release(); }
    expect((await fixture.from("users").update({ status: "suspended" }).eq("id", admin.id)).error).toBeNull();
    await expect(selectActivePaymentProvider({ provider: null }, admin.client)).rejects.toThrow();
  } finally {
    vi.unstubAllEnvs();
    await db.query("UPDATE public.payment_provider_settings SET active_provider=$1,updated_by_user_id=$2,updated_at=$3::timestamptz WHERE id",
      [previous[0].active_provider,previous[0].updated_by_user_id,previous[0].updated_at]);
    await db.query("DELETE FROM public.payment_provider_changes WHERE changed_by_user_id=ANY($1::uuid[])", [users]);
    await cleanupAuthFixtures(fixture, users);
  }
}, 30000);
