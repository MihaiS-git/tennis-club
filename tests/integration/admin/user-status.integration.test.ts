import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { assert, expect, test, vi } from "vitest";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

vi.mock("server-only", () => ({}));

import { updateAdminUserStatus } from "../../../src/lib/admin/user-status";

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

test("admin status changes use RLS and preserve the final active administrator", async () => {
  const service = client(localServiceRoleKey());
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
      .toEqual({ ok: false, reason: "final-active-admin" });
    expect(await statusOf(admin.id)).toBe("active");
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
