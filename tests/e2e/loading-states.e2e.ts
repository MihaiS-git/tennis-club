import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DataSource } from "typeorm";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

// Hold responses explicitly, so pending-state assertions do not depend on network speed.
async function holdResponses(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const handler = async (route: Route) => {
    if (route.request().method() === "GET" && route.request().headers().rsc === "1") {
      await gate;
    }
    await route.continue();
  };
  await page.route("**/*", handler);
  return async () => { release(); await page.unrouteAll({ behavior: "wait" }); };
}

async function fitsViewport(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function expectLoading(status: Locator, label: string) {
  await expect(status).toHaveText(label);
  await expect(status).toBeVisible();
  await expect(status.locator("svg")).toBeVisible();
  await expect(status.locator("svg")).toHaveAttribute("aria-hidden", "true");
}

test.describe("loading feedback", () => {
  const location = randomUUID(), court = randomUUID(), schedule = randomUUID(), rules = randomUUID();
  const email = `loading-${randomUUID()}@example.test`, password = "Loading-browser-123";
  const date = "2099-10-15";
  let user: string;
  let db: DataSource;
  let auth: ReturnType<typeof createClient>;
  test.beforeAll(async () => {
    db = await new DataSource({ type: "postgres", url: process.env.DATABASE_URL }).initialize();
    auth = createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    const created = await auth.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull(); user = created.data.user!.id;
    await db.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [user]);
    // A Romanian address needs Inter's latin-ext glyphs on the homepage.
    await db.query("INSERT INTO public.locations(id,name,slug,address_line1,city,timezone,currency,is_public) VALUES($1,'Loading Club',$2,'Splaiul Independenței 1','București','UTC','RON',true)", [location, `loading-${location}`]);
    await db.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'L1','l1','clay','outdoor')", [court, location]);
    await db.query("INSERT INTO public.opening_hours_schedules(id,location_id,starts_on) VALUES($1,$2,'0001-01-01')", [schedule, location]);
    await db.query("INSERT INTO public.pricing_rule_sets(id,location_id) VALUES($1,$2)", [rules, location]);
    for (let weekday = 0; weekday < 7; weekday++) {
      await db.query("INSERT INTO public.location_opening_hours(schedule_id,location_id,weekday,opens_at_minute,closes_at_minute) VALUES($1,$2,$3,480,1200)", [schedule, location, weekday]);
      await db.query("INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor) VALUES($1,$2,$3,'outdoor',$4,480,1200,5000)", [location, rules, court, weekday]);
    }
  });
  test.afterAll(async () => {
    try {
      for (const table of ["location_pricing_rules", "pricing_rule_sets", "location_opening_hours", "opening_hours_schedules", "courts"]) {
        await db.query(`DELETE FROM public.${table} WHERE location_id=$1`, [location]);
      }
      await db.query("DELETE FROM public.locations WHERE id=$1", [location]);
      await db.query("DELETE FROM public.user_roles WHERE user_id=$1", [user]);
      await db.query("DELETE FROM public.users WHERE id=$1", [user]);
      expect((await auth.auth.admin.deleteUser(user)).error).toBeNull();
    } finally { await db.destroy(); }
  });
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("initial public and management fallbacks are usable before streamed scripts run", async ({ page }) => {
    // Streaming behavior is shared across viewports; exercise it once.
    await page.setViewportSize({ width: 1440, height: 1000 });
    const session = await page.context().newCDPSession(page);
    try {
      for (const [path, label, heading] of [
        [`/book?location=${location}&date=${date}`, "Loading court availability…", "Find time on court."],
        [`/admin/locations/${location}`, "Loading management area…", "Loading Club"],
      ]) {
        // Inspect the actual initial HTML before React applies streamed replacements.
        await session.send("Emulation.setScriptExecutionDisabled", { value: true });
        await page.goto(path);
        await expectLoading(page.getByRole("status").filter({ hasText: label }), label);
        if (path.startsWith("/admin")) {
          await expect(page.getByRole("navigation", { name: "Management navigation" })).toHaveCount(0);
          // The page height is unknown until authorization, so the footer is not painted yet.
          await expect(page.locator("body > footer")).toBeHidden();
        }
        await fitsViewport(page);
        await session.send("Emulation.setScriptExecutionDisabled", { value: false });
        await page.reload();
        await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        await expect(page.getByRole("status").filter({ hasText: label })).toHaveCount(0);
        await expect(page.locator("body > footer")).toBeVisible();
      }
    } finally {
      await session.send("Emulation.setScriptExecutionDisabled", { value: false });
      await session.detach();
    }
  });

  // The management fallback fills the viewport; loaded pages may be taller at either width.
  for (const width of [1440, 390]) {
    test(`initial management load does not shift the footer at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => {
        const footerShifts: number[] = [];
        Object.assign(window, { footerShifts });
        new PerformanceObserver(list => {
          for (const entry of list.getEntries() as (PerformanceEntry & { value: number; sources: { node?: Node }[] })[]) {
            if (entry.sources.some(source => source.node?.nodeName === "FOOTER")) footerShifts.push(entry.value);
          }
        }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto("/admin/locations");
      await expect(page.getByRole("heading", { name: "Locations", exact: true })).toBeVisible();
      await expect(page.locator("body > footer")).toBeVisible();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.evaluate(() => (window as unknown as { footerShifts: number[] }).footerShifts)).toEqual([]);
    });
  }

  // The prerendered Profile layout paints its sidebar and page fallbacks first; the
  // streamed sidebar and the taller page must not move the content or the footer.
  for (const [path, probe] of [["/profile", "Player profile"], ["/profile/personal", "First name"]] as const) {
    test(`initial ${path} load does not shift the page content or footer at 390px`, async ({ page }) => {
      await page.addInitScript(() => {
        const contentShifts: number[] = [];
        Object.assign(window, { contentShifts });
        new PerformanceObserver(list => {
          for (const entry of list.getEntries() as (PerformanceEntry & { value: number; sources: { node?: Node }[] })[]) {
            if (entry.sources.some(({ node }) => node instanceof Element && (node.closest("main") || node.nodeName === "FOOTER"))) contentShifts.push(entry.value);
          }
        }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto(path);
      await expect(page.getByText(probe, { exact: true })).toBeVisible();
      await expect(page.locator("body > footer")).toBeVisible();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.evaluate(() => (window as unknown as { contentShifts: number[] }).contentShifts)).toEqual([]);
    });
  }

  test("homepage requests the latin-ext font only once Locations nears the viewport", async ({ page }) => {
    const latinExtInter = () => page.evaluate(() => [...document.fonts]
      .filter(font => font.family.replaceAll('"', "") === "Inter" && font.unicodeRange.startsWith("U+100-2BA"))
      .map(font => font.status));
    await page.goto("/");
    // Each location links to the Contact page with its city, which uses latin-ext glyphs.
    const address = page.locator("#locations li").filter({ hasText: "București" });
    await expect(address).toHaveCount(1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await latinExtInter()).toEqual(["unloaded"]);
    await address.scrollIntoViewIfNeeded();
    await expect(address.getByRole("link")).toHaveAttribute("href", /^\/contact\?location=/);
    await expect.poll(latinExtInter).toEqual(["loaded"]);
  });

  // Desktop and mobile headers have different controls and spinner placement.
  for (const width of [1440, 390]) {
    test(`navbar booking feedback stays inside the header without moving controls at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      // Reload with RSC responses held to keep prefetch from skipping the pending UI.
      const finish = await holdResponses(page);
      const header = page.locator("header:visible");
      const booking = header.locator('a[href="/book"]');
      const status = booking.locator(":scope > span[aria-hidden=true]");
      try {
        await page.reload();
        await expect(booking).toBeVisible();
        await expect(width < 1024 ? page.getByRole("button", { name: "Open menu", exact: true }) : header.getByRole("link", { name: "Profile", exact: true })).toBeVisible();
        await expect(status).toBeEmpty();
        const headerBefore = await header.boundingBox();
        const bookingBefore = await booking.boundingBox();
        const slotBefore = await status.boundingBox();
        const controlsBefore = await header.locator("a, button").evaluateAll(elements => elements.map(element => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        }));
        await booking.click();
        await expect(status.locator("svg")).toBeVisible();
        await expect(booking).toHaveAccessibleName("Book a court");
        await expect(page).toHaveURL(/\/$/);
        expect(await header.boundingBox()).toEqual(headerBefore);
        expect(await booking.boundingBox()).toEqual(bookingBefore);
        expect(await status.boundingBox()).toEqual(slotBefore);
        expect(await header.locator("a, button").evaluateAll(elements => elements.map(element => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        }))).toEqual(controlsBefore);
        if (width < 1024) {
          // The circular mobile spinner must fit in the gap below the button.
          const geometry = await status.evaluate(element => {
            const slot = element.getBoundingClientRect();
            const header = element.closest("header")!;
            const borderTop = header.getBoundingClientRect().bottom - parseFloat(getComputedStyle(header).borderBottomWidth);
            return { slotTop: slot.top, slotBottom: slot.bottom, buttonBottom: element.parentElement!.getBoundingClientRect().bottom, borderTop };
          });
          expect(geometry.slotTop).toBeGreaterThanOrEqual(geometry.buttonBottom);
          expect(geometry.slotBottom).toBeLessThan(geometry.borderTop);
        }
        await fitsViewport(page);
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(await status.locator("svg").evaluate(icon => getComputedStyle(icon).animationName)).toBe("none");
        await expect(status.locator("svg")).toBeVisible();
        await expect(booking).toHaveAccessibleName("Book a court");
      } finally { await finish(); }
      await expect(page).toHaveURL(/\/book$/);
      await expect(status).toBeEmpty();
      await expect(status.locator("svg")).toHaveCount(0);
    });
  }

  // Drawer lifecycle and narrow filter geometry need only the mobile viewport.
  test("mobile Admin redirect back to the current page dismisses the drawer", async ({ page }) => {
    await page.goto("/admin/locations");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/admin?*", async route => { await gate; await route.continue(); });
    const trigger = page.locator("header:visible button[aria-controls][aria-expanded]");
    await trigger.click();
    const admin = page.getByRole("navigation", { name: "Mobile navigation", exact: true }).getByRole("link", { name: "Admin", exact: true });
    try {
      await admin.click({ noWaitAfter: true });
      await expect(admin.locator("svg")).toBeVisible();
      await expect(admin).toHaveAccessibleName("Admin");
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
      const link = await admin.boundingBox();
      expect(link).not.toBeNull();
      await page.mouse.click(link!.x + link!.width / 2, link!.y + link!.height / 2);
    } finally { release(); }
    await expect(page).toHaveURL(/\/admin\/locations$/);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("mobile navigation unlocks scrolling after failure and browser history", async ({ page }) => {
    await page.goto("/admin/locations");
    let fail!: () => void;
    const gate = new Promise<void>(resolve => { fail = resolve; });
    await page.route("**/admin?*", async route => { await gate; await route.abort("failed"); });
    const trigger = page.locator("header:visible button[aria-controls][aria-expanded]");
    await trigger.click();
    const admin = page.getByRole("navigation", { name: "Mobile navigation", exact: true }).getByRole("link", { name: "Admin", exact: true });
    try {
      await admin.click({ noWaitAfter: true });
      await expect(admin.locator("svg")).toBeVisible();
    } finally { fail(); }
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
    await page.goto("/courts");
    await page.goto("/admin/locations");
    await trigger.click();
    await page.goBack();
    await expect(page).toHaveURL(/\/courts$/);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
    await page.goForward();
    await expect(page).toHaveURL(/\/admin\/locations$/);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("management search keeps focus and filter controls keep their geometry", async ({ page }) => {
    await page.goto("/admin/users?sort=email&dir=asc");
    const search = page.getByRole("searchbox");
    await search.focus();
    const before = await search.boundingBox();
    const finish = await holdResponses(page);
    try {
      await search.fill(email);
      await expectLoading(page.getByRole("status").filter({ hasText: "Updating results…" }), "Updating results…");
      await expect(search).toBeFocused();
      expect(await search.boundingBox()).toEqual(before);
    } finally { await finish(); }
    await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(email)}`));
    await expect(page.getByText("Updating results…", { exact: true })).toHaveCount(0);
    await expect(search).toBeFocused();
    expect(await search.boundingBox()).toEqual(before);
    await expect(page.getByRole("link", { name: "Clear filters", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("sort")).toBe("email");
    await fitsViewport(page);
  });
});
