import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { assert, expect, test, vi } from "vitest";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const { createServerClient, redirect } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("../../../src/lib/supabase/server", () => ({
  createClient: createServerClient,
}));
vi.mock("next/navigation", () => ({ redirect }));

import { resetPasswordAction } from "../../../src/app/(auth)/actions";

const supabaseUrl = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
if (!supabaseUrl || !publishableKey) {
  throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required.");
}

function authClient(key = publishableKey) {
  return createClient(supabaseUrl, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
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

function passwordForm(password: string, confirmPassword = password): FormData {
  const form = new FormData();
  form.set("password", password);
  form.set("confirmPassword", confirmPassword);
  return form;
}

test("password reset rejects a request without an authenticated recovery session", async () => {
  createServerClient.mockResolvedValueOnce(authClient());

  const result = await resetPasswordAction({}, passwordForm("new-password-456"));

  assert.deepStrictEqual(result, {
    formError: "This authentication link is invalid or has expired.",
  });
  assert.strictEqual(redirect.mock.calls.length, 0);
});

test.each([
  ["short", "short", { password: "Password must be at least 6 characters long." }],
  ["new-password-456", "different-password", { confirmPassword: "Passwords do not match." }],
])("password reset rejects invalid new-password input", async (password, confirmation, errors) => {
  createServerClient.mockClear();

  const result = await resetPasswordAction({}, passwordForm(password, confirmation));

  assert.deepStrictEqual(result, { fieldErrors: errors });
  assert.strictEqual(createServerClient.mock.calls.length, 0);
});

test("a valid recovery token permits reset and the new password signs in", async () => {
  const email = `password-recovery-${randomUUID()}@example.test`;
  const oldPassword = "old-password-123";
  const newPassword = "new-password-456";
  const admin = authClient(localServiceRoleKey());
  const created = await admin.auth.admin.createUser({
    email,
    password: oldPassword,
    email_confirm: true,
  });
  assert.strictEqual(created.error, null);
  assert.ok(created.data.user);

  const generated = await admin.auth.admin.generateLink({ type: "recovery", email });
  assert.strictEqual(generated.error, null);
  assert.ok(generated.data.properties.hashed_token);

  const recoveryClient = authClient();
  const verified = await recoveryClient.auth.verifyOtp({
    token_hash: generated.data.properties.hashed_token,
    type: "recovery",
  });
  assert.strictEqual(verified.error, null);
  assert.strictEqual(verified.data.user?.id, created.data.user.id);
  assert.ok(verified.data.session);

  createServerClient.mockResolvedValueOnce(recoveryClient);
  await expect(resetPasswordAction({}, passwordForm(newPassword))).rejects.toThrow(
    /^redirect:\/login\?message=Your\+password\+has\+been\+reset/,
  );
  assert.strictEqual(redirect.mock.calls.length, 1);

  const oldPasswordSignIn = await authClient().auth.signInWithPassword({
    email,
    password: oldPassword,
  });
  assert.ok(oldPasswordSignIn.error, "The old password must no longer authenticate.");

  const newPasswordSignIn = await authClient().auth.signInWithPassword({
    email,
    password: newPassword,
  });
  assert.strictEqual(newPasswordSignIn.error, null);
  assert.strictEqual(newPasswordSignIn.data.user?.id, created.data.user.id);
});
