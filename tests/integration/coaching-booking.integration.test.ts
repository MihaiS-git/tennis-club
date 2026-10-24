import { getAdminBookingRecords, listAdminBookingCoachFilterOptions, listAdminBookings } from "@/lib/bookings/admin-details";
import { parseAdminBookingQuery } from "@/lib/bookings/admin-query";
import { ensureIntegrationAdminAnchor } from "./admin-anchor";
import { parseActivityQuery } from "@/lib/bookings/activity-query";
import { inTransaction } from "@/lib/db/transaction";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { cleanupBookingEvidence, insertBookingRecords, setAdjustmentExpiryFixture, setPaymentAttemptExpiryFixture } from "../local/booking-fixtures";
import Stripe from "stripe";
import { commitCoachingCheckout } from "@/lib/coaching/checkout";
import { readOnlineCheckout, resolveAuthorizedCheckoutPayment, startOnlineCheckout } from "@/lib/payments/checkout";
import { processOnlinePaymentEvent, settleOnlinePayment } from "@/lib/payments/service";
import { POST } from "@/app/api/payments/stripe/webhook/route";
import { readCustomerBookingEditContext } from "@/lib/bookings/commands";
import { runBookingReschedule } from "@/lib/bookings/reschedule";
import { processBookingRefund } from "@/lib/payments/refunds";
import { expireAdjustmentsAtLocation } from "@/lib/payments/hold-expiry";
import { lockLocations } from "@/lib/db/repositories/clubs.repository";
import { adjustmentAttempt } from "@/lib/db/repositories/booking-adjustments.repository";
import { cancelOwnCustomerBooking } from "@/lib/bookings/self-cancellation-service";
import { listOwnCourtActivity, listOwnUpcomingActivity } from "@/lib/bookings/activity-service";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import type { DataSource } from "typeorm";
import { afterAll, assert, beforeAll, expect, test, vi } from "vitest";
import { createCustomerBooking } from "@/lib/bookings/service";
import { deleteCoachProfile } from "@/lib/coaching/admin";
import { createCoachingBooking } from "@/lib/coaching/booking";
import { createDataSource, getDataSource } from "@/lib/db/data-source";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { settled } from "./concurrency";

// Same Stripe SDK boundary as stripe-payment.integration.test.ts. No provider network calls.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/reservations/revalidation", () => ({ revalidateCourtActivity: vi.fn() }));
const stripeFixture = vi.hoisted(() => ({
  intents: new Map<string, { id: string; status: string; amount: number; amount_received: number;
    amount_capturable: number; currency: string; metadata: { payment_attempt_id: string } }>(),
  create: vi.fn(), retrieve: vi.fn(), capture: vi.fn(), cancel: vi.fn(),
  refundCreate: vi.fn(), refundList: vi.fn<() => { id: string; status: string; amount: number; currency: string; payment_intent: string; metadata: object }[]>(() => []), refundRetrieve: vi.fn(),
}));
vi.mock("@/lib/payments/providers/stripe/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/providers/stripe/client")>("@/lib/payments/providers/stripe/client");
  return { ...actual, stripeClient: () => ({
    paymentIntents: { create: stripeFixture.create, retrieve: stripeFixture.retrieve,
      capture: stripeFixture.capture, cancel: stripeFixture.cancel },
    refunds: { create: stripeFixture.refundCreate, list: stripeFixture.refundList, retrieve: stripeFixture.refundRetrieve },
    webhooks: new Stripe("sk_test_Fixture").webhooks,
  }) };
});

// Makes the last write of the creation transaction fail on demand.
const fault = vi.hoisted(() => ({ attempt: false }));
vi.mock("@/lib/db/repositories/payments.repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/repositories/payments.repository")>();
  return { ...original, insertCheckoutAttempt: async (...args: Parameters<typeof original.insertCheckoutAttempt>) => {
    if (fault.attempt) throw new Error("Injected payment attempt failure");
    return original.insertCheckoutAttempt(...args);
  } };
});

// Fixes the reservation clock on demand, so notice and start boundaries are tested
// against far-future lessons; every other read uses the database clock.
const clock = vi.hoisted(() => ({ now: null as string | null }));
vi.mock("@/lib/db/repositories/reservations.repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/repositories/reservations.repository")>();
  return { ...original, readReservationClockTime: async (...args: Parameters<typeof original.readReservationClockTime>) =>
    clock.now ?? original.readReservationClockTime(...args) };
});

// Two public UTC locations. A: courts A1 (5000/h), A2 (7000/h), A3 (6000/h).
// B: court B1 (4000/h). The coach teaches at A 08:00–16:00 and at B 16:00–20:00;
// a second coach teaches at A 08:00–15:00.
const service = localFixtureClient();
const reader = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const guest = reader(), member = reader();
let database: DataSource;
let previousProvider: string | null = null;
let providerCaptured = false;
let previousEmailSettings: { official_email: string; sender_name: string; emails_enabled: boolean } | undefined;
const userIds: string[] = [];
const removalCoachIds: string[] = [];
const [locationA, locationB] = [randomUUID(), randomUUID()];
const [courtA1, courtA2, courtA3, courtB1] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const [program, includedProgram, inactiveProgram, groupProgram] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const [semiProgram, semiIncludedProgram, unpricedProgram, juniorProgram] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
// Owned by the duration-removal test, whose Admin save destructively replaces its durations and prices.
const durationRemovalProgram = randomUUID();
const courts = [courtA1, courtA2, courtA3, courtB1];
let memberEmail: string;
let coach: string, coach2: string, hiddenCoach: string, formerCoach: string, memberId: string;
const date = "2099-11-02";
const weekday = mondayWeekday(date);

async function account(roles: "coach"[] = []) {
  const email = `coaching-booking-${randomUUID()}@example.test`, password = "coaching-booking-password-123";
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.strictEqual(error, null); assert.ok(data.user);
  userIds.push(data.user.id);
  for (const role of roles) assert.strictEqual((await service.from("user_roles").insert({ user_id: data.user.id, role_code: role })).error, null);
  return { id: data.user.id, email, password };
}

const base = () => ({ locationId: locationA, programId: program, coachId: coach, courtId: courtA3, date, startMinute: 900,
  durationMinutes: 60, participantCount: 1, customerName: "  Lesson Guest  ", customerEmail: " guest@example.test ", customerPhone: " +40 123 ",
  // The coach's own 60-minute rate (12000) plus A3's rental (6000).
  expectedTotalAmountMinor: 18000, expectedCurrency: "RON" });
const book = (overrides: Record<string, unknown> = {}, client = guest) => createCoachingBooking({ ...base(), ...overrides }, client);

async function written() {
  const [row] = await database.query(`SELECT
      (SELECT count(*)::int FROM public.court_reservations WHERE court_id=ANY($1::uuid[])) AS reservations,
      (SELECT count(*)::int FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id WHERE r.court_id=ANY($1::uuid[])) AS bookings,
      (SELECT count(*)::int FROM public.booking_revisions v WHERE v.court_id=ANY($1::uuid[])) AS revisions,
      (SELECT count(*)::int FROM public.payment_attempts p JOIN public.bookings b ON b.id=p.booking_id
        JOIN public.court_reservations r ON r.id=b.reservation_id WHERE r.court_id=ANY($1::uuid[])) AS attempts`, [courts]);
  return row as { reservations: number; bookings: number; revisions: number; attempts: number };
}

async function aggregate(bookingId: string) {
  const [row] = await database.query(`SELECT b.status,b.account_user_id,r.id AS reservation_id,r.court_id,r.coach_user_id,
      r.booking_date::text,r.starts_at_minute,r.ends_at_minute,r.status AS reservation_status,r.hold_expires_at,
      to_jsonb(v) AS revision,p.method,p.provider,p.amount_minor,p.currency,p.status AS attempt_status,p.expires_at AS attempt_expires_at
    FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id
    JOIN public.booking_revisions v ON v.id=b.current_revision_id JOIN public.payment_attempts p ON p.booking_id=b.id
    WHERE b.id=$1`, [bookingId]);
  return row;
}

// Every row persisted on the date that occupies a window of the given courts or coaches,
// including any partial aggregate a losing request could have left.
async function windowRows(courtIds: readonly string[], coachIds: readonly string[], startMinute: number, endMinute: number) {
  const [row] = await database.query(`WITH r AS (
      SELECT id FROM public.court_reservations WHERE booking_date=$1 AND starts_at_minute<$5 AND ends_at_minute>$4
        AND (court_id=ANY($2::uuid[]) OR coach_user_id=ANY($3::uuid[]))
    ), b AS (SELECT id FROM public.bookings WHERE reservation_id IN (SELECT id FROM r))
    SELECT ARRAY(SELECT id::text FROM r) AS reservations, ARRAY(SELECT id::text FROM b) AS bookings,
      ARRAY(SELECT v.booking_id::text FROM public.booking_revisions v WHERE v.booking_date=$1
        AND v.starts_at_minute<$5 AND v.ends_at_minute>$4 AND (v.court_id=ANY($2::uuid[]) OR v.coach_user_id=ANY($3::uuid[]))) AS revisions,
      ARRAY(SELECT p.booking_id::text FROM public.payment_attempts p WHERE p.booking_id IN (SELECT id FROM b)) AS attempts`,
  [date, courtIds, coachIds, startMinute, endMinute]);
  return row as { reservations: string[]; bookings: string[]; revisions: string[]; attempts: string[] };
}

// A competing writer on its own connection, outside the small application pool
// that the booking under test and the lock observer share. Sessions a failed or
// timed-out test leaves open are closed before teardown; closing the connection
// rolls back their transaction and releases its locks.
const sessions = new Set<() => Promise<void>>();
async function session() {
  const source = await createDataSource().initialize();
  const runner = source.createQueryRunner();
  await runner.connect();
  const end = async () => { if (!sessions.delete(end)) return; await runner.release(); await source.destroy(); };
  sessions.add(end);
  return { query: (sql: string, parameters?: unknown[]) => runner.query(sql, parameters), end };
}

// Waits until another session is blocked on a lock in a statement matching the pattern.
// Bounded well inside Vitest's 5 s test timeout: a missing wait fails the test and its
// finally ends the competing session, rather than Vitest abandoning it mid-transaction.
async function blockedOn(pattern: string, observer?: Awaited<ReturnType<typeof session>>) {
  for (const deadline = Date.now() + 2000; Date.now() < deadline;) {
    const query = `SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE $1`;
    const [row] = await (observer ? observer.query(query, [pattern]) : database.query(query, [pattern]));
    if (row.waiting > 0) return;
    await sleep(25);
  }
  throw new Error(`No session blocked on ${pattern}`);
}

async function expireHold(reservationId: string) {
  await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [reservationId]);
}

beforeAll(async () => {
  expect(process.env.TEST_SUPABASE_PROJECT).toBe("tennis-club-tests");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_Fixture"); vi.stubEnv("STRIPE_PUBLISHABLE_KEY", "pk_test_Fixture");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_Fixture");
  database = await getDataSource();
  [previousEmailSettings] = await database.query("SELECT official_email,sender_name,emails_enabled FROM public.club_settings WHERE id=true");
  await database.query("UPDATE public.club_settings SET official_email='',sender_name='',emails_enabled=false WHERE id=true");
  coach = (await account(["coach"])).id;
  coach2 = (await account(["coach"])).id;
  hiddenCoach = (await account(["coach"])).id;
  formerCoach = (await account()).id;
  const customer = await account();
  memberId = customer.id;
  memberEmail = customer.email;
  assert.strictEqual((await member.auth.signInWithPassword({ email: customer.email, password: customer.password })).error, null);
  previousProvider = (await database.query("SELECT active_provider FROM public.payment_provider_settings WHERE id=true"))[0].active_provider;
  providerCaptured = true;
  await database.query("UPDATE public.payment_provider_settings SET active_provider='stripe' WHERE id=true");

  await database.query(`INSERT INTO public.locations(id,name,slug,timezone,currency,is_active,is_public,customer_cancellation_notice_minutes) VALUES
    ($1,'Coaching booking A',($1::uuid)::text,'UTC','RON',true,true,120),($2,'Coaching booking B',($2::uuid)::text,'UTC','RON',true,true,60)`,
  [locationA, locationB]);
  await database.query(`INSERT INTO public.courts(id,location_id,name,slug,surface,environment,is_active) VALUES
    ($1,$5,'A1','a1','clay','outdoor',true),($2,$5,'A2','a2','clay','outdoor',true),($3,$5,'A3','a3','clay','outdoor',true),
    ($4,$6,'B1','b1','clay','outdoor',true)`, [courtA1, courtA2, courtA3, courtB1, locationA, locationB]);
  for (const location of [locationA, locationB]) {
    const [schedule] = await database.query(`INSERT INTO public.opening_hours_schedules(location_id,starts_on) VALUES($1,'2000-01-01') RETURNING id`, [location]);
    await database.query(`INSERT INTO public.location_opening_hours(location_id,schedule_id,weekday,opens_at_minute,closes_at_minute)
      SELECT $1,$2,weekday,0,1440 FROM generate_series(0,6) AS weekday`, [location, schedule.id]);
    const [ruleSet] = await database.query("INSERT INTO public.pricing_rule_sets(location_id) VALUES($1) RETURNING id", [location]);
    await database.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
      SELECT $1,$2,court.id,'outdoor',weekday,0,1440,court.rate FROM generate_series(0,6) AS weekday,
        (VALUES($3::uuid,5000),($4::uuid,7000),($5::uuid,6000),($6::uuid,4000)) AS court(id,rate)
      JOIN public.courts c ON c.id=court.id AND c.location_id=$1`, [location, ruleSet.id, courtA1, courtA2, courtA3, courtB1]);
  }

  await database.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,min_participants,max_participants,court_rental_included,is_active) VALUES
    ($1,'Booking private','','private',1,1,false,true),($2,'Booking private included','','private',1,1,true,true),
    ($3,'Booking retired','','private',1,1,false,false),($4,'Booking unpriced','','private',1,1,true,true)`,
  [program, includedProgram, inactiveProgram, unpricedProgram]);
  await database.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,min_participants,max_participants,court_rental_included,is_active)
    VALUES($1,'Booking group','','group',3,6,false,true),($2,'Booking junior','','junior',4,8,true,true)`, [groupProgram, juniorProgram]);
  await database.query(`INSERT INTO public.coaching_program_durations(program_id,duration_minutes)
    VALUES($1,60),($1,90),($2,60),($2,90),($2,120),($3,60),($4,60),($5,60),($6,60)`, [program, includedProgram, inactiveProgram, groupProgram, unpricedProgram, juniorProgram]);
  await database.query(`INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages,is_public) VALUES
    ($1,'Booking Coach','','','{}','{}',true),($2,'Second Coach','','','{}','{}',true),
    ($3,'Hidden Coach','','','{}','{}',false),($4,'Former Coach','','','{}','{}',true)`, [coach, coach2, hiddenCoach, formerCoach]);
  await database.query(`INSERT INTO public.coach_locations(coach_user_id,location_id) VALUES
    ($1,$5),($1,$6),($2,$5),($3,$5),($4,$5)`, [coach, coach2, hiddenCoach, formerCoach, locationA, locationB]);
  await database.query(`INSERT INTO public.coach_programs(coach_user_id,program_id)
    SELECT $1,p FROM unnest($5::uuid[]) p UNION ALL SELECT c,$6 FROM unnest(ARRAY[$2,$3,$4]::uuid[]) c`,
  [coach, coach2, hiddenCoach, formerCoach, [program, includedProgram, inactiveProgram, groupProgram, unpricedProgram, juniorProgram], program]);
  // Club-wide prices apply at every location charging in RON.
  await database.query(`INSERT INTO public.coaching_prices(program_id,duration_minutes,coach_user_id,amount_minor,currency) VALUES
    ($1,60,NULL,10000,'RON'),($1,90,NULL,14000,'RON'),($1,60,$5,12000,'RON'),($2,60,NULL,15000,'RON'),($2,90,NULL,22500,'RON'),($2,120,NULL,30000,'RON'),
    ($3,60,NULL,9000,'RON'),($4,60,NULL,8000,'RON'),($6,60,NULL,7000,'RON')`,
  [program, includedProgram, inactiveProgram, groupProgram, coach, juniorProgram]);
  await database.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,min_participants,max_participants,court_rental_included)
    VALUES($1,'Semi-private coaching','','semi_private',2,2,false),($2,'Semi-private included','','semi_private',2,2,true)`, [semiProgram, semiIncludedProgram]);
  await database.query(`INSERT INTO public.coaching_program_durations(program_id,duration_minutes)
    VALUES($1,60),($1,90),($2,60)`, [semiProgram, semiIncludedProgram]);
  await database.query(`INSERT INTO public.coach_programs(coach_user_id,program_id)
    SELECT c,p FROM unnest($1::uuid[]) c CROSS JOIN unnest($2::uuid[]) p`, [[coach, coach2], [semiProgram, semiIncludedProgram]]);
  await database.query(`INSERT INTO public.coaching_prices(program_id,duration_minutes,coach_user_id,amount_minor,currency) VALUES
    ($1,60,NULL,10000,'RON'),($1,60,$3,12000,'RON'),($1,90,NULL,14000,'RON'),($2,60,NULL,15000,'RON')`,
    [semiProgram, semiIncludedProgram, coach]);
  await database.query(`INSERT INTO public.coach_weekly_availability(coach_user_id,location_id,weekday,start_minute,end_minute,valid_from) VALUES
    ($1,$5,$6,480,960,'2000-01-01'),($1,$7,$6,960,1200,'2000-01-01'),($2,$5,$6,480,900,'2000-01-01'),($3,$5,$6,480,900,'2000-01-01'),($4,$5,$6,480,900,'2000-01-01')`,
  [coach, coach2, hiddenCoach, formerCoach, locationA, weekday, locationB]);
});

