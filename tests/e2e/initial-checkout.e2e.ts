import { cleanupBookingEvidence, setPaymentAttemptExpiryFixture } from "../local/booking-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DataSource } from "typeorm";
import { chromium, expect, test as base, type Page } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";
import { simulateStripeJs } from "./helpers/stripe";

// Initial online checkout from /book. Stripe.js and the Stripe HTTP API are simulated;
// the browser only authorizes the intent, and the server captures and confirms it.
const providerUrl = "http://127.0.0.1:3111", date = "2099-10-15";
type Club = { db: DataSource; locationId: string; courtId: string; courtName: string; coachName: string; programName: string; customerEmail: string; customerPassword: string };

const test = base.extend<{ club: Club }>({
  club: async ({ request }, runFixture) => {
    const db = await new DataSource({ type: "postgres", url: process.env.DATABASE_URL }).initialize();
    const auth = createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    const run = randomUUID().slice(0, 8), locationId = randomUUID(), courtId = randomUUID(), programId = randomUUID();
    const courtName = `Checkout Court ${run}`, coachName = `Checkout Coach ${run}`, programName = `Checkout semi-private ${run}`;
    let coachId: string | undefined, customerId: string | undefined;
    const customerEmail = `checkout-customer-${run}@example.test`, customerPassword = "Checkout-customer-123";
    const [{ active_provider: previousProvider }] = await db.query("SELECT active_provider FROM public.payment_provider_settings");
    const [previousSettings] = await db.query("SELECT official_email,sender_name,emails_enabled FROM public.club_settings WHERE id=true");
    try {
      // Persist eligible notification events, without dispatching any provider mail.
      await db.query("UPDATE public.club_settings SET official_email='club@example.test',sender_name='Checkout Club',emails_enabled=true WHERE id=true");
      await db.query("UPDATE public.payment_provider_settings SET active_provider='stripe'");
      const coach = await auth.auth.admin.createUser({ email: `checkout-coach-${run}@example.test`, password: "Checkout-coach-123", email_confirm: true });
      expect(coach.error).toBeNull();
      coachId = coach.data.user!.id;
      const customer = await auth.auth.admin.createUser({ email: customerEmail, password: customerPassword, email_confirm: true });
      expect(customer.error).toBeNull(); customerId = customer.data.user!.id;
      await db.query("INSERT INTO public.locations(id,name,slug,timezone,currency,is_public) VALUES($1,'Checkout Club',$2,'UTC','RON',true)", [locationId, `checkout-${locationId}`]);
      await db.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,$3,'one','clay','outdoor')", [courtId, locationId, courtName]);
      const [schedule] = await db.query("INSERT INTO public.opening_hours_schedules(location_id,starts_on) VALUES($1,'0001-01-01') RETURNING id", [locationId]);
      await db.query(`INSERT INTO public.location_opening_hours(schedule_id,location_id,weekday,opens_at_minute,closes_at_minute)
        SELECT $1,$2,weekday,480,1200 FROM generate_series(0,6) AS weekday`, [schedule.id, locationId]);
      const [rules] = await db.query("INSERT INTO public.pricing_rule_sets(location_id) VALUES($1) RETURNING id", [locationId]);
      await db.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
        SELECT $1,$2,$3,'outdoor',weekday,480,1200,5000 FROM generate_series(0,6) AS weekday`, [locationId, rules.id, courtId]);
      await db.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'coach')", [coachId]);
      await db.query(`INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages,is_public)
        VALUES($1,$2,'','','{}','{}',true)`, [coachId, coachName]);
      await db.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,min_participants,max_participants,court_rental_included,is_active)
        VALUES($1,$2,'','semi_private',2,4,false,true)`, [programId, programName]);
      await db.query("INSERT INTO public.coaching_program_durations(program_id,duration_minutes) VALUES($1,60)", [programId]);
      await db.query("INSERT INTO public.coach_locations(coach_user_id,location_id) VALUES($1,$2)", [coachId, locationId]);
      await db.query("INSERT INTO public.coach_programs(coach_user_id,program_id) VALUES($1,$2)", [coachId, programId]);
      // Independent club lesson prices/person per player count; none is derived from another.
      await db.query(`INSERT INTO public.coaching_prices(program_id,duration_minutes,participant_count,coach_user_id,amount_minor,currency)
        VALUES($1,60,2,NULL,5000,'RON'),($1,60,3,NULL,4500,'RON'),($1,60,4,NULL,4000,'RON')`, [programId]);
      await db.query(`INSERT INTO public.coach_weekly_availability(coach_user_id,location_id,weekday,start_minute,end_minute,valid_from)
        SELECT $1,$2,weekday,480,1200,'2000-01-01' FROM generate_series(0,6) AS weekday`, [coachId, locationId]);
      await runFixture({ db, locationId, courtId, courtName, coachName, programName, customerEmail, customerPassword });
    } finally {
      try {
        const intents: { provider_payment_id: string | null }[] = await db.query(`SELECT p.provider_payment_id FROM public.payment_attempts p
          JOIN public.checkout_records b ON b.id=p.booking_id JOIN public.court_reservations r ON r.id=b.reservation_id WHERE r.court_id=$1`, [courtId]);
        await db.query(`DELETE FROM public.email_deliveries e USING public.booking_revisions v,public.checkout_records c,public.court_reservations r
          WHERE e.event_key='booking.confirmed:'||v.id::text AND v.booking_id=c.id AND c.reservation_id=r.id AND r.court_id=$1`, [courtId]);
        await db.transaction(manager => cleanupBookingEvidence(manager, { courtIds: [courtId] }));
        await db.query("DELETE FROM public.court_reservations WHERE court_id=$1", [courtId]);
        await db.query("DELETE FROM public.coach_weekly_availability WHERE location_id=$1", [locationId]);
        await db.query("DELETE FROM public.coach_locations WHERE location_id=$1", [locationId]);
        for (const table of ["coach_programs", "coaching_prices", "coaching_program_durations"])
          await db.query(`DELETE FROM public.${table} WHERE program_id=$1`, [programId]);
        await db.query("DELETE FROM public.coaching_programs WHERE id=$1", [programId]);
        await db.query("DELETE FROM public.location_pricing_rules WHERE location_id=$1", [locationId]);
        await db.query("DELETE FROM public.pricing_rule_sets WHERE location_id=$1", [locationId]);
        await db.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [locationId]);
        await db.query("DELETE FROM public.opening_hours_schedules WHERE location_id=$1", [locationId]);
        await db.query("DELETE FROM public.courts WHERE location_id=$1", [locationId]);
        await db.query("DELETE FROM public.locations WHERE id=$1", [locationId]);
        if (coachId) {
          await db.query("DELETE FROM public.coach_profiles WHERE user_id=$1", [coachId]);
          await db.query("DELETE FROM public.user_roles WHERE user_id=$1", [coachId]);
          await db.query("DELETE FROM public.users WHERE id=$1", [coachId]);
          expect((await auth.auth.admin.deleteUser(coachId)).error).toBeNull();
        }
        if (customerId) {
          await db.query("DELETE FROM public.users WHERE id=$1", [customerId]);
          expect((await auth.auth.admin.deleteUser(customerId)).error).toBeNull();
        }
        await db.query("UPDATE public.payment_provider_settings SET active_provider=$1", [previousProvider]);
        await db.query("UPDATE public.club_settings SET official_email=$1,sender_name=$2,emails_enabled=$3 WHERE id=true",
          [previousSettings.official_email,previousSettings.sender_name,previousSettings.emails_enabled]);
        for (const { provider_payment_id: id } of intents) if (id) await request.delete(`${providerUrl}/fixture/payment`, { data: { id } });
      } finally { await db.destroy(); }
    }
  },
});

