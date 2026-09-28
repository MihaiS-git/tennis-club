import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";

const labels = ["Profile / player identity", "Personal information", "Tennis profile", "Account & security"] as const;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWP4z8Dwn4EBAAj+Af/KOtJRAAAAAElFTkSuQmCC", "base64");

async function section(page: Page, name: typeof labels[number]) {
  const selector = page.getByRole("navigation", { name: "Profile settings" });
  const button = selector.getByRole("button", { name, exact: true });
  // Playwright scrolls off-screen controls into view before clicking them.
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  const content = {
    "Profile / player identity": page.getByText("Player profile", { exact: true }),
    "Personal information": page.getByLabel("First name", { exact: true }),
    "Tennis profile": page.getByLabel("Bio", { exact: true }),
    "Account & security": page.getByLabel("Current password", { exact: true }),
  };
  for (const label of labels) {
    if (label === name) await expect(content[label]).toBeVisible();
    else await expect(content[label]).toBeHidden();
  }
}

async function assertNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

test("profile refinement: authenticated lifecycle, country, keyboard, navigation and responsive layouts", async ({ page }) => {
  test.setTimeout(120_000);
  const url = process.env.SUPABASE_URL!;
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url).hostname);
  const key = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY ?? z.object({ SERVICE_ROLE_KEY: z.string().min(1) })
    .parse(JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8" }))).SERVICE_ROLE_KEY;
  const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `profile-e2e-${randomUUID()}@example.test`;
  const password = "Profile-e2e-password-123";
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error).toBeNull();
  const id = created.data.user!.id;
  const avatarRequests: string[] = [];
  const forbiddenRequests: string[] = [];
  page.on("request", (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.pathname === "/profile/avatar") avatarRequests.push(request.url());
    if (requestUrl.pathname.startsWith("/storage/v1/") || requestUrl.pathname.startsWith("/rest/v1/")) forbiddenRequests.push(request.url());
  });
  try {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/profile");
    await expect(page.getByRole("img", { name: "Default player avatar" })).toBeVisible();
    await expect(page.getByText("Save your tennis profile to add an avatar.")).toBeVisible();
    await expect(page.getByText("Edit photo")).toHaveCount(0);
    expect(avatarRequests).toHaveLength(0);

    await section(page, "Personal information");
    await page.getByLabel("First name").fill("  Mihai  ");
    await page.getByLabel("Last name").fill(" Suciu ");
    const country = page.getByRole("combobox", { name: "Country", exact: true });
    for (const [name, code] of [["Romania", "RO"], ["France", "FR"], ["United Kingdom", "GB"]]) {
      await country.fill(name.toUpperCase());
      await expect(page.getByRole("option", { name, exact: true })).toBeVisible();
      await country.press("Enter");
      await expect(country).toHaveValue(name);
      await expect(page.locator('input[name="country_code"]')).toHaveValue(code);
    }
    await country.fill("Romania");
    await country.press("Enter");
    await section(page, "Tennis profile");
    await page.getByLabel("Bio").fill("Unsaved tennis edit");
    await section(page, "Personal information");
    await expect(page.getByLabel("First name")).toHaveValue("  Mihai  ");
    await expect(country).toHaveValue("Romania");
    await page.getByRole("button", { name: "Save personal information" }).click();
    await expect(page.getByText("Personal information saved.", { exact: true })).toBeVisible();
    expect((await service.from("player_profiles").select("user_id").eq("user_id", id)).data).toEqual([]);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Mihai Suciu", exact: true })).toBeVisible();
    await section(page, "Tennis profile");
    await expect(page.getByLabel("Display name")).toHaveValue("Mihai Suciu");
    await expect(page.getByLabel("Sportya level").locator("option")).toHaveText(["Not specified", "Level 4", "Level 5", "Level 6", "Level 7", "Level 8", "Level 9"]);
    await page.getByLabel("Sportya level").selectOption("6");
    await page.getByRole("button", { name: "Save tennis profile" }).click();
    await expect(page.getByText("Tennis profile saved.", { exact: true })).toBeVisible();
    expect((await service.from("player_profiles").select("display_name, sportya_level").eq("user_id", id).single()).data)
      .toEqual({ display_name: "Mihai Suciu", sportya_level: "6" });
    await section(page, "Personal information");
    await page.getByLabel("First name").fill("Changed");
    await page.getByRole("button", { name: "Save personal information" }).click();
    await expect(page.getByText("Personal information saved.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Mihai Suciu", exact: true })).toBeVisible();
    await page.getByText("Edit photo", { exact: true }).click();
    await page.getByLabel("Upload avatar").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: png });
    await page.getByRole("button", { name: "Save avatar" }).click();
    await expect(page.getByText("Avatar saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "Your player avatar" })).toBeVisible();

    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await section(page, "Profile / player identity");
      const selector = page.getByRole("navigation", { name: "Profile settings" });
      await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
      await expect(selector).toBeVisible();
      await expect(selector.getByRole("button")).toHaveText(labels);
      for (const label of labels) {
        await section(page, label);
        await assertNoOverflow(page);
      }
      await assertNoOverflow(page);
      // Native button Enter and Space activation preserve the selector's semantics.
      await selector.getByRole("button", { name: "Personal information", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("First name")).toBeVisible();
      await page.getByLabel("First name").fill("Unsaved name");
      await country.fill("france");
      await expect(page.getByRole("option", { name: "France", exact: true })).toBeVisible();
      await assertNoOverflow(page);
      await country.press("Escape");
      await expect(country).toHaveValue("Romania");
      await section(page, "Tennis profile");
      await page.getByLabel("Bio").fill("Unsaved bio");
      await selector.getByRole("button", { name: "Account & security", exact: true }).focus();
      await page.keyboard.press("Space");
      await expect(page.getByLabel("Current password")).toBeVisible();
      await expect(page.getByRole("main").getByRole("button", { name: "Sign out" })).toHaveCount(0);
      await assertNoOverflow(page);
      await section(page, "Personal information");
      await expect(page.getByLabel("First name")).toHaveValue("Unsaved name");
      await section(page, "Tennis profile");
      await expect(page.getByLabel("Bio")).toHaveValue("Unsaved bio");
      await assertNoOverflow(page);
      await section(page, "Profile / player identity");
      await page.getByText("Edit photo", { exact: true }).click();
      if (!await page.getByLabel("Change avatar").isVisible()) await page.getByText("Edit photo", { exact: true }).click();
      await expect(page.getByLabel("Change avatar")).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove avatar" })).toBeVisible();
      await assertNoOverflow(page);
      const openMenu = page.getByRole("button", { name: "Open menu" });
      const usesMenu = await openMenu.isVisible();
      if (usesMenu) await openMenu.click();
      const profileLink = usesMenu ? page.getByRole("link", { name: "Profile", exact: true }) : page.getByRole("link", { name: "Your profile" });
      await expect(profileLink).toBeVisible();
      await expect(profileLink).toHaveAttribute("href", "/profile");
      const navImage = profileLink.locator("img");
      await expect(navImage).toHaveAttribute("src", /\/profile\/avatar\?v=/);
      expect(await navImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      await profileLink.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(profileLink).toBeFocused();
      await assertNoOverflow(page);
      if (usesMenu) await page.getByRole("dialog").getByRole("button", { name: "Close menu", exact: true }).click();
    }
    await page.getByLabel("Change avatar").setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: png });
    await page.getByRole("button", { name: "Save avatar" }).click();
    await expect(page.getByRole("link", { name: "Your profile" }).locator("img")).toHaveAttribute("src", /\/profile\/avatar\?v=/);
    await page.getByRole("button", { name: "Remove avatar" }).click();
    await expect(page.getByRole("img", { name: "Default player avatar" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Your profile" }).locator("img")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Your profile" }).locator("svg")).toHaveCount(1);
    expect(forbiddenRequests).toEqual([]);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
  } finally {
    expect((await service.storage.from("profile-avatars").remove([`${id}/avatar.webp`])).error).toBeNull();
    expect((await service.from("player_profiles").delete().eq("user_id", id)).error).toBeNull();
    expect((await service.from("users").delete().eq("id", id)).error).toBeNull();
    expect((await service.auth.admin.deleteUser(id)).error).toBeNull();
  }
});