// One transaction: a failed teardown leaves every fixture row or none. Work from a
// failed test may still briefly hold a lock or commit a late row, so a fresh attempt
// (which reselects bookings by court) is retried a bounded number of times.
async function removeFixtures() {
  const locations = [locationA, locationB], coaches = [...userIds, ...removalCoachIds];
  for (let attempt = 1; ; attempt++) {
    try {
      return await inTransaction(async manager => {
        await manager.query("SET LOCAL lock_timeout = '2s'");
        await manager.query(`DELETE FROM public.email_deliveries d USING public.booking_revisions v
          WHERE v.court_id=ANY($1::uuid[]) AND d.event_key IN
            ('booking.confirmed:' || v.id, 'booking.rescheduled:' || v.id, 'booking.cancelled:' || v.id)`, [courts]);
        await cleanupBookingEvidence(manager, { courtIds: courts });
        await manager.query("DELETE FROM public.court_reservations WHERE court_id=ANY($1::uuid[])", [courts]);
        await manager.query("DELETE FROM public.coach_availability_exceptions WHERE coach_user_id=ANY($1::uuid[])", [coaches]);
        await manager.query("DELETE FROM public.coach_weekly_availability WHERE coach_user_id=ANY($1::uuid[])", [coaches]);
        await manager.query("DELETE FROM public.coaching_prices WHERE program_id=ANY($1::uuid[])", [[program, includedProgram, inactiveProgram, groupProgram, juniorProgram, semiProgram, semiIncludedProgram, unpricedProgram, durationRemovalProgram]]);
        await manager.query("DELETE FROM public.coach_programs WHERE coach_user_id=ANY($1::uuid[])", [coaches]);
        await manager.query("DELETE FROM public.coach_locations WHERE coach_user_id=ANY($1::uuid[])", [coaches]);
        await manager.query("DELETE FROM public.coach_profiles WHERE user_id=ANY($1::uuid[])", [coaches]);
        await manager.query("DELETE FROM public.coaching_programs WHERE id=ANY($1::uuid[])", [[program, includedProgram, inactiveProgram, groupProgram, juniorProgram, semiProgram, semiIncludedProgram, unpricedProgram, durationRemovalProgram]]);
        await manager.query("DELETE FROM public.location_pricing_rules WHERE location_id=ANY($1::uuid[])", [locations]);
        await manager.query("DELETE FROM public.pricing_rule_sets WHERE location_id=ANY($1::uuid[])", [locations]);
        await manager.query("DELETE FROM public.location_opening_hours WHERE location_id=ANY($1::uuid[])", [locations]);
        await manager.query("DELETE FROM public.opening_hours_schedules WHERE location_id=ANY($1::uuid[])", [locations]);
        await manager.query("DELETE FROM public.courts WHERE location_id=ANY($1::uuid[])", [locations]);
        await manager.query("DELETE FROM public.locations WHERE id=ANY($1::uuid[])", [locations]);
      });
    } catch (error) {
      // Lock timeout, deadlock, or a late row referencing a fixture; anything else is reported at once.
      if (attempt === 3 || !["55P03", "40P01", "23503"].includes(normalizeDatabaseError(error).sqlState ?? "")) throw error;
      await sleep(250);
    }
  }
}

afterAll(async () => {
  if (!database) return;
  try {
    await settled([...sessions].map(end => end()));
    if (providerCaptured) await database.query("UPDATE public.payment_provider_settings SET active_provider=$1 WHERE id=true", [previousProvider]);
    if (previousEmailSettings) await database.query("UPDATE public.club_settings SET official_email=$1,sender_name=$2,emails_enabled=$3 WHERE id=true",
      [previousEmailSettings.official_email, previousEmailSettings.sender_name, previousEmailSettings.emails_enabled]);
    await removeFixtures();
    await cleanupAuthFixtures(service, userIds);
  } finally {
    vi.unstubAllEnvs();
    await database.destroy();
  }
}, 30000);

test("rejects invalid, ineligible, unavailable and stale requests without writing anything", async () => {
  const before = await written();
  const reasons = async (cases: Record<string, unknown>[]) => {
    const results = [];
    for (const overrides of cases) {
      const result = await book(overrides);
      results.push(result.ok ? "ok" : result.reason);
    }
    return results;
  };
  // Invalid input and time, including a browser-supplied account identity.
  expect(await reasons([{ customerEmail: "not-an-email" }, { customerPhone: "call me" }, { customerName: " " },
    { accountUserId: memberId }, { startMinute: 915 }, { durationMinutes: 45 }, { startMinute: 1410 }, { date: "2099-02-30" },
    { participantCount: 0 }, { participantCount: 101 }, { participantCount: 2.5 }, { participantCount: undefined },
  ])).toEqual(Array(12).fill("invalid-input"));
  expect(await reasons([{ date: "2000-01-03" }])).toEqual(["past"]);
  // Ineligible coaches, unassigned locations, inactive programs, unsupported durations.
  expect(await reasons([{ coachId: hiddenCoach }, { coachId: formerCoach }, { coachId: randomUUID() },
    { locationId: locationB, courtId: courtB1, coachId: coach2 }, { programId: inactiveProgram }, { programId: groupProgram, coachId: coach2, participantCount: 4 },
  ])).toEqual(Array(6).fill("not-offered"));
  // Group and Junior programs are never booked online, at any participant count, even with a stored price.
  expect(await reasons([{ programId: groupProgram, participantCount: 5, expectedTotalAmountMinor: 14000 }, { programId: groupProgram, participantCount: 2 },
    { programId: juniorProgram, participantCount: 8, expectedTotalAmountMinor: 7000 }, { programId: juniorProgram, participantCount: 9 },
  ])).toEqual(Array(4).fill("not-offered"));
  // Counts outside the program's configured range.
  expect(await reasons([{ programId: semiProgram, participantCount: 3 }, { programId: semiProgram, participantCount: 1 }, { programId: semiProgram },
  ])).toEqual(Array(3).fill("invalid-participants"));
  expect(await reasons([{ durationMinutes: 120 }])).toEqual(["invalid-duration"]);
  // A court of another location is not this lesson's court.
  expect(await reasons([{ courtId: courtB1 }])).toEqual(["court-unavailable"]);
  // Outside the coach's working hours.
  expect(await reasons([{ startMinute: 420 }])).toEqual(["coach-unavailable"]);

  // Stale prices and currency: the authoritative current quote is returned instead.
  try {
    await database.query("UPDATE public.coaching_prices SET amount_minor=12500 WHERE program_id=$1 AND coach_user_id=$2", [program, coach]);
    expect(await book()).toEqual({ ok: false, reason: "price_changed", totalAmountMinor: 18500, currency: "RON" });
    await database.query("UPDATE public.coaching_prices SET amount_minor=12000 WHERE program_id=$1 AND coach_user_id=$2", [program, coach]);
    await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=6500 WHERE court_id=$1", [courtA3]);
    expect(await book()).toEqual({ ok: false, reason: "price_changed", totalAmountMinor: 18500, currency: "RON" });
  } finally {
    await database.query("UPDATE public.coaching_prices SET amount_minor=12000 WHERE program_id=$1 AND coach_user_id=$2", [program, coach]);
    await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=6000 WHERE court_id=$1", [courtA3]);
  }
  expect(await book({ expectedCurrency: "EUR" })).toEqual({ ok: false, reason: "price_changed", totalAmountMinor: 18000, currency: "RON" });

  // An occupied court, even while the coach is free.
  const occupied = randomUUID();
  try {
    await database.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,created_by_user_id)
      VALUES($1,$2,$3,900,960,'active',$4)`, [occupied, courtA1, date, memberId]);
    expect(await book({ courtId: courtA1, expectedTotalAmountMinor: 17000 })).toMatchObject({ ok: false, reason: "court-unavailable", availabilityChanged: true });
  } finally {
    await database.query("DELETE FROM public.court_reservations WHERE id=$1", [occupied]);
  }
  expect(await written()).toEqual(before);
});

test("a failure after the reservation insert rolls back every write", async () => {
  // Its own Monday: the booking it commits never occupies the slot the rejection cases quote.
  const own = { date: "2099-11-09" };
  const before = await written();
  fault.attempt = true;
  try { expect(await book(own)).toMatchObject({ ok: false, reason: "failed" }); } finally { fault.attempt = false; }
  expect(await written()).toEqual(before);
  // Nothing orphaned blocks the same court and coach afterwards.
  expect(await book(own)).toMatchObject({ ok: true });
});

test("a guest creates one pending booking, revision, held court-and-coach reservation and pending attempt", async () => {
  const result = await book({ courtId: courtA1, startMinute: 480, expectedTotalAmountMinor: 17000 });
  assert.ok(result.ok);
  expect(result).toMatchObject({ status: "pending_payment", totalAmountMinor: 17000, currency: "RON" });
  const row = await aggregate(result.bookingId);
  expect(row).toMatchObject({ status: "pending_payment", account_user_id: null, reservation_id: result.reservationId,
    court_id: courtA1, coach_user_id: coach, booking_date: date, starts_at_minute: 480, ends_at_minute: 540,
    reservation_status: "held", method: "online", provider: "stripe", amount_minor: 17000, currency: "RON", attempt_status: "pending" });
  // One hold deadline shared by the reservation and the attempt.
  expect(row.hold_expires_at.getTime()).toBe(row.attempt_expires_at.getTime());
  expect(new Date(result.holdExpiresAt).getTime()).toBe(row.hold_expires_at.getTime());
  expect(row.revision).toMatchObject({ revision_number: 1, kind: "created", booking_state: "pending_payment", actor_scope: "guest",
    actor_user_id: null, location_id: locationA, court_id: courtA1, location_name: "Coaching booking A", court_name: "A1",
    timezone: "UTC", booking_date: date, starts_at_minute: 480, ends_at_minute: 540, customer_name: "Lesson Guest",
    customer_email: "guest@example.test", customer_phone: "+40 123", total_amount_minor: 17000, currency: "RON",
    payment_method: "online", cancellation_notice_minutes: 120, coach_user_id: coach, coaching_program_id: program,
    coach_name: "Booking Coach", coaching_program_name: "Booking private" });
  expect(row.revision.pricing_evidence).toMatchObject({ version: 1, courtState: "outdoor",
    slots: [{ minute: 480, hourlyMinor: 5000 }, { minute: 510, hourlyMinor: 5000 }],
    coaching: { programId: program, coachUserId: coach, locationId: locationA, durationMinutes: 60, source: "coach",
      amountMinor: 12000, currency: "RON", courtRentalIncluded: false, courtRentalMinor: 5000, courtAmountMinor: 5000 } });

  // Admin price changes never alter the agreed amount of a pending booking.
  try {
    await database.query("UPDATE public.coaching_prices SET amount_minor=99000 WHERE program_id=$1 AND coach_user_id=$2", [program, coach]);
    expect((await aggregate(result.bookingId)).revision.total_amount_minor).toBe(17000);
  } finally {
    await database.query("UPDATE public.coaching_prices SET amount_minor=12000 WHERE program_id=$1 AND coach_user_id=$2", [program, coach]);
  }
});

test("an authenticated customer books with the session account, never the contact email", async () => {
  const result = await book({ courtId: courtA2, startMinute: 540, durationMinutes: 90, customerEmail: "someone-else@example.test",
    // The club's 90-minute price (no override) plus 1.5 hours of A2.
    expectedTotalAmountMinor: 24500 }, member);
  assert.ok(result.ok);
  const row = await aggregate(result.bookingId);
  expect(row).toMatchObject({ account_user_id: memberId, coach_user_id: coach, starts_at_minute: 540, ends_at_minute: 630 });
  expect(row.revision).toMatchObject({ actor_scope: "customer", actor_user_id: memberId, customer_email: "someone-else@example.test",
    total_amount_minor: 24500 });
  expect(row.revision.pricing_evidence.coaching).toMatchObject({ source: "club", amountMinor: 14000, courtRentalMinor: 10500, courtAmountMinor: 10500 });
});

test("an included court rental charges only the coaching price yet still holds the court", async () => {
  const result = await book({ programId: includedProgram, courtId: courtA1, startMinute: 630, expectedTotalAmountMinor: 15000 });
  assert.ok(result.ok);
  const row = await aggregate(result.bookingId);
  expect(row).toMatchObject({ court_id: courtA1, coach_user_id: coach, reservation_status: "held", amount_minor: 15000 });
  expect(row.revision.pricing_evidence.coaching).toMatchObject({ courtRentalIncluded: true, courtRentalMinor: 5000, courtAmountMinor: 0, amountMinor: 15000 });
});

test("two customers racing for one court and time: exactly one complete aggregate persists", async () => {
  const slot = [[courtA3], [coach, coach2], 720, 780] as const;
  expect(await windowRows(...slot)).toEqual({ reservations: [], bookings: [], revisions: [], attempts: [] });
  const requests = [{ coachId: coach, accountUserId: null, total: 18000 }, { coachId: coach2, accountUserId: memberId, total: 16000 }];
  const results = await settled([
    book({ courtId: courtA3, startMinute: 720 }),
    book({ courtId: courtA3, startMinute: 720, coachId: coach2, expectedTotalAmountMinor: 16000 }, member),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toMatchObject({ reason: "court-unavailable", availabilityChanged: true });
  const index = results.findIndex((result) => result.ok), winner = results[index];
  assert.ok(winner.ok);
  // Only the winner's booking, revision, reservation and attempt occupy the court and either coach.
  expect(await windowRows(...slot)).toEqual({ reservations: [winner.reservationId], bookings: [winner.bookingId],
    revisions: [winner.bookingId], attempts: [winner.bookingId] });
  const row = await aggregate(winner.bookingId);
  expect(row).toMatchObject({ status: "pending_payment", account_user_id: requests[index].accountUserId,
    reservation_id: winner.reservationId, court_id: courtA3, coach_user_id: requests[index].coachId,
    starts_at_minute: 720, ends_at_minute: 780, reservation_status: "held", amount_minor: requests[index].total, attempt_status: "pending" });
  expect(row.revision).toMatchObject({ revision_number: 1, booking_state: "pending_payment", court_id: courtA3,
    coach_user_id: requests[index].coachId, total_amount_minor: requests[index].total });
});

test("one coach racing on two courts at the same time: exactly one complete aggregate persists", async () => {
  const slot = [[courtA1, courtA2], [coach], 780, 840] as const;
  expect(await windowRows(...slot)).toEqual({ reservations: [], bookings: [], revisions: [], attempts: [] });
  const requests = [{ courtId: courtA1, accountUserId: null, total: 17000 }, { courtId: courtA2, accountUserId: memberId, total: 19000 }];
  const results = await settled([
    book({ courtId: courtA1, startMinute: 780, expectedTotalAmountMinor: 17000 }),
    book({ courtId: courtA2, startMinute: 780, expectedTotalAmountMinor: 19000 }, member),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toMatchObject({ reason: "coach-booked", availabilityChanged: true });
  const index = results.findIndex((result) => result.ok), winner = results[index];
  assert.ok(winner.ok);
  // Only the winner's aggregate occupies the coach, and the losing court stays free.
  expect(await windowRows(...slot)).toEqual({ reservations: [winner.reservationId], bookings: [winner.bookingId],
    revisions: [winner.bookingId], attempts: [winner.bookingId] });
  const row = await aggregate(winner.bookingId);
  expect(row).toMatchObject({ status: "pending_payment", account_user_id: requests[index].accountUserId,
    reservation_id: winner.reservationId, court_id: requests[index].courtId, coach_user_id: coach,
    starts_at_minute: 780, ends_at_minute: 840, reservation_status: "held", amount_minor: requests[index].total, attempt_status: "pending" });
  expect(row.revision).toMatchObject({ revision_number: 1, booking_state: "pending_payment", court_id: requests[index].courtId,
    coach_user_id: coach, total_amount_minor: requests[index].total });
});

test("an expired coach hold on another court is released by the existing expiry before the new hold", async () => {
  const stale = await book({ courtId: courtA2, startMinute: 840, expectedTotalAmountMinor: 19000 });
  assert.ok(stale.ok);
  await expireHold(stale.reservationId);
  const result = await book({ courtId: courtA1, startMinute: 840, expectedTotalAmountMinor: 17000 });
  assert.ok(result.ok);
  expect(await aggregate(stale.bookingId)).toMatchObject({ status: "expired", reservation_status: "released", attempt_status: "expired", hold_expires_at: null });
});

test("coach conflicts across locations: live holds block, expired holds are released, the exclusion arbitrates", async () => {
  // Holds at B while the coach still works there.
  // The coach's own price is not location-specific, so it applies at B as well.
  const live = await book({ locationId: locationB, courtId: courtB1, startMinute: 960, expectedTotalAmountMinor: 16000 });
  const stale = await book({ locationId: locationB, courtId: courtB1, startMinute: 1080, expectedTotalAmountMinor: 16000 });
  assert.ok(live.ok); assert.ok(stale.ok);
  await expireHold(stale.reservationId);
  // The coach then moves those hours to A, for this test only.
  const [exception] = await database.query(`INSERT INTO public.coach_availability_exceptions(coach_user_id,exception_date,until_date,kind,location_id,start_minute,end_minute,note)
    VALUES($1,$2,$2,'available',$3,960,1140,'') RETURNING id`, [coach, date, locationA]);
  let other: Awaited<ReturnType<typeof session>> | undefined;
  let racing: ReturnType<typeof book> | undefined;
  try {
    const at = (startMinute: number) => ({ courtId: courtA1, startMinute, expectedTotalAmountMinor: 17000 });

    expect(await book(at(960))).toMatchObject({ ok: false, reason: "coach-booked" });
    const released = await book(at(1080));
    assert.ok(released.ok);
    expect(await aggregate(stale.bookingId)).toMatchObject({ status: "expired", reservation_status: "released", attempt_status: "expired" });

    // A concurrent, not yet committed coach hold at B: the quote cannot see it,
    // so the coach exclusion decides when it commits.
    other = await session();
    await other.query("BEGIN");
    await other.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at,coach_user_id)
      VALUES($1,$2,$3,1020,1080,'held',clock_timestamp()+interval '10 minutes',$4)`, [randomUUID(), courtB1, date, coach]);
    racing = book(at(1020));
    await blockedOn("%INSERT INTO public.court_reservations%");
    await other.query("COMMIT");
    expect(await racing).toMatchObject({ ok: false, reason: "coach-booked", availabilityChanged: true });
  } finally {
    // Ending the session rolls back an uncommitted hold and releases the blocked request.
    await other?.end();
    await Promise.allSettled([racing]);
    await database.query("DELETE FROM public.coach_availability_exceptions WHERE id=$1", [exception.id]);
  }
});