async function payAsGuest(page: Page, email: string) {
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm your booking", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill("Checkout Guest");
  await dialog.getByLabel("Email", { exact: true }).fill(email);
  await dialog.getByLabel("Phone", { exact: true }).fill("+40712345678");
  await expect(dialog.getByRole("radio", { name: "Online payment", exact: true })).toBeChecked();
  await dialog.getByRole("button", { name: "Continue to payment", exact: true }).click();
  await page.getByLabel("Simulated card number").fill("4242424242424242");
  await page.getByRole("button", { name: "Pay and confirm booking", exact: true }).click();
  return page.getByRole("region", { name: "Booking confirmed", exact: true });
}

// The server-recorded outcome: one confirmed booking, active occupancy and one captured attempt.
async function persisted(db: DataSource, email: string) {
  const bookings = await db.query(`SELECT b.status,v.payment_method,v.total_amount_minor AS total,r.status AS occupancy,r.starts_at_minute AS start,
      r.ends_at_minute AS "end",r.coach_user_id IS NOT NULL AS coached
    FROM public.checkout_records b JOIN public.bookings actual ON actual.id=b.id JOIN public.booking_revisions v ON v.id=b.current_revision_id JOIN public.court_reservations r ON r.id=b.reservation_id
    WHERE v.customer_email=$1`, [email]);
  const attempts = await db.query(`SELECT p.status,p.amount_minor,c.amount_minor AS captured FROM public.payment_attempts p
    JOIN public.checkout_records b ON b.id=p.booking_id JOIN public.booking_revisions v ON v.id=b.current_revision_id
    LEFT JOIN public.payment_capture_receipts c ON c.payment_attempt_id=p.id WHERE v.customer_email=$1`, [email]);
  expect(bookings).toHaveLength(1);
  expect(await db.query(`SELECT e.event_key FROM public.email_deliveries e JOIN public.booking_revisions v
    ON e.event_key='booking.confirmed:'||v.id::text WHERE v.customer_email=$1`, [email])).toHaveLength(1);
  return { booking: bookings[0], attempts };
}

