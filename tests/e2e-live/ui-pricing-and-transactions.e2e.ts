import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DataSource } from "typeorm";
import { expect, test, type Page } from "@playwright/test";
import {
  cleanupBookingEvidence,
  insertBookingRecords,
  insertCaptureReceiptFixture,
} from "../local/booking-fixtures";
import { localServiceRoleKey } from "../e2e/helpers/supabase";

// Real Chromium + real Stripe test mode (see booking-modification-lifecycle.e2e.ts).
// Pricing changes at 17:30, a half-hour boundary. The paid extension and the
// reduction refund are real Stripe movements shown in Admin transaction details.
const date = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const locationId = randomUUID(),
  rules = randomUUID(),
  courts = new Map<string, string>();
let db: DataSource,
  previousProvider: string | null = null,
  bookingId = "",
  userId = "";
const q = async <T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
) => (await db.query(sql, params)) as T[];
const auth = () =>
  createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
const shot = (page: Page, name: string) =>
  page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    fullPage: true,
  });
const noPageOverflow = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );

test.beforeAll(async () => {
  db = await new DataSource({
    type: "postgres",
    url: process.env.DATABASE_URL,
  }).initialize();
  previousProvider =
    (
      await q<{ active_provider: string | null }>(
        "SELECT active_provider FROM public.payment_provider_settings",
      )
    )[0]?.active_provider ?? null;
  await q(
    "UPDATE public.payment_provider_settings SET active_provider='stripe'",
  );
  await q(
    "INSERT INTO public.locations(id,name,slug,timezone,currency,is_public) VALUES($1,'Bands Club',$2,'UTC','RON',true)",
    [locationId, `bands-${locationId}`],
  );
  const [schedule] = await q<{ id: string }>(
    "INSERT INTO public.opening_hours_schedules(location_id,starts_on) VALUES($1,'0001-01-01') RETURNING id",
    [locationId],
  );
  await q(
    "INSERT INTO public.location_opening_hours(schedule_id,location_id,weekday,opens_at_minute,closes_at_minute) SELECT $1,$2,d,480,1200 FROM generate_series(0,6) d",
    [schedule.id, locationId],
  );
  await q(
    "INSERT INTO public.pricing_rule_sets(id,location_id) VALUES($1,$2)",
    [rules, locationId],
  );
  for (const name of ["C1", "C2"]) {
    const id = randomUUID();
    courts.set(name, id);
    await q(
      "INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,$3,$4,'clay','outdoor')",
      [id, locationId, name, `${name}-${id}`],
    );
    await q(
      `INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
      SELECT $1,$2,$3,'outdoor',d,s,e,p FROM generate_series(0,6) d CROSS JOIN (VALUES (480,1050,5000),(1050,1200,7000)) r(s,e,p)`,
      [locationId, rules, id],
    );
  }
});
test.afterAll(async () => {
  try {
    if (bookingId)
      await db.transaction((m) =>
        cleanupBookingEvidence(m, { bookingIds: [bookingId] }),
      );
    await q(
      "DELETE FROM public.court_reservations WHERE court_id=ANY($1::uuid[])",
      [[...courts.values()]],
    );
    await q("DELETE FROM public.location_pricing_rules WHERE location_id=$1", [
      locationId,
    ]);
    await q("DELETE FROM public.pricing_rule_sets WHERE location_id=$1", [
      locationId,
    ]);
    await q("DELETE FROM public.location_opening_hours WHERE location_id=$1", [
      locationId,
    ]);
    await q("DELETE FROM public.opening_hours_schedules WHERE location_id=$1", [
      locationId,
    ]);
    await q("DELETE FROM public.courts WHERE location_id=$1", [locationId]);
    await q("DELETE FROM public.locations WHERE id=$1", [locationId]);
    await q("UPDATE public.payment_provider_settings SET active_provider=$1", [
      previousProvider,
    ]);
    if (userId) await auth().auth.admin.deleteUser(userId);
  } finally {
    await db.destroy();
  }
});

