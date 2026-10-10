import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

test("Admin Users shows live profiles and private avatars while preserving management", async ({ page }) => {
  test.setTimeout(90_000);
  const url = process.env.SUPABASE_URL!;
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url).hostname);
  const service = createClient(url, localServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const runId = randomUUID();
  const ids: string[] = [];
  const password = "Admin-details-test-123";
  async function createAccount(label: string) {
    const email = `admin-details-${runId}-${label}@example.test`;
    const result = await service.auth.admin.createUser({ email, password, email_confirm: true });
    expect(result.error).toBeNull();
    const id = result.data.user!.id;
    ids.push(id);
    return { id, email };
  }
  try {
    const admin = await createAccount("admin");
    const populated = await createAccount("populated");
    const incomplete = await createAccount("incomplete");
    expect((await service.from("user_roles").insert({ user_id: admin.id, role_code: "admin" })).error).toBeNull();
    expect((await service.from("users").update({ first_name: "Alex", last_name: "Player", phone: "+40712345678",
      date_of_birth: "1990-05-10", address_line1: "10 Court Street", address_line2: "Apartment 2", city: "Bucharest", postal_code: "010101", country_code: "RO" }).eq("id", populated.id)).error).toBeNull();
    const avatar = await sharp({ create: { width: 32, height: 48, channels: 3, background: "green" } }).webp().toBuffer();
    expect((await service.storage.from("profile-avatars").upload(`${populated.id}/avatar.webp`, avatar, { contentType: "image/webp" })).error).toBeNull();
    expect((await service.from("player_profiles").insert({ user_id: populated.id, display_name: "Ace Alex", avatar_path: `${populated.id}/avatar.webp`,
      sportya_level: "6", rating: 1450, handedness: "left", backhand: "two_handed", preferred_game: "both", preferred_surface: "clay", bio: "Enjoys competitive tennis." })).error).toBeNull();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill(admin.email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto(`/admin/users?q=${encodeURIComponent(`admin-details-${runId}`)}`);
    await expect(page.getByRole("columnheader")).toHaveCount(4);
    await expect(page.getByRole("row", { name: /Manage user/ })).toHaveCount(3);
    await expect(page.getByText("Sportya level")).toHaveCount(0);
    // Change contact data after the table read; opening must fetch current data.
    expect((await service.from("users").update({ phone: "+40799999999" }).eq("id", populated.id)).error).toBeNull();
    await page.getByRole("row", { name: `Manage user ${populated.email}` }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/users/${populated.id}`));
    const tabs = page.getByRole("navigation", { name: "User management" });
    const account = page.getByRole("region", { name: "Account & access", exact: true });
    await expect(page.getByRole("heading", { name: "Alex Player", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Admin navigation" }).getByRole("link", { name: "Users", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(tabs.getByRole("link")).toHaveCount(3);
    await expect(account).toBeVisible();
    await tabs.getByRole("link", { name: "Personal profile", exact: true }).click();
    const personal = page.getByRole("region", { name: "Personal profile", exact: true });
    for (const value of ["Alex Player", "+40799999999", "10 May 1990", "10 Court Street", "Apartment 2", "Bucharest", "010101", "Romania"]) {
      await expect(personal.getByText(value, { exact: true })).toBeVisible();
    }
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await personal.evaluate((element) => {
        const sections = [...element.querySelectorAll("section")].map((section) => section.getBoundingClientRect());
        return { sameRow: sections[0].y === sections[1].y, overflow: element.scrollWidth > element.clientWidth };
      });
      expect(layout.sameRow).toBe(width >= 768);
      expect(layout.overflow).toBe(false);
    }
    await tabs.getByRole("link", { name: "Tennis profile", exact: true }).click();
    const tennis = page.getByRole("region", { name: "Tennis profile", exact: true });
    for (const value of ["Ace Alex", "6", "1450", "Left-handed", "Two-handed", "Both", "Clay", "Enjoys competitive tennis."]) {
      await expect(tennis.getByText(value, { exact: true })).toBeVisible();
    }
    await page.reload();
    await expect(tennis).toBeVisible();
    await page.goBack();
    await expect(personal).toBeVisible();
    await page.goForward();
    await expect(tennis).toBeVisible();
    const image = tennis.getByRole("img", { name: "User avatar" });
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const imageStyle = await image.evaluate((element: HTMLImageElement) => ({
        fit: getComputedStyle(element).objectFit,
        radius: getComputedStyle(element).borderRadius,
        clip: getComputedStyle(element).clipPath,
        naturalRatio: element.naturalWidth / element.naturalHeight,
        ratio: element.getBoundingClientRect().width / element.getBoundingClientRect().height,
      }));
      expect(imageStyle.fit).toBe("contain");
      expect(imageStyle.radius).toBe("0px");
      expect(imageStyle.clip).toBe("none");
      expect(imageStyle.ratio).toBeCloseTo(imageStyle.naturalRatio, 2);
      expect(await tennis.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    const avatarResponse = await page.request.get(`/admin/users/${populated.id}/avatar`);
    expect(avatarResponse.status()).toBe(200);
    expect(avatarResponse.headers()["cache-control"]).toBe("private, no-store");
    // A landscape photograph uses the same full-image presentation.
    const landscape = await sharp({ create: { width: 64, height: 32, channels: 3, background: "green" } }).webp().toBuffer();
    expect((await service.storage.from("profile-avatars").upload(`${populated.id}/avatar.webp`, landscape, { contentType: "image/webp", upsert: true })).error).toBeNull();
    await page.reload();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth / element.naturalHeight)).toBe(2);
    const landscapeSize = await image.boundingBox();
    expect(landscapeSize!.width / landscapeSize!.height).toBeCloseTo(2, 2);
    await tabs.getByRole("link", { name: "Account & access", exact: true }).click();
    for (const role of ["Admin", "Coach"]) {
      const row = account.getByRole("listitem").filter({ has: page.getByText(role, { exact: true }) });
      await row.getByRole("button", { name: "Assign", exact: true }).click();
      await expect(row.getByText("Assigned", { exact: true })).toBeVisible();
      await page.reload();
      await expect(row.getByText("Assigned", { exact: true })).toBeVisible();
      await row.getByRole("button", { name: "Remove", exact: true }).click();
      await page.getByRole("dialog", { name: `Remove ${role} role?`, exact: true }).getByRole("button", { name: `Remove ${role} role`, exact: true }).click();
      await expect(row.getByText("Not assigned", { exact: true })).toBeVisible();
    }
    await account.getByRole("button", { name: "Suspend user", exact: true }).click();
    await page.getByRole("dialog", { name: `Suspend ${populated.email}?`, exact: true }).getByRole("button", { name: "Suspend user", exact: true }).click();
    await expect(account.getByText("Suspended", { exact: true })).toBeVisible();
    await page.reload();
    await expect(account.getByText("Suspended", { exact: true })).toBeVisible();
    await account.getByRole("button", { name: "Reactivate user", exact: true }).click();
    await expect(account.getByText("Active", { exact: true })).toBeVisible();
    const longBio = "Enjoys competitive tennis and meeting new players. ".repeat(9) + "LongWord".repeat(30);
    expect((await service.from("player_profiles").update({ bio: longBio }).eq("user_id", populated.id)).error).toBeNull();
    await tabs.getByRole("link", { name: "Tennis profile", exact: true }).click();
    await expect(tennis.getByText(longBio, { exact: true })).toBeVisible();
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await tennis.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await expect(page.getByRole("link", { name: "Back to users", exact: true })).toHaveCount(0);
    await page.getByRole("navigation", { name: "Admin navigation" }).getByRole("link", { name: "Users", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await page.goto(`/admin/users?q=${encodeURIComponent(`admin-details-${runId}`)}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("row", { name: `Manage user ${incomplete.email}` }).click();
    await expect(account.getByRole("button", { name: "Suspend user", exact: true })).toBeEnabled();
    await tabs.getByRole("link", { name: "Tennis profile", exact: true }).click();
    await expect(tennis.getByRole("img")).toHaveCount(0);
    await expect(tennis.getByText("No avatar uploaded", { exact: true })).toBeVisible();
    // The same route never serves private avatars without an authenticated Admin.
    const anonymous = await page.context().browser()!.newContext();
    try { expect((await anonymous.request.get(`${test.info().project.use.baseURL}/admin/users/${populated.id}/avatar`)).status()).toBe(401); }
    finally { await anonymous.close(); }
  } finally {
    for (const id of ids.reverse()) {
      await service.storage.from("profile-avatars").remove([`${id}/avatar.webp`]);
      expect((await service.from("player_profiles").delete().eq("user_id", id)).error).toBeNull();
      expect((await service.from("user_roles").delete().eq("user_id", id)).error).toBeNull();
      expect((await service.from("users").delete().eq("id", id)).error).toBeNull();
      expect((await service.auth.admin.deleteUser(id)).error).toBeNull();
    }
  }
});
