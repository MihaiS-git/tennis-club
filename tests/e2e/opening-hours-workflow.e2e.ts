import { cleanupBookingEvidence } from "../local/booking-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DataSource } from "typeorm";
import { expect, test, type Page, type Locator } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";
import { localToday } from "../../src/lib/courts/local-time";

const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0,10);

// One complete journey: only account/resources are fixtures. Every policy,
// price, booking and direct reservation is created through the real browser UI.
test("Admin opening-hours, pricing and reservation lifecycle survives sequential and competing edits", async ({ page, context }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(10_000);
  const service = createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const database = await new DataSource({ type: "postgres", url: process.env.DATABASE_URL }).initialize();
  const locationId = randomUUID(), court1 = randomUUID(), court2 = randomUUID();
  const email = `hours-browser-${randomUUID()}@example.test`, password = "Hours-browser-password-123";
  const account = await service.auth.admin.createUser({ email, password, email_confirm: true });
  expect(account.error).toBeNull();
  const userId = account.data.user!.id;
  const today = localToday("Europe/Bucharest", new Date());
  const future = shift(today,7), until = shift(today,14), later = shift(today,21);
  const workspace = `/admin/locations/${locationId}`;
  const editor = (p: Page = page) => p.getByRole("form", { name: "Opening hours editor" });
  const tab = async (label: string, p: Page = page) => p.getByRole("navigation", { name: "Location management" }).getByRole("link", { name: label, exact: true }).click();
  const intervals = async (): Promise<unknown> => database.query("SELECT * FROM public.location_opening_hours WHERE location_id=$1 ORDER BY weekday,opens_at_minute,id",[locationId]);
  const schedules = async (): Promise<unknown> => database.query(
    "SELECT to_jsonb(s) AS schedule FROM public.opening_hours_schedules s WHERE location_id=$1 ORDER BY id", [locationId]);
  const prices = async (): Promise<unknown> => database.query(
    "SELECT to_jsonb(r) AS rule FROM public.location_pricing_rules r WHERE location_id=$1 ORDER BY id", [locationId]);
  const contracts = async (): Promise<unknown> => database.query(`SELECT to_jsonb(r) AS reservation, to_jsonb(b) AS booking,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.payment_attempts p WHERE p.booking_id=b.id) AS payments,
    (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM public.payment_refunds f WHERE f.booking_id=b.id) AS refunds
    FROM public.court_reservations r LEFT JOIN public.bookings b ON b.reservation_id=r.id
    WHERE r.court_id=ANY($1::uuid[]) ORDER BY r.id`,[[court1,court2]]);
  async function times(form: Locator, index: number, start: string, end: string) {
    await form.getByLabel("Opening time",{ exact: true }).nth(index).fill(start);
    await form.getByLabel("Closing time",{ exact: true }).nth(index).fill(end);
    await form.getByLabel("Closing time",{ exact: true }).nth(index).press("Tab");
  }
  async function selectDays(form: Locator, index: number, preset: string) {
    await form.getByRole("button", { name: new RegExp(`^Days for interval ${index + 1}:`) }).click();
    await form.getByRole("button", { name: preset, exact: true }).click();
    await form.getByRole("button", { name: "Done", exact: true }).click();
  }
  async function selectPolicy(from: string) {
    const selector = page.getByRole("combobox", { name: "Schedule", exact: true });
    const value = await selector.locator("option").filter({ hasText: from }).getAttribute("value");
    expect(value).toBeTruthy();
    await selector.selectOption(value!);
  }
  async function createSchedule(from: string, end: string, hours: [string,string][]) {
    const create = page.getByRole("button", { name: "New schedule", exact: true });
    await expect(page.getByRole("combobox", { name: "Schedule", exact: true })).toBeEnabled();
    if (await create.isEnabled()) await create.click();
    const form = editor();
    await form.getByLabel("Valid from",{ exact: true }).fill(from);
    await form.getByLabel("Valid until (optional)").fill(end);
    while (await form.getByRole("button", { name: /^Delete interval/ }).count()) await form.getByRole("button", { name: /^Delete interval/ }).first().click();
    for (const [index,[start,finish]] of hours.entries()) {
      await form.getByRole("button",{ name: "Add interval", exact: true }).click();
      await selectDays(form, index, "All days");
      await times(form,index,start,finish);
    }
    return form;
  }
  async function saveSchedule(form: Locator, label: "Save changes" = "Save changes") {
    await expect(form.getByRole("button",{ name: label, exact: true })).toBeEnabled();
    await form.getByRole("button",{ name: label, exact: true }).click();
    await expect(form.getByRole("button", { name: "Save changes", exact: true }).or(form.getByText("Expired schedules are read-only."))).toBeVisible();
    if (await form.getByRole("button",{ name: "Save changes", exact: true }).count()) await expect(form.getByRole("button",{ name: "Save changes", exact: true })).toBeDisabled();
    else await expect(form.getByText("Expired schedules are read-only.")).toBeVisible();
    await expect(form.getByRole("alert")).toHaveCount(0);
  }
  async function addPrice(start: string, end: string, amount: string) {
    await page.getByRole("button",{ name: "Add rule", exact: true }).click();
    const dialog = page.getByRole("dialog",{ name: "Add pricing", exact: true });
    const form = dialog.getByRole("form",{ name: "Pricing rule" });
    await form.getByRole("checkbox",{ name: /Audit Court One/ }).check();
    await form.getByRole("checkbox",{ name: /Audit Court Two/ }).check();
    await form.getByRole("button", { name: "All days", exact: true }).click();
    await form.getByLabel("Start time",{ exact: true }).fill(start);
    await form.getByLabel("End time",{ exact: true }).fill(end);
    await form.getByLabel("Price per hour (RON)").fill(amount);
    await expect(form.getByRole("button",{ name: "Save rule", exact: true })).toBeEnabled();
    await form.getByRole("button",{ name: "Save rule", exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  await page.setViewportSize({ width: 1440,height: 1000 });
  let other: Page | undefined;
  try {
    expect((await service.from("user_roles").insert({ user_id:userId,role_code:"admin" })).error).toBeNull();
    expect((await service.from("locations").insert({ id:locationId,name:"Opening hours browser audit",slug:`hours-audit-${locationId}`,
      address_line1:"Audit street 1",city:"Cluj",timezone:"Europe/Bucharest",currency:"RON",allow_pay_at_club:true })).error).toBeNull();
    expect((await service.from("courts").insert([{ id:court1,name:"Audit Court One" },{ id:court2,name:"Audit Court Two" }]
      .map((court) => ({ ...court,location_id:locationId,slug:`audit-${court.id}`,surface:"clay",environment:"outdoor" })))).error).toBeNull();
    await page.goto("/login");
    await page.getByRole("textbox",{ name:"Email" }).fill(email);
    await page.getByLabel("Password",{ exact:true }).fill(password);
    await page.getByRole("button",{ name:"Sign in" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto(`${workspace}?tab=opening-hours`);

    await test.step("Create first split schedule, save and price both daily intervals with blank validity", async () => {
      await saveSchedule(await createSchedule(today,"",[["08:00","12:00"],["14:00","20:00"]]));
      await expect(page.getByText("Some newly opened hours need pricing configuration for one or more courts.",{ exact:true })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Schedule", exact: true })).toContainText(`Current · ${today} → Unlimited`);
      await page.reload();
      await expect(editor().getByLabel("Opening time", { exact: true }).nth(0)).toHaveValue("08:00");
      await expect(editor().getByLabel("Opening time", { exact: true }).nth(1)).toHaveValue("14:00");
      await tab("Pricing");
      await addPrice("08:00","12:00","50.00");
      await addPrice("14:00","20:00","80.00");
      await expect(page.getByRole("row",{ name:/Edit pricing rule/ })).toHaveCount(2);
    });

    await test.step("Two real editors reject stale opening-hours and pricing saves; date-only edits preserve interval identities", async () => {
      other = await context.newPage();
      await other.setViewportSize({ width:1440,height:1000 });
      await tab("Opening hours");
      const before = await intervals();
      await editor().getByLabel("Valid until (optional)").fill(shift(today,30));
      await other.goto(`${workspace}?tab=opening-hours`);
      await editor(other).getByLabel("Valid from",{ exact:true }).fill(shift(today,-1));
      await saveSchedule(editor(other),"Save changes");
      const competingSchedule = await schedules();
      const competingPrices = await prices();
      await editor().getByRole("button",{ name:"Save changes",exact:true }).click();
      await expect(page.locator('[data-sonner-toast][data-type="error"]').getByText(
        "This schedule has changed. Cancel edit to load its latest saved values.", { exact: true })).toBeVisible();
      await expect(editor().getByRole("button", { name: "Save changes", exact: true })).toBeEnabled();
      expect(await schedules()).toEqual(competingSchedule);
      expect(await intervals()).toEqual(before);
      expect(await prices()).toEqual(competingPrices);
      await expect(editor().getByLabel("Valid from", { exact: true })).toHaveValue(today);
      await expect(editor().getByLabel("Valid until (optional)")).toHaveValue(shift(today,30));
      await editor().getByRole("button",{ name:"Cancel edit",exact:true }).click();
      await expect(editor().getByLabel("Valid from",{ exact:true })).toHaveValue(shift(today,-1));
      await editor().getByLabel("Valid from",{ exact:true }).fill(today);
      await saveSchedule(editor(),"Save changes");
      expect(await intervals()).toEqual(before);
      await tab("Pricing"); await tab("Pricing",other);
      const first = (p: Page) => p.getByRole("row",{ name:/Edit pricing rule/ }).filter({ hasText:"08:00–12:00" });
      await first(page).click(); await first(other).click();
      await page.getByLabel("Price per hour (RON)").fill("55.00");
      await other.getByLabel("Price per hour (RON)").fill("60.00");
      await other.getByRole("button",{ name:"Save rule",exact:true }).click();
      await expect(other.getByRole("dialog",{ name:"Edit pricing",exact:true })).toBeHidden();
      const savedPrices = await prices();
      await page.getByRole("button",{ name:"Save rule",exact:true }).click();
      await expect(page.locator('[data-sonner-toast][data-type="error"]').getByText(
        "This pricing rule has changed. Close and reopen it to review the latest values.", { exact: true })).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Edit pricing", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save rule", exact: true })).toBeEnabled();
      await expect(page.getByLabel("Price per hour (RON)")).toHaveValue("55.00");
      expect(await prices()).toEqual(savedPrices);
      await expect(first(page)).toContainText("60");
      await page.getByRole("dialog",{ name:"Edit pricing",exact:true }).getByRole("button",{ name:"Close dialog",exact:true }).click();
      await first(page).click();
      await expect(page.getByLabel("Price per hour (RON)")).toHaveValue("60.00");
      await page.getByLabel("Price per hour (RON)").fill("50.00");
      await page.getByRole("button",{ name:"Save rule",exact:true }).click();
      await expect(page.getByRole("dialog",{ name:"Edit pricing",exact:true })).toBeHidden();
      await other.close(); other=undefined;
    });

    await test.step("Publish and create an actual direct reservation and customer booking before the future policy change", async () => {
      await tab("Public booking");
      await page.getByRole("button",{ name:"Enable public booking",exact:true }).click();
      await expect(page.getByRole("button",{ name:"Disable public booking",exact:true })).toBeVisible();
      await page.goto(`/admin/reservations?location=${locationId}&date=${future}`);
      await page.getByRole("button",{ name:`Audit Court One ${future} 10:00–10:30, Available`,exact:true }).click();
      await page.getByLabel("Reason",{ exact:true }).fill("Preserved administrative session");
      await page.getByRole("button",{ name:"Reserve court",exact:true }).click();
      await expect(page.getByText("Court reserved.",{ exact:true })).toBeVisible();
      await page.goto(`/book?location=${locationId}&date=${future}`);
      await page.getByRole("button",{ name:`Audit Court Two ${future} 16:00–16:30, RON 80/h`,exact:true }).click();
      await page.getByRole("button",{ name:"Continue",exact:true }).click();
      const dialog = page.getByRole("dialog",{ name:"Confirm your booking",exact:true });
      await dialog.getByLabel("Name",{ exact:true }).fill("Audit Customer");
      await dialog.getByLabel("Email",{ exact:true }).fill(`customer-${locationId}@example.test`);
      await dialog.getByLabel("Phone",{ exact:true }).fill("+40712345678");
      await dialog.getByRole("radio",{ name:"Pay at club",exact:true }).check();
      await dialog.getByRole("button",{ name:"Confirm booking",exact:true }).click();
      await expect(page.getByRole("region",{ name:"Booking confirmed",exact:true })).toBeVisible();
      await page.getByRole("link", { name: "View my bookings", exact: true }).click();
      await expect(page).toHaveURL(/\/my-activity\/bookings$/);
      await page.getByRole("banner").getByRole("link", { name: "Book a court", exact: true }).click();
      await expect(page).toHaveURL(/\/book$/);
      await expect(page.getByRole("region", { name: "Booking confirmed", exact: true })).toHaveCount(0);
      await page.goBack();
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`location=${locationId}`));
      await expect(page.getByRole("region", { name: "Booking confirmed", exact: true })).toHaveCount(0);
      await expect(page.getByRole("table")).toBeVisible();
      await page.goForward();
      await page.goForward();
      await page.reload();
      await expect(page.getByRole("region", { name: "Booking confirmed", exact: true })).toHaveCount(0);

    });
    const beforeContracts = await contracts();

    await test.step("Reject a future schedule excluding existing bookings, then create a bounded one with automatic cutoff", async () => {
      await page.goto(`${workspace}?tab=opening-hours`);
      const form = await createSchedule(future,until,[["11:00","12:00"],["14:00","19:00"]]);
      await expect(form.getByRole("status")).toContainText(`on ${shift(future,-1)}`);
      const unchangedSchedules = await schedules();
      await form.getByRole("button",{ name:"Save changes",exact:true }).click();
      await expect(page.locator('[data-sonner-toast][data-type="error"]').getByText(
        `Existing bookings on ${future} would fall outside these opening hours. Move or cancel them first; no changes were saved.`, { exact: true })).toBeVisible();
      expect(await schedules()).toEqual(unchangedSchedules);
      expect(await contracts()).toEqual(beforeContracts);
      await times(form,0,"09:00","12:00");
      await saveSchedule(form);
      await expect(page.getByRole("combobox", { name: "Schedule", exact: true })).toContainText(`Current · ${today} → ${shift(future,-1)}`);
      await expect(page.getByRole("combobox", { name: "Schedule", exact: true })).toContainText(`Scheduled · ${future} → ${until}`);
      expect(await contracts()).toEqual(beforeContracts);
      await tab("Pricing");
      await page.getByRole("button",{ name:"Add rule",exact:true }).click();
      const summary = page.getByRole("dialog",{ name:"Add pricing",exact:true }).getByRole("region",{ name:"Opening hours",exact:true });
      await expect(summary.getByText(`${today} – ${shift(future,-1)} · Current`,{ exact:true })).toBeVisible();
      await expect(summary.getByText(`${future} – ${until} · Scheduled`,{ exact:true })).toBeVisible();
      await page.getByRole("dialog",{ name:"Add pricing",exact:true }).getByRole("button",{ name:"Close dialog",exact:true }).click();
      await page.goto(`/admin/reservations?location=${locationId}&date=${future}`);
      await expect(page.getByRole("button",{ name:new RegExp(`Audit Court One ${future} 10:00–11:00, Reservation`) })).toBeVisible();
      await expect(page.getByRole("button",{ name:`Audit Court One ${future} 09:00–09:30, Available`,exact:true })).toBeVisible();
      await page.goto(`/book?location=${locationId}&date=${future}`);
      await expect(page.getByLabel(`Audit Court One ${future} 10:00–10:30, Booked`,{ exact:true })).toBeVisible();
    });

    await test.step("Schedule a later policy, fill a bounded gap, reject overlap and preserve history", async () => {
      await page.goto(`${workspace}?tab=opening-hours`);
      await saveSchedule(await createSchedule(later,"",[["08:00","12:00"],["14:00","20:00"]]));
      await createSchedule(shift(today,16),"",[["10:00","12:00"]]);
      await expect(editor().getByRole("alert")).toContainText("scheduled future policies cannot be adjusted automatically");
      await expect(editor().getByRole("button",{ name:"Save changes",exact:true })).toBeDisabled();
      await editor().getByLabel("Valid until (optional)").fill(shift(today,18));
      await saveSchedule(editor());
      await editor().getByLabel("Valid until (optional)").fill(shift(today,20));
      await saveSchedule(editor(),"Save changes");
      await editor().getByLabel("Valid until (optional)").fill(later);
      await expect(editor().getByRole("alert")).toContainText("overlap");
      await expect(editor().getByRole("button",{ name:"Save changes",exact:true })).toBeDisabled();
      await editor().getByRole("button",{ name:"Cancel edit",exact:true }).click();
      await saveSchedule(await createSchedule(shift(today,-14),shift(today,-1),[["10:00","12:00"]]));
      await expect(page.getByRole("combobox", { name: "Schedule", exact: true })).toContainText(`Expired · ${shift(today,-14)} → ${shift(today,-1)}`);
      await expect(editor().getByLabel("Opening time", { exact: true })).toBeDisabled();
      await page.goto(`/admin/reservations?location=${locationId}&date=${shift(today,15)}`);
      await expect(page.getByText(/is closed on/)).toBeVisible();
      await page.goto(`/book?location=${locationId}&date=${shift(today,15)}`);
      await expect(page.getByText(/is closed on/)).toBeVisible();
    });

    await test.step("Edit, add multiple intervals, remove one and revisit without replacing others", async () => {
      await page.goto(`${workspace}?tab=opening-hours`);
      await selectPolicy(future);
      await times(editor(),1,"15:00","19:00"); await saveSchedule(editor());
      await editor().getByRole("button",{ name:"Add interval",exact:true }).click();
      await selectDays(editor(),2,"All days"); await times(editor(),2,"12:00","13:00");
      await editor().getByRole("button",{ name:"Add interval",exact:true }).click();
      await selectDays(editor(),3,"All days"); await times(editor(),3,"13:00","14:00"); await saveSchedule(editor());
      await editor().getByRole("button", { name: "Delete interval 2", exact: true }).click();
      await saveSchedule(editor());
      await page.reload(); await selectPolicy(future);
      for (const [index, time] of ["09:00","13:00","15:00"].entries()) await expect(editor().getByLabel("Opening time", { exact: true }).nth(index)).toHaveValue(time);
      expect(await contracts()).toEqual(beforeContracts);
      const prices: unknown = await database.query("SELECT DISTINCT starts_at_minute,ends_at_minute,price_per_hour_minor FROM public.location_pricing_rules WHERE location_id=$1 AND starts_on <= $2::date AND (ends_on IS NULL OR ends_on >= $2::date) ORDER BY starts_at_minute",[locationId,future]);
      expect(prices).toEqual([{ starts_at_minute:540,ends_at_minute:720,price_per_hour_minor:5000 },
        { starts_at_minute:780,ends_at_minute:840,price_per_hour_minor:5000 },{ starts_at_minute:900,ends_at_minute:1140,price_per_hour_minor:8000 }]);
      await selectPolicy(today);
      await times(editor(),0,"07:17","12:00");
      for (const [index, [start, finish]] of [["09:00", "12:00"], ["13:00", "20:00"]].entries()) {
        await editor().getByRole("button", { name: "Add interval", exact: true }).click();
        await selectDays(editor(), index + 2, "Weekend"); await times(editor(), index + 2, start, finish);
      }
      // Existing Daily rows now apply only on weekdays; weekend rows stay independent.
      await selectDays(editor(),0,"Weekdays"); await selectDays(editor(),1,"Weekdays");
      await saveSchedule(editor()); await page.reload();
      await expect(editor().getByLabel("Opening time", { exact: true })).toHaveCount(4);
      const currentRows: unknown = await database.query(`SELECT weekday,opens_at_minute,closes_at_minute FROM public.location_opening_hours
        WHERE schedule_id=(SELECT id FROM public.opening_hours_schedules WHERE location_id=$1 AND starts_on=$2::date) ORDER BY weekday,opens_at_minute`,[locationId,today]);
      expect(currentRows).toEqual(Array.from({ length: 7 },(_,weekday) => weekday < 5
        ? [{ weekday,opens_at_minute:437,closes_at_minute:720 },{ weekday,opens_at_minute:840,closes_at_minute:1200 }]
        : [{ weekday,opens_at_minute:540,closes_at_minute:720 },{ weekday,opens_at_minute:780,closes_at_minute:1200 }]).flat());
      await page.getByRole("button", { name: "New schedule", exact: true }).click();
      await expect(editor().getByLabel("Opening time", { exact: true }).nth(0)).toHaveValue("07:17");
      await expect(editor().getByLabel("Opening time", { exact: true })).toHaveCount(4);
      await editor().getByLabel("Valid from", { exact: true }).fill(shift(today,3));
      await editor().getByLabel("Valid until (optional)").fill(shift(future,-1));
      await expect(editor().getByRole("status")).toContainText(`on ${shift(today,2)}`);
      await saveSchedule(editor());
      await expect(page.getByRole("combobox", { name: "Schedule", exact: true })).toContainText(`Current · ${today} → ${shift(today,2)}`);
      await times(editor(),0,"08:00","12:00");
      await page.getByRole("button", { name: "Expired", exact: true }).click();
      const discard = page.getByRole("dialog", { name: "Discard opening-hours changes?", exact: true });
      await expect(discard).toBeVisible();
      await discard.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(editor().getByLabel("Opening time", { exact: true }).nth(0)).toHaveValue("08:00");
      await page.getByRole("button", { name: "Expired", exact: true }).click();
      await discard.getByRole("button", { name: "Discard changes", exact: true }).click();
      await expect(editor().getByLabel("Opening time", { exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "Current & scheduled", exact: true }).click();
      await expect(editor().getByLabel("Opening time", { exact: true }).nth(0)).toHaveValue("07:17");
      const screenshot = test.info().outputPath("final-opening-hours-workspace.png");
      await page.screenshot({ path:screenshot,fullPage:true });
      await test.info().attach("final-opening-hours-workspace",{ path:screenshot,contentType:"image/png" });
    });
  } catch (error) {
    await test.info().attach("failure-page",{ body:await page.screenshot({ fullPage:true }),contentType:"image/png" });
    if (await editor().count()) console.log(await editor().evaluate((form) => ({ text:form.textContent, controls:[...form.querySelectorAll("input")].map((input) => ({ type:input.type,value:input.value,checked:input.checked })) })));
    throw error;
  } finally {
    await other?.close();
    await page.close();
    await database.transaction(manager => cleanupBookingEvidence(manager, { courtIds: [court1,court2] }));
    await database.query("DELETE FROM public.court_reservations WHERE court_id=ANY($1::uuid[])",[[court1,court2]]);
    await database.query("DELETE FROM public.pricing_rule_sets WHERE location_id=$1",[locationId]);
    await database.query("DELETE FROM public.opening_hours_schedules WHERE location_id=$1",[locationId]);
    await database.query("DELETE FROM public.courts WHERE location_id=$1",[locationId]);
    await database.query("DELETE FROM public.locations WHERE id=$1",[locationId]);
    expect((await service.from("user_roles").delete().eq("user_id",userId)).error).toBeNull();
    expect((await service.from("users").delete().eq("id",userId)).error).toBeNull();
    expect((await service.auth.admin.deleteUser(userId)).error).toBeNull();
    await database.destroy();
  }
});