test("a concurrent coach availability change serializes with booking creation", async () => {
  // Availability writes lock the coach profile FOR UPDATE; creation waits for it
  // and requotes from the committed schedule.
  const [{ schedule }] = await database.query(`SELECT coalesce(jsonb_agg(to_jsonb(a)), '[]') AS schedule
    FROM public.coach_weekly_availability a WHERE coach_user_id=$1`, [coach2]);
  const other = await session();
  let racing: ReturnType<typeof book> | undefined;
  try {
    await other.query("BEGIN");
    await other.query("SELECT user_id FROM public.coach_profiles WHERE user_id=$1 FOR UPDATE", [coach2]);
    await other.query("DELETE FROM public.coach_weekly_availability WHERE coach_user_id=$1", [coach2]);
    racing = book({ coachId: coach2, courtId: courtA2, startMinute: 480, expectedTotalAmountMinor: 17000 });
    await blockedOn("%coach_profiles%");
    await other.query("COMMIT");
    expect(await racing).toMatchObject({ ok: false, reason: "coach-unavailable" });
  } finally {
    await other.end();
    await Promise.allSettled([racing]);
    // The exact committed schedule, whether or not the competing delete committed.
    await inTransaction(async manager => {
      await manager.query("DELETE FROM public.coach_weekly_availability WHERE coach_user_id=$1", [coach2]);
      await manager.query(`INSERT INTO public.coach_weekly_availability
        SELECT * FROM jsonb_populate_recordset(NULL::public.coach_weekly_availability, $1::jsonb)`, [JSON.stringify(schedule)]);
    });
  }
  expect(await book({ coachId: coach2, courtId: courtA2, startMinute: 480, expectedTotalAmountMinor: 17000 })).toMatchObject({ ok: true });
});

test("ordinary court bookings keep their behaviour and stay coachless", async () => {
  const result = await createCustomerBooking({ paymentMethod: "online", courtId: courtA3, date, startMinute: 1020, endMinute: 1080,
    customerName: "Court Guest", customerEmail: "court@example.test", customerPhone: "+40 555",
    expectedTotalAmountMinor: 6000, expectedCurrency: "RON" }, guest);
  assert.ok(result.ok);
  const row = await aggregate(result.bookingId);
  expect(row).toMatchObject({ status: "pending_payment", coach_user_id: null, reservation_status: "held", amount_minor: 6000 });
  expect(row.revision).toMatchObject({ coach_user_id: null, coaching_program_id: null, coach_name: null, coaching_program_name: null });
  expect(row.revision.pricing_evidence).not.toHaveProperty("coaching");
});


function setupStripe() {
  stripeFixture.intents.clear();
  for (const mock of [stripeFixture.create, stripeFixture.retrieve, stripeFixture.capture, stripeFixture.cancel, stripeFixture.refundCreate]) mock.mockReset();
  stripeFixture.refundList.mockReturnValue([]);
  stripeFixture.create.mockImplementation(async (input: { amount: number; currency: string; metadata: { payment_attempt_id: string } }) => {
    const id = `pi_${input.metadata.payment_attempt_id}`;
    const intent = { id, status: "requires_payment_method", amount: input.amount, currency: input.currency,
      amount_received: 0, amount_capturable: 0, metadata: input.metadata };
    stripeFixture.intents.set(id, intent);
    return { ...intent, client_secret: `${id}_secret` };
  });
  stripeFixture.retrieve.mockImplementation(async (id: string) => {
    const intent = stripeFixture.intents.get(id);
    if (!intent) throw new Error("Unknown fixture intent");
    return { ...intent };
  });
  stripeFixture.capture.mockImplementation(async (id: string) => {
    const intent = stripeFixture.intents.get(id)!;
    intent.status = "succeeded"; intent.amount_received = intent.amount; intent.amount_capturable = 0;
    return { ...intent };
  });
  stripeFixture.cancel.mockImplementation(async (id: string) => {
    const intent = stripeFixture.intents.get(id)!;
    intent.status = "canceled";
    return { ...intent };
  });
  stripeFixture.refundCreate.mockImplementation(async (input: { amount: number; payment_intent: string; metadata: object }) => ({
    id: `re_${randomUUID()}`, status: "succeeded", amount: input.amount,
    currency: stripeFixture.intents.get(input.payment_intent)!.currency,
    payment_intent: input.payment_intent, metadata: input.metadata,
  }));
}

async function checkoutLesson(startMinute: number, client = guest, overrides: Record<string, unknown> = {}) {
  const result = await commitCoachingCheckout({ ...base(), date: "2099-12-07", startMinute, ...overrides }, client);
  assert.ok(result.ok, JSON.stringify(result));
  return { ...result, checkout: access(result.checkout) };
}
function access(checkout: { attemptId: string; token: string }) { return { attemptId: checkout.attemptId, token: checkout.token }; }
function remote(attemptId: string) { return stripeFixture.intents.get(`pi_${attemptId}`)!; }
function coachingWebhook(attemptId: string, type: string, eventId = `evt_${randomUUID()}`) {
  const payload = JSON.stringify({ id: eventId, type, data: { object: remote(attemptId) } });
  return new Request("http://localhost/api/payments/stripe/webhook", { method: "POST", body: payload,
    headers: { "stripe-signature": new Stripe("sk_test_Fixture").webhooks.generateTestHeaderString({ payload, secret: "whsec_Fixture" }) } });
}

// Payment tests use another occurrence of the same weekly schedule, with no creation-test holds.
test("coaching Stripe checkout captures the agreed contract once despite price and weekly schedule edits", async () => {
  setupStripe();
  const lesson = await checkoutLesson(480, member);
  const original = await aggregate(lesson.bookingId);
  expect(original).toMatchObject({ account_user_id: memberId, amount_minor: 18000, currency: "RON" });
  expect(stripeFixture.create).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 18000, currency: "ron", capture_method: "manual" }),
    { idempotencyKey: `court-payment-${lesson.paymentAttemptId}` });
  expect((await aggregate(lesson.bookingId)).status).toBe("pending_payment");
  try {
    await database.query("UPDATE public.coaching_prices SET amount_minor=22000 WHERE program_id=$1 AND coach_user_id=$2", [program, coach]);
    await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=9000 WHERE court_id=$1 AND weekday=$2", [courtA3, weekday]);
    await database.query("UPDATE public.coach_weekly_availability SET start_minute=540 WHERE coach_user_id=$1 AND location_id=$2", [coach, locationA]);
    const intent = remote(lesson.paymentAttemptId);
    intent.status = "requires_capture"; intent.amount_capturable = 18000;
    // Signed authorization and polling race through the same acceptance lock.
    await settled([
      POST(coachingWebhook(lesson.paymentAttemptId, "payment_intent.amount_capturable_updated")),
      readOnlineCheckout(lesson.checkout),
    ]);
    expect(stripeFixture.capture).toHaveBeenCalledTimes(1);
    const eventId = `evt_${randomUUID()}`;
    const responses = await settled(Array.from({ length: 3 }, () => POST(coachingWebhook(lesson.paymentAttemptId, "payment_intent.succeeded", eventId))));
    expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
    expect(await readOnlineCheckout(lesson.checkout)).toMatchObject({ status: "confirmed", totalAmountMinor: 18000, currency: "RON" });
    const confirmed = await aggregate(lesson.bookingId);
    expect(confirmed).toMatchObject({ status: "confirmed", reservation_id: lesson.reservationId, coach_user_id: coach,
      reservation_status: "active", attempt_status: "succeeded", amount_minor: 18000 });
    expect(confirmed.revision).toMatchObject({ ...original.revision, id: expect.any(String), kind: "confirmed",
      revision_number: 2, previous_revision_id: original.revision.id, booking_state: "confirmed",
      operation_key: "confirmation", intent_hash: "confirmation", actor_user_id: null, actor_scope: "provider", recorded_at: expect.any(String) });
    expect((await database.query("SELECT count(*)::int AS count FROM public.booking_revisions WHERE booking_id=$1 AND kind='confirmed'", [lesson.bookingId]))[0].count).toBe(1);
    expect((await listOwnUpcomingActivity({}, member)).bookings.find(b => b.id === lesson.bookingId)).toMatchObject({ includes_coaching: true });
    // Rescheduling offers the purchased lesson at its agreed fee, never the edited price.
    expect((await readCustomerBookingEditContext(lesson.bookingId, "2099-12-14", memberId))?.coaching)
      .toMatchObject({ coach: { id: coach }, program: { id: program }, durationMinutes: 60, coachingAmountMinor: 12000 });
  } finally {
    await database.query("UPDATE public.coaching_prices SET amount_minor=12000 WHERE program_id=$1 AND coach_user_id=$2", [program, coach]);
    await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=6000 WHERE court_id=$1", [courtA3]);
    await database.query("UPDATE public.coach_weekly_availability SET start_minute=480 WHERE coach_user_id=$1 AND location_id=$2", [coach, locationA]);
  }
});

