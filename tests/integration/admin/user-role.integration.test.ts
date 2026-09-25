import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { assert, expect, test, vi } from "vitest";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

vi.mock("server-only", () => ({}));

import { updateAdminUserRole } from "../../../src/lib/admin/user-role";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
if (!supabaseUrl || !publishableKey) {
  throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required.");
}

function localServiceRoleKey(): string {
  if (process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY) {
    return process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
  }
  const status = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
  });
  return z.object({ SERVICE_ROLE_KEY: z.string().min(1) }).parse(JSON.parse(status))
    .SERVICE_ROLE_KEY;
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

test("admin role changes are idempotent, authorized, and preserve the final active admin", async () => {
  const service = client(localServiceRoleKey());
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

    expect(await updateAdminUserRole({ userId: member.id, role: "coach", operation: "assign" }, adminSession))
      .toEqual({ ok: true, user: { id: member.id, roles: ["coach", "member"] } });
    expect(await hasRole(member.id, "coach")).toBe(1);

    expect(await updateAdminUserRole({ userId: member.id, role: "coach", operation: "assign" }, adminSession))
      .toEqual({ ok: true, user: { id: member.id, roles: ["coach", "member"] } });
    expect(await hasRole(member.id, "coach")).toBe(1);

    expect(await updateAdminUserRole({ userId: member.id, role: "coach", operation: "revoke" }, adminSession))
      .toEqual({ ok: true, user: { id: member.id, roles: ["member"] } });
    expect(await hasRole(member.id, "coach")).toBe(0);

    expect(await updateAdminUserRole({ userId: member.id, role: "coach", operation: "revoke" }, adminSession))
      .toEqual({ ok: true, user: { id: member.id, roles: ["member"] } });

    expect(await updateAdminUserRole({ userId: member.id, role: "admin", operation: "assign" }, adminSession))
      .toEqual({ ok: true, user: { id: member.id, roles: ["admin", "member"] } });
    expect(await hasRole(member.id, "admin")).toBe(1);

    expect(await updateAdminUserRole({ userId: member.id, role: "admin", operation: "revoke" }, adminSession))
      .toEqual({ ok: true, user: { id: member.id, roles: ["member"] } });
    expect(await hasRole(member.id, "admin")).toBe(0);

    expect(await updateAdminUserRole({ userId: randomUUID(), role: "coach", operation: "assign" }, adminSession))
      .toEqual({ ok: false, reason: "not-found" });

    await expect(updateAdminUserRole({ userId: admin.id, role: "member", operation: "revoke" }, memberSession))
      .rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(await hasRole(admin.id, "member")).toBe(1);

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
      .toEqual({ ok: false, reason: "final-active-admin" });
    expect(await hasRole(admin.id, "admin")).toBe(1);
  } finally {
    for (const id of temporarilySuspendedIds) {
      const result = await service.from("users").update({ status: "active" }).eq("id", id);
      assert.strictEqual(result.error, null);
    }
    for (const id of createdIds.reverse()) {
      const result = await service.auth.admin.deleteUser(id);
      assert.strictEqual(result.error, null);
    }
  }
}, 180_000);
