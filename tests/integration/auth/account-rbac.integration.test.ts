import { randomUUID } from "node:crypto";
import { assert, test, vi } from "vitest";

import { createClient } from "@supabase/supabase-js";

import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

vi.mock("server-only", () => ({}));

import { readCurrentAccount } from "../../../src/lib/auth/account";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
if (!supabaseUrl || !publishableKey) {
  throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required.");
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

test("account loading respects member RLS and suspension", async () => {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const createdIds: string[] = [];
  try {
    const admin = service;
    const ownEmail = `account-own-${randomUUID()}@example.test`;
    const otherEmail = `account-other-${randomUUID()}@example.test`;
    const password = "account-password-123";
    const ownUser = await admin.auth.admin.createUser({
      email: ownEmail,
      password,
      email_confirm: true,
    });
    if (ownUser.data.user) createdIds.push(ownUser.data.user.id);
    const otherUser = await admin.auth.admin.createUser({
      email: otherEmail,
      password,
      email_confirm: true,
    });
    if (otherUser.data.user) createdIds.push(otherUser.data.user.id);
    assert.strictEqual(ownUser.error, null);
    assert.strictEqual(otherUser.error, null);
    assert.ok(ownUser.data.user);
    assert.ok(otherUser.data.user);

    const member = client();
    const signIn = await member.auth.signInWithPassword({ email: ownEmail, password });
    assert.strictEqual(signIn.error, null);
    assert.strictEqual(signIn.data.user?.id, ownUser.data.user.id);

    assert.deepStrictEqual(await readCurrentAccount(member), {
      state: "active",
      userId: ownUser.data.user.id,
      email: ownEmail,
      roles: ["member"],
    });

    const ownProfile = await member.from("users").select("id, email, status")
      .eq("id", ownUser.data.user.id).single();
    assert.strictEqual(ownProfile.error, null);
    assert.deepStrictEqual(ownProfile.data, {
      id: ownUser.data.user.id,
      email: ownEmail,
      status: "active",
    });

    const otherProfile = await member.from("users").select("id, email, status")
      .eq("id", otherUser.data.user.id);
    const otherRoles = await member.from("user_roles").select("user_id, role_code")
      .eq("user_id", otherUser.data.user.id);
    assert.strictEqual(otherProfile.error, null);
    assert.deepStrictEqual(otherProfile.data, [], "A member must not read another profile.");
    assert.strictEqual(otherRoles.error, null);
    assert.deepStrictEqual(otherRoles.data, [], "A member must not read another user's roles.");

    const suspension = await admin.from("users").update({ status: "suspended" })
      .eq("id", ownUser.data.user.id).select("status").single();
    assert.strictEqual(suspension.error, null);
    assert.deepStrictEqual(suspension.data, { status: "suspended" });
    assert.deepStrictEqual(await readCurrentAccount(member), {
      state: "suspended",
      userId: ownUser.data.user.id,
      email: ownEmail,
      roles: ["member"],
    });
    const roleCheck = await member.rpc("has_role", { required_role: "member" });
    assert.strictEqual(roleCheck.error, null);
    assert.strictEqual(roleCheck.data, false);
  } finally {
    await cleanupAuthFixtures(service, createdIds);
  }
});