test("guest coaching uses combined included-rental price and polling recovers a missing webhook", async () => {
  setupStripe();
  const lesson = await checkoutLesson(540, guest, { programId: includedProgram, expectedTotalAmountMinor: 15000 });
  expect(await aggregate(lesson.bookingId)).toMatchObject({ account_user_id: null, amount_minor: 15000 });
  // Unknown provider response preserves the same attempt and hold for recovery.
  stripeFixture.retrieve.mockRejectedValueOnce(new Error("Network timeout"));
  expect(await readOnlineCheckout(lesson.checkout)).toMatchObject({ status: "pending_payment", paymentStatus: "unknown" });
  remote(lesson.paymentAttemptId).status = "requires_capture";
  remote(lesson.paymentAttemptId).amount_capturable = 15000;
  expect(await readOnlineCheckout(lesson.checkout)).toMatchObject({ status: "confirmed", paymentStatus: "succeeded" });
  expect(await aggregate(lesson.bookingId)).toMatchObject({ reservation_status: "active", coach_user_id: coach,
    revision: { total_amount_minor: 15000, pricing_evidence: { coaching: { courtRentalIncluded: true, courtAmountMinor: 0, courtRentalMinor: 6000 } } } });
  expect(await readOnlineCheckout(lesson.checkout)).toMatchObject({ status: "confirmed" });
  expect(stripeFixture.capture).toHaveBeenCalledTimes(1);
});

test("declined coaching never confirms; terminal cancellation and expiry release the court and coach", async () => {
  setupStripe();
  const failed = await checkoutLesson(600);
  expect((await POST(coachingWebhook(failed.paymentAttemptId, "payment_intent.payment_failed"))).status).toBe(200);
  expect(await aggregate(failed.bookingId)).toMatchObject({ status: "pending_payment", reservation_status: "held", attempt_status: "pending" });
  expect(await settleOnlinePayment({ attemptId: failed.paymentAttemptId, provider: "stripe",
    providerPaymentId: remote(failed.paymentAttemptId).id, outcome: "failed" })).toBe("failed");
  expect(await aggregate(failed.bookingId)).toMatchObject({ status: "failed", reservation_status: "released", coach_user_id: coach });
  const replacement = await checkoutLesson(600);
  remote(replacement.paymentAttemptId).status = "canceled";
  expect((await POST(coachingWebhook(replacement.paymentAttemptId, "payment_intent.canceled"))).status).toBe(200);
  expect(await aggregate(replacement.bookingId)).toMatchObject({ reservation_status: "released", attempt_status: "cancelled" });
  const expired = await checkoutLesson(600);
  await expireHold(expired.reservationId);
  expect(await readOnlineCheckout(expired.checkout)).toMatchObject({ status: "expired" });
  expect(await aggregate(expired.bookingId)).toMatchObject({ status: "expired", reservation_status: "released", coach_user_id: coach });
  const next = await checkoutLesson(600);
  expect(next.reservationId).not.toBe(expired.reservationId);
  expect(stripeFixture.capture).not.toHaveBeenCalled();
});

test("coaching amount mismatch cannot confirm and late capture uses the existing full compensation refund", async () => {
  setupStripe();
  const mismatch = await checkoutLesson(660);
  const event = { attemptId: mismatch.paymentAttemptId, provider: "stripe" as const, providerPaymentId: remote(mismatch.paymentAttemptId).id,
    eventId: `evt_${randomUUID()}`, outcome: "succeeded" as const, amountMinor: 6000, currency: "RON" };
  expect(await processOnlinePaymentEvent(event)).toBe("amount_mismatch");
  expect(await aggregate(mismatch.bookingId)).toMatchObject({ status: "pending_payment", reservation_status: "held" });
  const late = await checkoutLesson(720);
  await expireHold(late.reservationId);
  await readOnlineCheckout(late.checkout);
  const replacement = await checkoutLesson(720);
  const intent = remote(late.paymentAttemptId);
  intent.status = "succeeded"; intent.amount_received = intent.amount;
  const eventId = `evt_${randomUUID()}`;
  expect((await POST(coachingWebhook(late.paymentAttemptId, "payment_intent.succeeded", eventId))).status).toBe(200);
  expect((await POST(coachingWebhook(late.paymentAttemptId, "payment_intent.succeeded", eventId))).status).toBe(200);
  expect(await aggregate(late.bookingId)).toMatchObject({ status: "expired", reservation_status: "released" });
  expect(await aggregate(replacement.bookingId)).toMatchObject({ status: "pending_payment", reservation_status: "held" });
  expect((await database.query("SELECT amount_minor,status FROM public.payment_refunds WHERE booking_id=$1", [late.bookingId])))
    .toEqual([{ amount_minor: 18000, status: "succeeded" }]);
  expect(stripeFixture.refundCreate).toHaveBeenCalledTimes(1);
});

test("ordinary court Stripe settlement retains live court-price revalidation", async () => {
  setupStripe();
  const result = await createCustomerBooking({ paymentMethod: "online", courtId: courtA3, date: "2099-12-14", startMinute: 480, endMinute: 540,
    customerName: "Court Guest", customerEmail: "court@example.test", customerPhone: "+40 555",
    expectedTotalAmountMinor: 6000, expectedCurrency: "RON" }, guest);
  assert.ok(result.ok);
  const checkout = await startOnlineCheckout(result.paymentAttemptId);
  remote(result.paymentAttemptId).status = "requires_capture"; remote(result.paymentAttemptId).amount_capturable = 6000;
  expect(await resolveAuthorizedCheckoutPayment({ attemptId: result.paymentAttemptId, providerPaymentId: remote(result.paymentAttemptId).id })).toBe("succeeded");
  expect(await readOnlineCheckout(access(checkout))).toMatchObject({ status: "confirmed" });
  expect(await aggregate(result.bookingId)).toMatchObject({ coach_user_id: null, amount_minor: 6000, reservation_status: "active" });
});


test("an ambiguous coaching capture keeps protected occupancy and recovers without another capture", async () => {
  setupStripe();
  const lesson = await checkoutLesson(780);
  const intent = remote(lesson.paymentAttemptId);
  intent.status = "requires_capture"; intent.amount_capturable = 18000;
  stripeFixture.capture.mockImplementationOnce(async () => { throw new Error("Capture response lost"); });
  // Authorization retrieval succeeds; capture and its recovery retrieval fail.
  stripeFixture.retrieve.mockResolvedValueOnce({ ...intent }).mockRejectedValueOnce(new Error("Stripe unavailable"));
  expect(await readOnlineCheckout(lesson.checkout)).toMatchObject({ status: "pending_payment", paymentStatus: "unknown" });
  const held = await aggregate(lesson.bookingId);
  expect(held).toMatchObject({ reservation_status: "held", attempt_status: "pending", coach_user_id: coach });
  expect(Date.parse(held.hold_expires_at) - Date.parse(held.attempt_expires_at)).toBe(120000);
  expect(await book({ date: "2099-12-07", startMinute: 780, courtId: courtA1, expectedTotalAmountMinor: 17000 }))
    .toMatchObject({ ok: false, reason: "coach-booked" });
  // A later authoritative observation finds the original capture completed.
  intent.status = "succeeded"; intent.amount_received = 18000;
  expect(await readOnlineCheckout(lesson.checkout)).toMatchObject({ status: "confirmed", paymentStatus: "succeeded" });
  expect(stripeFixture.capture).toHaveBeenCalledTimes(1);
  expect(await aggregate(lesson.bookingId)).toMatchObject({ reservation_status: "active", coach_user_id: coach });
});

test("coaching owner cancellation preserves its contract and refunds the combined payment exactly once", async () => {
  setupStripe();
  const lesson = await checkoutLesson(840, member);
  const intent = remote(lesson.paymentAttemptId);
  intent.status = "requires_capture"; intent.amount_capturable = 18000;
  expect(await readOnlineCheckout(lesson.checkout)).toMatchObject({ status: "confirmed" });
  expect(await cancelOwnCustomerBooking(lesson.bookingId, member)).toMatchObject({ ok: true, refundStatus: "succeeded" });
  expect(await cancelOwnCustomerBooking(lesson.bookingId, member)).toMatchObject({ ok: true });
  expect(await aggregate(lesson.bookingId)).toMatchObject({ status: "cancelled", reservation_status: "cancelled",
    coach_user_id: coach, revision: { coach_user_id: coach, total_amount_minor: 18000,
      pricing_evidence: { coaching: { amountMinor: 12000, courtAmountMinor: 6000 } } } });
  expect(await database.query("SELECT amount_minor,status FROM public.payment_refunds WHERE booking_id=$1", [lesson.bookingId]))
    .toEqual([{ amount_minor: 18000, status: "succeeded" }]);
  expect(stripeFixture.refundCreate).toHaveBeenCalledTimes(1);
  expect(await book({ date: "2099-12-07", startMinute: 840 })).toMatchObject({ ok: true });
});


test.each([
  { included: false, override: false, start: 480, coaching: 10000, court: 6000, total: 16000 },
  { included: false, override: true, start: 540, coaching: 12000, court: 6000, total: 18000 },
  { included: true, override: false, start: 600, coaching: 15000, court: 0, total: 15000 },
  { included: true, override: true, start: 660, coaching: 16500, court: 0, total: 16500 },
].flatMap(scenario => [false, true].map(semi => ({ ...scenario, semi }))))(
  "Stripe honors stored coaching pricing (semi=$semi, included=$included, override=$override)", async scenario => {
  setupStripe();
  // Existing Step 4 fixtures supply excluded-rental default/override and included
  // default. This disposable override completes the payment matrix; pricing code
  // and the other configured prices are untouched.
  const selectedProgram = scenario.semi ? (scenario.included ? semiIncludedProgram : semiProgram) : (scenario.included ? includedProgram : program);
  const extraOverrideId = randomUUID();
  if (scenario.included && scenario.override)
    await database.query(`INSERT INTO public.coaching_prices(id,program_id,duration_minutes,coach_user_id,amount_minor,currency)
      VALUES($1,$2,60,$3,16500,'RON')`, [extraOverrideId, selectedProgram, coach]);
  try {
    const lesson = await checkoutLesson(scenario.start, scenario.semi && scenario.override ? member : guest, { date: scenario.semi ? "2100-01-04" : "2099-12-28",
      programId: selectedProgram, participantCount: scenario.semi ? 2 : 1,
      coachId: !scenario.included && !scenario.override ? coach2 : coach,
      expectedTotalAmountMinor: scenario.total });
    const before = await aggregate(lesson.bookingId);
    expect(before.revision.pricing_evidence.coaching).toMatchObject({ source: scenario.override ? "coach" : "club", participantCount: scenario.semi ? 2 : 1,
      amountMinor: scenario.coaching, courtRentalIncluded: scenario.included,
      courtRentalMinor: 6000, courtAmountMinor: scenario.court, currency: "RON" });
    expect(stripeFixture.create).toHaveBeenLastCalledWith(expect.objectContaining({ amount: scenario.total, currency: "ron" }),
      { idempotencyKey: `court-payment-${lesson.paymentAttemptId}` });
    const intent = remote(lesson.paymentAttemptId);
    intent.status = "requires_capture"; intent.amount_capturable = scenario.total;
    expect(await readOnlineCheckout(lesson.checkout)).toMatchObject({ status: "confirmed", totalAmountMinor: scenario.total, currency: "RON" });
    const after = await aggregate(lesson.bookingId);
    expect(after).toMatchObject({ reservation_status: "active", reservation_id: lesson.reservationId,
      coach_user_id: before.coach_user_id, amount_minor: scenario.total, attempt_status: "succeeded" });
    expect(after.revision.pricing_evidence).toEqual(before.revision.pricing_evidence);
    expect(after.revision.coaching_program_id).toBe(selectedProgram);
    expect(after.revision.coaching_program_name).toBe(before.revision.coaching_program_name);
    expect(after.account_user_id).toBe(scenario.semi && scenario.override ? memberId : null);
    expect(stripeFixture.create).toHaveBeenCalledTimes(1);
    expect(stripeFixture.capture).toHaveBeenCalledTimes(1);
    expect((await database.query("SELECT count(*)::int AS count FROM public.payment_attempts WHERE booking_id=$1", [lesson.bookingId]))[0].count).toBe(1);
  } finally {
    if (scenario.included && scenario.override)
      await database.query("DELETE FROM public.coaching_prices WHERE id=$1", [extraOverrideId]);
  }
});


