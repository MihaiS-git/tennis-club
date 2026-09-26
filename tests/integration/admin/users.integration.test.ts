import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { assert, expect, test, vi } from "vitest";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { ensureIntegrationAdminAnchor } from "../admin-anchor";

vi.mock("server-only", () => ({}));

import { listAdminUsers } from "../../../src/lib/admin/users";

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

test("admin user listing is authorized, ordered, bounded, and includes roles", async () => {
  const service = client(localServiceRoleKey());
  await ensureIntegrationAdminAnchor(service);
  const createdIds: string[] = [];
  const password = "admin-users-password-123";

  async function createUser(label: string) {
    const email = `admin-users-${label}-${randomUUID()}@example.test`;
    const result = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
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

  try {
    const admin = await createUser("admin");
    const adminRole = await service.from("user_roles").insert({
      user_id: admin.id,
      role_code: "admin",
    });
    assert.strictEqual(adminRole.error, null);

    const oldest = await createUser("oldest");
    for (let index = 0; index < 99; index += 1) {
      await createUser(`filler-${index}`);
    }

    const member = await createUser("member");
    const coach = await createUser("coach");
    const coachRole = await service.from("user_roles").insert({
      user_id: coach.id,
      role_code: "coach",
    });
    assert.strictEqual(coachRole.error, null);

    const suspendedAdmin = await createUser("suspended-admin");
    const suspendedRole = await service.from("user_roles").insert({
      user_id: suspendedAdmin.id,
      role_code: "admin",
    });
    assert.strictEqual(suspendedRole.error, null);
    const suspension = await service.from("users").update({ status: "suspended" })
      .eq("id", suspendedAdmin.id);
    assert.strictEqual(suspension.error, null);

    const adminSession = await signIn(admin.email);
    const rows = await listAdminUsers(adminSession);
    assert.strictEqual(rows.length, 100, "The list must stop at 100 users.");
    assert.ok(rows.length > 1);
    assert.ok(!rows.some((row) => row.id === oldest.id));
    assert.deepStrictEqual(
      rows.map((row) => row.id),
      [...rows].sort((a, b) =>
        b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
      ).map((row) => row.id),
      "Users must be ordered by created_at and then id, newest first.",
    );

    const memberRow = rows.find((row) => row.id === member.id);
    assert.ok(memberRow);
    assert.strictEqual(memberRow.email, member.email);
    assert.strictEqual(memberRow.status, "active");
    assert.ok(!Number.isNaN(Date.parse(memberRow.created_at)));
    assert.deepStrictEqual(memberRow.roles, ["member"]);
    assert.deepStrictEqual(rows.find((row) => row.id === coach.id)?.roles, ["coach", "member"]);
    assert.deepStrictEqual(rows.find((row) => row.id === suspendedAdmin.id)?.roles, ["admin", "member"]);
    assert.strictEqual(rows.find((row) => row.id === suspendedAdmin.id)?.status, "suspended");

    const memberSession = await signIn(member.email);
    await expect(listAdminUsers(memberSession)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");

    const suspendedSession = await signIn(suspendedAdmin.email);
    await expect(listAdminUsers(suspendedSession)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
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
