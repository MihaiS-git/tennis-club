import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { DataSource } from "typeorm";

import { deleteMailpitMessagesTo, mailpitMessageIds, mailpitMessageText } from "../local/mailpit";
import { localServiceRoleKey } from "./helpers/supabase";

function testEmail(journey: string): string {
  return `e2e-${journey}-${randomUUID()}@example.test`;
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

async function deleteTestUser(email: string): Promise<void> {
  const database = await new DataSource({ type: "postgres", url: process.env.DATABASE_URL }).initialize();
  try {
    const rows: { id: string }[] = await database.query("SELECT id FROM auth.users WHERE email=$1", [email]);
    for (const { id } of rows) {
      await database.query("DELETE FROM public.users WHERE id=$1", [id]);
      const admin = createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      expect((await admin.auth.admin.deleteUser(id)).error).toBeNull();
    }
  } finally {
    await database.destroy();
  }
}

// Polls the recipient's Mailpit messages (bounded by the poll timeout) for the Auth link.
async function findEmailLink(email: string, type: "signup" | "recovery"): Promise<string> {
  let link = "";
  await expect.poll(async () => {
    for (const id of await mailpitMessageIds(email)) {
      const urls = (await mailpitMessageText(id)).match(/https?:\/\/[^\s<>)]+/g) ?? [];
      link = urls.find((candidate) => {
        const url = new URL(candidate);
        return url.pathname === "/auth/v1/verify" && url.searchParams.get("type") === type;
      }) ?? "";
      if (link) break;
    }
    return link;
  }, { timeout: 30_000, intervals: [250, 500, 1_000] }).not.toBe("");

  return link;
}

// Soft checks keep a test failure primary, report each cleanup failure and still run the rest.
async function cleanupJourney(email: string): Promise<void> {
  await expect.soft(deleteTestUser(email), "delete test user").resolves.toBeUndefined();
  await expect.soft(deleteMailpitMessagesTo(email), "delete test mail").resolves.toBeUndefined();
}

test("signup requires email confirmation before the account is accessible", async ({ page }) => {
  const email = testEmail("signup");
  const password = "Signup-password-123";
  try {
    await page.goto("/signup");
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page.getByLabel("Confirm new password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign up" }).click();
    await expect(page).toHaveURL(/\/signup\/check-email$/);
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

    await page.goto("/account");
    await expect(page).toHaveURL(/\/login$/);

    const link = await findEmailLink(email, "signup");
    const callbackRequest = page.waitForRequest((browserRequest) =>
      new URL(browserRequest.url()).pathname === "/auth/callback");
    await page.goto(link);
    await callbackRequest;
    await expect(page).toHaveURL(/\/profile$/);
    await page.getByRole("navigation", { name: "My account navigation" }).getByRole("link", { name: "Account & security" }).click();
    await expect(page.getByRole("heading", { name: "Account & security" })).toBeVisible();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Assigned roles" }).getByRole("listitem")).toHaveCount(0);
  } finally {
    await cleanupJourney(email);
  }
});

test("recovery email permits password reset and sign-in with the new password", async ({ page }) => {
  const email = testEmail("recovery");
  const oldPassword = "Old-password-123";
  const newPassword = "New-password-456";
  try {
    await createConfirmedUser(email, oldPassword);

    await page.goto("/forgot-password");
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);

    const link = await findEmailLink(email, "recovery");
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
    await expect(page).toHaveURL(/\/$/);
  } finally {
    await cleanupJourney(email);
  }
});