test.each([
  { name: "group", participantCount: 5, start: 480, coaching: 8000, court: 6000, total: 14000, client: "guest" },
  { name: "junior", participantCount: 8, start: 600, coaching: 7000, court: 0, total: 7000, client: "member" },
] as const)("a $name lesson is not checked out online, while a historical one keeps its records and lifecycle", async scenario => {
  setupStripe();
  const programId = scenario.name === "group" ? groupProgram : juniorProgram;
  const request = { date: "2100-12-13", programId, participantCount: scenario.participantCount, startMinute: scenario.start, expectedTotalAmountMinor: scenario.total };
  const unchanged = await written();
  expect(await commitCoachingCheckout({ ...base(), ...request }, scenario.client === "member" ? member : guest))
    .toMatchObject({ ok: false, reason: "not-offered" });
  expect(await written()).toEqual(unchanged);
  expect(stripeFixture.create).not.toHaveBeenCalled();

  // A lesson booked online before the program became club-organized: it is created while the
  // program is still Semi-private, then the program type changes under the existing records.
  const [original] = await database.query("SELECT program_type FROM public.coaching_programs WHERE id=$1", [programId]);
  await database.query("UPDATE public.coaching_programs SET program_type='semi_private' WHERE id=$1", [programId]);
  let lesson: Awaited<ReturnType<typeof checkoutLesson>>;
  try {
    lesson = await checkoutLesson(scenario.start, scenario.client === "member" ? member : guest, { date: "2100-12-13", programId,
      participantCount: scenario.participantCount, expectedTotalAmountMinor: scenario.total });
  } finally {
    await database.query("UPDATE public.coaching_programs SET program_type=$2 WHERE id=$1", [programId, original.program_type]);
  }
  const before = await aggregate(lesson.bookingId);
  expect(before).toMatchObject({ status: "pending_payment", reservation_status: "held", coach_user_id: coach, court_id: courtA3,
    amount_minor: scenario.total, currency: "RON", attempt_status: "pending",
    account_user_id: scenario.client === "member" ? memberId : null });
  expect(before.revision.pricing_evidence.coaching).toMatchObject({ participantCount: scenario.participantCount, source: "club",
    amountMinor: scenario.coaching, courtRentalIncluded: scenario.name === "junior", courtRentalMinor: 6000, courtAmountMinor: scenario.court });
  // Verified provider evidence still confirms the historical checkout without repricing it.
  const intent = remote(lesson.paymentAttemptId);
  intent.status = "requires_capture"; intent.amount_capturable = scenario.total;
  expect(await readOnlineCheckout(lesson.checkout)).toMatchObject({ status: "confirmed", totalAmountMinor: scenario.total, currency: "RON" });
  const after = await aggregate(lesson.bookingId);
  expect(after).toMatchObject({ status: "confirmed", reservation_status: "active", reservation_id: lesson.reservationId,
    amount_minor: scenario.total, attempt_status: "succeeded" });
  expect(after.revision.pricing_evidence).toEqual(before.revision.pricing_evidence);
  expect(after.revision.coaching_program_name).toBe(scenario.name === "group" ? "Booking group" : "Booking junior");
  expect(stripeFixture.capture).toHaveBeenCalledTimes(1);
  // Its occupancy still blocks the coach and court; new online bookings stay rejected.
  const held = await written();
  expect(await book({ date: "2100-12-13", courtId: courtA1, startMinute: scenario.start })).toMatchObject({ ok: false, reason: "coach-booked" });
  expect(await book({ ...request, startMinute: scenario.start + 120 })).toMatchObject({ ok: false, reason: "not-offered" });
  expect(await written()).toEqual(held);
  // The owner cancellation refunds the verified historical capture exactly once.
  if (scenario.client === "member") {
    expect(await cancelOwnCustomerBooking(lesson.bookingId, member)).toMatchObject({ ok: true, refundStatus: "succeeded" });
    expect(await database.query("SELECT amount_minor,status FROM public.payment_refunds WHERE booking_id=$1", [lesson.bookingId]))
      .toEqual([{ amount_minor: scenario.total, status: "succeeded" }]);
    expect(await aggregate(lesson.bookingId)).toMatchObject({ status: "cancelled", reservation_status: "cancelled",
      revision: { pricing_evidence: before.revision.pricing_evidence } });
  }
});

test("an unpriced coaching scope never creates a booking or Stripe payment", async () => {
  setupStripe();
  const before = await written();
  // This private program is offered by the coach, but has neither a club default
  // nor a coach override in RON. A priced court cannot price the lesson.
  expect(await commitCoachingCheckout({ ...base(), programId: unpricedProgram,
    locationId: locationB, courtId: courtB1, date: "2099-12-28", startMinute: 1080,
    expectedTotalAmountMinor: 15000 }, guest)).toMatchObject({ ok: false, reason: "unpriced" });
  expect(await written()).toEqual(before);
  expect(stripeFixture.create).not.toHaveBeenCalled();
});


test("semi-private shares coach and court exclusion with every booking kind", async () => {
  const onDate = "2100-01-11";
  const results = await settled([
    book({ date: onDate, programId: semiProgram, participantCount: 2, courtId: courtA1, startMinute: 480, expectedTotalAmountMinor: 17000 }),
    book({ date: onDate, programId: semiProgram, participantCount: 2, courtId: courtA2, startMinute: 480, expectedTotalAmountMinor: 19000 }, member),
  ]);
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(results.find(r => !r.ok)).toMatchObject({ reason: "coach-booked" });
  const winner = results.find(r => r.ok);
  assert.ok(winner?.ok);
  const held = await aggregate(winner.bookingId);
  expect(await book({ date: onDate, programId: semiProgram, participantCount: 2, coachId: coach2, courtId: held.court_id,
    startMinute: 480, expectedTotalAmountMinor: held.court_id === courtA1 ? 15000 : 17000 })).toMatchObject({ ok: false, reason: "court-unavailable" });
  const longLesson = await book({ date: onDate, programId: semiProgram, participantCount: 2, courtId: courtA2,
    startMinute: 600, durationMinutes: 90, expectedTotalAmountMinor: 24500 }, member);
  assert.ok(longLesson.ok);
  expect((await aggregate(longLesson.bookingId)).revision.pricing_evidence.coaching).toMatchObject({
    participantCount: 2, source: "club", amountMinor: 14000, courtAmountMinor: 10500,
  });
});

test("Admin coaching records preserve included rental, participants and duration after live configuration changes", async () => {
  await ensureIntegrationAdminAnchor(service);
  const adminAccount = await account();
  await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [adminAccount.id]);
  const admin = reader();
  assert.strictEqual((await admin.auth.signInWithPassword({ email: adminAccount.email, password: adminAccount.password })).error, null);
  const lesson = await book({ date: "2100-02-22", programId: semiIncludedProgram, participantCount: 2, expectedTotalAmountMinor: 15000 }, member);
  assert.ok(lesson.ok);
  const contract = (await aggregate(lesson.bookingId)).revision;
  const [configuration] = await database.query("SELECT name,court_rental_included FROM public.coaching_programs WHERE id=$1", [semiIncludedProgram]);
  try {
    await database.query("UPDATE public.coaching_programs SET name='Changed program',court_rental_included=false,min_participants=3,max_participants=5 WHERE id=$1", [semiIncludedProgram]);
    await database.query("UPDATE public.coaching_prices SET amount_minor=99999 WHERE program_id=$1", [semiIncludedProgram]);
    const records = await getAdminBookingRecords(lesson.bookingId, { supabase: admin });
    expect(records?.booking).toMatchObject({ includes_coaching: true, coach_name: contract.coach_name,
      coaching_program_name: contract.coaching_program_name, total_amount_minor: 15000, currency: "RON",
      coaching: { participantCount: 2, durationMinutes: 60, amountMinor: 15000, courtRentalIncluded: true, courtAmountMinor: 0 } });
  } finally {
    await database.query("UPDATE public.coaching_programs SET name=$2,court_rental_included=$3,min_participants=2,max_participants=2 WHERE id=$1", [semiIncludedProgram, configuration.name, configuration.court_rental_included]);
    await database.query("UPDATE public.coaching_prices SET amount_minor=15000 WHERE program_id=$1", [semiIncludedProgram]);
  }
});

test("removing a priced duration preserves and settles the pending semi-private checkout agreement", async () => {
  const { saveCoachingProgram } = await import("@/lib/coaching/admin");
  const { ensureIntegrationAdminAnchor } = await import("./admin-anchor");
  await ensureIntegrationAdminAnchor(service);
  const admin = await account();
  await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [admin.id]);
  const adminClient = reader();
  assert.strictEqual((await adminClient.auth.signInWithPassword({ email: admin.email, password: admin.password })).error, null);
  // A dedicated copy of the included semi-private configuration (60 minutes at 15000): the
  // shared fixture keeps its 60-minute duration and price for every other test. It is
  // removed with the other fixtures once its booking evidence is gone.
  await database.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,min_participants,max_participants,court_rental_included)
    VALUES($1,'Semi-private duration removal','','semi_private',2,2,true)`, [durationRemovalProgram]);
  await database.query("INSERT INTO public.coaching_program_durations(program_id,duration_minutes) VALUES($1,60)", [durationRemovalProgram]);
  await database.query("INSERT INTO public.coach_programs(coach_user_id,program_id) VALUES($1,$2)", [coach, durationRemovalProgram]);
  await database.query(`INSERT INTO public.coaching_prices(program_id,duration_minutes,coach_user_id,amount_minor,currency)
    VALUES($1,60,NULL,15000,'RON')`, [durationRemovalProgram]);
  setupStripe();
  const lesson = await checkoutLesson(600, guest, { date: "2100-01-18", programId: durationRemovalProgram, participantCount: 2, expectedTotalAmountMinor: 15000 });
  const agreed = await aggregate(lesson.bookingId);
  expect(await saveCoachingProgram({ id: durationRemovalProgram, fields: { name: "Renamed semi-private", description: "Updated configuration",
    program_type: "semi_private", min_participants: 2, max_participants: 2, durations: [90], court_rental_included: true, is_active: true } }, adminClient))
    .toMatchObject({ ok: true });
  expect(await database.query("SELECT 1 FROM public.coaching_prices WHERE program_id=$1 AND duration_minutes=60", [durationRemovalProgram])).toEqual([]);
  const pending = await aggregate(lesson.bookingId);
  expect(pending).toMatchObject({ status: "pending_payment", reservation_status: "held", amount_minor: 15000 });
  expect(pending.revision).toEqual(agreed.revision);
  const intent = remote(lesson.paymentAttemptId);
  intent.status = "requires_capture"; intent.amount_capturable = 15000;
  expect(await readOnlineCheckout(lesson.checkout)).toMatchObject({ status: "confirmed", totalAmountMinor: 15000 });
  const confirmed = await aggregate(lesson.bookingId);
  expect(confirmed.revision).toMatchObject({ coaching_program_name: agreed.revision.coaching_program_name,
    starts_at_minute: 600, ends_at_minute: 660, total_amount_minor: 15000, pricing_evidence: agreed.revision.pricing_evidence });
  expect(stripeFixture.capture).toHaveBeenCalledTimes(1);
});


test("personal activity distinguishes coaching snapshots and court bookings before filtering and pagination", async () => {
  setupStripe();
  await ensureIntegrationAdminAnchor(service);
  const adminAccount = await account();
  await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [adminAccount.id]);
  const admin = reader();
  assert.strictEqual((await admin.auth.signInWithPassword({ email: adminAccount.email, password: adminAccount.password })).error, null);
  const lesson = await checkoutLesson(480, member, { date: "2100-01-25" });
  const intent = remote(lesson.paymentAttemptId);
  intent.status = "requires_capture"; intent.amount_capturable = 18000;
  expect(await readOnlineCheckout(lesson.checkout)).toMatchObject({ status: "confirmed" });
  const contract = (await aggregate(lesson.bookingId)).revision;
  const courtIds: string[] = [];
  await inTransaction(async manager => {
    for (let index = 0; index < 21; index++) {
      const reservationId = randomUUID(), bookingId = randomUUID();
      courtIds.push(bookingId);
      await manager.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute)
        VALUES($1,$2,$3,600,660)`, [reservationId, courtA3, new Date(Date.UTC(2100, 0, 25 + index)).toISOString().slice(0, 10)]);
      await insertBookingRecords(manager, { id: bookingId, reservation_id: reservationId, account_user_id: memberId,
        customer_name: "Court customer", customer_email: "court@example.test", customer_phone: "123",
        total_amount_minor: 18000, currency: "RON", cancellation_notice_minutes: 120, payment_method: "pay_at_club" });
    }
  });
  try {
    await database.query("UPDATE public.coach_profiles SET display_name='Current renamed coach',is_public=false WHERE user_id=$1", [coach]);
    await database.query("UPDATE public.coaching_programs SET name='Current renamed program',is_active=false WHERE id=$1", [program]);
    for (const scope of ["upcoming", "history"] as const) {
      const now = new Date(scope === "upcoming" ? "2100-01-01T00:00:00Z" : "2101-01-01T00:00:00Z");
      const read = (type: string, page = "1", direction = "asc") => listOwnCourtActivity(scope,
        parseActivityQuery({ type, page, sort: "type", direction, from: "2100-01-25", to: "2100-02-15" }, scope, false), member, now);
      const all = await read("all");
      expect(all.rows).toHaveLength(20); expect(all.hasNext).toBe(true);
      expect(all.rows[0]).toMatchObject({ id: lesson.bookingId, includes_coaching: true,
        coach_name: contract.coach_name, coaching_program_name: contract.coaching_program_name });
      expect((await read("all", "2")).rows).toHaveLength(2);
      expect((await read("all", "1", "desc")).rows[0]).toMatchObject({ includes_coaching: false });
      const coaching = await read("coaching");
      expect(coaching.rows.map(row => row.id)).toEqual([lesson.bookingId]);
      expect(coaching.hasNext).toBe(false);
      expect(coaching.locations).toEqual(all.locations);
      const court = await read("court");
      expect(court.rows.every(row => row.kind === "booking" && !row.includes_coaching)).toBe(true);
      expect(court.hasNext).toBe(true);
      const tail = await read("court", "2");
      expect(tail.rows).toHaveLength(1); expect(tail.hasNext).toBe(false);
      expect([...court.rows, ...tail.rows].map(row => row.id).sort()).toEqual(courtIds.sort());
    }
    const adminRead = (type: string, page = "1", extra: Record<string, string> = {}) => listAdminBookings(
      parseAdminBookingQuery({ type, page, location: locationA, from: "2100-01-25", to: "2100-02-15", sort: "scheduled", dir: "asc", ...extra }), admin);
    const all = await adminRead("all");
    expect(all).toMatchObject({ total: 22, totalPages: 2, page: 1 });
    expect(all.rows).toHaveLength(20);
    expect((await adminRead("all", "2")).rows).toHaveLength(2);
    const lessons = await adminRead("coaching", "99");
    expect(lessons).toMatchObject({ total: 1, totalPages: 1, page: 1 });
    expect(lessons.rows).toMatchObject([{ id: lesson.bookingId, includes_coaching: true,
      coach_name: contract.coach_name, coaching_program_name: contract.coaching_program_name }]);
    const firstCourts = await adminRead("court"), lastCourts = await adminRead("court", "2");
    expect(firstCourts).toMatchObject({ total: 21, totalPages: 2 });
    expect(firstCourts.rows).toHaveLength(20); expect(lastCourts.rows).toHaveLength(1);
    expect([...firstCourts.rows, ...lastCourts.rows].map(row => row.id).sort()).toEqual(courtIds.sort());
    expect((await adminRead("coaching", "1", { q: lesson.bookingId, status: "confirmed", court: courtA3 })).total).toBe(1);
    expect((await adminRead("court", "1", { q: lesson.bookingId })).total).toBe(0);
    const records = await getAdminBookingRecords(lesson.bookingId, { supabase: admin });
    expect(records?.booking).toMatchObject({ includes_coaching: true, coach_name: contract.coach_name,
      coaching_program_name: contract.coaching_program_name, total_amount_minor: 18000, currency: "RON",
      coaching: { participantCount: 1, durationMinutes: 60, amountMinor: 12000, courtRentalIncluded: false, courtAmountMinor: 6000 } });
    expect(await cancelOwnCustomerBooking(lesson.bookingId, member)).toMatchObject({ ok: true });
    expect((await adminRead("coaching", "1", { status: "cancelled" })).rows).toMatchObject([{ id: lesson.bookingId,
      coach_name: contract.coach_name, coaching_program_name: contract.coaching_program_name }]);
    expect((await getAdminBookingRecords(lesson.bookingId, { supabase: admin }))?.booking.coaching).toEqual(records?.booking.coaching);
    const cancelled = await listOwnCourtActivity("history", parseActivityQuery({ type: "coaching", status: "cancelled" }, "history", false), member);
    expect(cancelled.rows.find(row => row.id === lesson.bookingId)).toMatchObject({ includes_coaching: true,
      coach_name: contract.coach_name, coaching_program_name: contract.coaching_program_name, status: "cancelled" });
  } finally {
    await database.query("UPDATE public.coach_profiles SET display_name='Booking Coach',is_public=true WHERE user_id=$1", [coach]);
    await database.query("UPDATE public.coaching_programs SET name='Booking private',is_active=true WHERE id=$1", [program]);
  }
});