test("guest pays online for a court and the server confirms the captured booking", async ({ page, club }) => {
  test.setTimeout(90_000);
  await simulateStripeJs(page);
  const email = `court-checkout-${randomUUID()}@example.test`;
  await page.goto(`/book?location=${club.locationId}&date=${date}`);
  // One click selects the default one-hour interval.
  await page.getByRole("button", { name: `${club.courtName} ${date} 16:00–16:30, RON 50/h`, exact: true }).click();
  await expect(page.getByRole("region", { name: "Selected interval" })).toContainText(/Total:\s*RON\s*50\.00/);
  await expect(await payAsGuest(page, email)).toBeVisible();
  expect(await persisted(club.db, email)).toEqual({
    booking: { status: "confirmed", payment_method: "online", total: 5000, occupancy: "active", start: 960, end: 1020, coached: false },
    attempts: [{ status: "succeeded", amount_minor: 5000, captured: 5000 }],
  });
  await page.goto(`/book?location=${club.locationId}&date=${date}`);
  for (const slot of ["16:00–16:30", "16:30–17:00"])
    await expect(page.getByRole("cell", { name: `${club.courtName} ${date} ${slot}, Booked`, exact: true })).toBeVisible();
});

test("guest pays online for a semi-private coaching lesson and the server confirms coach, court and participants", async ({ page, club }) => {
  test.setTimeout(90_000);
  await simulateStripeJs(page);
  const email = `lesson-checkout-${randomUUID()}@example.test`;
  await page.goto(`/book?mode=coaching&location=${club.locationId}&date=${date}`);
  await page.getByRole("combobox", { name: "Coach" }).selectOption({ label: club.coachName });
  await page.getByRole("combobox", { name: "Program" }).selectOption({ label: club.programName });
  await page.getByRole("combobox", { name: "Lesson duration" }).selectOption("60");
  const players = page.getByRole("combobox", { name: "Players" });
  await expect(players).toHaveValue("2");
  await expect(players.locator("option:not([disabled])")).toHaveText(["2 players", "3 players", "4 players"]);
  await players.selectOption("4");
  await expect(page).toHaveURL(/participants=4/);
  await page.getByRole("button", { name: new RegExp(`^${club.courtName} ${date} 16:00.*60 min lesson`) }).click();
  const confirmed = await payAsGuest(page, email);
  await expect(confirmed).toContainText("Your coach and court are booked");
  await expect(confirmed).toContainText(club.programName);
  await expect(confirmed).toContainText("4 players");
  expect(await persisted(club.db, email)).toEqual({
    // 4 players × the 4-player lesson price/person (40) plus the court rental (50).
    booking: { status: "confirmed", payment_method: "online", total: 21000, occupancy: "active", start: 960, end: 1020, coached: true },
    attempts: [{ status: "succeeded", amount_minor: 21000, captured: 21000 }],
  });
  expect(await club.db.query(`SELECT (v.pricing_evidence->'coaching'->>'participantCount')::int AS participants
    FROM public.booking_revisions v WHERE v.customer_email=$1 ORDER BY v.revision_number`, [email])).toEqual([{ participants: 4 }, { participants: 4 }]);
});