async function bands(page: Page, court: string) {
  const row = page.getByRole("row", { name: `${court} hourly prices` });
  return row
    .locator('[role="cell"][aria-colspan]')
    .evaluateAll((cells) =>
      cells.map((cell) => [cell.getAttribute("aria-label"), cell.textContent]),
    );
}
async function fillCard(page: Page, number: string) {
  const frames = page.locator('iframe[title="Secure payment input frame"]');
  await expect(frames.first()).toBeAttached();
  let frame = frames.first().contentFrame();
  await expect
    .poll(
      async () => {
        for (let i = 0; i < (await frames.count()); i++) {
          const candidate = frames.nth(i).contentFrame();
          if (await candidate.getByPlaceholder("1234 1234 1234 1234").count()) {
            frame = candidate;
            return true;
          }
        }
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await frame.getByPlaceholder("1234 1234 1234 1234").fill(number);
  await frame.getByPlaceholder("MM / YY").fill("12 / 34");
  await frame.getByPlaceholder("CVC").fill("123");
}

test("booking timetables show split price bands; Admin detail shows each movement once", async ({
  page,
}) => {
  // Paid confirmed 16:00–17:00 booking on C1 at RON 50/h.
  const email = `bands-${randomUUID()}@example.test`,
    password = "Bands-browser-123";
  const account = await auth().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  userId = account.data.user!.id;
  const reservationId = randomUUID(),
    attemptId = randomUUID(),
    pi = `pi_seed_${attemptId}`;
  bookingId = randomUUID();
  await q(
    "INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,$2,$3,960,1020)",
    [reservationId, courts.get("C1"), date],
  );
  await db.transaction((m) =>
    insertBookingRecords(m, {
      id: bookingId,
      reservation_id: reservationId,
      account_user_id: userId,
      customer_name: "Band member",
      customer_email: email,
      customer_phone: "123",
      total_amount_minor: 5000,
      currency: "RON",
      payment_method: "online",
      status: "confirmed",
      cancellation_notice_minutes: 1440,
    }),
  );
  await db.transaction(async (m) => {
    await m.query(
      `INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at,completed_at)
      VALUES($1,$2,'online','stripe',$3,5000,'RON','succeeded',clock_timestamp()+interval '10 minutes',clock_timestamp())`,
      [attemptId, bookingId, pi],
    );
    await insertCaptureReceiptFixture(m, {
      paymentAttemptId: attemptId,
      providerPaymentId: pi,
      providerCaptureId: pi,
      amountMinor: 5000,
      currency: "RON",
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);

  // Public booking: bands split exactly at 17:30, repeat on long spans, booked time keeps its rate.
  await page.goto(`/book?location=${locationId}&date=${date}`);
  await expect(
    page.getByRole("row", { name: "C1 hourly prices" }),
  ).toBeVisible();
  for (const court of ["C1", "C2"])
    expect(await bands(page, court)).toEqual([
      [`${court} 08:00–10:00, RON 50/h`, "50"],
      [`${court} 10:00–12:00, RON 50/h`, "50"],
      [`${court} 12:00–14:00, RON 50/h`, "50"],
      [`${court} 14:00–16:00, RON 50/h`, "50"],
      [`${court} 16:00–17:30, RON 50/h`, "50"],
      [`${court} 17:30–19:30, RON 70/h`, "70"],
      [`${court} 19:30–20:00, RON 70/h`, "70"],
    ]);
  expect(
    await page
      .getByRole("button", { name: new RegExp(`C2 ${date} 17:00–17:30`) })
      .textContent(),
  ).toBe("");
  // The selected-interval quote is still authoritative across the boundary: 1h at 50 + 30m at 70.
  await page
    .getByRole("button", { name: new RegExp(`C2 ${date} 17:00–17:30`) })
    .click();
  await page
    .getByRole("button", { name: new RegExp(`C2 ${date} 18:00–18:30`) })
    .click();
  await expect(
    page.getByRole("region", { name: "Selected interval" }),
  ).toContainText(/17:00–18:30/);
  await expect(
    page.getByRole("region", { name: "Selected interval" }),
  ).toContainText(/Total:\s*RON\s*95\.00/);
  await page.getByRole("button", { name: "Clear selection" }).click();
  await shot(page, "book-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("row", { name: "C1 hourly prices" }),
  ).toBeVisible();
  expect(await noPageOverflow(page)).toBe(true);
  await shot(page, "book-mobile");
  await page.setViewportSize({ width: 1440, height: 1000 });

  // Customer edit: same bands from the server; pay a real surcharge, then reduce for a real refund.
  await page.goto("/my-activity/bookings");
  await page
    .getByRole("row", { name: /Details for/ })
    .filter({ hasText: "C1" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Edit booking", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("row", { name: "C1 hourly prices" }),
  ).toBeVisible();
  expect((await bands(page, "C1")).slice(-3)).toEqual([
    [`C1 16:00–17:30, RON 50/h`, "50"],
    [`C1 17:30–19:30, RON 70/h`, "70"],
    [`C1 19:30–20:00, RON 70/h`, "70"],
  ]);
  await shot(page, "edit-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noPageOverflow(page)).toBe(true);
  await shot(page, "edit-mobile");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", {
      name: `C1 ${date} 17:00–17:30, Available`,
      exact: true,
    })
    .click();
  await expect(
    page.getByText(/Additional amount payable:.*25\.00/),
  ).toBeVisible();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await fillCard(page, "4242424242424242");
  await page
    .getByRole("button", { name: "Pay and confirm booking", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Booking", exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Edit booking", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: `C1 ${date} 17:00–17:30, Available, selected`,
      exact: true,
    })
    .click();
  await expect(page.getByText(/Eligible refund:.*25\.00/)).toBeVisible();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Refund completed", { exact: true })).toBeVisible(
    { timeout: 30_000 },
  );

  // Admin detail of the refund: summary, totals, one row per actual movement.
  await q(
    "INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')",
    [userId],
  );
  const [refund] = await q<{ id: string }>(
    "SELECT id FROM public.payment_refunds WHERE booking_id=$1",
    [bookingId],
  );
  const attempts = await q<{ id: string }>(
    "SELECT id FROM public.payment_attempts WHERE booking_id=$1",
    [bookingId],
  );
  const executions = await q(
    "SELECT 1 FROM public.refund_executions WHERE refund_id=$1",
    [refund.id],
  );
  await page.goto(`/admin/payments/transactions/refund/${refund.id}`);
  const detail = page.getByRole("region", { name: "Transaction details" });
  await expect(detail.getByRole("heading", { level: 2 })).toHaveText(
    "Partial refund",
  );
  await expect(
    page.getByRole("region", { name: "Transaction summary" }),
  ).toContainText("Booking price reduction");
  const totals = page.getByLabel("RON totals");
  await expect(totals).toContainText(/Verified captured\s*RON\s*75\.00/);
  await expect(totals).toContainText(/Verified refunded\s*RON\s*25\.00/);
  await expect(totals).toContainText(/Net retained\s*RON\s*50\.00/);
  const rows = page
    .getByRole("region", { name: "Payment and refund history" })
    .locator("tbody tr");
  await expect(rows).toHaveCount(3);
  expect(
    await rows.evaluateAll((trs) =>
      trs.map((tr) =>
        [...tr.querySelectorAll("td")]
          .slice(1, 4)
          .map((td) =>
            td.textContent
              ?.replace(/\s+/g, " ")
              .replace(/^\d+ \w+ \d{4}, \d\d:\d\d/, ""),
          ),
      ),
    ),
  ).toEqual([
    ["Booking payment", "RON 50.00", "Captured"],
    ["Additional modification payment", "RON 25.00", "Captured"],
    [
      "Refund · Booking price reduction(this transaction)",
      "−RON 25.00",
      "Refunded",
    ],
  ]);
  await expect(rows.nth(2)).toHaveAttribute("aria-current", "true");
  expect({ attempts: attempts.length, executions: executions.length }).toEqual({
    attempts: 2,
    executions: 1,
  });
  await expect(
    page.getByRole("region", { name: "Needs attention" }),
  ).toHaveCount(0);
  await expect(page.locator("details")).not.toHaveAttribute("open", "");
  await shot(page, "admin-detail-desktop");
  await page.getByText("Technical details").click();
  await expect(
    page.getByRole("region", { name: "Refund execution history" }),
  ).toContainText("Execution 1");
  await shot(page, "admin-detail-technical");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "admin-detail-mobile");
  expect(await noPageOverflow(page)).toBe(true);
  // History links resolve to the movement's own detail.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await rows
    .nth(1)
    .getByRole("link", { name: "Additional modification payment" })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Transaction details" })
      .getByRole("heading", { level: 2 }),
  ).toHaveText("Additional adjustment payment");
  await expect(
    page
      .getByRole("region", { name: "Payment and refund history" })
      .locator('tbody tr[aria-current="true"]'),
  ).toContainText("Additional modification payment");
});