test("Admin coach filters use historical IDs and names including archived coaches before pagination", async () => {
  await ensureIntegrationAdminAnchor(service);
  const adminAccount = await account();
  await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [adminAccount.id]);
  const admin = reader();
  assert.strictEqual((await admin.auth.signInWithPassword({ email: adminAccount.email, password: adminAccount.password })).error, null);
  const ids: string[] = [];
  const dates = Array.from({ length: 21 }, (_, index) => new Date(Date.UTC(2100, 2, 1 + index * 7)).toISOString().slice(0, 10));
  try {
    await database.query("UPDATE public.coach_profiles SET display_name='Earlier historical coach' WHERE user_id=$1", [coach]);
    for (const [index, date] of dates.entries()) {
      const lesson = await book({ date, startMinute: 600 }, member);
      assert.ok(lesson.ok); ids.push(lesson.bookingId);
      if (index === 0) await database.query("UPDATE public.coach_profiles SET display_name='Booking Coach' WHERE user_id=$1", [coach]);
    }
    // Matching historical names must remain two options, with distinct stored IDs.
    await database.query("UPDATE public.coach_profiles SET display_name='Booking Coach' WHERE user_id=$1", [coach2]);
    const other = await book({ date: dates[0], startMinute: 600, coachId: coach2, courtId: courtA2, expectedTotalAmountMinor: 17000 });
    assert.ok(other.ok);
    await inTransaction(async manager => {
      const reservation = randomUUID();
      await manager.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute)
        VALUES($1,$2,$3,600,660)`, [reservation, courtA1, dates[0]]);
      await insertBookingRecords(manager, { reservation_id: reservation, account_user_id: memberId, customer_name: "Ordinary court customer",
        customer_email: "court@example.test", customer_phone: "123", total_amount_minor: 18000, currency: "RON", cancellation_notice_minutes: 120 });
    });
    await database.query(`UPDATE public.coach_profiles SET display_name='Current renamed coach',is_public=false,archived_at=clock_timestamp()
      WHERE user_id=ANY($1::uuid[])`, [[coach, coach2]]);
    const options = await listAdminBookingCoachFilterOptions(admin);
    expect(options.filter(option => option.id === coach || option.id === coach2)).toEqual(
      [coach, coach2].sort().map(id => ({ id, name: "Booking Coach" })));
    expect(options.some(option => option.id === hiddenCoach)).toBe(false);
    const read = (extra: Record<string, string> = {}) => listAdminBookings(parseAdminBookingQuery({ type: "coaching", coach,
      location: locationA, from: dates[0], to: "2100-08-01", sort: "scheduled", dir: "asc", ...extra }), admin);
    const first = await read(), second = await read({ page: "2" });
    expect(first).toMatchObject({ total: 21, totalPages: 2, page: 1 });
    expect(first.rows).toHaveLength(20); expect(second.rows).toHaveLength(1);
    expect([...first.rows, ...second.rows].map(row => row.id)).toEqual(ids);
    expect((await read({ dir: "desc" })).rows[0].id).toBe(ids.at(-1));
    expect((await read({ coach: coach2 })).rows.map(row => row.id)).toEqual([other.bookingId]);
    expect((await read({ coach: "" })).total).toBe(22);
    expect((await read({ type: "court" })).total).toBe(1); // A hidden Coach filter cannot affect Court.
    expect((await read({ coach: randomUUID() })).total).toBe(0);
    expect((await read({ q: ids[0], court: courtA3, status: "pending_payment", to: dates[0] })).rows.map(row => row.id)).toEqual([ids[0]]);
    expect((await read({ q: other.bookingId })).total).toBe(0);
    await expect(listAdminBookingCoachFilterOptions(member)).rejects.toThrow();
  } finally {
    await database.query("UPDATE public.coach_profiles SET display_name='Booking Coach',is_public=true,archived_at=NULL WHERE user_id=$1", [coach]);
    await database.query("UPDATE public.coach_profiles SET display_name='Second Coach',is_public=true,archived_at=NULL WHERE user_id=$1", [coach2]);
  }
});


// Dedicated coaches and dates keep each removal assertion independent of earlier
// bookings in this suite. Only the isolated test database is used.
let removalAdmin: ReturnType<typeof reader> | undefined;
async function removalFixture() {
  if (!removalAdmin) {
    await ensureIntegrationAdminAnchor(service);
    const accountDetails = await account();
    await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [accountDetails.id]);
    removalAdmin = reader();
    assert.strictEqual((await removalAdmin.auth.signInWithPassword(accountDetails)).error, null);
  }
  const { id } = await account(["coach"]);
  removalCoachIds.push(id);
  const date = new Date(Date.UTC(2101, 0, 3 + removalCoachIds.length * 7)).toISOString().slice(0, 10);
  await database.query(`INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages,is_public) VALUES($1,'Removal regression coach','','','{}','{}',true)`, [id]);
  await database.query("INSERT INTO public.coach_locations(coach_user_id,location_id) VALUES($1,$2)", [id, locationA]);
  await database.query("INSERT INTO public.coach_programs(coach_user_id,program_id) VALUES($1,$2)", [id, program]);
  await database.query(`INSERT INTO public.coach_weekly_availability(coach_user_id,location_id,weekday,start_minute,end_minute,valid_from)
    VALUES($1,$2,$3,480,960,'2000-01-01')`, [id, locationA, mondayWeekday(date)]);
  return { id, admin: removalAdmin, intent: { ...base(), coachId: id, date, expectedTotalAmountMinor: 16000 } };
}

// Complete persistence evidence, rather than just lifecycle status: failed removal
// and historical archival must leave every reservation and financial row unchanged.
async function removalBookingSnapshot(coachId: string) {
  const reservationIds = "SELECT id FROM public.court_reservations WHERE coach_user_id=$1";
  const bookingIds = `SELECT id FROM public.bookings WHERE reservation_id IN (${reservationIds})`;
  const attemptIds = `SELECT id FROM public.payment_attempts WHERE booking_id IN (${bookingIds})`;
  const refundIds = `SELECT id FROM public.payment_refunds WHERE booking_id IN (${bookingIds})`;
  const scopes = [
    ["court_reservations", "coach_user_id=$1"], ["bookings", `id IN (${bookingIds})`],
    ["booking_revisions", `booking_id IN (${bookingIds})`], ["payment_attempts", `booking_id IN (${bookingIds})`],
    ["payment_capture_receipts", `payment_attempt_id IN (${attemptIds})`],
    ["payment_refunds", `booking_id IN (${bookingIds})`], ["refund_executions", `refund_id IN (${refundIds})`],
    ["payment_provider_events", `attempt_id IN (${attemptIds})`],
  ];
  return Promise.all(scopes.map(([table, scope]) => database.query(`SELECT * FROM public.${table} WHERE ${scope} ORDER BY ${table === "payment_provider_events" ? "provider,event_id" : "id"}`, [coachId])));
}

async function removalConfigurationSnapshot(coachId: string) {
  return Promise.all([
    database.query("SELECT * FROM public.coach_profiles WHERE user_id=$1", [coachId]),
    ...["coach_locations", "coach_programs", "coach_weekly_availability", "coaching_prices"].map(table =>
      database.query(`SELECT * FROM public.${table} WHERE coach_user_id=$1 ORDER BY 1`, [coachId])),
  ]);
}

test.each(["live hold", "uncertain accepted capture", "confirmed lesson"])("coach removal rejects a %s without changing bookings, configuration or payment evidence", async phase => {
  setupStripe();
  const fixture = await removalFixture();
  const lesson = await commitCoachingCheckout(fixture.intent, member);
  assert.ok(lesson.ok);
  if (phase !== "live hold") {
    const intent = remote(lesson.paymentAttemptId);
    intent.status = "requires_capture"; intent.amount_capturable = 16000;
    if (phase === "uncertain accepted capture") {
      stripeFixture.capture.mockRejectedValueOnce(new Error("Capture response lost"));
      stripeFixture.retrieve.mockResolvedValueOnce({ ...intent }).mockRejectedValueOnce(new Error("Stripe unavailable"));
      expect(await readOnlineCheckout(access(lesson.checkout))).toMatchObject({ status: "pending_payment", paymentStatus: "unknown" });
      const accepted = await aggregate(lesson.bookingId);
      expect(Date.parse(accepted.hold_expires_at) - Date.parse(accepted.attempt_expires_at)).toBe(120000);
    } else {
      expect(await readOnlineCheckout(access(lesson.checkout))).toMatchObject({ status: "confirmed", paymentStatus: "succeeded" });
      expect(await database.query("SELECT id FROM public.payment_capture_receipts WHERE payment_attempt_id=$1", [lesson.paymentAttemptId])).toHaveLength(1);
    }
  }
  const bookingBefore = await removalBookingSnapshot(fixture.id);
  const configurationBefore = await removalConfigurationSnapshot(fixture.id);
  const providerCallsBefore = [stripeFixture.capture.mock.calls.length, stripeFixture.cancel.mock.calls.length, stripeFixture.refundCreate.mock.calls.length];
  expect(await deleteCoachProfile({ user_id: fixture.id }, fixture.admin)).toEqual({ ok: false, reason: "active-lessons" });
  expect(await removalBookingSnapshot(fixture.id)).toEqual(bookingBefore);
  expect(await removalConfigurationSnapshot(fixture.id)).toEqual(configurationBefore);
  expect([stripeFixture.capture.mock.calls.length, stripeFixture.cancel.mock.calls.length, stripeFixture.refundCreate.mock.calls.length]).toEqual(providerCallsBefore);
  expect((await service.auth.admin.getUserById(fixture.id)).data.user?.id).toBe(fixture.id);
});

test("coach removal archives cancelled lesson history without changing captured payments, refunds, reservations or the account", async () => {
  setupStripe();
  const fixture = await removalFixture();
  const lesson = await commitCoachingCheckout(fixture.intent, member);
  assert.ok(lesson.ok);
  const intent = remote(lesson.paymentAttemptId);
  intent.status = "requires_capture"; intent.amount_capturable = 16000;
  expect(await readOnlineCheckout(access(lesson.checkout))).toMatchObject({ status: "confirmed" });
  expect(await cancelOwnCustomerBooking(lesson.bookingId, member)).toMatchObject({ ok: true, refundStatus: "succeeded" });
  expect(await database.query("SELECT status FROM public.payment_refunds WHERE booking_id=$1", [lesson.bookingId])).toEqual([{ status: "succeeded" }]);
  const before = await removalBookingSnapshot(fixture.id);
  const refundCalls = stripeFixture.refundCreate.mock.calls.length;
  expect(await deleteCoachProfile({ user_id: fixture.id }, fixture.admin)).toEqual({ ok: true, id: fixture.id, archived: true });
  expect(await removalBookingSnapshot(fixture.id)).toEqual(before);
  expect(await database.query("SELECT is_public,archived_at IS NOT NULL AS archived FROM public.coach_profiles WHERE user_id=$1", [fixture.id]))
    .toEqual([{ is_public: false, archived: true }]);
  expect((await service.auth.admin.getUserById(fixture.id)).data.user?.id).toBe(fixture.id);
  expect(stripeFixture.refundCreate).toHaveBeenCalledTimes(refundCalls);
});

test.each(["booking first", "removal first"])("coach removal and booking creation serialize safely: %s", async order => {
  const fixture = await removalFixture();
  const blocker = await session();
  const observer = await session();
  let booking: ReturnType<typeof createCoachingBooking> | undefined;
  let removal: ReturnType<typeof deleteCoachProfile> | undefined;
  try {
    await blocker.query("BEGIN");
    if (order === "booking first") {
      // Stop booking after its shared configuration/profile fences, at the
      // existing location lock. Removal must wait for its transaction to finish.
      await blocker.query("SELECT id FROM public.locations WHERE id=$1 FOR UPDATE", [locationA]);
      booking = createCoachingBooking(fixture.intent, guest);
      await blockedOn("%location%", observer);
      removal = deleteCoachProfile({ user_id: fixture.id }, fixture.admin);
      await blockedOn("%pg_advisory_xact_lock(1791462257, 1)%", observer);
      await blocker.query("COMMIT");
      expect(await booking).toMatchObject({ ok: true, status: "pending_payment" });
      expect(await removal).toEqual({ ok: false, reason: "active-lessons" });
      expect(await database.query("SELECT status FROM public.court_reservations WHERE coach_user_id=$1", [fixture.id])).toEqual([{ status: "held" }]);
    } else {
      // Stop removal after its exclusive configuration fence, at the profile
      // lock. A new booking cannot enter until the removal commits.
      await blocker.query("SELECT user_id FROM public.coach_profiles WHERE user_id=$1 FOR UPDATE", [fixture.id]);
      removal = deleteCoachProfile({ user_id: fixture.id }, fixture.admin);
      await blockedOn("%CoachProfileEntity%", observer);
      booking = createCoachingBooking(fixture.intent, guest);
      await blockedOn("%pg_advisory_xact_lock_shared(1791462257, 1)%", observer);
      await blocker.query("COMMIT");
      expect(await removal).toEqual({ ok: true, id: fixture.id, archived: false });
      expect(await booking).toMatchObject({ ok: false, reason: "not-offered" });
      expect(await database.query("SELECT id FROM public.court_reservations WHERE coach_user_id=$1", [fixture.id])).toEqual([]);
      expect((await service.auth.admin.getUserById(fixture.id)).data.user?.id).toBe(fixture.id);
    }
  } finally {
    await blocker.query("ROLLBACK");
    await Promise.allSettled([booking, removal]);
    await blocker.end();
    await observer.end();
  }
}, 15000);

// Rescheduling a confirmed, member-owned lesson. Each test uses its own Monday;
// the coach teaches at A 08:00–16:00, A1 5000/h, A2 7000/h, A3 6000/h.
async function confirmedLesson(startMinute: number, lessonDate: string, overrides: Record<string, unknown> = {}) {
  setupStripe();
  const lesson = await checkoutLesson(startMinute, member, { date: lessonDate, customerEmail: memberEmail, ...overrides });
  const intent = remote(lesson.paymentAttemptId);
  intent.status = "requires_capture"; intent.amount_capturable = intent.amount;
  expect(await readOnlineCheckout(lesson.checkout)).toMatchObject({ status: "confirmed" });
  return lesson;
}
async function lessonEdit(bookingId: string, target: { courtId: string; date: string; startMinute: number; expectedTotal: number }) {
  const context = await readCustomerBookingEditContext(bookingId, target.date, memberId);
  assert.ok(context);
  return { id: bookingId, expectedUpdatedAt: context.updated_at, expectedRevisionId: context.current_revision_id,
    endMinute: target.startMinute + (context.coaching?.durationMinutes ?? context.ends_at_minute - context.starts_at_minute), save: true, priceAcknowledged: true, ...target };
}
const revisionCount = async (bookingId: string) =>
  (await database.query("SELECT count(*)::int AS count FROM public.booking_revisions WHERE booking_id=$1", [bookingId]))[0].count;
const coachRows = async (lessonDate: string) => database.query(`SELECT court_id,starts_at_minute,ends_at_minute,status,adjustment_id IS NOT NULL AS hold
  FROM public.court_reservations WHERE coach_user_id=$1 AND booking_date=$2 AND status IN ('active','held') ORDER BY starts_at_minute`, [coach, lessonDate]);
const stripeCalls = () => [stripeFixture.create, stripeFixture.capture, stripeFixture.refundCreate].map(mock => mock.mock.calls.length);

test.each([false, true])("an owner moves a lesson at an unchanged total without Stripe, keeping its contract, and notifies customer and coach (email enabled=%s)", async emailsEnabled => {
  await database.query("UPDATE public.club_settings SET official_email=$1,sender_name=$2,emails_enabled=$3 WHERE id=true",
    [emailsEnabled ? "club@example.test" : "", emailsEnabled ? "Test Club" : "", emailsEnabled]);
  const lessonDate = emailsEnabled ? "2100-10-04" : "2100-09-06";
  try {
    const lesson = await confirmedLesson(480, lessonDate);
    const original = await aggregate(lesson.bookingId);
    const calls = stripeCalls();
    // Configuration and marketing changes never reprice the lesson or block it.
    await database.query("UPDATE public.coaching_prices SET amount_minor=22000 WHERE program_id=$1 AND coach_user_id=$2", [program, coach]);
    await database.query("UPDATE public.coach_profiles SET is_public=false WHERE user_id=$1", [coach]);
    const context = await readCustomerBookingEditContext(lesson.bookingId, lessonDate, memberId);
    expect(context?.coaching).toMatchObject({ coach: { id: coach, name: "Booking Coach" },
      program: { id: program, name: "Booking private", participantCount: 1, courtRentalIncluded: false },
      durationMinutes: 60, coachingAmountMinor: 12000 });
    // The lesson's own reservation never conflicts with itself.
    expect(context!.coaching!.starts.find(s => s.startMinute === 480)?.courts).toContainEqual(
      { id: courtA3, name: "A3", coachingAmountMinor: 12000, courtAmountMinor: 6000, totalAmountMinor: 18000 });
    const input = await lessonEdit(lesson.bookingId, { courtId: courtA3, date: lessonDate, startMinute: 600, expectedTotal: 18000 });

    // Only date and start can change; all other lesson terms are fixed.
    expect(await runBookingReschedule({ ...input, coachId: coach2 }, memberId)).toEqual({ ok: false, message: "Check the booking interval." });
    expect(await runBookingReschedule({ ...input, programId: includedProgram }, memberId)).toEqual({ ok: false, message: "Check the booking interval." });
    expect(await runBookingReschedule({ ...input, endMinute: 690 }, memberId)).toEqual({ ok: false,
      message: "A coaching lesson keeps its original length. Choose a new start time." });
    expect(await runBookingReschedule({ ...input, courtId: courtA1 }, memberId)).toMatchObject({ ok: false,
      message: "A coaching lesson keeps its original court. Choose a new date or start time." });
    expect(await runBookingReschedule({ ...input, durationMinutes: 90 }, memberId)).toMatchObject({ ok: false });
    expect(await runBookingReschedule({ ...input, participantCount: 2 }, memberId)).toMatchObject({ ok: false });
    expect(await runBookingReschedule({ ...input, courtId: courtB1 }, memberId)).toMatchObject({ ok: false });
    expect(await runBookingReschedule(input, coach2)).toEqual({ ok: false, message: "This booking is no longer available to edit." });
    expect(await revisionCount(lesson.bookingId)).toBe(2);

    expect(await runBookingReschedule(input, memberId)).toEqual({ ok: true, totalAmountMinor: 18000 });
    const moved = await aggregate(lesson.bookingId);
    expect(moved).toMatchObject({ status: "confirmed", reservation_id: lesson.reservationId, court_id: courtA3, coach_user_id: coach,
      booking_date: lessonDate, starts_at_minute: 600, ends_at_minute: 660, reservation_status: "active" });
    expect(moved.revision).toMatchObject({ kind: "rescheduled", revision_number: 3, previous_revision_id: original.revision.id,
      total_amount_minor: 18000, coach_user_id: coach, coaching_program_id: program, coach_name: "Booking Coach",
      coaching_program_name: "Booking private", location_id: locationA });
    expect(moved.revision.pricing_evidence.coaching).toEqual(original.revision.pricing_evidence.coaching);
    await expectLessonContract(lesson.bookingId, original);
    expect(stripeCalls()).toEqual(calls);
    // One reservation protects both the court and the coach.
    expect(await coachRows(lessonDate)).toEqual([{ court_id: courtA3, starts_at_minute: 600, ends_at_minute: 660, status: "active", hold: false }]);
    expect(await database.query("SELECT recipient_email,status FROM public.email_deliveries WHERE event_key=$1",
      [`booking.rescheduled:${moved.revision.id}`])).toEqual(emailsEnabled ? [{ recipient_email: memberEmail, status: "pending" }] : []);
    expect(await database.query("SELECT count(*)::int AS count FROM public.user_messages WHERE user_id=$1 AND event_key=$2",
      [memberId, `booking.rescheduled:${moved.revision.id}`])).toEqual([{ count: 1 }]);
    expect(await database.query("SELECT count(*)::int AS count FROM public.user_messages WHERE user_id=$1 AND event_key=$2",
      [coach, `coaching.rescheduled:${moved.revision.id}`])).toEqual([{ count: 1 }]);
    // The original confirmation is never sent again.
    expect(await database.query(`SELECT count(*)::int AS count FROM public.email_deliveries d JOIN public.booking_revisions v
      ON d.event_key LIKE 'booking.confirmed:' || v.id WHERE v.booking_id=$1`, [lesson.bookingId])).toEqual([{ count: emailsEnabled ? 1 : 0 }]);

    // A replay is idempotent and a stale request changes nothing.
    expect(await runBookingReschedule(input, memberId)).toEqual({ ok: true, totalAmountMinor: 18000 });
    expect(await runBookingReschedule({ ...input, startMinute: 720, endMinute: 780 }, memberId)).toMatchObject({ ok: false, reason: "stale" });
    expect(await revisionCount(lesson.bookingId)).toBe(3);
    expect((await aggregate(lesson.bookingId)).starts_at_minute).toBe(600);
  } finally {
    await database.query("UPDATE public.coaching_prices SET amount_minor=12000 WHERE program_id=$1 AND coach_user_id=$2", [program, coach]);
    await database.query("UPDATE public.coach_profiles SET is_public=true WHERE user_id=$1", [coach]);
    await database.query("UPDATE public.club_settings SET official_email='',sender_name='',emails_enabled=false WHERE id=true");
  }
});

test("lesson rescheduling rejects coach and court conflicts, a deauthorized coach and closed or started lessons", async () => {
  const lessonDate = "2100-09-13";
  const lesson = await confirmedLesson(480, lessonDate);
  const before = await aggregate(lesson.bookingId);
  const other = await book({ date: lessonDate, courtId: courtA1, startMinute: 720, expectedTotalAmountMinor: 17000 });
  assert.ok(other.ok);
  await database.query(`INSERT INTO public.court_reservations(court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,$2,840,900)`, [courtA3, lessonDate]);
  const context = await readCustomerBookingEditContext(lesson.bookingId, lessonDate, memberId);
  const starts = new Map(context!.coaching!.starts.map(s => [s.startMinute, s.courts.map(c => c.id)]));
  expect(starts.has(720)).toBe(false);
  expect(starts.has(840)).toBe(false);
  const attempt = async (startMinute: number, courtId = courtA3) =>
    runBookingReschedule(await lessonEdit(lesson.bookingId, { courtId, date: lessonDate, startMinute, expectedTotal: 18000 }), memberId);
  expect(await attempt(720)).toEqual({ ok: false, message: "The coach is no longer available at the selected time. The booking has not changed." });
  expect(await attempt(840)).toEqual({ ok: false, message: "That court is no longer available. The booking has not changed." });
  expect(await attempt(960)).toEqual({ ok: false, message: "The coach is not available at the selected time." });
  // Another coach is never substituted when the lesson's coach can no longer teach it.
  const deauthorized = await lessonEdit(lesson.bookingId, { courtId: courtA3, date: lessonDate, startMinute: 600, expectedTotal: 18000 });
  await database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code='coach'", [coach]);
  try {
    await expect(readCustomerBookingEditContext(lesson.bookingId, lessonDate, memberId)).rejects.toThrow("no longer available for lessons");
    expect(await runBookingReschedule(deauthorized, memberId)).toEqual({ ok: false, message: "This lesson's coach is no longer available for lessons. Contact the club to rearrange it." });
  } finally {
    await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'coach')", [coach]);
  }
  const input = await lessonEdit(lesson.bookingId, { courtId: courtA3, date: lessonDate, startMinute: 600, expectedTotal: 18000 });
  try {
    // The snapshotted 120-minute notice closes editing; a started lesson never moves.
    for (const now of [`${lessonDate}T06:30:00.000Z`, `${lessonDate}T08:01:00.000Z`]) {
      clock.now = now;
      expect(await runBookingReschedule(input, memberId)).toEqual({ ok: false, message: "The rescheduling window for this booking has closed." });
    }
  } finally { clock.now = null; }
  const after = await aggregate(lesson.bookingId);
  expect(after).toMatchObject({ reservation_id: before.reservation_id, court_id: courtA3, starts_at_minute: 480, revision: { id: before.revision.id } });
});

test("a lesson surcharge holds the target for court and coach and settles the accepted quote without repricing", async () => {
  const lessonDate = "2100-09-20";
  const restorePricing = await peakLessonRental();
  try {
    const lesson = await confirmedLesson(480, lessonDate, { courtId: courtA3, expectedTotalAmountMinor: 18000 });
    const original = await aggregate(lesson.bookingId);
    await database.query("UPDATE public.coaching_programs SET court_rental_included=true WHERE id=$1", [program]);
    const result = await runBookingReschedule(await lessonEdit(lesson.bookingId,
      { courtId: courtA3, date: lessonDate, startMinute: 600, expectedTotal: 20000 }), memberId);
    expect(result).toMatchObject({ ok: true, totalAmountMinor: 20000, adjustmentStatus: "pending" });
    if (!result.ok || !result.adjustmentId || !result.checkout) throw new Error("No surcharge checkout");
    const adjustmentId = result.adjustmentId;
    // Pending: the original lesson stays and the target holds both court and coach.
    expect(await coachRows(lessonDate)).toEqual([
      { court_id: courtA3, starts_at_minute: 480, ends_at_minute: 540, status: "active", hold: false },
      { court_id: courtA3, starts_at_minute: 600, ends_at_minute: 660, status: "held", hold: true }]);
    expect(await book({ date: lessonDate, courtId: courtA3, startMinute: 600 })).toMatchObject({ ok: false, reason: "coach-booked" });
    await database.query("UPDATE public.coaching_prices SET amount_minor=30000 WHERE program_id=$1 AND coach_user_id=$2", [program, coach]);
    await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=9000 WHERE court_id=$1 AND weekday=$2", [courtA3, weekday]);
    const attempt = await adjustmentAttempt(database.manager, adjustmentId);
    assert.ok(attempt);
    expect(attempt.amountMinor).toBe(2000);
    const intent = remote(attempt.id);
    intent.status = "succeeded"; intent.amount_received = 2000;
    expect((await POST(coachingWebhook(attempt.id, "payment_intent.succeeded"))).status).toBe(200);
    const moved = await aggregate(lesson.bookingId);
    expect(moved).toMatchObject({ status: "confirmed", reservation_id: lesson.reservationId, court_id: courtA3, starts_at_minute: 600,
      coach_user_id: coach, reservation_status: "active" });
    expect(moved.revision).toMatchObject({ kind: "rescheduled", total_amount_minor: 20000, adjustment_id: adjustmentId, coach_user_id: coach });
    await expectLessonContract(lesson.bookingId, original);
    expect(moved.revision.pricing_evidence.coaching).toEqual({ ...original.revision.pricing_evidence.coaching,
      courtRentalMinor: 8000, courtAmountMinor: 8000 });
    expect(await database.query("SELECT status FROM public.booking_adjustments WHERE id=$1", [adjustmentId])).toEqual([{ status: "applied" }]);
    expect(await coachRows(lessonDate)).toEqual([{ court_id: courtA3, starts_at_minute: 600, ends_at_minute: 660, status: "active", hold: false }]);
    expect(await database.query("SELECT amount_minor,status FROM public.payment_attempts WHERE booking_id=$1 ORDER BY amount_minor", [lesson.bookingId]))
      .toEqual([{ amount_minor: 2000, status: "succeeded" }, { amount_minor: 18000, status: "succeeded" }]);
    expect(stripeFixture.refundCreate).not.toHaveBeenCalled();
    expect(await database.query("SELECT count(*)::int AS count FROM public.user_messages WHERE user_id=$1 AND event_key=$2",
      [coach, `coaching.rescheduled:${moved.revision.id}`])).toEqual([{ count: 1 }]);
  } finally {
    await database.query("UPDATE public.coaching_programs SET court_rental_included=false WHERE id=$1", [program]);
    await database.query("UPDATE public.coaching_prices SET amount_minor=12000 WHERE program_id=$1 AND coach_user_id=$2", [program, coach]);
    await restorePricing();
  }
});

test("a cheaper lesson move refunds only the court difference and keeps the captured payment and coaching evidence", async () => {
  const lessonDate = "2100-09-27";
  const restorePricing = await peakLessonRental();
  try {
    const lesson = await confirmedLesson(720, lessonDate, { courtId: courtA3, expectedTotalAmountMinor: 20000 });
    const original = await aggregate(lesson.bookingId);
    const [capture] = await database.query("SELECT * FROM public.payment_attempts WHERE id=$1", [lesson.paymentAttemptId]);
    const result = await runBookingReschedule(await lessonEdit(lesson.bookingId,
      { courtId: courtA3, date: lessonDate, startMinute: 480, expectedTotal: 18000 }), memberId);
    expect(result).toMatchObject({ ok: true, totalAmountMinor: 18000, adjustmentStatus: "applied", refundStatus: "succeeded" });
    expect(stripeFixture.refundCreate).toHaveBeenCalledTimes(1);
    expect(stripeFixture.refundCreate).toHaveBeenCalledWith(expect.objectContaining({ amount: 2000 }), expect.anything());
    const moved = await aggregate(lesson.bookingId);
    await expectLessonContract(lesson.bookingId, original);
    expect(moved).toMatchObject({ reservation_id: lesson.reservationId, court_id: courtA3, starts_at_minute: 480, coach_user_id: coach });
    expect(moved.revision).toMatchObject({ kind: "rescheduled", total_amount_minor: 18000, coach_user_id: coach, coaching_program_id: program });
    expect(moved.revision.pricing_evidence.coaching).toEqual({ ...original.revision.pricing_evidence.coaching,
      courtRentalMinor: 6000, courtAmountMinor: 6000 });
    expect(await database.query("SELECT amount_minor,status,reason FROM public.payment_refunds WHERE booking_id=$1", [lesson.bookingId]))
      .toEqual([{ amount_minor: 2000, status: "succeeded", reason: "booking_price_reduction" }]);
    expect(await database.query("SELECT * FROM public.payment_attempts WHERE id=$1", [lesson.paymentAttemptId])).toEqual([capture]);
    expect(await coachRows(lessonDate)).toEqual([{ court_id: courtA3, starts_at_minute: 480, ends_at_minute: 540, status: "active", hold: false }]);
    expect(await database.query("SELECT count(*)::int AS count FROM public.user_messages WHERE user_id=$1 AND event_key=$2",
      [coach, `coaching.rescheduled:${moved.revision.id}`])).toEqual([{ count: 1 }]);
  } finally { await restorePricing(); }
});

async function peakLessonRental() {
  const ids = await inTransaction(async manager => {
    const [rule] = await manager.query("SELECT * FROM public.location_pricing_rules WHERE court_id=$1 AND weekday=$2", [courtA3, weekday]);
    await manager.query("UPDATE public.location_pricing_rules SET ends_at_minute=600 WHERE id=$1", [rule.id]);
    const [peak] = await manager.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,
      starts_at_minute,ends_at_minute,price_per_hour_minor) VALUES($1,$2,$3,'outdoor',$4,600,1440,8000) RETURNING id`,
      [locationA, rule.rule_set_id, courtA3, weekday]);
    return { base: rule.id, peak: peak.id };
  });
  return () => inTransaction(async manager => {
    await manager.query("DELETE FROM public.location_pricing_rules WHERE id=$1", [ids.peak]);
    await manager.query("UPDATE public.location_pricing_rules SET ends_at_minute=1440,price_per_hour_minor=6000 WHERE id=$1", [ids.base]);
  });
}

