import { randomUUID } from "node:crypto";
import { assert, test, vi } from "vitest";

import { createClient } from "@supabase/supabase-js";

import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";

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

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
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


function passwordForm(password: string): FormData {
  const form = new FormData();
  form.set("password", password);
  form.set("confirmPassword", password);
  return form;
}

async function assertPasswordUnchanged(email: string, oldPassword: string, newPassword: string) {
  const oldPasswordSignIn = await authClient().auth.signInWithPassword({
    email,
    password: oldPassword,
  });
  assert.strictEqual(oldPasswordSignIn.error, null);
  assert.ok(oldPasswordSignIn.data.session);

  const newPasswordSignIn = await authClient().auth.signInWithPassword({
    email,
    password: newPassword,
  });
  assert.ok(newPasswordSignIn.error, "The attempted new password must not authenticate.");
  assert.strictEqual(newPasswordSignIn.data.session, null);
}

test("normal email/password session cannot reset the password", async () => {
  const service = localFixtureClient();
  const createdIds: string[] = [];
  try {
    const email = `password-session-${randomUUID()}@example.test`;
    const oldPassword = "old-password-123";
    const newPassword = "new-password-456";
    const admin = service;
    const created = await admin.auth.admin.createUser({
      email,
      password: oldPassword,
      email_confirm: true,
    });
    if (created.data.user) createdIds.push(created.data.user.id);
    assert.strictEqual(created.error, null);
    assert.ok(created.data.user);

    const passwordClient = authClient();
    const signedIn = await passwordClient.auth.signInWithPassword({
      email,
      password: oldPassword,
    });
    assert.strictEqual(signedIn.error, null);
    assert.strictEqual(signedIn.data.user?.id, created.data.user.id);
    assert.ok(signedIn.data.session);

    const passwordClaims = await passwordClient.auth.getClaims();
    assert.strictEqual(passwordClaims.error, null);
    assert.strictEqual(passwordClaims.data?.claims.sub, created.data.user.id);
    assert.deepStrictEqual(passwordClaims.data?.claims.amr?.map((entry) =>
      typeof entry === "string" ? entry : entry.method,
    ), ["password"]);

    createServerClient.mockResolvedValueOnce(passwordClient);
    assert.deepStrictEqual(await resetPasswordAction({}, passwordForm(newPassword)), {
      formError: "This authentication link is invalid or has expired.",
    });
    await assertPasswordUnchanged(email, oldPassword, newPassword);
  } finally {
    await cleanupAuthFixtures(service, createdIds);
  }
});

test("direct OTP verification cannot use the PKCE recovery reset action", async () => {
  const service = localFixtureClient();
  const createdIds: string[] = [];
  try {
    const email = `password-recovery-${randomUUID()}@example.test`;
    const oldPassword = "old-password-123";
    const newPassword = "new-password-456";
    const admin = service;
    const created = await admin.auth.admin.createUser({
      email,
      password: oldPassword,
      email_confirm: true,
    });
    if (created.data.user) createdIds.push(created.data.user.id);
    assert.strictEqual(created.error, null);
    assert.ok(created.data.user);

    const generated = await admin.auth.admin.generateLink({ type: "recovery", email });
    assert.strictEqual(generated.error, null);
    const properties = generated.data.properties;
    assert.ok(properties);
    const { hashed_token: hashedToken } = properties;
    assert.ok(hashedToken);

    const recoveryClient = authClient();
    const verified = await recoveryClient.auth.verifyOtp({
      token_hash: hashedToken,
      type: "recovery",
    });
    assert.strictEqual(verified.error, null);
    assert.strictEqual(verified.data.user?.id, created.data.user.id);
    assert.ok(verified.data.session);

    const recoveryClaims = await recoveryClient.auth.getClaims();
    assert.strictEqual(recoveryClaims.error, null);
    assert.deepStrictEqual(recoveryClaims.data?.claims.amr?.map((entry) =>
      typeof entry === "string" ? entry : entry.method,
    ), ["otp"]);

    createServerClient.mockResolvedValueOnce(recoveryClient);
    assert.deepStrictEqual(await resetPasswordAction({}, passwordForm(newPassword)), {
      formError: "This authentication link is invalid or has expired.",
    });

    await assertPasswordUnchanged(email, oldPassword, newPassword);
  } finally {
    await cleanupAuthFixtures(service, createdIds);
  }
});
