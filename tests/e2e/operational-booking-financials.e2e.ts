import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DataSource } from "typeorm";
import { expect, test as base, type Page } from "@playwright/test";
import { z } from "zod";
import { cleanupBookingEvidence, insertBookingRecords, insertCaptureReceiptFixture } from "../local/booking-fixtures";
import { localServiceRoleKey } from "./helpers/supabase";

const provider = "http://127.0.0.1:3111";
type Fixture = {
  db: DataSource; admin: string; customer: string; emails: string[]; password: string;
  booking: string; reservation: string; locations: string[]; courts: string[]; payment: string;
};
const test = base.extend<{ fixture: Fixture; method: "online" | "pay_at_club"; failRefund: boolean }>({
  method: ["online", { option: true }], failRefund: [false, { option: true }],
  fixture: async ({ request, method, failRefund }, runFixture) => {
    const db = await new DataSource({ type: "postgres", url: process.env.DATABASE_URL }).initialize();
    const auth = createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    const users: string[] = [], emails: string[] = [], password = "Operational-browser-123";
    const locations = [randomUUID(), randomUUID(), randomUUID()], courts = locations.map(() => randomUUID());
    const booking = randomUUID(), reservation = randomUUID(), attempt = randomUUID(), payment = `pi_browser_${attempt}`;
    try {
      for (const role of ["admin", "customer"]) {
        const email = `operational-${role}-${randomUUID()}@example.test`;
        const account = await auth.auth.admin.createUser({ email, password, email_confirm: true });
        expect(account.error).toBeNull(); users.push(account.data.user!.id); emails.push(email);
      }
      await db.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [users[0]]);
      for (const [i, location] of locations.entries()) {
        await db.query("INSERT INTO public.locations(id,name,slug,timezone,currency,is_public) VALUES($1::uuid,$2,($1::uuid)::text,'UTC',$3,true)",
          [location, `Financial browser ${i}`, i === 2 ? "EUR" : "RON"]);
        await db.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,$3,'one','clay','outdoor')", [courts[i], location, `Court ${i}`]);
        const [schedule] = await db.query("INSERT INTO public.opening_hours_schedules(location_id,starts_on) VALUES($1,'2000-01-01') RETURNING id", [location]);
        await db.query(`INSERT INTO public.location_opening_hours(location_id,schedule_id,weekday,opens_at_minute,closes_at_minute)
          SELECT $1,$2,d,480,1200 FROM generate_series(0,6) d`, [location, schedule.id]);
        const [rules] = await db.query("INSERT INTO public.pricing_rule_sets(location_id) VALUES($1) RETURNING id", [location]);
        await db.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
          SELECT $1,$2,$3,'outdoor',d,480,1200,$4 FROM generate_series(0,6) d`, [location, rules.id, courts[i], i === 1 ? 7500 : 5000]);
      }
      await db.query("INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,$2,'2099-10-15',600,660)", [reservation, courts[0]]);
      await db.transaction(async manager => {
        await insertBookingRecords(manager, { id: booking, reservation_id: reservation, account_user_id: users[1], customer_name: "Operational browser customer",
          customer_email: emails[1], customer_phone: "123", total_amount_minor: 5000, currency: "RON", payment_method: method,
          cancellation_notice_minutes: 1440, status: "confirmed" });
        if (method === "online") {
          await manager.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at,completed_at)
            VALUES($1,$2,'online','stripe',$3,5000,'RON','succeeded',clock_timestamp()+interval '10 minutes',clock_timestamp())`, [attempt, booking, payment]);
          await insertCaptureReceiptFixture(manager, { paymentAttemptId: attempt, providerPaymentId: payment, providerCaptureId: payment, amountMinor: 5000, currency: "RON" });
        }
      });
      if (method === "online") expect((await request.post(`${provider}/fixture/payment`, { data: { id: payment, amount: 5000, attemptId: attempt, failRefund, delayRefund: true } })).ok()).toBe(true);
      await runFixture({ db, admin: users[0], customer: users[1], emails, password, locations, courts, booking, reservation, payment });
    } finally {
      // Release any blocked simulated refund even if an assertion fails.
      await request.post(`${provider}/fixture/release-refund`, { data: { id: payment } });
      try {
        await db.transaction(async manager => {
          // Financial failures also notify other fixture Admins (including the test anchor).
          await manager.query(`DELETE FROM public.user_messages m WHERE EXISTS
            (SELECT 1 FROM public.payment_refunds f WHERE f.booking_id=$1 AND strpos(m.event_key,f.id::text)>0)
            OR EXISTS (SELECT 1 FROM public.booking_adjustments a WHERE a.booking_id=$1 AND strpos(m.event_key,a.id::text)>0)`, [booking]);
          await cleanupBookingEvidence(manager, { bookingIds: [booking] });
        });
        await db.query("DELETE FROM public.user_messages WHERE user_id=ANY($1::uuid[])", [users]);
        await db.query("DELETE FROM public.court_reservations WHERE court_id=ANY($1::uuid[])", [courts]);
        for (const table of ["location_pricing_rules", "pricing_rule_sets", "location_opening_hours", "opening_hours_schedules", "courts"])
          await db.query(`DELETE FROM public.${table} WHERE location_id=ANY($1::uuid[])`, [locations]);
        await db.query("DELETE FROM public.locations WHERE id=ANY($1::uuid[])", [locations]);
        await db.query("DELETE FROM public.user_roles WHERE user_id=ANY($1::uuid[])", [users]);
        for (const id of users) {
          await db.query("DELETE FROM public.users WHERE id=$1", [id]);
          expect((await auth.auth.admin.deleteUser(id)).error).toBeNull();
        }
        await request.delete(`${provider}/fixture/payment`, { data: { id: payment } });
      } finally { await db.destroy(); }
    }
  },
});

