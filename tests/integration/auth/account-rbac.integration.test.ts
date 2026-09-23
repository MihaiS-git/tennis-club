import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { assert, test, vi } from "vitest";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

vi.mock("server-only", () => ({}));

import { readCurrentAccount } from "../../../src/lib/auth/account";

const supabaseUrl = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
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

function client(key = publishableKey, schema = "public") {
  return createClient(supabaseUrl, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    db: { schema },
  });
}

test("account loading respects member RLS and suspension", async () => {
  const admin = client(localServiceRoleKey());
  const ownEmail = `account-own-${randomUUID()}@example.test`;
  const otherEmail = `account-other-${randomUUID()}@example.test`;
  const password = "account-password-123";
  const ownUser = await admin.auth.admin.createUser({
    email: ownEmail,
    password,
    email_confirm: true,
  });
  const otherUser = await admin.auth.admin.createUser({
    email: otherEmail,
    password,
    email_confirm: true,
  });
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
  const activeCheck = await member.rpc("current_user_is_active");
  assert.strictEqual(activeCheck.error, null);
  assert.strictEqual(activeCheck.data, false);
  const roleCheck = await member.rpc("has_role", { required_role: "member" });
  assert.strictEqual(roleCheck.error, null);
  assert.strictEqual(roleCheck.data, false);

  const wrongSchemaClient = client(publishableKey, "auth");
  const wrongSchemaSignIn = await wrongSchemaClient.auth.signInWithPassword({
    email: ownEmail,
    password,
  });
  assert.strictEqual(wrongSchemaSignIn.error, null);
  const failedQuery = await wrongSchemaClient.from("users").select("id").limit(1);
  assert.ok(failedQuery.error, "The disallowed schema must produce a query error.");
  assert.deepStrictEqual(await readCurrentAccount(wrongSchemaClient), {
    state: "load-error",
  });
});
