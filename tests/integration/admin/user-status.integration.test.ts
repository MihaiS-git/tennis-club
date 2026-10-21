import { randomUUID } from "node:crypto";
import { assert, expect, test, vi } from "vitest";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { assertTestEnvironment } from "../../local/environment.mjs";

import { ensureIntegrationAdminAnchor } from "../admin-anchor";

vi.mock("server-only", () => ({}));

import { readAdminUserDetails } from "../../../src/lib/admin/users";
import { updateAdminUserStatus } from "../../../src/lib/admin/user-status";

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

test("admin TypeORM status changes preserve authorization and denied browser grants", async () => {
  const service = client(localServiceRoleKey());
  await ensureIntegrationAdminAnchor(service);
  const createdIds: string[] = [];
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
    expect((await readAdminUserDetails(member.id, adminSession))?.status).toBe("suspended");

    expect(await updateAdminUserStatus({ userId: member.id, status: "active" }, adminSession))
      .toEqual({ ok: true, user: { id: member.id, status: "active" } });
    expect(await statusOf(member.id)).toBe("active");

    expect((await readAdminUserDetails(member.id, adminSession))?.status).toBe("active");

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

    expect(await updateAdminUserStatus({ userId: admin.id, status: "suspended" }, adminSession))
      .toEqual({ ok: false, reason: "self-management" });
  } finally {
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
