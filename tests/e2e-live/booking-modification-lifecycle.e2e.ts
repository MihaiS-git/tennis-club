import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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

// Real Chromium + real Stripe test mode + `stripe listen`. Only the original
// booking is seeded; every modification, PaymentIntent and webhook is real.
// Playwright starts the isolated server. The late scenario needs
// E2E_ALLOW_HOLD_OVERRIDE=1 BOOKING_HOLD_SECONDS_OVERRIDE=60 and LIVE_LATE=1.
const webhook = "localhost:3100/api/payments/stripe/webhook";
const date = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const courts = ["C1", "C2", "C3", "C4", "C5", "C6"];
let db: DataSource,
  listener: { child: ChildProcess; exited: Promise<void> } | null = null,
  // undefined until read, so teardown never "restores" a value it did not observe.
  previousProvider: string | null | undefined;
const auth = () =>
  createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
const locationId = randomUUID(),
  rules = randomUUID(),
  courtIds = new Map<string, string>();
const bookings: string[] = [],
  users: string[] = [];

function stripe(args: string[]) {
  return JSON.parse(
    execFileSync("stripe", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}
// One forwarder at a time: a restart waits for the previous process to exit.
async function startListener() {
  if (listener?.child.exitCode === null && listener.child.signalCode === null)
    return;
  await stopListener();
  const child = spawn("stripe", ["listen", "--forward-to", webhook], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  // A failed spawn emits "error" and never "exit".
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  listener = { child, exited };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("stripe listen did not become ready")),
        30_000,
      );
      const settle = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const ready = (chunk: Buffer) => {
        if (chunk.toString().includes("Ready!")) settle();
      };
      child.stdout?.on("data", ready);
      child.stderr?.on("data", ready);
      child.once("error", (error) =>
        settle(new Error("stripe listen failed to start", { cause: error })),
      );
      child.once("exit", (code, signal) =>
        settle(
          new Error(
            `stripe listen exited before it was ready (${signal ?? `code ${code}`})`,
          ),
        ),
      );
    });
  } catch (error) {
    await stopListener();
    throw error;
  }
}
// Interrupts the forwarder and keeps its reference until the process has exited.
async function stopListener() {
  if (!listener) return;
  const { child, exited } = listener;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
  const forced = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    await exited;
  } finally {
    clearTimeout(forced);
  }
  listener = null;
}
// Delivers a recorded event again through the running CLI listener.
function resend(eventId: string) {
  execFileSync("stripe", ["events", "resend", eventId], { stdio: "ignore" });
}
function eventFor(type: string, paymentIntent: string): string {
  const events = stripe([
    "events",
    "list",
    "--type",
    type,
    "--limit",
    "50",
  ]) as { data: { id: string; data: { object: { id: string } } }[] };
  const event = events.data.find((e) => e.data.object.id === paymentIntent);
  if (!event) throw new Error(`No ${type} event for ${paymentIntent}`);
  return event.id;
}
const q = async <T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
) => (await db.query(sql, params)) as T[];
// Soft checks report a failed cleanup step without hiding test failures or skipping
// independent steps; steps within one call depend on each other and stop at the first error.
const cleanup = (step: string, work: () => Promise<unknown>) =>
  expect
    .soft(
      Promise.resolve()
        .then(work)
        .then(() => "done"),
      step,
    )
    .resolves.toBe("done");

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
    "INSERT INTO public.locations(id,name,slug,timezone,currency,is_public) VALUES($1,'Lifecycle Club',$2,'UTC','RON',true)",
    [locationId, `lifecycle-${locationId}`],
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
  for (const name of courts) {
    const id = randomUUID();
    courtIds.set(name, id);
    await q(
      "INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,$3,$4,'clay','outdoor')",
      [id, locationId, name, `${name}-${id}`],
    );
    await q(
      `INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
      SELECT $1,$2,$3,'outdoor',d,480,1200,5000 FROM generate_series(0,6) d`,
      [locationId, rules, id],
    );
  }
  await startListener();
});
test.afterAll(async () => {
  await cleanup("stop stripe listen", stopListener);
  if (!db?.isInitialized) return;
  try {
    // Bookings and reservations reference the users, so they go first.
    await cleanup("delete bookings and club fixtures", async () => {
      if (bookings.length)
        await db.transaction((m) =>
          cleanupBookingEvidence(m, { bookingIds: bookings }),
        );
      await q(
        "DELETE FROM public.court_reservations WHERE court_id=ANY($1::uuid[])",
        [[...courtIds.values()]],
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
    });
    if (previousProvider !== undefined)
      await cleanup("restore payment provider", () =>
        q("UPDATE public.payment_provider_settings SET active_provider=$1", [
          previousProvider,
        ]),
      );
    // Application references before Auth: public.users restricts Auth deletion.
    for (const id of users)
      await cleanup(`delete user ${id}`, async () => {
        await q("DELETE FROM public.player_profiles WHERE user_id=$1", [id]);
        await q("DELETE FROM public.user_roles WHERE user_id=$1", [id]);
        await q("DELETE FROM public.users WHERE id=$1", [id]);
        const { error } = await auth().auth.admin.deleteUser(id);
        if (error) throw error;
      });
  } finally {
    await db.destroy();
  }
});

// A paid, confirmed 16:00–17:00 booking (RON 50.00) owned by a new signed-in member.
async function signedInBooking(page: Page, court: string) {
  const email = `lifecycle-${randomUUID()}@example.test`,
    password = "Lifecycle-browser-123";
  const account = await auth().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (account.data.user) users.push(account.data.user.id);
  expect(account.error).toBeNull();
  const userId = account.data.user!.id;
  const reservationId = randomUUID(),
    bookingId = randomUUID(),
    attemptId = randomUUID(),
    pi = `pi_seed_${attemptId}`;
  await q(
    "INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,$2,$3,960,1020)",
    [reservationId, courtIds.get(court), date],
  );
  await db.transaction((m) =>
    insertBookingRecords(m, {
      id: bookingId,
      reservation_id: reservationId,
      account_user_id: userId,
      customer_name: "Lifecycle member",
      customer_email: email,
      customer_phone: "123",
      total_amount_minor: 5000,
      currency: "RON",
      payment_method: "online",
      status: "confirmed",
      cancellation_notice_minutes: 1440,
    }),
  );
  bookings.push(bookingId);
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
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  return { bookingId, court };
}
async function openDetails(page: Page, court: string) {
  await page.goto("/my-activity/bookings");
  await page
    .getByRole("row", { name: /Details for/ })
    .filter({ hasText: court })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
const editButton = (page: Page) =>
  page
    .getByRole("dialog")
    .getByRole("button", { name: "Edit booking", exact: true });
// Extends 16:00–17:00 to 17:30 (+RON 25.00) and reaches the payment step.
async function proposeExtension(page: Page, court: string) {
  await openDetails(page, court);
  await editButton(page).click();
  await expect(
    page.getByRole("region", { name: "Booking modification" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", {
      name: `${court} ${date} 17:00–17:30, Available`,
      exact: true,
    })
    .click();
  await expect(
    page.getByText(/Additional amount payable:.*25\.00/),
  ).toBeVisible();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Booking modification" }),
  ).toBeVisible();
}
async function fillCard(page: Page, number: string) {
  // Stripe renders several same-titled frames; use the one holding the card field.
  const frames = page.locator('iframe[title="Secure payment input frame"]');
  await expect(frames.first()).toBeAttached({ timeout: 30_000 });
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
  const postal = frame.getByPlaceholder(/ZIP|Postal/i);
  if (await postal.count()) await postal.fill("12345");
}
const pay = (page: Page) =>
  page
    .getByRole("button", { name: "Pay and confirm booking", exact: true })
    .click();
const closeDialog = (page: Page) =>
  page
    .getByRole("dialog")
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
async function adjustments(bookingId: string) {
  return q<{
    id: string;
    status: string;
    attempt_status: string;
    provider_payment_id: string | null;
  }>(
    `SELECT a.id,a.status,p.status AS attempt_status,p.provider_payment_id
    FROM public.booking_adjustments a JOIN public.payment_attempts p ON p.adjustment_id=a.id WHERE a.booking_id=$1 ORDER BY a.created_at`,
    [bookingId],
  );
}
const holdStatuses = async (adjustmentId: string) =>
  (
    await q<{ status: string }>(
      "SELECT status FROM public.court_reservations WHERE adjustment_id=$1",
      [adjustmentId],
    )
  ).map((r) => r.status);
async function contract(bookingId: string) {
  const [row] = await q<{ total: number; end: number; rescheduled: number }>(
    `SELECT v.total_amount_minor AS total,r.ends_at_minute AS "end",
    (SELECT count(*)::integer FROM public.booking_revisions WHERE booking_id=b.id AND kind='rescheduled') AS rescheduled
    FROM public.bookings b JOIN public.booking_revisions v ON v.id=b.current_revision_id JOIN public.court_reservations r ON r.id=b.reservation_id WHERE b.id=$1`,
    [bookingId],
  );
  return row;
}
const refunds = (bookingId: string) =>
  q<{ amount_minor: number; reason: string }>(
    "SELECT amount_minor,reason FROM public.payment_refunds WHERE booking_id=$1",
    [bookingId],
  );

// These cases use Stripe's real 3DS2 challenge, never the Stripe.js fixture.
async function newCheckout(page: Page, court: string) {
  page.setDefaultTimeout(15_000);
  const scripts: string[] = [];
  page.on("request", request => {
    if (/https:\/\/js\.stripe\.com\/[^/]+\/stripe\.js/.test(request.url())) scripts.push(request.url());
  });
  await page.goto(`/book?location=${locationId}&date=${date}`);
  await page.getByRole("button", { name: new RegExp(`^${court} ${date} 16:00–16:30,`) }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("3DS browser guest");
  await page.getByLabel("Email", { exact: true }).fill(`three-ds-${randomUUID()}@example.test`);
  await page.getByLabel("Phone", { exact: true }).fill("+40722123456");
  expect(scripts).toEqual([]);
  await page.getByRole("button", { name: "Continue to payment", exact: true }).click();
  await expect.poll(async () => (await q<{ id: string }>(
    "SELECT b.id FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id WHERE r.court_id=$1", [courtIds.get(court)]
  )).length).toBe(1);
  const [booking] = await q<{ id: string }>(
    "SELECT b.id FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id WHERE r.court_id=$1", [courtIds.get(court)]
  );
  bookings.push(booking.id);
  await fillCard(page, "4000000000003220");
  expect(scripts).toHaveLength(1);
  const attempts = await q<{ provider_payment_id: string }>("SELECT provider_payment_id FROM public.payment_attempts WHERE booking_id=$1", [booking.id]);
  expect(attempts).toHaveLength(1);
  return { bookingId: booking.id, intent: attempts[0].provider_payment_id };
}

async function challenge(page: Page, intent: string, outcome: "Complete" | "Fail", slow = false) {
  const element = await page.locator('iframe[title="Secure payment input frame"]').first().elementHandle();
  expect(element).not.toBeNull();
  await pay(page);
  let challengeFrame = page.mainFrame();
  await expect.poll(async () => {
    for (const frame of page.frames()) {
      if (await frame.getByRole("button", { name: "Complete", exact: true }).count()) {
        challengeFrame = frame;
        return true;
      }
    }
    return false;
  }, { timeout: 30_000 }).toBe(true);
  expect(stripe(["payment_intents", "retrieve", intent])).toMatchObject({ livemode: false, status: "requires_action", capture_method: "manual", amount_received: 0 });
  await expect(page.getByRole("region", { name: "Booking confirmed", exact: true })).toHaveCount(0);
  if (slow) {
    // Stripe's challenge is itself modal, so the underlying payment button is
    // intentionally absent from the accessibility tree until it closes.
    await expect(page.locator('form[aria-label="Online payment"] button[type="submit"]'))
      .toHaveText("Waiting for authentication…", { timeout: 35_000 });
    await expect(page.locator('[data-sonner-toast][data-type="loading"]')).toHaveCount(0);
  }
  expect(await element!.evaluate(node => node.isConnected)).toBe(true);
  await challengeFrame.getByRole("button", { name: outcome, exact: true }).click();
  return element!;
}

async function verifiedCapture(bookingId: string, intent: string, amount: number) {
  await expect.poll(() => stripe(["payment_intents", "retrieve", intent]).status, { timeout: 30_000 }).toBe("succeeded");
  const payment = stripe(["payment_intents", "retrieve", intent]);
  expect(payment).toMatchObject({ livemode: false, capture_method: "manual", amount_received: amount, amount_capturable: 0 });
  const charge = stripe(["charges", "retrieve", payment.latest_charge]);
  expect(charge).toMatchObject({ captured: true, amount_captured: amount });
  expect(charge.payment_method_details.card.three_d_secure).toMatchObject({ result: "authenticated", authentication_flow: "challenge" });
  expect(charge.payment_method_details.card.three_d_secure.version).toMatch(/^2\./);
  expect(await q("SELECT p.status,p.amount_minor,c.amount_minor AS captured FROM public.payment_attempts p JOIN public.payment_capture_receipts c ON c.payment_attempt_id=p.id WHERE p.booking_id=$1 AND p.provider_payment_id=$2", [bookingId, intent]))
    .toEqual([{ status: "succeeded", amount_minor: amount, captured: amount }]);
  console.log(JSON.stringify({ bookingId, intent, status: payment.status, captured: amount, threeDS: charge.payment_method_details.card.three_d_secure }));
}

if (process.env.LIVE_LATE !== "1") test.describe("live lifecycle", () => {

  test("3DS2 new booking authenticates then captures and confirms", async ({ page }) => {
    const { bookingId, intent } = await newCheckout(page, "C3");
    await challenge(page, intent, "Complete", true);
    await expect(page.getByRole("region", { name: "Booking confirmed", exact: true })).toBeVisible({ timeout: 30_000 });
    await verifiedCapture(bookingId, intent, 5000);
    expect(await contract(bookingId)).toMatchObject({ total: 5000, end: 1020, rescheduled: 0 });
    expect(await q("SELECT b.status,r.status AS reservation FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id WHERE b.id=$1", [bookingId]))
      .toEqual([{ status: "confirmed", reservation: "active" }]);
    await expect(page.locator('[data-sonner-toast][data-type="loading"]')).toHaveCount(0);
  });

  test("3DS2 failed authentication preserves the hold and retries the same intent", async ({ page }) => {
    const { bookingId, intent } = await newCheckout(page, "C4");
    const element = await challenge(page, intent, "Fail");
    await expect(page.getByRole("button", { name: "Pay and confirm booking", exact: true })).toBeEnabled({ timeout: 15_000 });
    expect(await element.evaluate(node => node.isConnected)).toBe(true);
    expect(stripe(["payment_intents", "retrieve", intent])).toMatchObject({ status: "requires_payment_method", amount_received: 0 });
    expect(await q("SELECT b.status,r.status AS reservation FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id WHERE b.id=$1", [bookingId]))
      .toEqual([{ status: "pending_payment", reservation: "held" }]);
    expect(await q("SELECT c.id FROM public.payment_capture_receipts c JOIN public.payment_attempts p ON p.id=c.payment_attempt_id WHERE p.booking_id=$1", [bookingId])).toEqual([]);
    await fillCard(page, "4000000000003220");
    await challenge(page, intent, "Complete");
    await expect(page.getByRole("region", { name: "Booking confirmed", exact: true })).toBeVisible({ timeout: 30_000 });
    await verifiedCapture(bookingId, intent, 5000);
    expect(await q("SELECT id FROM public.payment_attempts WHERE booking_id=$1", [bookingId])).toHaveLength(1);
  });

  test("3DS2 surcharge captures only the difference and applies one revision", async ({ page }) => {
    const { bookingId, court } = await signedInBooking(page, "C5");
    expect(await page.locator('script[src^="https://js.stripe.com/"]').count()).toBe(0);
    await proposeExtension(page, court);
    await fillCard(page, "4000000000003220");
    const [adjustment] = await adjustments(bookingId);
    expect(await contract(bookingId)).toMatchObject({ total: 5000, end: 1020, rescheduled: 0 });
    await challenge(page, adjustment.provider_payment_id!, "Complete");
    await expect(page.getByRole("dialog", { name: "Booking", exact: true })).toBeVisible({ timeout: 30_000 });
    await verifiedCapture(bookingId, adjustment.provider_payment_id!, 2500);
    expect(await contract(bookingId)).toMatchObject({ total: 7500, end: 1050, rescheduled: 1 });
    expect((await adjustments(bookingId)).map(a => [a.status, a.attempt_status])).toEqual([["applied", "succeeded"]]);
    expect(await refunds(bookingId)).toEqual([]);
    await expect(page.locator('[data-sonner-toast][data-type="loading"]')).toHaveCount(0);
  });

  test("abandon: X before paying discards the modification, releases the hold, and Edit reopens fresh", async ({
    page,
  }) => {
    const { bookingId, court } = await signedInBooking(page, "C1");
    await proposeExtension(page, court);
    await closeDialog(page);
    await expect
      .poll(async () => (await adjustments(bookingId))[0]?.status)
      .toBe("cancelled");
    const [adjustment] = await adjustments(bookingId);
    expect(adjustment.attempt_status).toBe("cancelled");
    expect(await holdStatuses(adjustment.id)).toEqual(["released"]);
    expect(
      stripe(["payment_intents", "retrieve", adjustment.provider_payment_id!])
        .status,
    ).toBe("canceled");
    expect(await contract(bookingId)).toMatchObject({
      total: 5000,
      end: 1020,
      rescheduled: 0,
    });
    await openDetails(page, court);
    await editButton(page).click();
    await expect(
      page.getByRole("button", {
        name: `${court} ${date} 16:00–16:30, Available, selected`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Booking modification" }),
    ).toHaveCount(0);
    await expect(
      page.locator('iframe[title="Secure payment input frame"]'),
    ).toHaveCount(0);
  });

  test("declined card keeps the original; retry succeeds and applies exactly once", async ({
    page,
  }) => {
    const { bookingId, court } = await signedInBooking(page, "C2");
    await proposeExtension(page, court);
    await fillCard(page, "4000000000000002");
    await pay(page);
    await expect(page.getByText(/declined/i).first()).toBeVisible();
    expect(await contract(bookingId)).toMatchObject({
      total: 5000,
      end: 1020,
      rescheduled: 0,
    });
    await fillCard(page, "4242424242424242");
    await pay(page);
    await expect(
      page.getByRole("dialog", { name: "Booking", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => (await contract(bookingId)).rescheduled)
      .toBe(1);
    expect(await contract(bookingId)).toMatchObject({ total: 7500, end: 1050 });
    expect(
      (await adjustments(bookingId)).map((a) => [a.status, a.attempt_status]),
    ).toEqual([["applied", "succeeded"]]);
    await expect(editButton(page)).toBeVisible();
    expect(await refunds(bookingId)).toEqual([]);
  });

  test("insufficient funds then X: discarded, released, and never resurrected by later events", async ({
    page,
  }) => {
    const { bookingId, court } = await signedInBooking(page, "C3");
    await proposeExtension(page, court);
    await fillCard(page, "4000000000009995");
    await pay(page);
    await expect(page.getByText(/insufficient funds/i).first()).toBeVisible();
    await closeDialog(page);
    await expect
      .poll(async () => (await adjustments(bookingId))[0]?.status)
      .toBe("cancelled");
    const [adjustment] = await adjustments(bookingId);
    expect(await holdStatuses(adjustment.id)).toEqual(["released"]);
    expect(
      stripe(["payment_intents", "retrieve", adjustment.provider_payment_id!])
        .status,
    ).toBe("canceled");
    // Replay the provider's failure delivery after abandonment.
    resend(
      eventFor(
        "payment_intent.payment_failed",
        adjustment.provider_payment_id!,
      ),
    );
    resend(
      eventFor("payment_intent.canceled", adjustment.provider_payment_id!),
    );
    await expect
      .poll(
        async () =>
          (
            await q(
              "SELECT 1 FROM public.payment_provider_events WHERE attempt_id=(SELECT id FROM public.payment_attempts WHERE adjustment_id=$1)",
              [adjustment.id],
            )
          ).length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    expect((await adjustments(bookingId)).map((a) => a.status)).toEqual([
      "cancelled",
    ]);
    expect(await contract(bookingId)).toMatchObject({
      total: 5000,
      end: 1020,
      rescheduled: 0,
    });
    await openDetails(page, court);
    await editButton(page).click();
    await expect(
      page.getByRole("region", { name: "Booking modification" }),
    ).toHaveCount(0);
    await expect(
      page.locator('iframe[title="Secure payment input frame"]'),
    ).toHaveCount(0);
  });

  test("delayed webhook: pay, X immediately with the listener stopped, then resend twice — applied exactly once", async ({
    page,
  }) => {
    const { bookingId, court } = await signedInBooking(page, "C4");
    await proposeExtension(page, court);
    await stopListener();
    const [pending] = await adjustments(bookingId);
    await fillCard(page, "4242424242424242");
    await pay(page);
    // After submitting, keep the open dialog from observing the provider so X (and the webhook) settle it.
    await page.route("**/api/payments/checkout/status", (route) =>
      route.abort(),
    );
    await expect
      .poll(
        () =>
          stripe(["payment_intents", "retrieve", pending.provider_payment_id!])
            .status,
        { timeout: 30_000 },
      )
      .toBe("succeeded");
    await closeDialog(page);
    await expect
      .poll(async () => (await contract(bookingId)).rescheduled, {
        timeout: 30_000,
      })
      .toBe(1);
    const settledBy = await q<{ event_id: string }>(
      "SELECT event_id FROM public.payment_provider_events WHERE attempt_id=(SELECT id FROM public.payment_attempts WHERE adjustment_id=$1)",
      [pending.id],
    );
    await startListener();
    const succeeded = eventFor(
      "payment_intent.succeeded",
      pending.provider_payment_id!,
    );
    resend(succeeded);
    resend(succeeded);
    await expect
      .poll(
        async () =>
          (
            await q(
              "SELECT 1 FROM public.payment_provider_events WHERE event_id=$1",
              [succeeded],
            )
          ).length,
        { timeout: 30_000 },
      )
      .toBe(1);
    expect(await contract(bookingId)).toMatchObject({
      total: 7500,
      end: 1050,
      rescheduled: 1,
    });
    expect(
      (await adjustments(bookingId)).map((a) => [a.status, a.attempt_status]),
    ).toEqual([["applied", "succeeded"]]);
    expect(
      await q(
        "SELECT count(*)::integer AS n FROM public.payment_capture_receipts WHERE provider_payment_id=$1",
        [pending.provider_payment_id],
      ),
    ).toEqual([{ n: 1 }]);
    expect(await refunds(bookingId)).toEqual([]);
    await page.unroute("**/api/payments/checkout/status");
    await openDetails(page, court);
    await expect(editButton(page)).toBeVisible();
    console.log(
      `settled before webhook resend by: ${settledBy.map((e) => e.event_id).join(",") || "nothing"}; webhook event ${succeeded}`,
    );
  });
});

// Adjustment PaymentIntents use manual capture: confirming one only authorizes it.
// Both late scenarios open a surcharge on the shortened-hold server and confirm it
// at Stripe after the cutoff, while the listener is stopped and the customer is gone.
async function confirmAfterCutoff(page: Page, courtName: string) {
  const { bookingId, court } = await signedInBooking(page, courtName);
  await proposeExtension(page, court);
  const [pending] = await adjustments(bookingId);
  const [{ cutoff }] = await q<{ cutoff: Date }>(
    "SELECT expires_at AS cutoff FROM public.booking_adjustments WHERE id=$1",
    [pending.id],
  );
  expect(cutoff.getTime() - Date.now()).toBeLessThanOrEqual(61_000);
  await page.close();
  await stopListener();
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, cutoff.getTime() - Date.now()) + 5_000),
  );
  const authorized = stripe([
    "payment_intents",
    "confirm",
    pending.provider_payment_id!,
    "--payment-method",
    "pm_card_visa",
  ]);
  expect(authorized).toMatchObject({
    status: "requires_capture",
    amount_capturable: 2500,
    amount_received: 0,
  });
  return { bookingId, pending, paymentId: pending.provider_payment_id! };
}
// Stripe lists events account-wide and asynchronously; poll the latest page for this intent.
async function awaitEvent(type: string, paymentIntent: string) {
  let id = "";
  await expect
    .poll(
      () => {
        try {
          id = eventFor(type, paymentIntent);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return id;
}
const receipts = async (paymentId: string) =>
  (
    await q<{ n: number }>(
      "SELECT count(*)::integer AS n FROM public.payment_capture_receipts WHERE provider_payment_id=$1",
      [paymentId],
    )
  )[0].n;

if (process.env.LIVE_LATE === "1") test("late authorization: an authorization after the shortened hold is cancelled at Stripe and collects no money", async ({
  page,
}) => {
  const { bookingId, pending, paymentId } = await confirmAfterCutoff(page, "C5");
  await startListener();
  const authorized = await awaitEvent(
    "payment_intent.amount_capturable_updated",
    paymentId,
  );
  resend(authorized);
  await expect
    .poll(() => stripe(["payment_intents", "retrieve", paymentId]).status, {
      timeout: 30_000,
    })
    .toBe("canceled");
  expect(stripe(["payment_intents", "retrieve", paymentId])).toMatchObject({
    amount_received: 0,
  });
  expect(await receipts(paymentId)).toBe(0);
  expect(await refunds(bookingId)).toEqual([]);
  expect(await contract(bookingId)).toMatchObject({
    total: 5000,
    end: 1020,
    rescheduled: 0,
  });
  expect(await holdStatuses(pending.id)).toEqual(["released"]);
  expect((await adjustments(bookingId))[0].status).not.toBe("applied");
});

if (process.env.LIVE_LATE === "1") test("late capture: funds captured after the shortened hold are refunded once, never applied, and the hold is released", async ({
  page,
}) => {
  const { bookingId, pending, paymentId } = await confirmAfterCutoff(page, "C6");
  // Arrange authoritative captured funds at Stripe before the application observes anything.
  stripe(["payment_intents", "capture", paymentId]);
  expect(stripe(["payment_intents", "retrieve", paymentId])).toMatchObject({
    status: "succeeded",
    amount_received: 2500,
  });
  await startListener();
  const succeeded = await awaitEvent("payment_intent.succeeded", paymentId);
  resend(succeeded);
  await expect
    .poll(async () => (await refunds(bookingId)).length, { timeout: 30_000 })
    .toBe(1);
  resend(succeeded);
  await expect
    .poll(
      async () =>
        (
          await q(
            "SELECT 1 FROM public.payment_provider_events WHERE event_id=$1",
            [succeeded],
          )
        ).length,
      { timeout: 30_000 },
    )
    .toBe(1);
  expect(await receipts(paymentId)).toBe(1);
  expect(await refunds(bookingId)).toEqual([
    { amount_minor: 2500, reason: "failed_adjustment_compensation" },
  ]);
  expect(await contract(bookingId)).toMatchObject({
    total: 5000,
    end: 1020,
    rescheduled: 0,
  });
  expect(await holdStatuses(pending.id)).toEqual(["released"]);
  expect(
    (await adjustments(bookingId)).map((a) => [a.status, a.attempt_status]),
  ).toEqual([["expired", "succeeded"]]);
});