// Check every immutable contractual field against persistence, including the untouched predecessor.
async function expectLessonContract(bookingId: string, original: Awaited<ReturnType<typeof aggregate>>) {
  const moved = await aggregate(bookingId);
  expect(moved.reservation_id).toBe(original.reservation_id);
  expect(moved.court_id).toBe(original.court_id);
  expect(moved.coach_user_id).toBe(original.coach_user_id);
  expect(moved.ends_at_minute - moved.starts_at_minute).toBe(original.ends_at_minute - original.starts_at_minute);
  for (const field of ["location_id", "court_id", "coach_user_id", "coaching_program_id", "customer_name", "customer_email",
    "customer_phone", "cancellation_notice_minutes", "payment_method", "currency"]) {
    expect(moved.revision[field], field).toEqual(original.revision[field]);
  }
  for (const field of ["durationMinutes", "participantCount", "amountMinor", "source", "courtRentalIncluded"]) {
    expect(moved.revision.pricing_evidence.coaching[field], field).toEqual(original.revision.pricing_evidence.coaching[field]);
  }
  const [historical] = await database.query("SELECT to_jsonb(v) AS revision FROM public.booking_revisions v WHERE id=$1", [original.revision.id]);
  expect(historical.revision).toEqual(original.revision);
}

test.each([60, 90, 120])("included court rental keeps the purchased total at a higher-priced time despite changed program policy (%i minutes)", async durationMinutes => {
  const lessonDate = { 60: "2100-10-11", 90: "2100-11-22", 120: "2100-11-29" }[durationMinutes]!;
  const total = durationMinutes * 250;
  const targetDate = durationMinutes === 120 ? "2100-12-06" : lessonDate;
  const restorePricing = await peakLessonRental();
  try {
    const lesson = await confirmedLesson(480, lessonDate, { programId: includedProgram, durationMinutes, expectedTotalAmountMinor: total });
    const original = await aggregate(lesson.bookingId);
    const calls = stripeCalls();
    await database.query("UPDATE public.coaching_programs SET court_rental_included=false WHERE id=$1", [includedProgram]);
    const result = await runBookingReschedule(await lessonEdit(lesson.bookingId,
      { courtId: courtA3, date: targetDate, startMinute: 600, expectedTotal: total }), memberId);
    expect(result).toEqual({ ok: true, totalAmountMinor: total });
    await expectLessonContract(lesson.bookingId, original);
    expect(await aggregate(lesson.bookingId)).toMatchObject({ booking_date: targetDate, starts_at_minute: 600, ends_at_minute: 600 + durationMinutes });
    expect((await aggregate(lesson.bookingId)).revision.pricing_evidence.coaching).toMatchObject({ courtAmountMinor: 0, courtRentalMinor: durationMinutes / 60 * 8000 });
    expect(stripeCalls()).toEqual(calls);
    expect(await database.query("SELECT id FROM public.payment_refunds WHERE booking_id=$1", [lesson.bookingId])).toEqual([]);
  } finally {
    await database.query("UPDATE public.coaching_programs SET court_rental_included=true WHERE id=$1", [includedProgram]);
    await restorePricing();
  }
});