for (const authenticated of [false, true]) {
  test(`${authenticated ? "authenticated customer" : "guest"} cancels unpaid checkout, immediately releases the court and creates no booking`, async ({ page, club }) => {
    await simulateStripeJs(page);
    if (authenticated) {
      await page.goto("/login");
      await page.getByLabel("Email", { exact: true }).fill(club.customerEmail);
      await page.getByLabel("Password", { exact: true }).fill(club.customerPassword);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page).not.toHaveURL(/\/login/);
    }
    const email = authenticated ? club.customerEmail : `cancel-${randomUUID()}@example.test`;
    await page.goto(`/book?location=${club.locationId}&date=${date}`);
    const slot = page.getByRole("button", { name: `${club.courtName} ${date} 16:00–16:30, RON 50/h`, exact: true });
    await slot.click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm your booking", exact: true });
    await dialog.getByLabel("Name", { exact: true }).fill("Checkout customer");
    await dialog.getByLabel("Email", { exact: true }).fill(email);
    await dialog.getByLabel("Phone", { exact: true }).fill("+40712345678");
    await dialog.getByRole("button", { name: "Continue to payment", exact: true }).click();
    await expect(page.getByLabel("Simulated card number")).toBeVisible();
    expect(await club.db.query(`SELECT actual.id FROM public.bookings actual JOIN public.checkout_records c ON c.id=actual.id
      JOIN public.booking_revisions v ON v.id=c.current_revision_id WHERE v.customer_email=$1`, [email])).toEqual([]);
    await page.getByRole("button", { name: "Cancel payment", exact: true }).click();
    await page.getByRole("button", { name: "Cancel payment", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(slot).toBeVisible();
    expect(await club.db.query(`SELECT c.status,r.status AS occupancy,p.status AS payment,
      actual.id AS actual_booking,(SELECT count(*)::int FROM public.booking_revisions cancelled WHERE cancelled.booking_id=c.id AND cancelled.kind='cancelled') AS cancellations
      FROM public.checkout_records c JOIN public.booking_revisions v ON v.id=c.current_revision_id
      JOIN public.court_reservations r ON r.id=c.reservation_id JOIN public.payment_attempts p ON p.booking_id=c.id
      LEFT JOIN public.bookings actual ON actual.id=c.id WHERE v.customer_email=$1`, [email]))
      .toEqual([{ status: "cancelled", occupancy: "released", payment: "cancelled", actual_booking: null, cancellations: 0 }]);
    expect(await club.db.query("SELECT id FROM public.email_deliveries WHERE recipient_email=$1", [email])).toEqual([]);
    if (authenticated) {
      await page.goto("/my-activity/history");
      await expect(page.getByText(club.courtName, { exact: true })).not.toBeVisible();
    }
  });
}


test("browser closes before authorization and server expiry resolves the unpaid checkout after a controlled deadline", async ({ page: observer, request, club }) => {
  test.setTimeout(90_000);
  const customerBrowser = await chromium.launch({ channel: "chrome" });
  try {
    const customer = await customerBrowser.newPage();
    await simulateStripeJs(customer);
    await customer.goto("http://localhost:3100/login");
    await customer.getByLabel("Email", { exact: true }).fill(club.customerEmail);
    await customer.getByLabel("Password", { exact: true }).fill(club.customerPassword);
    await customer.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(customer).not.toHaveURL(/\/login/);
    await customer.goto(`http://localhost:3100/book?location=${club.locationId}&date=${date}`);
    const slotName = `${club.courtName} ${date} 16:00–16:30, RON 50/h`;
    await customer.getByRole("button", { name: slotName, exact: true }).click();
    await customer.getByRole("button", { name: "Continue", exact: true }).click();
    const dialog = customer.getByRole("dialog", { name: "Confirm your booking", exact: true });
    await dialog.getByLabel("Name", { exact: true }).fill("Browser abandonment customer");
    await dialog.getByLabel("Phone", { exact: true }).fill("+40712345678");
    await dialog.getByRole("button", { name: "Continue to payment", exact: true }).click();
    await expect(customer.getByLabel("Simulated card number")).toBeVisible();
    const [attempt] = await club.db.query(`SELECT p.id,p.booking_id,p.provider_payment_id,p.expires_at,
      extract(epoch from (p.expires_at-p.created_at)) AS lifetime
      FROM public.payment_attempts p JOIN public.checkout_records c ON c.id=p.booking_id
      JOIN public.court_reservations r ON r.id=c.reservation_id WHERE r.court_id=$1`, [club.courtId]);
    expect(Number(attempt.lifetime)).toBeGreaterThan(599);
    expect(Number(attempt.lifetime)).toBeLessThan(601);
    await customerBrowser.close(); // No Cancel action, unload request or original customer polling.
    const sweep = () => request.post("/api/payments/holds/expire", {
      headers: { Authorization: `Bearer ${process.env.CHECKOUT_EXPIRY_CRON_SECRET}` }, data: {},
    });
    expect((await sweep()).ok()).toBeTruthy();
    expect(await club.db.query("SELECT status FROM public.payment_attempts WHERE id=$1", [attempt.id])).toEqual([{ status: "pending" }]);
    await observer.goto(`/book?location=${club.locationId}&date=${date}`);
    await expect(observer.getByRole("button", { name: slotName, exact: true })).not.toBeVisible();
    // The browser is gone and the live hold was verified above. Move both persisted
    // deadlines together in the isolated DB, then exercise the production Cron path.
    await club.db.transaction(async manager => {
      const [{ deadline }] = await manager.query("SELECT (clock_timestamp()-interval '1 minute')::text AS deadline");
      await setPaymentAttemptExpiryFixture(manager, attempt.id, deadline);
      await manager.query(`UPDATE public.court_reservations SET hold_expires_at=$2::timestamptz
        WHERE id=(SELECT reservation_id FROM public.checkout_records WHERE id=$1)`, [attempt.booking_id, deadline]);
    });
    expect((await sweep()).ok()).toBeTruthy();
    expect(await club.db.query(`SELECT c.status,r.status AS occupancy,p.status AS payment,actual.id AS actual_booking
      FROM checkout_records c JOIN court_reservations r ON r.id=c.reservation_id
      JOIN payment_attempts p ON p.booking_id=c.id LEFT JOIN bookings actual ON actual.id=c.id WHERE p.id=$1`, [attempt.id]))
      .toEqual([{ status: "expired", occupancy: "released", payment: "cancelled", actual_booking: null }]);
    const evidence = await (await request.get(`${providerUrl}/fixture/evidence?paymentId=${attempt.provider_payment_id}`)).json();
    expect(evidence.payment.status).toBe("canceled");
    expect(evidence.payment.amount_received).toBe(0);
    await observer.reload();
    await expect(observer.getByRole("button", { name: slotName, exact: true })).toBeVisible();
    expect((await sweep()).ok()).toBeTruthy();
    expect(await club.db.query("SELECT id FROM bookings WHERE id=$1", [attempt.booking_id])).toEqual([]);
    await simulateStripeJs(observer);
    await observer.getByRole("button", { name: slotName, exact: true }).click();
    const replacementEmail = `replacement-${randomUUID()}@example.test`;
    await expect(await payAsGuest(observer, replacementEmail)).toBeVisible();
    const replacement = await persisted(club.db, replacementEmail);
    expect(replacement.booking).toMatchObject({ status: "confirmed", occupancy: "active", start: 960, end: 1020 });
  } finally { await customerBrowser.close(); }
});
