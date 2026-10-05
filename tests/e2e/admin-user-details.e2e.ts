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
    const avatar = await sharp({ create: { width: 32, height: 32, channels: 3, background: "green" } }).webp().toBuffer();
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
    const dialog = page.getByRole("dialog", { name: "Manage user", exact: true });
    for (const value of ["Alex Player", "+40799999999", "10 May 1990", "10 Court Street", "Apartment 2", "Bucharest", "010101", "Romania",
      "6", "1450", "Left-handed", "Two-handed", "Both", "Clay", "Enjoys competitive tennis."]) {
      await expect(dialog.getByText(value, { exact: true })).toBeVisible();
    }
    const image = dialog.getByRole("img", { name: "User avatar" });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    const avatarResponse = await page.request.get(`/admin/users/${populated.id}/avatar`);
    expect(avatarResponse.status()).toBe(200);
    expect(avatarResponse.headers()["cache-control"]).toBe("private, no-store");

    async function verifyLayout(width: number) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await dialog.evaluate((element) => {
        const headings = [...element.querySelectorAll("h3")];
        const rect = (title: string) => {
          const section = headings.find((heading) => heading.textContent === title)!.parentElement!;
          const { x, y, width } = section.getBoundingClientRect();
          return { x, y, width };
        };
        return {
          identity: rect("Profile"), address: rect("Address"), tennis: rect("Tennis profile"), account: rect("Account"),
          width: element.getBoundingClientRect().width,
          overflowX: element.scrollWidth > element.clientWidth,
          overflowY: element.scrollHeight > element.clientHeight,
        };
      });
      expect(layout.overflowX).toBe(false);
      expect(layout.width).toBeLessThanOrEqual(width - 32);
      expect(layout.account.y).toBeGreaterThan(layout.tennis.y);
      if (width >= 1280) {
        expect(layout.width).toBe(1024);
        expect(layout.identity.y).toBe(layout.address.y);
        expect(layout.address.y).toBe(layout.tennis.y);
        expect(layout.identity.x).toBeLessThan(layout.address.x);
        expect(layout.address.x).toBeLessThan(layout.tennis.x);
        expect(layout.overflowY).toBe(false);
      } else if (width >= 768) {
        expect(layout.identity.y).toBe(layout.address.y);
        expect(layout.identity.x).toBeLessThan(layout.address.x);
        expect(layout.tennis.y).toBeGreaterThan(layout.address.y);
      } else {
        expect(layout.identity.x).toBe(layout.address.x);
        expect(layout.address.x).toBe(layout.tennis.x);
        expect(layout.address.y).toBeGreaterThan(layout.identity.y);
        expect(layout.tennis.y).toBeGreaterThan(layout.address.y);
      }
      await page.screenshot({ path: test.info().outputPath(`manage-user-${width}.png`) });
    }
    for (const width of [1440, 1920, 768, 1024, 375]) await verifyLayout(width);
    const avatarSize = await image.boundingBox();
    expect(avatarSize?.width).toBe(144);
    expect(avatarSize?.height).toBe(144);
    await page.setViewportSize({ width: 1440, height: 900 });

    for (const role of ["Admin", "Coach"]) {
      const row = dialog.getByRole("listitem").filter({ has: page.getByText(role, { exact: true }) });
      await row.getByRole("button", { name: "Assign", exact: true }).click();
      await expect(row.getByText("Assigned", { exact: true })).toBeVisible();
      await row.getByRole("button", { name: "Remove", exact: true }).click();
      await page.getByRole("dialog", { name: `Remove ${role} role?`, exact: true }).getByRole("button", { name: `Remove ${role} role`, exact: true }).click();
      await expect(row.getByText("Not assigned", { exact: true })).toBeVisible();
    }
    await dialog.getByRole("button", { name: "Suspend user", exact: true }).click();
    await page.getByRole("dialog", { name: `Suspend ${populated.email}?`, exact: true }).getByRole("button", { name: "Suspend user", exact: true }).click();
    await expect(dialog.getByText("Suspended", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Reactivate user", exact: true }).click();
    await expect(dialog.getByText("Active", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    const longBio = "Enjoys competitive tennis and meeting new players. ".repeat(9) + "LongWord".repeat(30);
    expect((await service.from("player_profiles").update({ bio: longBio }).eq("user_id", populated.id)).error).toBeNull();
    await page.getByRole("row", { name: `Manage user ${populated.email}` }).click();
    await expect(dialog.getByText(longBio, { exact: true })).toBeVisible();
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await dialog.getByRole("button", { name: "Suspend user", exact: true }).scrollIntoViewIfNeeded();
      await expect(dialog.getByRole("button", { name: "Suspend user", exact: true })).toBeVisible();
    }
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("row", { name: `Manage user ${incomplete.email}` }).click();
    await expect(dialog.getByRole("heading", { name: "Tennis profile" })).toBeVisible();
    await expect(dialog.getByRole("img")).toHaveCount(0);
    expect(await dialog.getByText("—", { exact: true }).count()).toBeGreaterThan(10);
    await expect(dialog.getByRole("button", { name: "Suspend user", exact: true })).toBeEnabled();
    for (const width of [1440, 1024, 375]) await verifyLayout(width);
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
