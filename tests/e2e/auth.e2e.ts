import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { z } from "zod";

const mailpitMessagesSchema = z.object({
  messages: z.array(z.object({
    ID: z.string(),
    To: z.array(z.object({ Address: z.string() })),
  })),
});
const mailpitMessageSchema = z.object({ Text: z.string() });
const localStatusSchema = z.object({ SERVICE_ROLE_KEY: z.string().min(1) });

function testEmail(journey: string): string {
  return `e2e-${journey}-${randomUUID()}@example.test`;
}

function localServiceRoleKey(): string {
  const configured = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
  if (configured) return configured;

  const status = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
  });
  return localStatusSchema.parse(JSON.parse(status)).SERVICE_ROLE_KEY;
}

async function createConfirmedUser(email: string, password: string): Promise<void> {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is required for E2E setup.");

  const admin = createClient(url, localServiceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(error).toBeNull();
  expect(data.user?.email).toBe(email);
}

async function findEmailLink(
  request: APIRequestContext,
  email: string,
  type: "signup" | "recovery",
): Promise<string> {
  let link = "";
  await expect.poll(async () => {
    const inboxResponse = await request.get("http://127.0.0.1:54324/api/v1/messages");
    expect(inboxResponse.ok()).toBe(true);
    const inbox = mailpitMessagesSchema.parse(await inboxResponse.json());
    const message = inbox.messages.find((candidate) =>
      candidate.To.some((recipient) => recipient.Address === email));
    if (!message) return "";

    const detailResponse = await request.get(
      `http://127.0.0.1:54324/api/v1/message/${message.ID}`,
    );
    expect(detailResponse.ok()).toBe(true);
    const detail = mailpitMessageSchema.parse(await detailResponse.json());
    const urls = detail.Text.match(/https?:\/\/[^\s<>)]+/g) ?? [];
    link = urls.find((candidate) => {
      const url = new URL(candidate);
      return url.pathname === "/auth/v1/verify" && url.searchParams.get("type") === type;
    }) ?? "";
    return link;
  }, { timeout: 30_000, intervals: [250, 500, 1_000] }).not.toBe("");

  return link;
}

test("signup requires email confirmation before the member account is accessible", async ({ page, request }) => {
  const email = testEmail("signup");
  const password = "Signup-password-123";

  await page.goto("/signup");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/signup\/check-email$/);
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  await page.goto("/account");
  await expect(page).toHaveURL(/\/login\?next=%2Faccount$/);

  const link = await findEmailLink(request, email, "signup");
  const callbackRequest = page.waitForRequest((browserRequest) =>
    new URL(browserRequest.url()).pathname === "/auth/callback");
  await page.goto(link);
  await callbackRequest;
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Assigned roles" }).getByText("member")).toBeVisible();
});

test("recovery email permits password reset and sign-in with the new password", async ({ page, request }) => {
  const email = testEmail("recovery");
  const oldPassword = "Old-password-123";
  const newPassword = "New-password-456";
  await createConfirmedUser(email, oldPassword);

  await page.goto("/forgot-password");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);

  const link = await findEmailLink(request, email, "recovery");
  const callbackRequest = page.waitForRequest((browserRequest) =>
    new URL(browserRequest.url()).pathname === "/auth/callback");
  await page.goto(link);
  await callbackRequest;
  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();

  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill(newPassword);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page).toHaveURL(/\/login(?:\?|$)/);

  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(newPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
});

test("protected account route requires login and logout removes the session", async ({ page }) => {
  const email = testEmail("session");
  const password = "Session-password-123";
  await createConfirmedUser(email, password);

  await page.goto("/account");
  await expect(page).toHaveURL(/\/login\?next=%2Faccount$/);

  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login\?next=%2Faccount$/);
});
