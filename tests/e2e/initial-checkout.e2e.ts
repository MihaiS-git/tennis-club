import { cleanupBookingEvidence } from "../local/booking-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DataSource } from "typeorm";
import { expect, test as base, type Page } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";
import { simulateStripeJs } from "./helpers/stripe";

// Initial online checkout from /book. Stripe.js and the Stripe HTTP API are simulated;
// the browser only authorizes the intent, and the server captures and confirms it.
const providerUrl = "http://127.0.0.1:3111", date = "2099-10-15";
type Club = { db: DataSource; locationId: string; courtId: string; courtName: string; coachName: string; programName: string };

const test = base.extend<{ club: Club }>({
  club: async ({ request }, runFixture) => {
    const db = await new DataSource({ type: "postgres", url: process.env.DATABASE_URL }).initialize();
    const auth = createClient(process.env.SUPABASE_URL!, localServiceRoleKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    const run = randomUUID().slice(0, 8), locationId = randomUUID(), courtId = randomUUID(), programId = randomUUID();
    const courtName = `Checkout Court ${run}`, coachName = `Checkout Coach ${run}`, programName = `Checkout semi-private ${run}`;
    let coachId: string | undefined;
    const [{ active_provider: previousProvider }] = await db.query("SELECT active_provider FROM public.payment_provider_settings");
    try {
      await db.query("UPDATE public.payment_provider_settings SET active_provider='stripe'");
      const coach = await auth.auth.admin.createUser({ email: `checkout-coach-${run}@example.test`, password: "Checkout-coach-123", email_confirm: true });
      expect(coach.error).toBeNull();
      coachId = coach.data.user!.id;
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
      await runFixture({ db, locationId, courtId, courtName, coachName, programName });
    } finally {
      try {
        const intents: { provider_payment_id: string | null }[] = await db.query(`SELECT p.provider_payment_id FROM public.payment_attempts p
          JOIN public.bookings b ON b.id=p.booking_id JOIN public.court_reservations r ON r.id=b.reservation_id WHERE r.court_id=$1`, [courtId]);
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
        await db.query("UPDATE public.payment_provider_settings SET active_provider=$1", [previousProvider]);
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
  const [booking] = await db.query(`SELECT b.status,v.payment_method,v.total_amount_minor AS total,r.status AS occupancy,r.starts_at_minute AS start,
      r.ends_at_minute AS "end",r.coach_user_id IS NOT NULL AS coached
    FROM public.bookings b JOIN public.booking_revisions v ON v.id=b.current_revision_id JOIN public.court_reservations r ON r.id=b.reservation_id
    WHERE v.customer_email=$1`, [email]);
  const attempts = await db.query(`SELECT p.status,p.amount_minor,c.amount_minor AS captured FROM public.payment_attempts p
    JOIN public.bookings b ON b.id=p.booking_id JOIN public.booking_revisions v ON v.id=b.current_revision_id
    LEFT JOIN public.payment_capture_receipts c ON c.payment_attempt_id=p.id WHERE v.customer_email=$1`, [email]);
  return { booking, attempts };
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
