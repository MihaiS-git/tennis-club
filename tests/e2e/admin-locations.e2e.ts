import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

test("location rows navigate to the shared workspace form and edits stay in place", async ({ page }) => {
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
    await expect(page.getByRole("link", { name: "Create location", exact: true })).toHaveAttribute("href", "/admin/locations/new");
    const table = page.getByRole("table", { name: "Locations" });
    await expect(table.getByRole("columnheader")).toHaveCount(10);
    const row = table.getByRole("row", { name: `Manage location ${locationName}` });
    await row.getByText("Cluj", { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/locations/${locationId}$`));
    const form = page.getByRole("form", { name: "Edit location" });
    await expect(form.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(locationName);
    await expect(form.getByRole("textbox", { name: "Address line 1" })).toHaveValue("Fixture street 1");
    await expect(form.getByRole("textbox", { name: "City", exact: true })).toHaveValue("Cluj");
    await form.getByRole("textbox", { name: "City", exact: true }).fill("Updated city");
    await form.getByRole("button", { name: "Save location", exact: true }).click();
    await expect(form.getByRole("button", { name: "Save location", exact: true })).toBeDisabled();
    await expect(page).toHaveURL(new RegExp(`/admin/locations/${locationId}$`));
    await expect(page.getByRole("textbox", { name: "City", exact: true })).toHaveValue("Updated city");
    await page.getByRole("navigation", { name: "Admin navigation" }).getByRole("link", { name: "Locations", exact: true }).click();
    await expect(row.getByText("Updated city", { exact: true })).toBeVisible();
    await row.focus();
    await row.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/admin/locations/${locationId}$`));
    await expect(page.getByRole("heading", { name: locationName, exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "City", exact: true })).toHaveValue("Updated city");
    const tabs = page.getByRole("navigation", { name: "Location management" });
    await expect(tabs.getByRole("link")).toHaveCount(5);
    await page.getByRole("textbox", { name: "City", exact: true }).fill("Unsaved city");
    await tabs.getByRole("link", { name: "Opening hours", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/locations/${locationId}\\?tab=opening-hours$`));
    await expect(page.getByRole("region", { name: "Opening hours", exact: true })).toBeVisible();
    await expect(form).toBeHidden();
    await tabs.getByRole("link", { name: "Courts", exact: true }).click();
    await expect(page.getByRole("button", { name: "Create court", exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("region", { name: "Opening hours", exact: true })).toBeVisible();
    await page.goForward();
    await expect(page.getByRole("region", { name: "Courts", exact: true })).toBeVisible();
    await tabs.getByRole("link", { name: "Pricing", exact: true }).click();
    await expect(page.getByRole("button", { name: "Add rule", exact: true })).toBeDisabled();
    await tabs.getByRole("link", { name: "Public booking", exact: true }).click();
    await expect(page.getByRole("button", { name: "Enable public booking" })).toBeDisabled();
    await page.getByRole("link", { name: "Opening hours not configured" }).click();
    await expect(page.getByRole("region", { name: "Opening hours", exact: true })).toBeVisible();
    await tabs.getByRole("link", { name: /^Details/ }).click();
    await expect(page.getByRole("textbox", { name: "City", exact: true })).toHaveValue("Unsaved city");
    await page.getByRole("navigation", { name: "Admin navigation" }).getByRole("link", { name: "Locations", exact: true }).click();
    await expect(page.getByText("You have unsaved changes in Details.")).toBeVisible();
    await page.getByRole("button", { name: "Stay", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "City", exact: true })).toHaveValue("Unsaved city");
    await expect(page.getByRole("dialog")).toHaveCount(0);

  } finally {
    await page.close();
    expect((await service.from("locations").delete().eq("id", locationId)).error).toBeNull();
    expect((await service.from("users").delete().eq("id", userId)).error).toBeNull();
    expect((await service.auth.admin.deleteUser(userId)).error).toBeNull();
  }
});