async function login(page: Page, f: Fixture, index = 0) {
  await page.context().clearCookies(); await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(f.emails[index]);
  await page.getByLabel("Password", { exact: true }).fill(f.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
}
async function state(f: Fixture) {
  return f.db.query(`SELECT r.court_id,r.booking_date::text,r.starts_at_minute,r.status,b.current_revision_id,v.total_amount_minor,
    (SELECT count(*)::int FROM public.booking_revisions WHERE booking_id=b.id) AS revisions,
    (SELECT count(*)::int FROM public.booking_adjustments WHERE booking_id=b.id) AS adjustments,
    (SELECT count(*)::int FROM public.payment_refunds WHERE booking_id=b.id) AS refunds
    FROM public.checkout_records b JOIN public.court_reservations r ON r.id=b.reservation_id
    JOIN public.booking_revisions v ON v.id=b.current_revision_id WHERE b.id=$1`, [f.booking]);
}
async function notices(f: Fixture) {
  return z.array(z.object({ id: z.string(), kind: z.string(), body_text: z.string() })).parse(
    await f.db.query("SELECT id,kind,body_text FROM public.user_messages WHERE user_id=$1 ORDER BY created_at,id", [f.customer]));
}
async function viewNotice(page: Page, f: Fixture, notice: { id: string; body_text: string }) {
  await page.goto(`/messages/${notice.id}`);
  await expect(page.getByText(notice.body_text, { exact: true })).toBeVisible();
  // Reading a message also saves read_at asynchronously; finish before fixture teardown.
  await expect.poll(async () => (await f.db.query("SELECT read_at FROM public.user_messages WHERE id=$1", [notice.id]))[0]?.read_at).toBeTruthy();
}
async function openEditor(page: Page) {
  await page.getByRole("button", { name: "Edit booking", exact: true }).click();
  const editor = page.getByRole("region", { name: "Rescheduling booking", exact: true });
  await expect(page).toHaveURL(/\/admin\/bookings\?view=calendar.*reschedule=/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Location", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Court timetable" })).toHaveCount(1);
  return editor;
}

