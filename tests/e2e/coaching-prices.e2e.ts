import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

test("homepage, public Coaching and authenticated Admin Prices read the real pricing schema", async ({ page }) => {
  const service = createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const program = randomUUID(), location = randomUUID(), court = randomUUID(), schedule = randomUUID(), ruleSet = randomUUID();
  const name = `Coaching regression ${program}`;
  const email = `coaching-prices-${randomUUID()}@example.test`, password = "Coaching-prices-password-123";
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error).toBeNull();
  const user = created.data.user!.id;
  try {
    expect((await service.from("user_roles").insert({ user_id: user, role_code: "admin" })).error).toBeNull();
    expect((await service.from("locations").insert({ id: location, name, slug: location, timezone: "UTC", currency: "RON", is_public: true, address_line1: "1 Fixture Street", city: "Cluj" })).error).toBeNull();
    expect((await service.from("coaching_programs").insert({ id: program, name, description: "Regression lesson", program_type: "private",
      court_rental_included: true, min_participants: 1, max_participants: 2 })).error).toBeNull();
    expect((await service.from("coaching_program_durations").insert({ program_id: program, duration_minutes: 60 })).error).toBeNull();
    expect((await service.from("coaching_prices").insert([
      { program_id: program, duration_minutes: 60, participant_count: 1, amount_minor: 9000, currency: "RON" },
      { program_id: program, duration_minutes: 60, participant_count: 2, amount_minor: 9000, currency: "RON" },
    ])).error).toBeNull();
    expect((await service.from("courts").insert({ id: court, location_id: location, name: "C1", slug: "c1", surface: "clay", environment: "outdoor" })).error).toBeNull();
    expect((await service.from("opening_hours_schedules").insert({ id: schedule, location_id: location, starts_on: "0001-01-01" })).error).toBeNull();
    expect((await service.from("location_opening_hours").insert(Array.from({ length: 7 }, (_, weekday) => ({ schedule_id: schedule, location_id: location,
      weekday, opens_at_minute: 480, closes_at_minute: 1200 })))).error).toBeNull();
    expect((await service.from("pricing_rule_sets").insert({ id: ruleSet, location_id: location })).error).toBeNull();
    expect((await service.from("location_pricing_rules").insert(Array.from({ length: 7 }, (_, weekday) => ({ rule_set_id: ruleSet, location_id: location,
      court_id: court, court_state: "outdoor", weekday, starts_at_minute: 480, ends_at_minute: 1200, price_per_hour_minor: 5000 })))).error).toBeNull();
    for (const path of ["/", "/coaching"]) {
      expect((await page.goto(path))?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
      await expect(page.getByText(/Coaching information is temporarily unavailable/)).toHaveCount(0);
    }
    const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) }).first();
    await expect(card).toContainText(/From RON\s*90.00 per person per lesson/);
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    expect((await page.goto(`/admin/coaching/programs?q=${encodeURIComponent(name)}`))?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Programs", exact: true })).toBeVisible();
    await expect(page.getByRole("row", { name: `Edit program ${name}`, exact: true })).toBeVisible();
    expect((await page.goto(`/admin/coaching/prices?program=${program}&currency=RON`))?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Prices", exact: true })).toBeVisible();
    await expect(page.getByRole("table", { name: "Coaching prices", exact: true }).getByText(name, { exact: true }).first()).toBeVisible();
    expect((await service.from("coaching_prices").select("participant_count,amount_minor").eq("program_id", program).order("participant_count")).data)
      .toEqual([{ participant_count: 1, amount_minor: 9000 }, { participant_count: 2, amount_minor: 9000 }]);
    const form = page.getByRole("form", { name: `${name} club prices in RON` });
    await expect(form).toContainText("Lesson price/person");
    await form.getByRole("textbox", { name: /^2 players,/ }).fill("95");
    await form.getByRole("button", { name: "Save prices", exact: true }).click();
    await expect.poll(async () => (await service.from("coaching_prices").select("participant_count,amount_minor").eq("program_id", program).order("participant_count")).data)
      .toEqual([{ participant_count: 1, amount_minor: 9000 }, { participant_count: 2, amount_minor: 9500 }]);
    await page.goto("/coaching");
    await expect(card).toContainText(/From RON\s*90.00 per person per lesson/);
  } finally {
    await page.close();
    for (const table of ["coaching_prices", "coaching_program_durations"]) {
      expect((await service.from(table).delete().eq("program_id", program)).error).toBeNull();
    }
    expect((await service.from("coaching_programs").delete().eq("id", program)).error).toBeNull();
    for (const table of ["location_pricing_rules", "pricing_rule_sets", "location_opening_hours", "opening_hours_schedules", "courts"]) {
      expect((await service.from(table).delete().eq("location_id", location)).error).toBeNull();
    }
    expect((await service.from("locations").delete().eq("id", location)).error).toBeNull();
    expect((await service.from("users").delete().eq("id", user)).error).toBeNull();
    expect((await service.auth.admin.deleteUser(user)).error).toBeNull();
  }
});
