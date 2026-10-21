import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

const email = `admin-navbar-${randomUUID()}@example.test`;
const password = "Admin-navbar-test-123";
let userId: string | undefined;

// Follow the other Admin E2E fixtures: provision only in the verified isolated
// test project, and remove this account without touching existing records.
const service = () => createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), {
  auth: { persistSession: false, autoRefreshToken: false },
});

test.beforeAll(async () => {
  const client = service();
  const account = await client.auth.admin.createUser({ email, password, email_confirm: true });
  expect(account.error).toBeNull();
  userId = account.data.user!.id;
  expect((await client.from("user_roles").insert({ user_id: userId, role_code: "admin" })).error).toBeNull();
});

test.afterAll(async () => {
  if (!userId) return;
  const client = service();
  expect((await client.from("user_roles").delete().eq("user_id", userId)).error).toBeNull();
  expect((await client.from("users").delete().eq("id", userId)).error).toBeNull();
  expect((await client.auth.admin.deleteUser(userId)).error).toBeNull();
});

for (const width of [1440, 375]) {
  test(`Admin navbar navigates from public pages and Admin at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);

    for (const source of ["/", "/club", "/admin/users"]) {
      await page.goto(source);
      if (width < 1024) await page.getByRole("button", { name: "Open menu", exact: true }).click();
      const navigation = page.getByRole("navigation", {
        name: width < 1024 ? "Mobile navigation" : "Main navigation", exact: true,
      });
      const admin = navigation.getByRole("link", { name: "Admin", exact: true });
      await expect(admin).toHaveAttribute("href", "/admin");
      const originalDocument = await page.evaluateHandle(() => document);
      await admin.click();
      await expect(page).toHaveURL(/\/admin\/locations$/);
      await expect(page.getByRole("heading", { name: "Locations", exact: true })).toBeVisible();
      // A document reload destroys this handle. The redirect must complete
      // through the client router while preserving the original document.
      expect(await originalDocument.evaluate((previous) => previous === document)).toBe(true);
      await originalDocument.dispose();
      if (width >= 1024) {
        await expect(page.getByRole("navigation", { name: "Management navigation", exact: true })
          .getByRole("link", { name: "Locations", exact: true })).toHaveAttribute("aria-current", "page");
      }
      if (width < 1024) await expect(page.getByRole("dialog", { name: "Mobile navigation menu" })).toHaveCount(0);
    }
  });
}
