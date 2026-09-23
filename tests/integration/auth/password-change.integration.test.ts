import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { assert, test } from "vitest";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { changePasswordWithVerification } from "../../../src/lib/auth/password-change";

function requiredEnvironmentVariable(
  name: "SUPABASE_URL" | "SUPABASE_PUBLISHABLE_KEY",
): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const supabaseUrl = requiredEnvironmentVariable("SUPABASE_URL");
const publishableKey = requiredEnvironmentVariable("SUPABASE_PUBLISHABLE_KEY");
const mailpitMessagesSchema = z.object({
  messages: z.array(
    z.object({
      ID: z.string(),
      To: z.array(z.object({ Address: z.string() })),
    }),
  ),
});
const mailpitMessageSchema = z.object({ Text: z.string() });

function createAuthClient() {
  return createClient(supabaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "pkce",
      persistSession: false,
    },
  });
}

function provisioningCounts(userId: string): number[] {
  assert.match(userId, /^[0-9a-f-]{36}$/i);
  const result = execFileSync(
    "psql",
    [
      process.env.LOCAL_SUPABASE_DB_URL ??
        "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      "-At",
      "-c",
      `select
        (select count(*) from auth.users where id = '${userId}'),
        (select count(*) from public.users where id = '${userId}'),
        (select count(*) from public.user_roles where user_id = '${userId}' and role_code = 'member'),
        (select count(*) from public.user_roles where user_id = '${userId}' and role_code <> 'member')`,
    ],
    { encoding: "utf8" },
  );
  return result.trim().split("|").map(Number);
}

async function confirmationLinkFor(email: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const messagesResponse = await fetch(
      "http://127.0.0.1:54324/api/v1/messages",
    );
    const messages = mailpitMessagesSchema.parse(await messagesResponse.json());
    const message = messages.messages.find((candidate) =>
      candidate.To.some((recipient) => recipient.Address === email),
    );

    if (message) {
      const messageResponse = await fetch(
        `http://127.0.0.1:54324/api/v1/message/${message.ID}`,
      );
      const detail = mailpitMessageSchema.parse(await messageResponse.json());
      const link = detail.Text.match(/https?:\/\/[^ )]+/)?.[0];
      if (link) return link;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Confirmation email was not delivered for ${email}.`);
}

async function confirmSignUp(
  email: string,
  client: ReturnType<typeof createAuthClient>,
) {
  const verificationResponse = await fetch(await confirmationLinkFor(email), {
    redirect: "manual",
  });
  const callbackLocation = verificationResponse.headers.get("location");
  assert.ok(
    callbackLocation,
    "Supabase must redirect a valid confirmation link.",
  );

  const code = new URL(callbackLocation).searchParams.get("code");
  assert.ok(
    code,
    "A PKCE confirmation redirect must contain an authorization code.",
  );

  const exchange = await client.auth.exchangeCodeForSession(code);
  assert.strictEqual(exchange.error, null);
  assert.ok(exchange.data.session);
}

test("signup provisions the application profile and default member role", async () => {
  const email = `profile-provisioning-${randomUUID()}@example.test`;
  const client = createAuthClient();
  const signUp = await client.auth.signUp({
    email,
    password: "profile-password-123",
    options: {
      emailRedirectTo:
        "http://localhost:3000/auth/callback?next=/account&flow=email-confirmation",
    },
  });

  assert.strictEqual(signUp.error, null);
  assert.ok(signUp.data.user);
  assert.strictEqual(
    signUp.data.session,
    null,
    "Signup must not authenticate before confirmation.",
  );
  assert.deepStrictEqual(provisioningCounts(signUp.data.user.id), [1, 1, 1, 0],
    "A successful signup must already have its matching profile and only the member role.");
  const pendingSession = await client.auth.getSession();
  assert.strictEqual(pendingSession.error, null);
  assert.strictEqual(pendingSession.data.session, null);

  await confirmSignUp(email, client);

  const profile = await client
    .from("users")
    .select("id, email, status")
    .eq("id", signUp.data.user.id)
    .single();
  assert.strictEqual(profile.error, null);
  assert.deepStrictEqual(profile.data, {
    id: signUp.data.user.id,
    email,
    status: "active",
  });

  const roles = await client
    .from("user_roles")
    .select("role_code")
    .eq("user_id", signUp.data.user.id);
  assert.strictEqual(roles.error, null);
  assert.deepStrictEqual(roles.data, [{ role_code: "member" }]);

  await client.auth.signOut({ scope: "local" });
});

test("current-password verification protects a real Supabase password change", async () => {
  const email = `password-change-${randomUUID()}@example.test`;
  const oldPassword = "old-password-123";
  const newPassword = "new-password-456";
  const authenticatedClient = createAuthClient();
  const signUp = await authenticatedClient.auth.signUp({
    email,
    password: oldPassword,
    options: {
      emailRedirectTo:
        "http://localhost:3000/auth/callback?next=/account&flow=email-confirmation",
    },
  });

  assert.strictEqual(signUp.error, null);
  assert.ok(signUp.data.user);
  if (!signUp.data.session) await confirmSignUp(email, authenticatedClient);

  const rejected = await changePasswordWithVerification({
    authenticatedClient,
    verificationClient: createAuthClient(),
    userId: signUp.data.user.id,
    email,
    currentPassword: "incorrect-password",
    newPassword,
  });

  assert.deepStrictEqual(rejected, {
    ok: false,
    reason: "current-password-incorrect",
  });

  const unchangedProbe = createAuthClient();
  const unchangedSignIn = await unchangedProbe.auth.signInWithPassword({
    email,
    password: oldPassword,
  });
  assert.strictEqual(
    unchangedSignIn.error,
    null,
    "A rejected change must preserve the old password.",
  );
  await unchangedProbe.auth.signOut({ scope: "local" });

  const changed = await changePasswordWithVerification({
    authenticatedClient,
    verificationClient: createAuthClient(),
    userId: signUp.data.user.id,
    email,
    currentPassword: oldPassword,
    newPassword,
  });
  assert.deepStrictEqual(changed, { ok: true });

  await authenticatedClient.auth.signOut({ scope: "local" });

  const oldPasswordProbe = createAuthClient();
  const oldPasswordSignIn = await oldPasswordProbe.auth.signInWithPassword({
    email,
    password: oldPassword,
  });
  assert.ok(
    oldPasswordSignIn.error,
    "The old password must no longer sign in.",
  );

  const newPasswordProbe = createAuthClient();
  const newPasswordSignIn = await newPasswordProbe.auth.signInWithPassword({
    email,
    password: newPassword,
  });
  assert.strictEqual(newPasswordSignIn.error, null, "The new password must sign in.");
  assert.strictEqual(newPasswordSignIn.data.user?.id, signUp.data.user.id);
  await newPasswordProbe.auth.signOut({ scope: "local" });
});
