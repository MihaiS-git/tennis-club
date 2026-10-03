import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

// Headless Chromium hides scrollbars by default. Exercise desktop viewport
// layout with real scrollbars so a disappearing scrollbar cannot mask a shift.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--disable-features=OverlayScrollbar"] } });

test("resolved authenticated navbar stays visible throughout unmatched-route navigation", async ({ page }) => {
  test.setTimeout(60_000);
  const url = process.env.SUPABASE_URL!;
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url).hostname);
  const service = createClient(url, localServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const email = `navbar-transition-${randomUUID()}@example.test`;
  const password = "Navbar-transition-password-123";
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error).toBeNull();
  const userId = created.data.user!.id;

  try {
    // Home scrolls at this desktop height; the branded 404 fits the viewport.
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Play more tennis." })).toBeVisible();
    const navigation = page.getByRole("navigation", { name: "Main navigation" });
    await expect(navigation.getByRole("link", { name: "Matches", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
    // Wait for all initial boundaries (including ones that resolve to null).
    await expect(page.locator('header:visible span[aria-hidden="true"]')).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready);

    // Canonical unmatched routes may force a new document. Keep observing its
    // first paints too, rather than losing the evidence with the old window.
    await page.addInitScript(() => {
      const saved = sessionStorage.getItem("navbar-continuity");
      if (!saved) return;
      const result = JSON.parse(saved);
      result.failures.push("Navbar/root layout was remounted by document navigation");
      result.sameDocument = false;
      result.done = false;
      Object.assign(window, { __navbarContinuity: result });
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return element.isConnected && rect.width > 0 && rect.height > 0
          && getComputedStyle(element).visibility !== "hidden";
      };
      let settledFrames = 0;
      const check = () => {
        const header = Array.from(document.querySelectorAll("header")).find(visible);
        if (!header) return false;
        if (Array.from(header.querySelectorAll('span[aria-hidden="true"]')).some(visible)
          && !result.failures.includes("Visible loading placeholder replaced navbar content")) {
          result.failures.push("Visible loading placeholder replaced navbar content");
        }
        const authenticated = Array.from(header.querySelectorAll("button"))
          .some((button) => button.getAttribute("aria-label") === "Account menu" && visible(button));
        if (!authenticated && !result.failures.includes("Resolved authenticated navbar content disappeared")) {
          result.failures.push("Resolved authenticated navbar content disappeared");
        }
        result.finalText = header.innerText;
        return authenticated && Array.from(document.querySelectorAll("h2"))
          .some((heading) => heading.textContent === "This page is out of bounds." && visible(heading));
      };
      const observer = new MutationObserver(() => { result.mutations++; check(); });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      const sample = () => {
        result.frames++;
        const header = Array.from(document.querySelectorAll("header")).find(visible);
        if (header && Array.from(header.querySelectorAll('span[aria-hidden="true"]')).some(visible)) {
          result.placeholderFrames = (result.placeholderFrames || 0) + 1;
        }
        settledFrames = check() ? settledFrames + 1 : 0;
        if (settledFrames >= 2) {
          observer.disconnect();
          result.done = true;
          sessionStorage.removeItem("navbar-continuity");
        } else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    const missingPath = `/navbar-missing-${randomUUID()}`;
    const responses: { status: number; contentType: string | undefined; resourceType: string; rsc: string | undefined }[] = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname !== missingPath) return;
      responses.push({
        status: response.status(),
        contentType: response.headers()["content-type"],
        resourceType: response.request().resourceType(),
        rsc: response.request().headers().rsc,
      });
    });
    await page.evaluate((href) => {
      // A test-only link exercises a real click and the same public App Router
      // navigation API used by application links, without adding fixture UI.
      const link = document.createElement("a");
      link.href = href;
      link.textContent = "Visit nonexistent route";
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const next = Reflect.get(window, "next") as { router: { push: (path: string) => void } };
        next.router.push(href);
      });
      document.querySelector("main")!.prepend(link);
    }, missingPath);
    await page.evaluate(() => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        if (!element.isConnected || rect.width === 0 || rect.height === 0) return false;
        for (let current: Element | null = element; current; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
        }
        return rect.bottom > 0 && rect.top < innerHeight;
      };
      const header = Array.from(document.querySelectorAll("header")).find(visible);
      if (!header) throw new Error("Resolved navbar missing before observation");
      const body = document.body;
      const html = document.documentElement;
      const controls = Array.from(header.querySelectorAll("a, button")).filter(visible);
      const brand = header.querySelector('a[href="/"]');
      const container = brand?.parentElement;
      if (!brand || !container) throw new Error("Navbar brand/container missing before observation");
      const geometry = () => {
        const box = (element: Element) => {
          const { left, width } = element.getBoundingClientRect();
          return { left, width };
        };
        const scrolling = document.scrollingElement;
        if (!scrolling) throw new Error("Root scrolling element missing");
        return {
          header: box(header), container: box(container), brand: box(brand),
          viewportWidth: innerWidth, clientWidth: html.clientWidth,
          scrollingElement: scrolling.tagName,
          scrollHeight: scrolling.scrollHeight, clientHeight: scrolling.clientHeight,
          scrollbarGutter: getComputedStyle(scrolling).scrollbarGutter,
        };
      };
      const initialGeometry = geometry();
      const initialText = header.innerText;
      const failures = new Set<string>();
      const result = {
        failures: [] as string[], frames: 0, mutations: 0, placeholderFrames: 0,
        sameDocument: true, initialText, finalText: "", done: false,
        initialGeometry, finalGeometry: initialGeometry,
      };
      Object.assign(window, { __navbarContinuity: result });
      window.addEventListener("pagehide", () => {
        sessionStorage.setItem("navbar-continuity", JSON.stringify(result));
      }, { once: true });
      const check = () => {
        if (document.body !== body || document.documentElement !== html || !header.isConnected) failures.add("Navbar/root layout was replaced");
        if (!visible(header)) failures.add("Resolved navbar became invisible");
        for (const control of controls) {
          if (!visible(control)) failures.add(`Resolved control disappeared: ${control.getAttribute("aria-label") || control.textContent?.trim()}`);
        }
        if (header.innerText !== initialText) failures.add(`Navbar text changed: ${header.innerText}`);
        const currentHeader = Array.from(document.querySelectorAll("header")).find(visible);
        if (currentHeader !== header) failures.add("Visible navbar was remounted");
        if (currentHeader && Array.from(currentHeader.querySelectorAll('span[aria-hidden="true"]')).some(visible)) failures.add("Visible loading placeholder replaced navbar content");
        result.failures = Array.from(failures);
      };
      const observer = new MutationObserver(() => { result.mutations++; check(); });
      observer.observe(html, { subtree: true, childList: true, attributes: true, characterData: true });
      let completedFrames = 0;
      const sample = () => {
        result.frames++;
        const currentHeader = Array.from(document.querySelectorAll("header")).find(visible);
        if (currentHeader && Array.from(currentHeader.querySelectorAll('span[aria-hidden="true"]')).some(visible)) {
          result.placeholderFrames++;
        }
        check();
        const heading = Array.from(document.querySelectorAll("h2")).find((element) => element.textContent === "This page is out of bounds." && visible(element));
        // Observe through a painted, fully resolved 404, including the auth stream.
        const settled = heading && currentNavbarResolved();
        completedFrames = settled ? completedFrames + 1 : 0;
        if (completedFrames >= 2) {
          observer.disconnect();
          result.finalText = Array.from(document.querySelectorAll("header")).find(visible)?.innerText || "";
          result.finalGeometry = geometry();
          result.done = true;
        } else requestAnimationFrame(sample);
      };
      const currentNavbarResolved = () => {
        const current = Array.from(document.querySelectorAll("header")).find(visible);
        return current && !Array.from(current.querySelectorAll('span[aria-hidden="true"]')).some(visible)
          && Array.from(current.querySelectorAll("button")).some((button) => button.getAttribute("aria-label") === "Account menu" && visible(button));
      };
      check();
      requestAnimationFrame(sample);
    });
    await page.getByRole("link", { name: "Visit nonexistent route", exact: true }).click();

    await expect(page).toHaveURL(missingPath);
    await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "This page is out of bounds.", exact: true })).toBeVisible();
    await page.waitForFunction(() => Reflect.get(window, "__navbarContinuity")?.done === true);
    const observation = await page.evaluate(() => Reflect.get(window, "__navbarContinuity") as {
      failures: string[]; frames: number; mutations: number; initialText: string; finalText: string;
      sameDocument: boolean; placeholderFrames: number;
      initialGeometry: { header: { left: number; width: number }; container: { left: number; width: number }; brand: { left: number; width: number } };
      finalGeometry: { header: { left: number; width: number }; container: { left: number; width: number }; brand: { left: number; width: number } };
    });
    expect(observation.frames).toBeGreaterThan(1);
    expect(observation.mutations).toBeGreaterThan(0);
    const evidencePath = test.info().outputPath("navbar-transition-observation.json");
    await writeFile(evidencePath, JSON.stringify({ observation, responses }, null, 2));
    await test.info().attach("navbar-transition-observation", {
      path: evidencePath,
      contentType: "application/json",
    });
    expect(observation.failures, JSON.stringify(observation, null, 2)).toEqual([]);
    expect(observation.sameDocument).toBe(true);
    expect(observation.placeholderFrames).toBe(0);
    expect(observation.finalText).toBe(observation.initialText);
    for (const element of ["header", "container", "brand"] as const) {
      for (const dimension of ["left", "width"] as const) {
        const movement = observation.finalGeometry[element][dimension] - observation.initialGeometry[element][dimension];
        expect(Math.abs(movement), `${element} ${dimension} moved ${movement}px; ${JSON.stringify(observation)}`).toBeLessThanOrEqual(0.5);
      }
    }
    expect(responses.some((response) => response.resourceType === "document")).toBe(false);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /(?:^|,)\s*noindex(?:,|$)/);
    // Verify actual HTTP 404 semantics independently of the client Flight stream.
    const missingResponse = await page.request.get(missingPath);
    expect(missingResponse.status()).toBe(404);
    expect(await missingResponse.text()).toContain("This page is out of bounds.");
  } finally {
    await page.close();
    expect((await service.from("users").delete().eq("id", userId)).error).toBeNull();
    expect((await service.auth.admin.deleteUser(userId)).error).toBeNull();
  }
});
