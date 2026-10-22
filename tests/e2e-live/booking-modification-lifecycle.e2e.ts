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
  listener: ChildProcess | null = null,
  previousProvider: string | null = null;
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
async function startListener() {
  if (listener) return;
  const child = spawn("stripe", ["listen", "--forward-to", webhook], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  listener = child;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("stripe listen did not become ready")),
      30_000,
    );
    const ready = (chunk: Buffer) => {
      if (chunk.toString().includes("Ready!")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", ready);
    child.stderr?.on("data", ready);
  });
}
function stopListener() {
  listener?.kill("SIGINT");
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
  stopListener();
  try {
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
    await q("UPDATE public.payment_provider_settings SET active_provider=$1", [
      previousProvider,
    ]);
    for (const id of users) await auth().auth.admin.deleteUser(id);
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
  expect(account.error).toBeNull();
  const userId = account.data.user!.id;
  users.push(userId);
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

test.describe("live lifecycle", () => {
  test.skip(
    process.env.LIVE_LATE === "1",
    "Late scenario run uses the shortened-hold server only.",
  );

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
    stopListener();
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

test("late success: payment after the shortened hold is refunded once, never applied, and the hold is released", async ({
  page,
}) => {
  test.skip(
    process.env.LIVE_LATE !== "1",
    "Requires the server started with the hold override.",
  );
  const { bookingId, court } = await signedInBooking(page, "C5");
  await proposeExtension(page, court);
  const [pending] = await adjustments(bookingId);
  const [{ cutoff }] = await q<{ cutoff: Date }>(
    "SELECT expires_at AS cutoff FROM public.booking_adjustments WHERE id=$1",
    [pending.id],
  );
  expect(cutoff.getTime() - Date.now()).toBeLessThanOrEqual(61_000);
  // The customer leaves without X; the provider completes only after the cutoff.
  await page.close();
  stopListener();
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, cutoff.getTime() - Date.now()) + 5_000),
  );
  stripe([
    "payment_intents",
    "confirm",
    pending.provider_payment_id!,
    "--payment-method",
    "pm_card_visa",
  ]);
  await startListener();
  const succeeded = eventFor(
    "payment_intent.succeeded",
    pending.provider_payment_id!,
  );
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