test.each(["declined", "expired"])("an unpaid lesson surcharge leaves the original contract and occupancy intact: %s", async outcome => {
  const lessonDate = outcome === "declined" ? "2100-10-18" : "2100-10-25";
  const restorePricing = await peakLessonRental();
  try {
    const lesson = await confirmedLesson(480, lessonDate);
    const original = await aggregate(lesson.bookingId);
    const result = await runBookingReschedule(await lessonEdit(lesson.bookingId,
      { courtId: courtA3, date: lessonDate, startMinute: 600, expectedTotal: 20000 }), memberId);
    assert.ok(result.ok && result.adjustmentId && result.checkout);
    const attempt = await adjustmentAttempt(database.manager, result.adjustmentId);
    assert.ok(attempt);
    if (outcome === "declined") {
      expect(await settleOnlinePayment({ attemptId: attempt.id, provider: "stripe", providerPaymentId: remote(attempt.id).id,
        outcome: "retryable_failed" })).toBe("pending");
      expect((await aggregate(lesson.bookingId)).revision.id).toBe(original.revision.id);
      expect(await settleOnlinePayment({ attemptId: attempt.id, provider: "stripe", providerPaymentId: remote(attempt.id).id,
        outcome: "cancelled" })).toBe("cancelled");
    } else {
      await inTransaction(async manager => {
        await lockLocations(manager, [locationA]);
        const expiredAt = new Date(Date.now() - 60_000).toISOString();
        await setAdjustmentExpiryFixture(manager, result.adjustmentId!, expiredAt);
        await setPaymentAttemptExpiryFixture(manager, attempt.id, expiredAt);
        await manager.query("UPDATE public.court_reservations SET hold_expires_at=$2::timestamptz WHERE adjustment_id=$1 AND status='held'", [result.adjustmentId, expiredAt]);
        await expireAdjustmentsAtLocation(manager, locationA);
      });
    }
    expect((await aggregate(lesson.bookingId)).revision.id).toBe(original.revision.id);
    await expectLessonContract(lesson.bookingId, original);
    expect(await coachRows(lessonDate)).toEqual([{ court_id: courtA3, starts_at_minute: 480, ends_at_minute: 540, status: "active", hold: false }]);
    expect(stripeFixture.capture).toHaveBeenCalledTimes(1);
    expect(stripeFixture.refundCreate).not.toHaveBeenCalled();
  } finally { await restorePricing(); }
});

test.each(["failed", "uncertain"])("a lesson reduction preserves the original booking and refund obligation on a %s refund", async outcome => {
  const lessonDate = outcome === "failed" ? "2100-11-01" : "2100-11-08";
  const restorePricing = await peakLessonRental();
  try {
    const lesson = await confirmedLesson(720, lessonDate, { expectedTotalAmountMinor: 20000 });
    const original = await aggregate(lesson.bookingId);
    if (outcome === "uncertain") {
      const createRefund = stripeFixture.refundCreate.getMockImplementation()!;
      stripeFixture.refundCreate.mockImplementationOnce(async (...args) => {
        const accepted = await createRefund(...args);
        // Stripe accepted it; discovery recovers the exact execution after the lost response.
        stripeFixture.refundList.mockReturnValue([accepted]);
        throw new Error("Lost refund response");
      });
    }
    else {
      const createRefund = stripeFixture.refundCreate.getMockImplementation()!;
      stripeFixture.refundCreate.mockImplementationOnce(async (...args) => ({ ...await createRefund(...args), status: "failed", failure_reason: "lost_or_stolen_card" }));
    }
    const input = await lessonEdit(lesson.bookingId, { courtId: courtA3, date: lessonDate, startMinute: 480, expectedTotal: 18000 });
    const result = await runBookingReschedule(input, memberId);
    assert.ok(result.ok && result.adjustmentId && result.refundIds?.length === 1);
    expect(result).toMatchObject({ adjustmentStatus: outcome === "failed" ? "unsuccessful" : "pending",
      refundStatus: outcome === "failed" ? "failed" : "pending_retry" });
    expect((await aggregate(lesson.bookingId)).revision.id).toBe(original.revision.id);
    await expectLessonContract(lesson.bookingId, original);
    expect(stripeFixture.refundCreate).toHaveBeenCalledTimes(1);
    expect(await runBookingReschedule(input, memberId)).toMatchObject({ ok: true, adjustmentId: result.adjustmentId });
    await processBookingRefund(result.refundIds[0]);
    expect(stripeFixture.refundCreate).toHaveBeenCalledTimes(1);
    expect(await database.query("SELECT amount_minor,status FROM public.payment_refunds WHERE booking_id=$1", [lesson.bookingId]))
      .toEqual([{ amount_minor: 2000, status: outcome === "failed" ? "voided" : "succeeded" }]);
    expect((await aggregate(lesson.bookingId)).starts_at_minute).toBe(outcome === "failed" ? 720 : 480);
    await expectLessonContract(lesson.bookingId, original);
  } finally { stripeFixture.refundList.mockReturnValue([]); await restorePricing(); }
});

test("concurrent lesson moves create one surcharge and duplicate capture events apply it once", async () => {
  const lessonDate = "2100-11-15";
  const restorePricing = await peakLessonRental();
  try {
    const lesson = await confirmedLesson(480, lessonDate);
    // Both requests enter surcharge PaymentIntent creation before either attaches its intent:
    // the overlap that otherwise occurs only intermittently. A bounded wait keeps a missing
    // entry inside the test budget; the gate is always opened and the fixture restored.
    const create = stripeFixture.create.getMockImplementation()!;
    let entered = 0, open!: () => void;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const deadline = setTimeout(() => open(), 2000);
    stripeFixture.create.mockImplementation(async (...args) => {
      if (++entered === 2) open();
      await gate;
      return create(...args);
    });
    try {
      const original = await aggregate(lesson.bookingId);
      const input = await lessonEdit(lesson.bookingId, { courtId: courtA3, date: lessonDate, startMinute: 600, expectedTotal: 20000 });
      const results = await settled([runBookingReschedule(input, memberId), runBookingReschedule(input, memberId)]);
      expect(entered).toBe(2);
      expect(results.every(result => result.ok)).toBe(true);
      const result = results[0];
      assert.ok(result.ok && result.adjustmentId);
      expect(results[1]).toMatchObject({ adjustmentId: result.adjustmentId });
      const attempt = await adjustmentAttempt(database.manager, result.adjustmentId);
      assert.ok(attempt);
      expect(await database.query("SELECT amount_minor,provider_payment_id FROM public.payment_attempts WHERE adjustment_id=$1", [result.adjustmentId]))
        .toEqual([{ amount_minor: 2000, provider_payment_id: `pi_${attempt.id}` }]);
      // The original, then both initializations of the one surcharge attempt: the repeat carries the
      // same idempotency key and terms, so the provider returns the same intent rather than a second one.
      expect(stripeFixture.create.mock.calls.map(([params, options]) => [params.metadata.payment_attempt_id, params.amount, options.idempotencyKey]))
        .toEqual([[lesson.paymentAttemptId, 18000, `court-payment-${lesson.paymentAttemptId}`],
          [attempt.id, 2000, `court-payment-${attempt.id}`], [attempt.id, 2000, `court-payment-${attempt.id}`]]);
      expect([...stripeFixture.intents.keys()].sort()).toEqual([`pi_${lesson.paymentAttemptId}`, `pi_${attempt.id}`].sort());
      const intent = remote(attempt.id);
      intent.status = "succeeded"; intent.amount_received = 2000;
      const eventId = `evt_${randomUUID()}`;
      const responses = await settled([POST(coachingWebhook(attempt.id, "payment_intent.succeeded", eventId)),
        POST(coachingWebhook(attempt.id, "payment_intent.succeeded", eventId))]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      await expectLessonContract(lesson.bookingId, original);
      expect(await revisionCount(lesson.bookingId)).toBe(3);
      expect(await coachRows(lessonDate)).toEqual([{ court_id: courtA3, starts_at_minute: 600, ends_at_minute: 660, status: "active", hold: false }]);
      expect(stripeFixture.refundCreate).not.toHaveBeenCalled();
    } finally {
      clearTimeout(deadline); open();
      stripeFixture.create.mockImplementation(create);
    }
  } finally { await restorePricing(); }
}, 15000);
