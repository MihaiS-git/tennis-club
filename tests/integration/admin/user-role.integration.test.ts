import { randomUUID } from "node:crypto";
import { assert, expect, test, vi } from "vitest";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { assertTestEnvironment } from "../../local/environment.mjs";

import { ensureIntegrationAdminAnchor } from "../admin-anchor";

vi.mock("server-only", () => ({}));

import { updateAdminUserRole } from "../../../src/lib/admin/user-role";
import * as userRolesRepository from "../../../src/lib/db/repositories/user-roles.repository";

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

test("admin TypeORM role changes are idempotent, authorized, and preserve the final active admin", async () => {
  const service = client(localServiceRoleKey());
  await ensureIntegrationAdminAnchor(service);
  const createdIds: string[] = [];
  const temporarilySuspendedIds: string[] = [];
  const password = "admin-role-password-123";

  async function createUser(label: string) {
    const email = `admin-role-${label}-${randomUUID()}@example.test`;
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

  async function hasRole(userId: string, role: string) {
    const result = await service.from("user_roles")
      .select("role_code")
      .eq("user_id", userId)
      .eq("role_code", role);
    assert.strictEqual(result.error, null);
    return result.data?.length ?? 0;
  }

  try {
    const admin = await createUser("admin");
    const member = await createUser("member");
    const adminRole = await service.from("user_roles").insert({
      user_id: admin.id,
      role_code: "admin",
    });
    assert.strictEqual(adminRole.error, null);

    const adminSession = await signIn(admin.email);
    const memberSession = await signIn(member.email);

    const selfDelete = await adminSession.from("user_roles").delete()
      .eq("user_id", admin.id).eq("role_code", "admin").select("role_code");
    expect(selfDelete.error?.code).toBe("42501");
    expect(await hasRole(admin.id, "admin")).toBe(1);
    const selfInsert = await adminSession.from("user_roles").insert({ user_id: admin.id, role_code: "admin" });
    expect(selfInsert.error?.code).toBe("42501");
    const ownCoach = await adminSession.from("user_roles").insert({ user_id: admin.id, role_code: "coach" });
    expect(ownCoach.error?.code).toBe("42501");
    expect(await hasRole(admin.id, "coach")).toBe(0);
    const ownCoachDelete = await adminSession.from("user_roles").delete().eq("user_id", admin.id).eq("role_code", "coach");
    expect(ownCoachDelete.error?.code).toBe("42501");
    expect(await hasRole(admin.id, "coach")).toBe(0);
    const otherAdmin = await adminSession.from("user_roles").insert({ user_id: member.id, role_code: "admin" });
    expect(otherAdmin.error?.code).toBe("42501");
    expect(await hasRole(member.id, "admin")).toBe(0);
    const otherAdminDelete = await adminSession.from("user_roles").delete().eq("user_id", member.id).eq("role_code", "admin");
    expect(otherAdminDelete.error?.code).toBe("42501");
    expect(await hasRole(member.id, "admin")).toBe(0);
    // Auth still uses Supabase; role persistence must never use PostgREST.
    vi.spyOn(adminSession, "from").mockImplementation(() => {
      throw new Error("Unexpected PostgREST role persistence.");
    });
    for (const operation of ["assign", "revoke"] as const) {
      expect(await updateAdminUserRole({ userId: admin.id.toUpperCase(), role: "admin", operation }, adminSession))
        .toEqual({ ok: false, reason: "self-management" });
      expect(await updateAdminUserRole({ userId: admin.id, role: "admin", operation }, adminSession))
        .toEqual({ ok: false, reason: "self-management" });
      expect(await hasRole(admin.id, "admin")).toBe(1);
    }
    expect(await updateAdminUserRole({ userId: admin.id, role: "coach", operation: "assign" }, adminSession))
      .toEqual({ ok: true, user: { id: admin.id, roles: ["admin", "coach"] } });
    expect(await hasRole(admin.id, "coach")).toBe(1);
    expect(await updateAdminUserRole({ userId: admin.id, role: "coach", operation: "revoke" }, adminSession))
      .toEqual({ ok: true, user: { id: admin.id, roles: ["admin"] } });
    expect(await hasRole(admin.id, "coach")).toBe(0);

    expect(await updateAdminUserRole({ userId: member.id, role: "coach", operation: "assign" }, adminSession))
      .toEqual({ ok: true, user: { id: member.id, roles: ["coach"] } });
    expect(await hasRole(member.id, "coach")).toBe(1);
    const attributed = await service.from("user_roles").select("assigned_by").eq("user_id", member.id).eq("role_code", "coach").single();
    expect(attributed.error).toBeNull();
    expect(attributed.data?.assigned_by).toBe(admin.id);


    expect(await updateAdminUserRole({ userId: member.id, role: "coach", operation: "assign" }, adminSession))
      .toEqual({ ok: true, user: { id: member.id, roles: ["coach"] } });
    expect(await hasRole(member.id, "coach")).toBe(1);

    expect(await updateAdminUserRole({ userId: member.id, role: "coach", operation: "revoke" }, adminSession))
      .toEqual({ ok: true, user: { id: member.id, roles: [] } });
    expect(await hasRole(member.id, "coach")).toBe(0);

    const reload = vi.spyOn(userRolesRepository, "listUserRoleCodes")
      .mockResolvedValueOnce(["unsupported-role"]);
    try {
      await expect(updateAdminUserRole({ userId: member.id, role: "coach", operation: "revoke" }, adminSession))
        .rejects.toThrow("Unable to update user roles.");
    } finally {
      reload.mockRestore();
    }

    expect(await updateAdminUserRole({ userId: member.id, role: "coach", operation: "revoke" }, adminSession))
      .toEqual({ ok: true, user: { id: member.id, roles: [] } });

    expect(await updateAdminUserRole({ userId: member.id, role: "admin", operation: "assign" }, adminSession))
      .toEqual({ ok: true, user: { id: member.id, roles: ["admin"] } });
    expect(await hasRole(member.id, "admin")).toBe(1);

    expect(await updateAdminUserRole({ userId: member.id, role: "admin", operation: "revoke" }, adminSession))
      .toEqual({ ok: true, user: { id: member.id, roles: [] } });
    expect(await hasRole(member.id, "admin")).toBe(0);

    expect(await updateAdminUserRole({ userId: randomUUID(), role: "coach", operation: "assign" }, adminSession))
      .toEqual({ ok: false, reason: "not-found" });

    await expect(updateAdminUserRole({ userId: admin.id, role: "admin", operation: "revoke" }, memberSession))
      .rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(await hasRole(admin.id, "admin")).toBe(1);

    await expect(updateAdminUserRole({ userId: "invalid-id", role: "coach", operation: "assign" }, adminSession))
      .rejects.toBeInstanceOf(z.ZodError);
    // @ts-expect-error Exercise runtime validation of an untrusted role.
    await expect(updateAdminUserRole({ userId: member.id, role: "owner", operation: "assign" }, adminSession))
      .rejects.toBeInstanceOf(z.ZodError);
    // @ts-expect-error Exercise runtime validation of an untrusted operation.
    await expect(updateAdminUserRole({ userId: member.id, role: "coach", operation: "replace" }, adminSession))
      .rejects.toBeInstanceOf(z.ZodError);
    expect(await hasRole(member.id, "coach")).toBe(0);

    // Existing test databases may have other active admins. Restore every
    // temporary status change before deleting this test's users.
    const roles = await service.from("user_roles").select("user_id").eq("role_code", "admin");
    assert.strictEqual(roles.error, null);
    const otherIds = (roles.data ?? []).map((assignment) => assignment.user_id)
      .filter((id) => id !== admin.id);
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

    expect(await updateAdminUserRole({ userId: admin.id, role: "admin", operation: "revoke" }, adminSession))
      .toEqual({ ok: false, reason: "self-management" });
    // Final-admin policy belongs to TypeScript; native PostgreSQL has no policy trigger.
    // Application concurrency coverage is shared with the status-change suite.

  } finally {
    vi.restoreAllMocks();
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
