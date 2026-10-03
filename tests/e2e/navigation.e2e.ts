import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

test("auth forms start fresh when revisited through navigation", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Email" }).fill("draft@example.test");
  await page.getByLabel("Password", { exact: true }).fill("Unsaved-password-123");
  await page.getByRole("link", { name: "Sign up", exact: true }).click();
  await page.getByLabel("New password", { exact: true }).fill("Unsaved-signup-password");
  await page.getByRole("main").getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue("");
  await page.getByRole("link", { name: "Sign up", exact: true }).click();
  await expect(page.getByLabel("New password", { exact: true })).toHaveValue("");
});

test("navigation follows the current account and protected routes enforce access", async ({ page }) => {
  test.setTimeout(60_000);
  const url = process.env.SUPABASE_URL!;
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url).hostname);
  const key = localServiceRoleKey();
  const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  // Retain the database's last-active-admin invariant during fixture cleanup.
  const anchor = await service.from("user_roles").select("user_id, users!user_roles_user_id_fkey!inner(status)")
    .eq("role_code", "admin").eq("users.status", "active").limit(1);
  expect(anchor.error).toBeNull();
  expect(anchor.data?.length, "Local E2E setup requires an existing active admin").toBe(1);
  const password = "Navigation-password-123";
  const accounts: { id: string; email: string }[] = [];
  async function signIn(target: Page, email: string) {
    await target.getByRole("textbox", { name: "Email" }).fill(email);
    await target.getByLabel("Password", { exact: true }).fill(password);
    await target.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(target).toHaveURL(/\/$/);
    await expect(target.getByRole("button", { name: "Account menu" })).toBeVisible();
  }
  try {
    for (const label of ["member", "admin"]) {
      const email = `navigation-${label}-${randomUUID()}@example.test`;
      const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
      expect(created.error).toBeNull();
      accounts.push({ id: created.data.user!.id, email });
    }
    expect((await service.from("user_roles").insert({ user_id: accounts[1].id, role_code: "admin" })).error).toBeNull();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    const navigation = page.getByRole("navigation", { name: "Main navigation" });
    await expect(navigation.getByRole("link", { name: "Matches" })).toHaveCount(0);
    await expect(navigation.getByRole("link", { name: "Admin" })).toHaveCount(0);
    for (const route of ["/profile", "/admin/users", "/reset-password"]) {
      await page.goto(route);
      await expect(page).toHaveURL(/\/login(?:\?|$)/);
    }
    await signIn(page, accounts[0].email);
    await page.getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByRole("link", { name: "My activity" })).toHaveAttribute("href", "/my-activity");
    await expect(page.getByRole("link", { name: "Profile & settings" })).toHaveAttribute("href", "/profile");
    await page.getByRole("link", { name: "My activity" }).click();
    await expect(page).toHaveURL(/\/my-activity$/);
    await expect(navigation.getByRole("link", { name: "Matches" })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Admin" })).toHaveCount(0);
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: /404|not found/i })).toBeVisible();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("button", { name: "Account menu" })).toHaveCount(0);
    await signIn(page, accounts[1].email);
    await expect(navigation.getByRole("link", { name: "Admin" })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Users" })).toHaveCount(0);
    await navigation.getByRole("link", { name: "Admin" }).click();
    const adminNavigation = page.getByRole("navigation", { name: "Admin navigation" });
    await adminNavigation.getByRole("link", { name: "Users" }).click();
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
    await page.getByRole("row", { name: `Manage user ${accounts[0].email}` }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Club administration" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Play more tennis." })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await navigation.getByRole("link", { name: "Admin" }).click();
    await adminNavigation.getByRole("link", { name: "Users" }).click();
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await signIn(page, accounts[0].email);
    await expect(navigation.getByRole("link", { name: "Admin" })).toHaveCount(0);
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("link", { name: "Profile & settings" }).click();
    await page.getByRole("navigation", { name: "Profile settings" }).getByRole("button", { name: "Account & security" }).click();
    await expect(page.getByText(accounts[0].email, { exact: true })).toBeVisible();
    await expect(page.getByText(accounts[1].email, { exact: true })).toHaveCount(0);
    await page.getByRole("navigation", { name: "Profile settings" }).getByRole("button", { name: "Personal information" }).click();
    await page.getByLabel("First name", { exact: true }).fill("Unsaved draft");
    await page.locator('header a[href="/"]:visible').click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stay", exact: true }).click();
    await expect(page.getByLabel("First name", { exact: true })).toHaveValue("Unsaved draft");
    await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toHaveCount(0);
    // Repeated attempts update one confirmation to the latest destination.
    await page.locator('header a[href="/"]:visible').click();
    await page.locator('header a[href="/"]:visible').click();
    await navigation.getByRole("link", { name: "Courts", exact: true }).click();
    await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Leave without saving", exact: true }).click();
    await expect(page).toHaveURL(/\/courts$/);
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("link", { name: "Profile & settings" }).click();
    await page.getByRole("navigation", { name: "Profile settings" }).getByRole("button", { name: "Personal information" }).click();
    await expect(page.getByLabel("First name", { exact: true })).toHaveValue("");
    // All shared link entry points guard the active Profile visit.
    for (const destination of ["/book", "/matches", "/coaching", "/courts", "/rankings", "/club"]) {
      await page.getByLabel("First name", { exact: true }).fill("Footer draft");
      await page.getByRole("navigation", { name: "Footer", exact: true }).locator(`a[href="${destination}"]`).click();
      await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/profile$/);
      await page.getByRole("button", { name: "Stay", exact: true }).click();
      await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toHaveCount(0);
    }
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('header a[href="/book"]:visible').click();
      await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Stay", exact: true }).click();
      await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toHaveCount(0);
      await page.locator('header a[href="/"]:visible').click();
      await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Stay", exact: true }).click();
      await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("link", { name: "Courts", exact: true }).click();
    await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stay", exact: true }).click();
    await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("First name", { exact: true })).toHaveValue("Footer draft");
    // Browser reload uses native confirmation; cancelling preserves drafts.
    const nativeConfirmation = page.waitForEvent("dialog");
    // Chrome can leave a cancelled reload waiting for its load event.
    const reload = page.reload({ timeout: 3_000 }).catch((error: unknown) => {
      expect(error instanceof Error ? error.message : String(error)).toMatch(/ERR_ABORTED|Timeout/);
    });
    const dialog = await nativeConfirmation;
    expect(dialog.type()).toBe("beforeunload");
    await dialog.dismiss();
    await reload;
    await expect(page.getByLabel("First name", { exact: true })).toHaveValue("Footer draft");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByLabel("First name", { exact: true }).fill("Saved name");
    await page.getByRole("button", { name: "Save personal information", exact: true }).click();
    await expect(page.getByText("Personal information saved.", { exact: true })).toHaveCount(1);
    await page.locator('header a[href="/"]:visible').click();
    await expect(page).toHaveURL(/\/$/);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
    await expect(page.getByText("Personal information saved.", { exact: true })).toHaveCount(1);
  } finally {
    await page.close();
    for (const account of accounts.reverse()) {
      expect((await service.from("users").delete().eq("id", account.id)).error).toBeNull();
      expect((await service.auth.admin.deleteUser(account.id)).error).toBeNull();
    }
  }
});
