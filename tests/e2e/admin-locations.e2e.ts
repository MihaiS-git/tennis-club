import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

test("a location link opens its management page", async ({ page }) => {
  test.setTimeout(60_000);
  const url = process.env.SUPABASE_URL!;
  const service = createClient(url, localServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `location-row-${randomUUID()}@example.test`;
  const password = "Location-row-password-123";
  const locationId = randomUUID();
  const locationName = `Location row ${locationId.slice(0, 8)}`;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error).toBeNull();
  const userId = created.data.user!.id;
  try {
    expect((await service.from("user_roles").insert({ user_id: userId, role_code: "admin" })).error).toBeNull();
    expect((await service.from("locations").insert({
      id: locationId, name: locationName, slug: `location-row-${locationId}`,
      address_line1: "Fixture street 1", city: "Cluj", timezone: "Europe/Bucharest",
    })).error).toBeNull();

    const appUrl = process.env.PLAYWRIGHT_APP_URL ?? "http://localhost:3000";
    await page.goto(new URL("/login", appUrl).toString());
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto(new URL("/admin/locations", appUrl).toString());
    const table = page.getByRole("table", { name: "Locations" });
    await expect(table.getByRole("columnheader")).toHaveCount(10);
    await table.getByRole("link", { name: locationName, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/locations/${locationId}$`));
    await expect(page.getByRole("heading", { name: locationName, exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(locationName);
    await expect(page.getByRole("textbox", { name: "Address line 1" })).toHaveValue("Fixture street 1");
    await expect(page.getByRole("textbox", { name: "City", exact: true })).toHaveValue("Cluj");
    await expect(page.getByRole("region", { name: "Opening hours", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Manage courts" })).toHaveAttribute("href", `/admin/courts?location=${locationId}`);
    await expect(page.getByRole("link", { name: "Configure pricing" })).toHaveAttribute("href", `/admin/pricing?location=${locationId}`);
    await expect(page.getByRole("button", { name: "Enable public booking" })).toBeDisabled();
  } finally {
    await page.close();
    expect((await service.from("locations").delete().eq("id", locationId)).error).toBeNull();
    expect((await service.from("users").delete().eq("id", userId)).error).toBeNull();
    expect((await service.auth.admin.deleteUser(userId)).error).toBeNull();
  }
});
