import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

test("auth forms start fresh when revisited through navigation", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Email" }).fill("draft@example.test");
  await page.getByLabel("Password", { exact: true }).fill("Unsaved-password-123");
  await page.getByRole("link", { name: "Sign up", exact: true }).click();
  await page.getByLabel("New password", { exact: true }).fill("Unsaved-signup-password");
  await page.getByRole("main").getByRole("link", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "Email" })).toHaveValue("");
  await page.getByRole("link", { name: "Sign up", exact: true }).click();
  await expect(page.getByLabel("New password", { exact: true })).toHaveValue("");
});

test("navigation follows the current account and protected routes enforce access", async ({ page }) => {
  test.setTimeout(120_000);
  const url = process.env.SUPABASE_URL!;
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url).hostname);
  const key = localServiceRoleKey();
  const service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const password = "Navigation-password-123";
  const accounts: { id: string; email: string }[] = [];
  const locationId = randomUUID(), courtId = randomUUID(), scheduleId = randomUUID(), ruleSetId = randomUUID();
  async function signIn(target: Page, email: string) {
    // Finish the preceding protected-route redirect before submitting a new form.
    await target.goto("/login");
    await target.getByRole("textbox", { name: "Email" }).fill(email);
    await target.getByLabel("Password", { exact: true }).fill(password);
    await target.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(target).toHaveURL(/\/$/);
    await expect(target.getByRole("link", { name: "Profile", exact: true })).toHaveAttribute("href", "/profile");
  }
  try {
    for (const label of ["member", "admin", "coach"]) {
      const email = `navigation-${label}-${randomUUID()}@example.test`;
      const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
      expect(created.error).toBeNull();
      accounts.push({ id: created.data.user!.id, email });
    }
    expect((await service.from("user_roles").insert({ user_id: accounts[1].id, role_code: "admin" })).error).toBeNull();
    expect((await service.from("user_roles").insert({ user_id: accounts[2].id, role_code: "coach" })).error).toBeNull();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
    const navigation = page.getByRole("navigation", { name: "Main navigation" });
    await expect(navigation.getByRole("link", { name: "Matches" })).toHaveCount(0);
    await expect(navigation.getByRole("link", { name: "Admin" })).toHaveCount(0);
    for (const route of ["/profile", "/admin", "/admin/users", "/admin/reservations", "/reservations?date=2099-10-15", "/admin/payments/transactions", "/admin/payments/settings", "/reset-password",
      "/coach/bookings", "/coach/bookings?view=calendar"]) {
      await page.goto(route);
      await expect(page).toHaveURL(/\/login(?:\?|$)/);
    }
    await signIn(page, accounts[0].email);
    await expect(page.getByRole("button", { name: "Account menu", exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Profile", exact: true }).click();
    await expect(page).toHaveURL(/\/profile$/);
    // Every user-area destination, with exactly one active link, in the shared sidebar.
    const userNavigation = page.getByRole("navigation", { name: "My account navigation" });
    const userDestinations = [
      ["Bookings", /\/my-activity\/bookings$/], ["Booking history", /\/my-activity\/history$/],
      ["Player identity", /\/profile$/],
      ["Personal information", /\/profile\/personal$/], ["Tennis profile", /\/profile\/tennis$/],
      ["Account & security", /\/profile\/security$/],
    ] as const;
    async function visitUserDestinations() {
      await expect(userNavigation.getByRole("link")).toHaveText(userDestinations.map(([label]) => label));
      for (const [label, destination] of userDestinations) {
        await userNavigation.getByRole("link", { name: label, exact: true }).click();
        await expect(page).toHaveURL(destination);
        await expect(userNavigation.locator('a[aria-current="page"]')).toHaveText([label]);
      }
    }
    await visitUserDestinations();
    await page.goto("/my-activity/bookings/history");
    await expect(page).toHaveURL(/\/my-activity\/history$/);
    await userNavigation.getByRole("link", { name: "Bookings", exact: true }).click();
    await expect(page).toHaveURL(/\/my-activity\/bookings$/);
    await expect(navigation.getByRole("link", { name: "Matches" })).toHaveCount(0);
    await expect(navigation.getByRole("link", { name: "Rankings" })).toHaveCount(0);
    await expect(navigation.getByRole("link", { name: "Admin" })).toHaveCount(0);
    for (const route of ["/admin", "/admin/users", "/admin/reservations", "/admin/payments/transactions", "/admin/payments/settings",
      "/coach/bookings", "/coach/bookings?view=calendar"]) {
      await page.goto(route);
      await expect(page.getByRole("heading", { name: /404|not found/i })).toBeVisible();
    }
    await page.getByRole("link", { name: "Profile", exact: true }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("link", { name: "Profile", exact: true })).toHaveCount(0);
    await signIn(page, accounts[1].email);
    await expect(navigation.getByRole("link", { name: "Admin" })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Admin" })).toHaveAttribute("href", "/admin");
    await expect(navigation.getByRole("link", { name: "Users" })).toHaveCount(0);
    await navigation.getByRole("link", { name: "Admin" }).click();
    const adminNavigation = page.getByRole("navigation", { name: "Management navigation" });
    await expect(page).toHaveURL(/\/admin\/locations$/);
    await expect(adminNavigation.getByRole("link")).toHaveText(["Locations", "Bookings & Reservations", "Programs", "Coaches", "Prices", "Availability", "Transactions", "Settings", "Users"]);
    await expect(adminNavigation.getByRole("link", { name: "Locations" })).toHaveAttribute("aria-current", "page");
    await adminNavigation.getByRole("link", { name: "Users" }).click();
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
    await page.getByRole("row", { name: `Manage user ${accounts[0].email}` }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/users/${accounts[0].id}`));
    await expect(page.getByRole("navigation", { name: "User management" })).toBeVisible();
    await expect(adminNavigation.getByRole("link", { name: "Users" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/admin\/locations$/);
    await expect(page.getByRole("heading", { name: "Locations", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Play more tennis." })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await navigation.getByRole("link", { name: "Admin" }).click();
    await adminNavigation.getByRole("link", { name: "Users" }).click();
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/locations$/);
    // The Calendar renders its date control only when a configured location exists.
    // Own this prerequisite instead of depending on data left by another test.
    expect((await service.from("locations").insert({ id: locationId, name: "Navigation Club", slug: `navigation-${locationId}`, timezone: "UTC", currency: "RON" })).error).toBeNull();
    expect((await service.from("courts").insert({ id: courtId, location_id: locationId, name: "N1", slug: "n1", surface: "clay", environment: "outdoor" })).error).toBeNull();
    expect((await service.from("opening_hours_schedules").insert({ id: scheduleId, location_id: locationId, starts_on: "0001-01-01" })).error).toBeNull();
    expect((await service.from("location_opening_hours").insert({ schedule_id: scheduleId, location_id: locationId, weekday: 3, opens_at_minute: 480, closes_at_minute: 1200 })).error).toBeNull();
    expect((await service.from("pricing_rule_sets").insert({ id: ruleSetId, location_id: locationId })).error).toBeNull();
    expect((await service.from("location_pricing_rules").insert({ location_id: locationId, rule_set_id: ruleSetId, court_id: courtId, court_state: "outdoor", weekday: 3, starts_at_minute: 480, ends_at_minute: 1200, price_per_hour_minor: 5000 })).error).toBeNull();
    // Legacy Reservations URLs open the Admin Calendar tab with their location and date.
    await page.goto("/reservations?date=2099-10-15&extra=one&extra=two");
    await expect(page).toHaveURL(/\/admin\/bookings\?view=calendar&date=2099-10-15$/);
    await expect(page.getByRole("heading", { name: "Bookings & Reservations", exact: true })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Reservations" })).toHaveCount(0);
    await expect(navigation.getByRole("link", { name: "Admin", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(adminNavigation.getByRole("link", { name: "Bookings & Reservations" })).toHaveAttribute("aria-current", "page");
    const views = page.getByRole("navigation", { name: "Bookings and reservations views" });
    await expect(views.getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByLabel("Date")).toHaveValue("2099-10-15");
    await expect(page.getByRole("table", { name: "Bookings and reservations" })).toHaveCount(0);
    await views.getByRole("link", { name: "List" }).click();
    await expect(page).toHaveURL(/\/admin\/bookings$/);
    await expect(views.getByRole("link", { name: "List" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
    await expect(page.getByLabel("Date")).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/admin\/bookings\?view=calendar&date=2099-10-15$/);
    await expect(views.getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByLabel("Date")).toHaveValue("2099-10-15");
    await page.goForward();
    await expect(views.getByRole("link", { name: "List" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("searchbox", { name: "Search" })).toBeVisible();
    await page.goto("/admin/payments?status=due&q=A%20%26%20B&page=2");
    await expect(page).toHaveURL(/\/admin\/payments\/transactions\?/);
    expect(new URL(page.url()).searchParams.get("q")).toBe("A & B");
    expect(new URL(page.url()).searchParams.get("status")).toBe("due");
    expect(new URL(page.url()).searchParams.get("page")).toBe("2");
    await expect(navigation.getByRole("link", { name: "Admin", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(navigation.getByRole("link", { name: "Reservations" })).toHaveCount(0);
    await expect(adminNavigation.getByRole("link", { name: "Transactions" })).toHaveAttribute("aria-current", "page");
    await adminNavigation.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/payments\/settings$/);
    await expect(adminNavigation.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("aria-current", "page");
    await page.goBack();
    await expect(adminNavigation.getByRole("link", { name: "Transactions" })).toHaveAttribute("aria-current", "page");
    await page.goForward();
    await expect(adminNavigation.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("aria-current", "page");
    await page.getByRole("link", { name: "Profile", exact: true }).click();
    await visitUserDestinations();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await signIn(page, accounts[2].email);
    await expect(navigation.getByRole("link", { name: "Admin", exact: true })).toHaveAttribute("href", "/admin");
    await navigation.getByRole("link", { name: "Admin", exact: true }).click();
    await expect(page).toHaveURL(/\/coach\/bookings$/);
    await expect(adminNavigation.getByRole("link")).toHaveText(["Bookings & Reservations", "My availability"]);
    await expect(adminNavigation.getByRole("link", { name: "Bookings & Reservations" })).toHaveAttribute("aria-current", "page");
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/coach\/bookings$/);
    for (const route of ["/admin/locations", "/admin/locations/new", "/admin/courts", "/admin/pricing", "/admin/users", "/admin/payments", "/admin/payments/transactions", "/admin/payments/settings",
      "/admin/bookings", "/admin/bookings?view=calendar"]) {
      await page.goto(route);
      await expect(page.getByRole("heading", { name: /404|not found/i })).toBeVisible();
    }
    // Legacy Reservations URLs open the Coach Calendar tab with their date.
    await page.goto("/admin/reservations?date=2099-10-15");
    await expect(page).toHaveURL(/\/coach\/bookings\?view=calendar&date=2099-10-15$/);
    await expect(page.getByRole("heading", { name: "Bookings & Reservations", exact: true })).toBeVisible();
    await expect(adminNavigation.getByRole("link")).toHaveText(["Bookings & Reservations", "My availability"]);
    await page.getByRole("link", { name: "Profile", exact: true }).click();
    await visitUserDestinations();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await signIn(page, accounts[0].email);
    await expect(navigation.getByRole("link", { name: "Admin" })).toHaveCount(0);
    await page.getByRole("link", { name: "Profile", exact: true }).click();
    await userNavigation.getByRole("link", { name: "Account & security", exact: true }).click();
    await expect(page.getByText(accounts[0].email, { exact: true })).toBeVisible();
    await expect(page.getByText(accounts[1].email, { exact: true })).toHaveCount(0);
    await userNavigation.getByRole("link", { name: "Personal information", exact: true }).click();
    await page.getByLabel("First name", { exact: true }).fill("Unsaved draft");
    await page.locator('header a[href="/"]:visible').click();
    await expect(page).toHaveURL(/\/profile\/personal$/);
    await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stay", exact: true }).click();
    await expect(page.getByLabel("First name", { exact: true })).toHaveValue("Unsaved draft");
    await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toHaveCount(0);
    // Repeated attempts update one confirmation to the latest destination.
    await page.locator('header a[href="/"]:visible').click();
    await page.locator('header a[href="/"]:visible').click();
    await navigation.getByRole("link", { name: "Courts", exact: true }).click();
    await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Leave without saving", exact: true }).click();
    await expect(page).toHaveURL(/\/courts$/);
    await page.getByRole("link", { name: "Profile", exact: true }).click();
    await userNavigation.getByRole("link", { name: "Personal information", exact: true }).click();
    await expect(page.getByLabel("First name", { exact: true })).toHaveValue("");
    // All shared link entry points guard the active Profile visit.
    for (const destination of ["/book", "/coaching", "/courts", "/club"]) {
      await page.getByLabel("First name", { exact: true }).fill("Footer draft");
      await page.getByRole("navigation", { name: "Footer", exact: true }).locator(`a[href="${destination}"]`).click();
      await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/profile\/personal$/);
      await page.getByRole("button", { name: "Stay", exact: true }).click();
      await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toHaveCount(0);
    }
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('header a[href="/book"]:visible').click();
      await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Stay", exact: true }).click();
      await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toHaveCount(0);
      await page.locator('header a[href="/"]:visible').click();
      await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Stay", exact: true }).click();
      await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("link", { name: "Courts", exact: true }).click();
    await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stay", exact: true }).click();
    await expect(page.getByText("You have unsaved changes in Personal information.", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("First name", { exact: true })).toHaveValue("Footer draft");
    // Browser reload uses native confirmation; cancelling preserves drafts.
    const nativeConfirmation = page.waitForEvent("dialog");
    // Chrome can leave a cancelled reload waiting for its load event.
    const reload = page.reload({ timeout: 3_000 }).catch((error: unknown) => {
      expect(error instanceof Error ? error.message : String(error)).toMatch(/ERR_ABORTED|Timeout/);
    });
    const dialog = await nativeConfirmation;
    expect(dialog.type()).toBe("beforeunload");
    await dialog.dismiss();
    await reload;
    await expect(page.getByLabel("First name", { exact: true })).toHaveValue("Footer draft");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByLabel("First name", { exact: true }).fill("Saved name");
    await page.getByRole("button", { name: "Save personal information", exact: true }).click();
    await expect(page.getByText("Personal information saved.", { exact: true })).toHaveCount(1);
    await page.locator('header a[href="/"]:visible').click();
    await expect(page).toHaveURL(/\/$/);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
    await expect(page.getByText("Personal information saved.", { exact: true })).toHaveCount(1);
  } finally {
    await page.close();
    for (const table of ["location_pricing_rules", "pricing_rule_sets", "location_opening_hours", "opening_hours_schedules", "courts"]) {
      expect((await service.from(table).delete().eq("location_id", locationId)).error).toBeNull();
    }
    expect((await service.from("locations").delete().eq("id", locationId)).error).toBeNull();
    for (const account of accounts.reverse()) {
      expect((await service.from("users").delete().eq("id", account.id)).error).toBeNull();
      expect((await service.auth.admin.deleteUser(account.id)).error).toBeNull();
    }
  }
});