test("Calendar rescheduling recovers from a competing reservation and exits without saving", async ({ page, fixture: f }) => {
  await login(page, f);
  await page.goto(`/admin/bookings?view=calendar&location=${f.locations[0]}&date=2099-10-15`);
  const timetable = page.getByRole("table", { name: "Court timetable" });
  await timetable.evaluate(node => node.setAttribute("data-mounted-calendar", "original"));
  await page.getByLabel("Location", { exact: true }).evaluate(node => node.setAttribute("data-mounted-control", "original"));
  const availabilityRequests: string[] = [];
  page.on("request", request => {
    const body = request.postData() ?? "";
    if (request.headers()["next-action"] && body.includes(f.booking) && body.includes("locationId") && !body.includes("expectedRevisionId"))
      availabilityRequests.push(body);
  });
  await timetable.getByRole("button", { name: /Booking · Operational browser customer/ }).click();
  let editor = await openEditor(page);
  await expect(timetable.getByRole("button", { name: /10:00–11:00.*Original reservation.*selected/ })).toBeVisible();
  await expect(timetable).toHaveAttribute("data-mounted-calendar", "original");
  await expect(page.getByLabel("Location", { exact: true })).toHaveAttribute("data-mounted-control", "original");
  expect(availabilityRequests).toHaveLength(1);
  await editor.getByRole("button", { name: "Exit rescheduling" }).click();
  await expect(editor).toHaveCount(0);
  await expect(timetable).toHaveAttribute("data-mounted-calendar", "original");
  expect(availabilityRequests).toHaveLength(1);
  await timetable.getByRole("button", { name: /Booking · Operational browser customer/ }).click();
  editor = await openEditor(page);
  await expect(timetable.getByRole("button", { name: /10:00–11:00.*Original reservation.*selected/ })).toBeVisible();
  const before = await state(f);
  await page.getByRole("table", { name: "Court timetable" }).getByRole("button", { name: /Court 0 .*12:00–13:00/ }).click();
  await editor.getByRole("button", { name: "Preview change" }).click();
  await expect(editor.getByRole("region", { name: "Financial preview" })).toBeVisible();
  expect(availabilityRequests).toHaveLength(2);
  await expect(timetable).toHaveAttribute("data-mounted-calendar", "original");
  await f.db.query("INSERT INTO public.court_reservations(court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,'2099-10-15',720,780)", [f.courts[0]]);
  await editor.getByRole("button", { name: "Confirm booking change" }).click();
  await expect(editor.getByRole("alert")).toContainText("The court is already booked");
  await expect(page.getByRole("table", { name: "Court timetable" }).getByRole("button", { name: /Court 0 .*12:00–13:00/ })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Preview change" })).toBeDisabled();
  await page.getByLabel("Location", { exact: true }).selectOption(f.locations[1]);
  await expect(timetable.getByRole("button", { name: /Court 1 .*14:00–15:00/ })).toBeEnabled();
  await page.getByRole("button", { name: "Next day" }).click();
  await page.getByRole("table", { name: "Court timetable" }).getByRole("button", { name: /Court 1 .*14:00–15:00/ }).click();
  await expect(timetable).toHaveAttribute("data-mounted-calendar", "original");
  await editor.getByRole("button", { name: "Exit rescheduling" }).click();
  await expect(editor).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`view=calendar&location=${f.locations[1]}&date=2099-10-16`));
  await expect(page.getByRole("table", { name: "Court timetable" })).toHaveCount(1);
  await expect(timetable).toHaveAttribute("data-mounted-calendar", "original");
  await expect(page.getByLabel("Location", { exact: true })).toHaveAttribute("data-mounted-control", "original");
  await page.getByRole("button", { name: "Next day" }).click();
  await expect(page.getByLabel("Date", { exact: true })).toHaveValue("2099-10-17");
  await expect(timetable).toHaveAttribute("data-mounted-calendar", "original");
  expect(await state(f)).toEqual(before);
  expect(await notices(f)).toEqual([]);
});

