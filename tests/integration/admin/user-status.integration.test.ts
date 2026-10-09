import { randomUUID } from "node:crypto";
import { assert, expect, test, vi } from "vitest";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { assertTestEnvironment } from "../../local/environment.mjs";

import { ensureIntegrationAdminAnchor } from "../admin-anchor";

vi.mock("server-only", () => ({}));

import * as authorization from "../../../src/lib/admin/authorization";
import * as identity from "../../../src/lib/db/repositories/user-roles.repository";
import { updateAdminUserRole } from "../../../src/lib/admin/user-role";
import { updateAdminUserStatus } from "../../../src/lib/admin/user-status";
import { getDataSource } from "../../../src/lib/db/data-source";
import { updateUserStatus } from "../../../src/lib/db/repositories/users.repository";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
if (!supabaseUrl || !publishableKey) {
  throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required.");
}

function localServiceRoleKey(): string {
  assertTestEnvironment();
  return process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY!;
}

function client(key = publishableKey) {
  return createClient(supabaseUrl, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    db: { schema: "public" },
  });
}

test("admin TypeORM status changes preserve authorization, denied browser grants, and the final active administrator", async () => {
  const service = client(localServiceRoleKey());
  await ensureIntegrationAdminAnchor(service);
  const createdIds: string[] = [];
  const temporarilySuspendedIds: string[] = [];
  const password = "admin-status-password-123";

  async function createUser(label: string) {
    const email = `admin-status-${label}-${randomUUID()}@example.test`;
    const result = await service.auth.admin.createUser({ email, password, email_confirm: true });
    assert.strictEqual(result.error, null);
    assert.ok(result.data.user);
    createdIds.push(result.data.user.id);
    return { id: result.data.user.id, email };
  }

  async function signIn(email: string) {
    const user = client();
    const result = await user.auth.signInWithPassword({ email, password });
    assert.strictEqual(result.error, null);
    return user;
  }

  async function statusOf(id: string) {
    const result = await service.from("users").select("status").eq("id", id).single();
    assert.strictEqual(result.error, null);
    assert.ok(result.data);
    return result.data.status;
  }

  try {
    const admin = await createUser("admin");
    const member = await createUser("member");
    const anotherAdmin = await createUser("another-admin");
    for (const id of [admin.id, anotherAdmin.id]) {
      const result = await service.from("user_roles").insert({ user_id: id, role_code: "admin" });
      assert.strictEqual(result.error, null);
    }

    const adminSession = await signIn(admin.email);
    const memberSession = await signIn(member.email);

    for (const status of ["active", "suspended"] as const) {
      const ownStatus = await adminSession.from("users").update({ status }).eq("id", admin.id).select("id");
      expect(ownStatus.error?.code).toBe("42501");
      expect(await statusOf(admin.id)).toBe("active");
    }
    for (const status of ["suspended", "active"] as const) {
      const otherStatus = await adminSession.from("users").update({ status }).eq("id", member.id).select("id");
      expect(otherStatus.error?.code).toBe("42501");
      expect(await statusOf(member.id)).toBe("active");
    }


    // Other active administrators exist, so this proves the application rule.
    for (const status of ["active", "suspended"] as const) {
      expect(await updateAdminUserStatus({ userId: admin.id.toUpperCase(), status }, adminSession))
        .toEqual({ ok: false, reason: "self-management" });
      expect(await updateAdminUserStatus({ userId: admin.id, status }, adminSession))
        .toEqual({ ok: false, reason: "self-management" });
      expect(await statusOf(admin.id)).toBe("active");
    }

    expect(await updateAdminUserStatus({ userId: member.id, status: "suspended" }, adminSession))
      .toEqual({ ok: true, user: { id: member.id, status: "suspended" } });
    expect(await statusOf(member.id)).toBe("suspended");

    expect(await updateAdminUserStatus({ userId: member.id, status: "active" }, adminSession))
      .toEqual({ ok: true, user: { id: member.id, status: "active" } });
    expect(await statusOf(member.id)).toBe("active");

    expect(await updateAdminUserStatus({ userId: anotherAdmin.id, status: "suspended" }, adminSession))
      .toEqual({ ok: true, user: { id: anotherAdmin.id, status: "suspended" } });
    expect(await statusOf(anotherAdmin.id)).toBe("suspended");

    expect(await updateAdminUserStatus({ userId: randomUUID(), status: "suspended" }, adminSession))
      .toEqual({ ok: false, reason: "not-found" });

    await expect(updateAdminUserStatus({ userId: member.id, status: "suspended" }, memberSession))
      .rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(await statusOf(member.id)).toBe("active");

    await expect(updateAdminUserStatus({ userId: "invalid-id", status: "suspended" }, adminSession))
      .rejects.toBeInstanceOf(z.ZodError);
    // @ts-expect-error Exercise runtime validation of untrusted status input.
    await expect(updateAdminUserStatus({ userId: member.id, status: "inactive" }, adminSession))
      .rejects.toBeInstanceOf(z.ZodError);
    expect(await statusOf(member.id)).toBe("active");

    // The test database may have existing admins. Temporarily suspend them so
    // this fixture has exactly one active admin; restore them in finally.
    const roles = await service.from("user_roles").select("user_id").eq("role_code", "admin");
    assert.strictEqual(roles.error, null);
    const otherIds = (roles.data ?? []).map((role) => role.user_id)
      .filter((id) => id !== admin.id && id !== anotherAdmin.id);
    if (otherIds.length > 0) {
      const users = await service.from("users").select("id, status").in("id", otherIds);
      assert.strictEqual(users.error, null);
      for (const user of users.data ?? []) {
        if (user.status !== "active") continue;
        const result = await service.from("users").update({ status: "suspended" }).eq("id", user.id);
        assert.strictEqual(result.error, null);
        temporarilySuspendedIds.push(user.id);
      }
    }

    expect(await updateAdminUserStatus({ userId: admin.id, status: "suspended" }, adminSession))
      .toEqual({ ok: false, reason: "self-management" });
    // Reuse the isolated final-admin fixture for application-level concurrency.
    const dataSource = await getDataSource();
    expect(await updateUserStatus(dataSource.manager, anotherAdmin.id, "active"))
      .toEqual({ id: anotherAdmin.id, status: "active" });
    const activeAdmins = await service.from("users")
      .select("id, user_roles!user_roles_user_id_fkey!inner(role_code)").eq("status", "active")
      .eq("user_roles.role_code", "admin");
    assert.strictEqual(activeAdmins.error, null);
    expect(activeAdmins.data?.map(({ id }) => id).sort()).toEqual([admin.id, anotherAdmin.id].sort());

    // Two authenticated Admins concurrently remove one another. Both pass the
    // initial boundary, but only one may mutate after the Admin-role mutex.
    const anotherSession = await signIn(anotherAdmin.email);
    const roleWriter = vi.spyOn(identity, "removeUserRole");
    async function raceAfterAuthorization<T>(operations: [() => Promise<T>, () => Promise<T>]) {
      const original = authorization.requireActiveAdmin;
      let arrived = 0;
      let release: () => void = () => {};
      const ready = new Promise<void>((resolve) => { release = resolve; });
      const boundary = vi.spyOn(authorization, "requireActiveAdmin").mockImplementation(async (...args) => {
        const actor = await original(...args);
        if (++arrived === 2) release();
        await ready;
        return actor;
      });
      try { return await Promise.allSettled(operations.map((operation) => operation())); }
      finally { boundary.mockRestore(); }
    }
    const race = await raceAfterAuthorization([
      () => updateAdminUserRole({ userId: anotherAdmin.id, role: "admin", operation: "revoke" }, adminSession),
      () => updateAdminUserRole({ userId: admin.id, role: "admin", operation: "revoke" }, anotherSession),
    ]);
    expect(race.filter((row) => row.status === "fulfilled" && row.value.ok)).toHaveLength(1);
    expect(roleWriter).toHaveBeenCalledTimes(1);
    roleWriter.mockRestore();
    const afterRace = await service.from("users")
      .select("id, user_roles!user_roles_user_id_fkey!inner(role_code)").eq("status", "active").eq("user_roles.role_code", "admin");
    expect(afterRace.error).toBeNull();
    expect(afterRace.data).toHaveLength(1);
    for (const id of [admin.id, anotherAdmin.id]) {
      expect((await service.from("user_roles").upsert({ user_id: id, role_code: "admin" })).error).toBeNull();
    }
    const suspensionRace = await raceAfterAuthorization([
      () => updateAdminUserStatus({ userId: anotherAdmin.id, status: "suspended" }, adminSession),
      () => updateAdminUserStatus({ userId: admin.id, status: "suspended" }, anotherSession),
    ]);
    expect(suspensionRace.filter((row) => row.status === "fulfilled" && row.value.ok)).toHaveLength(1);
    const afterSuspension = await service.from("users")
      .select("id, user_roles!user_roles_user_id_fkey!inner(role_code)").eq("status", "active").eq("user_roles.role_code", "admin");
    expect(afterSuspension.error).toBeNull();
    expect(afterSuspension.data).toHaveLength(1);
    for (const id of [admin.id, anotherAdmin.id]) await updateUserStatus(dataSource.manager, id, "active");


  } finally {
    for (const id of temporarilySuspendedIds) {
      const result = await service.from("users").update({ status: "active" }).eq("id", id);
      assert.strictEqual(result.error, null);
    }
    for (const id of createdIds.reverse()) {
      const roles = await service.from("user_roles").delete().eq("user_id", id);
      assert.strictEqual(roles.error, null);
      const account = await service.from("users").delete().eq("id", id);
      assert.strictEqual(account.error, null);
      const result = await service.auth.admin.deleteUser(id);
      assert.strictEqual(result.error, null);
    }
  }
}, 180_000);
