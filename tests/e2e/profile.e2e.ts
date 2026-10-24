import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

const labels = ["Player identity", "Personal information", "Tennis profile", "Account & security"] as const;
const routes = { "Player identity": "/profile", "Personal information": "/profile/personal", "Tennis profile": "/profile/tennis", "Account & security": "/profile/security" } as const;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWP4z8Dwn4EBAAj+Af/KOtJRAAAAAElFTkSuQmCC", "base64");

// Below lg the shared user sidebar is a drawer behind the "My account menu" trigger.
async function openSidebar(page: Page) {
  const trigger = page.getByRole("button", { name: "My account menu", exact: true });
  if (await trigger.isVisible()) await trigger.click();
}

async function closeSidebar(page: Page) {
  const close = page.getByRole("button", { name: "Close my account menu", exact: true });
  if (await close.isVisible()) await close.click();
}

function sectionLink(page: Page, name: typeof labels[number]) {
  return page.getByRole("navigation", { name: "My account navigation" }).getByRole("link", { name, exact: true });
}

async function section(page: Page, name: typeof labels[number]) {
  await openSidebar(page);
  await sectionLink(page, name).click();
  await expect(page).toHaveURL(new RegExp(`${routes[name]}$`));
  await expect(page.locator(`nav[aria-label="My account navigation"] a[href="${routes[name]}"]`)).toHaveAttribute("aria-current", "page");
  const content = {
    "Player identity": page.getByText("Player profile", { exact: true }),
    "Personal information": page.getByLabel("First name", { exact: true }),
    "Tennis profile": page.getByLabel("Bio", { exact: true }),
    "Account & security": page.getByLabel("Current password", { exact: true }),
  };
  for (const label of labels) {
    if (label === name) await expect(content[label]).toBeVisible();
    // Next.js retains prior routes in hidden history subtrees.
    else await expect(content[label]).toBeHidden();
  }
}

test("profile refinement: authenticated lifecycle, country, keyboard, navigation and avatar", async ({ page }) => {
  test.setTimeout(120_000);
  const url = process.env.SUPABASE_URL!;
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url).hostname);
  const key = localServiceRoleKey();
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
    await country.fill("ROMANIA");
    await expect(page.getByRole("option", { name: "Romania", exact: true })).toBeVisible();
    await country.press("Enter");
    await expect(country).toHaveValue("Romania");
    await expect(page.locator('input[name="country_code"]')).toHaveValue("RO");
    // Leaving a Profile page with drafts asks first; Stay keeps them on the page.
    await openSidebar(page);
    await sectionLink(page, "Tennis profile").click();
    await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stay", exact: true }).click();
    await closeSidebar(page);
    await expect(page).toHaveURL(/\/profile\/personal$/);
    await expect(page.getByLabel("First name")).toHaveValue("  Mihai  ");
    await expect(country).toHaveValue("Romania");
    await page.getByRole("button", { name: "Save personal information" }).click();
    await expect(page.getByText("Personal information saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save personal information", exact: true })).toBeDisabled();
    expect((await service.from("player_profiles").select("user_id").eq("user_id", id)).data).toEqual([]);
    // The identity page reflects the saved personal information.
    await section(page, "Player identity");
    await expect(page.getByRole("heading", { name: "Mihai Suciu", exact: true })).toBeVisible();
    await section(page, "Tennis profile");
    await expect(page.getByLabel("Display name")).toHaveValue("Mihai Suciu");
    await expect(page.getByLabel("Sportya level").locator("option")).toHaveText(["Not specified", "Level 4", "Level 5", "Level 6", "Level 7", "Level 8", "Level 9"]);
    await page.getByLabel("Sportya level").selectOption("6");
    await page.getByRole("button", { name: "Save tennis profile" }).click();
    await expect(page.getByText("Tennis profile saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save tennis profile", exact: true })).toBeDisabled();
    expect((await service.from("player_profiles").select("display_name, sportya_level").eq("user_id", id).single()).data)
      .toEqual({ display_name: "Mihai Suciu", sportya_level: "6" });
    await section(page, "Personal information");
    await page.getByLabel("First name").fill("Changed");
    await page.getByRole("button", { name: "Save personal information" }).click();
    await expect(page.getByText("Personal information saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save personal information", exact: true })).toBeDisabled();
    await section(page, "Player identity");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Mihai Suciu", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit photo", exact: true }).click();
    await page.getByLabel("Upload avatar").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: png });
    await page.getByRole("button", { name: "Save avatar" }).click();
    await expect(page.getByText("Avatar saved.", { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "Your player avatar" })).toBeVisible();
    const avatarDialog = page.getByRole("dialog", { name: "Edit photo", exact: true });
    await avatarDialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(avatarDialog).toBeHidden();

    // Keyboard activation of a sidebar destination; leaving discards only the unsaved draft.
    await openSidebar(page);
    await sectionLink(page, "Personal information").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/profile\/personal$/);
    await page.getByLabel("First name").fill("Unsaved name");
    await country.fill("france");
    await expect(page.getByRole("option", { name: "France", exact: true })).toBeVisible();
    await country.press("Escape");
    await expect(country).toHaveValue("Romania");
    await openSidebar(page);
    await sectionLink(page, "Tennis profile").click();
    await page.getByRole("button", { name: "Leave without saving", exact: true }).click();
    await expect(page).toHaveURL(/\/profile\/tennis$/);
    await section(page, "Personal information");
    await expect(page.getByLabel("First name")).toHaveValue("Changed");
    await page.setViewportSize({ width: 1440, height: 900 });
    await section(page, "Player identity");
    await expect(page.getByRole("link", { name: "Profile", exact: true }).locator("img")).toBeVisible();
    await page.getByRole("button", { name: "Edit photo", exact: true }).click();
    await page.getByLabel("Change avatar").setInputFiles({ name: "replacement.png", mimeType: "image/png", buffer: png });
    await page.getByRole("button", { name: "Save avatar" }).click();
    await expect(page.getByRole("link", { name: "Profile", exact: true }).locator("img")).toBeVisible();
    await page.getByRole("button", { name: "Remove avatar" }).click();
    await expect(page.getByRole("img", { name: "Default player avatar" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Profile", exact: true }).locator("img")).toHaveCount(0);
    await avatarDialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(avatarDialog).toBeHidden();
    expect(forbiddenRequests).toEqual([]);
    // Navbar sign out guards the current page's drafts.
    await section(page, "Tennis profile");
    await page.getByLabel("Bio").fill("Unsaved bio");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByText("You have unsaved changes in Tennis profile.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Leave without saving", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
  } finally {
    expect((await service.storage.from("profile-avatars").remove([`${id}/avatar.webp`])).error).toBeNull();
    expect((await service.from("player_profiles").delete().eq("user_id", id)).error).toBeNull();
    expect((await service.from("users").delete().eq("id", id)).error).toBeNull();
    expect((await service.auth.admin.deleteUser(id)).error).toBeNull();
  }
});