test("Admin financial confirmation rejects changed quotes and currency, absorbs increases and never raises customer obligation", async ({ page, fixture: f }) => {
  test.setTimeout(90000);
  await login(page, f); await page.goto(`/admin/bookings/${f.booking}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await f.db.query("INSERT INTO public.court_reservations(court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,'2099-10-15',690,750)", [f.courts[0]]);
  const editor = await openEditor(page), before = await state(f);
  await expect(page.getByRole("table", { name: "Court timetable" }).getByLabel(/Court 0 .*11:30–12:00, Booked/)).toHaveCount(1);
  await expect(page.getByRole("table", { name: "Court timetable" }).getByRole("button", { name: /Court 0 .*11:30–12:30/ })).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Court timetable" }).getByRole("button", { name: /Court 0 .*10:00–11:00.*Original reservation.*selected/ })).toBeVisible();
  await page.getByLabel("Location", { exact: true }).selectOption(f.locations[2]);
  await expect(editor.getByRole("alert")).toContainText("Bookings cannot move between currencies.");
  await expect(editor.getByRole("button", { name: "Preview change" })).toBeDisabled();
  expect(await state(f)).toEqual(before);
  await page.getByLabel("Location", { exact: true }).selectOption(f.locations[1]);
  await page.getByLabel("Date", { exact: true }).fill("2099-10-16");
  await page.getByRole("table", { name: "Court timetable" }).getByRole("button", { name: /Court 1 .*12:00–13:00/ }).click();
  await editor.getByRole("button", { name: "Preview change" }).click();
  await expect(editor.getByRole("region", { name: "Financial preview" })).toContainText("The club pays the increase. No additional customer charge.");
  expect(await state(f)).toEqual(before); expect(await notices(f)).toEqual([]);
  // A real configuration change between the browser's preview and confirmation.
  await f.db.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=8000 WHERE court_id=$1", [f.courts[1]]);
  await editor.getByRole("button", { name: "Confirm booking change" }).click();
  await expect(editor.getByRole("alert")).toContainText("The quote changed. Request a new preview and confirm it.");
  expect(await state(f)).toEqual(before); expect(await notices(f)).toEqual([]);
  await editor.getByRole("button", { name: "Preview change" }).click();
  await expect(editor.getByRole("region", { name: "Financial preview" })).toContainText(/80\.00/);
  expect(await editor.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await editor.getByRole("button", { name: "Confirm booking change" }).click();
  await expect(editor).toHaveCount(0);
  await page.goto(`/admin/bookings/${f.booking}`);
  await expect(page.getByText("12:00–13:00 (UTC)")).toBeVisible();
  expect(await state(f)).toEqual([expect.objectContaining({ court_id: f.courts[1], booking_date: "2099-10-16", starts_at_minute: 720,
    total_amount_minor: 5000, revisions: 2, adjustments: 1, refunds: 0 })]);
  await expect(page.getByRole("region", { name: "Booking history" })).toContainText("Financial browser 1");
  const [notice] = await notices(f);
  expect(await notices(f)).toHaveLength(1);
  expect(notice.body_text).toMatch(/club covers the difference of RON\s30\.00/);
  await login(page, f, 1); await viewNotice(page, f, notice);
});

for (const method of ["online", "pay_at_club"] as const) {
  test.describe(method, () => {
    test.use({ method });
    test("Admin reduction confirms the final balance and displays the customer's actual notification", async ({ page, request, fixture: f }) => {
      test.setTimeout(90000);
      await login(page, f); await page.goto(`/admin/bookings/${f.booking}`);
      const editor = await openEditor(page), before = await state(f);
      await f.db.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=4000 WHERE court_id=$1", [f.courts[1]]);
      await page.getByLabel("Location", { exact: true }).selectOption(f.locations[1]);
      await page.getByRole("table", { name: "Court timetable" }).getByRole("button", { name: /Court 1 .*14:00–15:00/ }).click();
      await editor.getByRole("button", { name: "Preview change" }).click();
      await expect(editor.getByRole("region", { name: "Financial preview" })).toContainText(method === "online"
        ? "The original booking remains confirmed until all refunds complete." : "The amount owed is reduced.");
      await editor.getByRole("button", { name: "Confirm booking change" }).click();
      if (method === "online") {
        await expect.poll(async () => (await (await request.get(`${provider}/fixture/evidence?paymentId=${f.payment}`)).json()).dispatches.length).toBe(1);
        await expect(editor.getByRole("status").filter({ hasText: "Checking booking" })).toBeVisible();
        await expect(editor.getByRole("button", { name: "Confirm booking change" })).toBeDisabled();
        const pending = await state(f);
        expect(pending).toEqual([expect.objectContaining({ ...before[0], adjustments: 1, refunds: 1 })]);
        expect((await notices(f)).map(n => n.kind)).toEqual(["booking.change_refund_requested"]);
        await request.post(`${provider}/fixture/release-refund`, { data: { id: f.payment } });
      }
      await expect(editor).toHaveCount(0);
      await page.goto(`/admin/bookings/${f.booking}`);
      await expect(page.getByText("14:00–15:00 (UTC)")).toBeVisible();
      expect(await state(f)).toEqual([expect.objectContaining({ court_id: f.courts[1], total_amount_minor: 4000, revisions: 2,
        refunds: method === "online" ? 1 : 0 })]);
      await expect(page.getByRole("region", { name: "Financial summary" })).toContainText("40.00");
      if (method === "online") {
        await expect(page.getByRole("table", { name: "Financial history" })).toContainText("10.00");
        const evidence = await (await request.get(`${provider}/fixture/evidence?paymentId=${f.payment}`)).json();
        expect(evidence.refunds).toEqual([expect.objectContaining({ status: "succeeded", amount: 1000 })]);
        expect(evidence.dispatches).toHaveLength(1);
      } else await expect(page.getByRole("region", { name: "Financial summary" })).toContainText("Due at club");
      await page.reload();
      const messages = await notices(f);
      expect(messages.map(n => n.kind)).toEqual(method === "online" ? ["booking.change_refund_requested", "booking.rescheduled"] : ["booking.rescheduled"]);
      const notice = messages.at(-1)!;
      expect(notice.body_text).toMatch(method === "online" ? /refund of RON\s10\.00 completed/ : /(?:club|owed|balance)/i);
      await login(page, f, 1);
      for (const message of messages) await viewNotice(page, f, message);
      // A later increase must preserve the reduced obligation and the single refund.
      await login(page, f); await page.goto(`/admin/bookings/${f.booking}`);
      const repeat = await openEditor(page);
      await page.getByLabel("Location", { exact: true }).selectOption(f.locations[0]);
      await page.getByRole("table", { name: "Court timetable" }).getByRole("button", { name: /Court 0 .*14:00–15:00/ }).click();
      await repeat.getByRole("button", { name: "Preview change" }).click();
      await expect(repeat.getByRole("region", { name: "Financial preview" })).toContainText("The club pays the increase.");
      await repeat.getByRole("button", { name: "Confirm booking change" }).click();
      await expect(repeat).toHaveCount(0);
      await page.goto(`/admin/bookings/${f.booking}`);
      expect(await state(f)).toEqual([expect.objectContaining({ court_id: f.courts[0], total_amount_minor: 4000, revisions: 3,
        refunds: method === "online" ? 1 : 0 })]);
      expect((await notices(f)).map(n => n.kind)).toEqual([...messages.map(n => n.kind), "booking.rescheduled"]);
      if (method === "online") {
        const repeated = await (await request.get(`${provider}/fixture/evidence?paymentId=${f.payment}`)).json();
        expect(repeated.dispatches).toHaveLength(1); expect(repeated.refunds).toHaveLength(1);
      }
    });
  });
}

test.describe("failed refund", () => {
  test.use({ failRefund: true });
  test("Admin failed reduction preserves the booking, records failure and does not announce a reschedule", async ({ page, request, fixture: f }) => {
    test.setTimeout(90000);
    await login(page, f); await page.goto(`/admin/bookings/${f.booking}`);
    const before = await state(f), editor = await openEditor(page);
    await f.db.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=4000 WHERE court_id=$1", [f.courts[1]]);
    await page.getByLabel("Location", { exact: true }).selectOption(f.locations[1]);
    await page.getByRole("table", { name: "Court timetable" }).getByRole("button", { name: /Court 1 .*10:00–11:00/ }).click();
    await editor.getByRole("button", { name: "Preview change" }).click();
    await editor.getByRole("button", { name: "Confirm booking change" }).click();
    await expect.poll(async () => (await (await request.get(`${provider}/fixture/evidence?paymentId=${f.payment}`)).json()).dispatches.length).toBe(1);
    await request.post(`${provider}/fixture/release-refund`, { data: { id: f.payment } });
    await expect(page.getByText("The refund could not complete. The booking has not changed.", { exact: true })).toBeVisible();
    await expect(editor).toHaveCount(0);
    await page.goto(`/admin/bookings/${f.booking}`);
    expect(await state(f)).toEqual([expect.objectContaining({ ...before[0], adjustments: 1, refunds: 1 })]);
    await expect(page.getByText("10:00–11:00 (UTC)")).toBeVisible();
    const messages = await notices(f);
    expect(messages.map(n => n.kind)).toEqual(["booking.change_refund_requested", "financial.modification_rejected"]);
    await page.reload(); expect(await notices(f)).toEqual(messages);
    expect(await f.db.query("SELECT status FROM public.payment_refunds WHERE booking_id=$1", [f.booking])).toEqual([{ status: "voided" }]);
    await login(page, f, 1);
    for (const message of messages) await viewNotice(page, f, message);
  });
});
