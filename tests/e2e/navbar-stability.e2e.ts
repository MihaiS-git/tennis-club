import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { z } from "zod";

test("resolved authenticated navbar stays visible during client navigation to a missing route", async ({ page }) => {
  test.setTimeout(90_000);
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is required for navigation setup.");
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url).hostname);
  const key = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY ?? z.object({ SERVICE_ROLE_KEY: z.string().min(1) })
    .parse(JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8" }))).SERVICE_ROLE_KEY;
  const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `navbar-stability-${randomUUID()}@example.test`;
  const password = "Navigation-password-123";
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error).toBeNull();
  const user = created.data.user;
  if (!user) throw new Error("Expected a navigation test user.");
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();

    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('header a[href="/"]:visible').click();
      await expect(page.getByRole("heading", { name: "Play more tennis." })).toBeVisible();
      if (width < 1024) {
        await page.getByRole("button", { name: "Open menu", exact: true }).click();
      }
      const navigation = page.getByRole("navigation", { name: width < 1024 ? "Mobile navigation" : "Main navigation", exact: true });
      await expect(navigation.getByRole("link", { name: "Matches", exact: true })).toBeVisible();
      // Sample every painted frame, including the intermediate navigation UI.
      await page.evaluate(() => {
        const header = [...document.querySelectorAll("header")].find((element) => element.getBoundingClientRect().height > 0);
        if (!header) throw new Error("Expected a resolved navbar.");
        const documentId = document.documentElement;
        const observations: string[] = [];
        let running = true;
        const sample = () => {
          if (!running) return;
          if (!header.isConnected) observations.push("Resolved navbar was replaced");
          if (header.querySelector('span[aria-hidden="true"].bg-surface-muted')) observations.push("Navbar loading placeholder appeared");
          requestAnimationFrame(sample);
        };
        const probe = document.createElement("div");
        probe.id = "navbar-stability-probe";
        probe.hidden = true;
        document.body.append(probe);
        probe.addEventListener("finish", () => {
          running = false;
          probe.textContent = JSON.stringify({ observations, sameDocument: document.documentElement === documentId });
        });
        requestAnimationFrame(sample);
      });
      await navigation.getByRole("link", { name: "Matches", exact: true }).click();
      await expect(page).toHaveURL(/\/matches$/);
      await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
      await expect(page.locator('header a[href="/profile"]:visible')).toBeVisible();
      const result = await page.evaluate(() => {
        const probe = document.getElementById("navbar-stability-probe");
        if (!probe) throw new Error("Client navigation replaced the document.");
        probe.dispatchEvent(new Event("finish"));
        const result = probe.textContent;
        probe.remove();
        return result;
      });
      expect(JSON.parse(result ?? "null")).toEqual({ observations: [], sameDocument: true });
    }
  } finally {
    expect((await service.from("users").delete().eq("id", user.id)).error).toBeNull();
    expect((await service.auth.admin.deleteUser(user.id)).error).toBeNull();
  }
});
