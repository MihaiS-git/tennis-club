import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

test("clicking the L1 location row opens its edit dialog", async ({ page }) => {
  test.setTimeout(60_000);
  const url = process.env.SUPABASE_URL!;
  const service = createClient(url, localServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `location-row-${randomUUID()}@example.test`;
  const password = "Location-row-password-123";
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error).toBeNull();
  const userId = created.data.user!.id;
  try {
    expect((await service.from("user_roles").insert({ user_id: userId, role_code: "admin" })).error).toBeNull();
    const location = await service.from("locations").select("name, address_line1, city").eq("name", "L1").single();
    expect(location.error).toBeNull();
    expect(location.data).not.toBeNull();

    const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
    await page.goto(new URL("/login", appUrl).toString());
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto(new URL("/admin/locations", appUrl).toString());
    const row = page.getByRole("table", { name: "Locations" }).getByRole("row", { name: "Edit location L1" });
    await expect(row).toBeVisible();
    await row.click();
    const dialog = page.getByRole("dialog", { name: "Edit location" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue(location.data!.name);
    await expect(dialog.getByRole("textbox", { name: "Address line 1" })).toHaveValue(location.data!.address_line1 ?? "");
    await expect(dialog.getByRole("textbox", { name: "City" })).toHaveValue(location.data!.city ?? "");
  } finally {
    expect((await service.from("users").delete().eq("id", userId)).error).toBeNull();
    expect((await service.auth.admin.deleteUser(userId)).error).toBeNull();
  }
});
