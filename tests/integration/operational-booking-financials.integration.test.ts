import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { DataSource } from "typeorm";
import { afterAll, assert, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { cancelCustomerBookingCommand } from "@/lib/bookings/commands";
import type { OperationalCapacity, OperationalFinancialQuote } from "@/lib/bookings/operational-policy";
import { runOperationalBookingChange } from "@/lib/bookings/reschedule";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { inTransaction } from "@/lib/db/transaction";
import { processBookingRefund } from "@/lib/payments/refunds";
import { cleanupBookingEvidence, insertBookingRecords, insertCaptureReceiptFixture } from "../local/booking-fixtures";
import { ensureIntegrationAdminAnchor } from "./admin-anchor";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { settled } from "./concurrency";

// Simulated Stripe: only the refund call is reached by these workflows.
const { refundPayment } = vi.hoisted(() => ({ refundPayment: vi.fn() }));
vi.mock("@/lib/payments/providers", () => ({ onlinePaymentAdapter: async () => ({ refundPayment }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/reservations/revalidation", () => ({ revalidateCourtActivity: vi.fn() }));

// Staff operational changes with a financial consequence against real PostgreSQL. Location A
// (Europe/Bucharest, RON, open and priced all day): A1 5000/h, A3 7500/h, A4 4000/h; B (RON)
// B1 6000/h; E charges EUR. Coaches work at A 08:00–18:00; coach2 does not offer the program.
const service = localFixtureClient();
let database: DataSource;
let previousEmailSettings: { official_email: string; sender_name: string; emails_enabled: boolean } | undefined;
const userIds: string[] = [];
const [locationA, locationB, locationE] = [randomUUID(), randomUUID(), randomUUID()];
const [courtA1, courtA3, courtA4, courtB1, courtE1] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const courts = [courtA1, courtA3, courtA4, courtB1, courtE1];
const locations = [locationA, locationB, locationE];
const rates: Record<string, number> = { [courtA1]: 5000, [courtA3]: 7500, [courtA4]: 4000, [courtB1]: 6000, [courtE1]: 5000 };
const [program, otherProgram, includedProgram] = [randomUUID(), randomUUID(), randomUUID()];
let admin: string, coach: string, coach2: string, coach3: string, customer: string, customerEmail: string;
const fee = 10000;

async function account(roles: ("coach" | "admin")[] = []) {
  const email = `operational-financial-${randomUUID()}@example.test`;
  const { data, error } = await service.auth.admin.createUser({ email, password: "operational-password-123", email_confirm: true });
  assert.strictEqual(error, null); assert.ok(data.user);
  userIds.push(data.user.id);
  for (const role of roles) await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,$2)", [data.user.id, role]);
  return { id: data.user.id, email };
}

beforeAll(async () => {
  expect(process.env.TEST_SUPABASE_PROJECT).toBe("tennis-club-tests");
  database = await getDataSource();
  [previousEmailSettings] = await database.query("SELECT official_email,sender_name,emails_enabled FROM public.club_settings WHERE id=true");
  await database.query("UPDATE public.club_settings SET official_email='',sender_name='',emails_enabled=false WHERE id=true");
  await ensureIntegrationAdminAnchor(service);
  admin = (await account(["admin"])).id;
  coach = (await account(["coach"])).id;
  coach2 = (await account(["coach"])).id;
  coach3 = (await account(["coach"])).id;
  ({ id: customer, email: customerEmail } = await account());
  await database.query(`INSERT INTO public.locations(id,name,slug,timezone,currency,is_active,is_public) VALUES
    ($1,'Financial A',($1::uuid)::text,'Europe/Bucharest','RON',true,true),($2,'Financial B',($2::uuid)::text,'Europe/Bucharest','RON',true,true),
    ($3,'Financial E',($3::uuid)::text,'Europe/Bucharest','EUR',true,true)`, locations);
  await database.query(`INSERT INTO public.courts(id,location_id,name,slug,surface,environment,is_active) VALUES
    ($1,$6,'A1','a1','clay','outdoor',true),($2,$6,'A3','a3','clay','outdoor',true),($3,$6,'A4','a4','clay','outdoor',true),
    ($4,$7,'B1','b1','clay','outdoor',true),($5,$8,'E1','e1','clay','outdoor',true)`, [...courts, ...locations]);
  for (const location of locations) {
    const [schedule] = await database.query("INSERT INTO public.opening_hours_schedules(location_id,starts_on) VALUES($1,'2000-01-01') RETURNING id", [location]);
    await database.query(`INSERT INTO public.location_opening_hours(location_id,schedule_id,weekday,opens_at_minute,closes_at_minute)
      SELECT $1,$2,weekday,0,1440 FROM generate_series(0,6) AS weekday`, [location, schedule.id]);
    const [ruleSet] = await database.query("INSERT INTO public.pricing_rule_sets(location_id) VALUES($1) RETURNING id", [location]);
    await database.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
      SELECT $1,$2,c.id,'outdoor',weekday,0,1440,($3::jsonb->>(c.id::text))::int FROM generate_series(0,6) AS weekday, public.courts c
      WHERE c.location_id=$1`, [location, ruleSet.id, JSON.stringify(rates)]);
  }
  await database.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,min_participants,max_participants,court_rental_included,is_active) VALUES
    ($1,'Financial private','','private',1,1,false,true),($2,'Financial other','','private',1,1,false,true),
    ($3,'Financial court included','','private',1,1,true,true)`, [program, otherProgram, includedProgram]);
  await database.query("INSERT INTO public.coaching_program_durations(program_id,duration_minutes) VALUES($1,60),($2,60),($3,60)",
    [program, otherProgram, includedProgram]);
  await database.query(`INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages,is_public) VALUES
    ($1,'Financial Coach','','','{}','{}',true),($2,'Second Financial Coach','','','{}','{}',true),
    ($3,'Third Financial Coach','','','{}','{}',true)`, [coach, coach2, coach3]);
  await database.query("INSERT INTO public.coach_programs(coach_user_id,program_id) VALUES($1,$3),($2,$4),($5,$3),($1,$6)",
    [coach, coach2, program, otherProgram, coach3, includedProgram]);
  await database.query("INSERT INTO public.coach_locations(coach_user_id,location_id) SELECT unnest($1::uuid[]),$2", [[coach, coach2, coach3], locationA]);
  await database.query(`INSERT INTO public.coach_weekly_availability(coach_user_id,location_id,weekday,start_minute,end_minute,valid_from)
    SELECT c,$2,d,480,1080,'2000-01-01' FROM unnest($1::uuid[]) c CROSS JOIN generate_series(0,6) d`, [[coach, coach2, coach3], locationA]);
});

const bookingIds: string[] = [];

async function removeFixtures() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await inTransaction(async manager => {
        await manager.query("SET LOCAL lock_timeout = '2s'");
        // Admin alerts of the persistent anchor account name these bookings' financial records.
        await manager.query(`DELETE FROM public.user_messages m WHERE EXISTS (SELECT 1 FROM public.payment_refunds f
            WHERE f.booking_id=ANY($1::uuid[]) AND strpos(m.event_key,f.id::text)>0)
          OR EXISTS (SELECT 1 FROM public.booking_adjustments a WHERE a.booking_id=ANY($1::uuid[]) AND strpos(m.event_key,a.id::text)>0)`, [bookingIds]);
        await cleanupBookingEvidence(manager, { courtIds: courts });
        await manager.query("DELETE FROM public.court_reservations WHERE court_id=ANY($1::uuid[])", [courts]);
        await manager.query("DELETE FROM public.coach_weekly_availability WHERE coach_user_id=ANY($1::uuid[])", [userIds]);
        await manager.query("DELETE FROM public.coach_programs WHERE coach_user_id=ANY($1::uuid[])", [userIds]);
        await manager.query("DELETE FROM public.coach_locations WHERE coach_user_id=ANY($1::uuid[])", [userIds]);
        await manager.query("DELETE FROM public.coach_profiles WHERE user_id=ANY($1::uuid[])", [userIds]);
        await manager.query("DELETE FROM public.coaching_program_durations WHERE program_id=ANY($1::uuid[])", [[program, otherProgram, includedProgram]]);
        await manager.query("DELETE FROM public.coaching_programs WHERE id=ANY($1::uuid[])", [[program, otherProgram, includedProgram]]);
        await manager.query("DELETE FROM public.location_pricing_rules WHERE location_id=ANY($1::uuid[])", [locations]);
        await manager.query("DELETE FROM public.pricing_rule_sets WHERE location_id=ANY($1::uuid[])", [locations]);
        await manager.query("DELETE FROM public.location_opening_hours WHERE location_id=ANY($1::uuid[])", [locations]);
        await manager.query("DELETE FROM public.opening_hours_schedules WHERE location_id=ANY($1::uuid[])", [locations]);
        await manager.query("DELETE FROM public.courts WHERE location_id=ANY($1::uuid[])", [locations]);
        await manager.query("DELETE FROM public.locations WHERE id=ANY($1::uuid[])", [locations]);
      });
    } catch (error) {
      if (attempt === 3 || !["55P03", "40P01", "23503"].includes(normalizeDatabaseError(error).sqlState ?? "")) throw error;
      await sleep(250);
    }
  }
}

afterAll(async () => {
  if (!database) return;
  try {
    if (previousEmailSettings) await database.query("UPDATE public.club_settings SET official_email=$1,sender_name=$2,emails_enabled=$3 WHERE id=true",
      [previousEmailSettings.official_email, previousEmailSettings.sender_name, previousEmailSettings.emails_enabled]);
    await removeFixtures();
    await cleanupAuthFixtures(service, userIds);
  } finally {
    await database.destroy();
  }
}, 30000);

beforeEach(() => {
  refundPayment.mockReset();
  refundPayment.mockImplementation(async (request: { id: string }) => ({ status: "succeeded", providerRefundId: `re_${request.id}` }));
});

let dayOffset = 0;
const nextDate = () => new Date(Date.UTC(2107, 0, 4 + 7 * dayOffset++)).toISOString().slice(0, 10);

// Verified Stripe captures of the booking, oldest first: succeeded attempts with exact receipts.
async function capture(bookingId: string, amounts: number[]) {
  await inTransaction(async manager => {
    for (const [index, amount] of amounts.entries()) {
      const attempt = randomUUID();
      await manager.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,
          expires_at,completed_at,created_at)
        VALUES($1,$2,'online','stripe',$3,$4,'RON','succeeded',clock_timestamp(),clock_timestamp(),clock_timestamp()-make_interval(mins => $5))`,
      [attempt, bookingId, `pi_${attempt}`, amount, amounts.length - index]);
      await insertCaptureReceiptFixture(manager, { paymentAttemptId: attempt, providerPaymentId: `pi_${attempt}`,
        providerCaptureId: `ch_${attempt}`, amountMinor: amount, currency: "RON" });
    }
  });
}

// A court booking priced at its court's rate; an online one is fully captured (in parts when given).
async function courtBooking(courtId: string, date: string, options: { startMinute?: number; hours?: number;
  paymentMethod?: "online" | "pay_at_club"; captures?: number[] } = {}) {
  const { startMinute = 600, hours = 1, paymentMethod = "online" } = options;
  const reservationId = randomUUID(), bookingId = randomUUID(), total = rates[courtId] * hours;
  await inTransaction(async manager => {
    await manager.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,'active',$6)`, [reservationId, courtId, date, startMinute, startMinute + 60 * hours, customer]);
    await insertBookingRecords(manager, { id: bookingId, reservation_id: reservationId, account_user_id: customer, customer_name: "Financial Customer",
      customer_email: customerEmail, customer_phone: "+40 700", total_amount_minor: total, currency: "RON",
      payment_method: paymentMethod, cancellation_notice_minutes: 1440 });
  });
  bookingIds.push(bookingId);
  if (paymentMethod === "online") await capture(bookingId, options.captures ?? [total]);
  return bookingId;
}

// An online lesson whose program does not include court rental: the agreed coaching fee plus
// its court's rental, agreed with the given coach at location A. agreedRental other than the
// court's current rate is a price agreed under earlier pricing: below it, any moved placement
// on that court is a refund-backed reduction. included: a program whose fee includes the rental.
async function lesson(lessonCoach: string, date: string, courtId = courtA3, startMinute = 600, agreedRental = rates[courtId],
  included = false) {
  const reservationId = randomUUID(), bookingId = randomUUID(), rental = agreedRental, courtAmount = included ? 0 : rental;
  const slots = [startMinute, startMinute + 30].map(minute => ({ minute, ruleId: randomUUID(), ruleSetId: randomUUID(), hourlyMinor: rental,
    startsOn: null, endsOn: null }));
  const evidence = { version: 1, rounding: "half-hour-sum-round", courtState: "outdoor", slots,
    coaching: { participantCount: 1, pricePerPersonMinor: fee, programId: included ? includedProgram : program, coachUserId: lessonCoach,
      locationId: locationA, durationMinutes: 60, source: "coach", amountMinor: fee, currency: "RON", courtRentalIncluded: included,
      courtRentalMinor: rental, courtAmountMinor: courtAmount } };
  await inTransaction(async manager => {
    await manager.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,coach_user_id,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,'active',$6,$7)`, [reservationId, courtId, date, startMinute, startMinute + 60, lessonCoach, customer]);
    await insertBookingRecords(manager, { id: bookingId, reservation_id: reservationId, account_user_id: customer, customer_name: "Financial Customer",
      customer_email: customerEmail, customer_phone: "+40 700", total_amount_minor: fee + courtAmount, currency: "RON", payment_method: "online",
      cancellation_notice_minutes: 1440, pricing_evidence: evidence,
      coaching: { coach_user_id: lessonCoach, coaching_program_id: included ? includedProgram : program, coach_name: "Agreed Coach",
        coaching_program_name: included ? "Financial court included" : "Financial private" } });
  });
  bookingIds.push(bookingId);
  await capture(bookingId, [fee + courtAmount]);
  return bookingId;
}

async function state(bookingId: string) {
  const [row] = await database.query(`SELECT r.court_id,r.booking_date::text AS date,r.starts_at_minute,r.coach_user_id,r.status,
      to_json(r.updated_at)#>>'{}' AS updated_at,b.current_revision_id,v.total_amount_minor AS total,
      (SELECT count(*)::int FROM public.booking_revisions x WHERE x.booking_id=b.id) AS revisions,
      (SELECT count(*)::int FROM public.booking_adjustments a WHERE a.booking_id=b.id) AS adjustments,
      (SELECT count(*)::int FROM public.payment_attempts p WHERE p.booking_id=b.id) AS attempts,
      (SELECT count(*)::int FROM public.payment_refunds f WHERE f.booking_id=b.id) AS refunds,
      (SELECT count(*)::int FROM public.court_reservations h JOIN public.booking_adjustments a ON a.id=h.adjustment_id
        WHERE a.booking_id=b.id AND h.status='held') AS holds
    FROM public.checkout_records b JOIN public.court_reservations r ON r.id=b.reservation_id
    JOIN public.booking_revisions v ON v.id=b.current_revision_id WHERE b.id=$1`, [bookingId]);
  return row as { court_id: string; date: string; starts_at_minute: number; coach_user_id: string | null; status: string; updated_at: string;
    current_revision_id: string; total: number; revisions: number; adjustments: number; attempts: number; refunds: number; holds: number };
}
const currentRevision = async (bookingId: string) => (await database.query(`SELECT to_jsonb(v) AS revision FROM public.booking_revisions v
  JOIN public.checkout_records b ON b.current_revision_id=v.id WHERE b.id=$1`, [bookingId]))[0].revision;
const refunds = async (bookingId: string) => database.query(`SELECT f.amount_minor,f.status,f.reason,f.adjustment_id,f.payment_attempt_id,
    p.amount_minor AS captured FROM public.payment_refunds f JOIN public.payment_attempts p ON p.id=f.payment_attempt_id
  WHERE f.booking_id=$1 ORDER BY f.created_at,f.amount_minor`, [bookingId]) as Promise<{ amount_minor: number; status: string; reason: string;
    adjustment_id: string; payment_attempt_id: string; captured: number }[]>;
const adjustmentsOf = async (bookingId: string) => database.query(`SELECT id,status,scope,original_total,new_total,target
  FROM public.booking_adjustments WHERE booking_id=$1 ORDER BY created_at`, [bookingId]) as Promise<{ id: string; status: string; scope: string;
    original_total: number; new_total: number; target: Record<string, unknown> & { destinationTotalMinor?: number } }[]>;
// The customer's in-app notifications about the booking, oldest first.
const notices = async (bookingId: string) => database.query(`SELECT m.kind,m.body_text,m.event_key FROM public.user_messages m
  WHERE m.user_id=$1 AND (strpos(m.href,$2::text)>0 OR EXISTS (SELECT 1 FROM public.booking_adjustments a WHERE a.booking_id=$2::uuid
    AND strpos(m.event_key,a.id::text)>0)) ORDER BY m.created_at,m.kind`, [customer, bookingId]) as Promise<{ kind: string; body_text: string; event_key: string }[]>;
// Formatted money separates the currency with a non-breaking space.
const money = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s"));

type Target = { locationId: string; courtId: string; date: string; startMinute: number; coachUserId?: string; requestId?: string; save?: boolean;
  // true: accept the consequence this actor's preview quotes; otherwise the given acceptance.
  accept?: true | OperationalFinancialQuote };
async function change(bookingId: string, actor: string, capacity: OperationalCapacity, target: Target, base?: Awaited<ReturnType<typeof state>>) {
  const current = base ?? await state(bookingId);
  const { accept, ...destination } = target;
  const input = { id: bookingId, expectedRevisionId: current.current_revision_id, expectedUpdatedAt: current.updated_at,
    overrideCoachRestrictions: false, save: true, ...destination };
  let financialAcceptance = accept === true ? undefined : accept;
  if (accept === true) {
    const preview = await runOperationalBookingChange({ ...input, save: false }, actor, capacity);
    assert(preview.ok && preview.financial, "preview has a financial quote");
    financialAcceptance = preview.financial;
  }
  return runOperationalBookingChange({ ...input, ...(financialAcceptance ? { financialAcceptance } : {}) }, actor, capacity);
}
const quote = (consequence: OperationalFinancialQuote["consequence"], amounts: Partial<OperationalFinancialQuote>): OperationalFinancialQuote =>
  ({ consequence, currency: "RON", currentAmountMinor: 0, destinationAmountMinor: 0, customerAmountMinor: 0, refundMinor: 0, absorbedMinor: 0, ...amounts });

describe("equal and higher destination prices", () => {
  test("an equal price reschedules without any financial operation", async () => {
    const date = nextDate(), booking = await courtBooking(courtA1, date);
    const original = await currentRevision(booking);
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 720 })).toMatchObject({
      ok: true, changed: true, totalAmountMinor: 5000,
      financial: quote("none", { currentAmountMinor: 5000, destinationAmountMinor: 5000, customerAmountMinor: 5000 }) });
    expect(await state(booking)).toMatchObject({ starts_at_minute: 720, total: 5000, adjustments: 0, attempts: 1, refunds: 0 });
    expect(await currentRevision(booking)).toMatchObject({ adjustment_id: null, pricing_evidence: original.pricing_evidence });
    const [notice] = await notices(booking);
    expect(notice).toMatchObject({ kind: "booking.rescheduled", body_text: expect.stringMatching(/Total price \(unchanged\): RON\s50\.00$/) });
    expect(refundPayment).not.toHaveBeenCalled();
  });

  test("a dearer destination is absorbed by the club after explicit acceptance", async () => {
    const date = nextDate(), booking = await courtBooking(courtA1, date);
    const before = await state(booking), original = await currentRevision(booking);
    const absorbed = quote("club_absorbs", { currentAmountMinor: 5000, destinationAmountMinor: 7500, customerAmountMinor: 5000, absorbedMinor: 2500 });
    // Unaccepted, the change is refused with the quote and writes nothing.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA3, date, startMinute: 600 }))
      .toEqual({ ok: false, reason: "financial_confirmation_required", financial: absorbed });
    expect(await state(booking)).toEqual(before);
    const result = await change(booking, admin, "admin", { locationId: locationA, courtId: courtA3, date, startMinute: 600, accept: absorbed });
    expect(result).toMatchObject({ ok: true, changed: true, totalAmountMinor: 5000, financial: absorbed, adjustmentStatus: "applied" });
    // The obligation, payments and commercial provenance are kept; no payment or refund exists.
    expect(await state(booking)).toMatchObject({ court_id: courtA3, total: 5000, revisions: 2, adjustments: 1, attempts: 1, refunds: 0, holds: 0 });
    const revision = await currentRevision(booking);
    expect(revision).toMatchObject({ total_amount_minor: 5000, pricing_evidence: original.pricing_evidence, actor_scope: "admin" });
    // The applied decision records the destination price and its evidence beside the revision.
    const [decision] = await adjustmentsOf(booking);
    assert(result.ok);
    expect(decision).toMatchObject({ id: result.adjustmentId, status: "applied", scope: "admin", original_total: 5000, new_total: 5000,
      target: { courtId: courtA3, locationId: locationA, destinationTotalMinor: 7500, actorScope: "admin",
        pricingEvidence: { slots: [{ hourlyMinor: 7500 }, { hourlyMinor: 7500 }] } } });
    expect(revision.adjustment_id).toBe(decision.id);
    const [notice] = await notices(booking);
    expect(notice.kind).toBe("booking.rescheduled");
    expect(notice.body_text).toMatch(money("Total price (unchanged): RON 50.00"));
    expect(notice.body_text).toMatch(money("The club covers the difference of RON 25.00; no additional payment is required."));
    expect(refundPayment).not.toHaveBeenCalled();
  });

  test("a stale or tampered financial acceptance is refused without changing anything", async () => {
    const date = nextDate(), booking = await courtBooking(courtA1, date);
    const before = await state(booking);
    const accepted = quote("club_absorbs", { currentAmountMinor: 5000, destinationAmountMinor: 7500, customerAmountMinor: 5000, absorbedMinor: 2500 });
    // Client totals are never trusted: a forged consequence or amount is a changed quote.
    for (const forged of [{ ...accepted, absorbedMinor: 0, destinationAmountMinor: 5000, consequence: "none" as const },
      { ...accepted, customerAmountMinor: 4000 }, quote("refund", { currentAmountMinor: 5000, destinationAmountMinor: 4000, customerAmountMinor: 4000, refundMinor: 1000 })])
      expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA3, date, startMinute: 600, accept: forged }))
        .toEqual({ ok: false, reason: "financial_changed", financial: accepted });
    // The destination's price changes after the quote was accepted.
    await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=8000 WHERE court_id=$1", [courtA3]);
    try {
      expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA3, date, startMinute: 600, accept: accepted }))
        .toEqual({ ok: false, reason: "financial_changed", financial: { ...accepted, destinationAmountMinor: 8000, absorbedMinor: 3000 } });
    } finally {
      await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=7500 WHERE court_id=$1", [courtA3]);
    }
    // A stale booking revision is refused before any quote is applied.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA3, date, startMinute: 600, accept: accepted },
      { ...before, current_revision_id: randomUUID() })).toEqual({ ok: false, reason: "stale" });
    expect(await state(booking)).toEqual(before);
    // Another currency's location is never a destination.
    expect(await change(booking, admin, "admin", { locationId: locationE, courtId: courtE1, date, startMinute: 600 }))
      .toEqual({ ok: false, reason: "cross_currency" });
    expect(await state(booking)).toEqual(before);
  });
});

describe("lower destination prices", () => {
  test("a reduction refunds the difference once Stripe verifies it, then applies the change", async () => {
    const date = nextDate(), booking = await courtBooking(courtA3, date);
    const reduced = quote("refund", { currentAmountMinor: 7500, destinationAmountMinor: 4000, customerAmountMinor: 4000, refundMinor: 3500 });
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 600, save: false }))
      .toMatchObject({ ok: true, changed: true, totalAmountMinor: 4000, financial: reduced });
    const result = await change(booking, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 600, accept: reduced });
    expect(result).toMatchObject({ ok: true, changed: true, totalAmountMinor: 4000, adjustmentStatus: "applied", refundStatus: "succeeded" });
    expect(refundPayment).toHaveBeenCalledOnce();
    expect(refundPayment).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 3500, currency: "RON", operation: "create" }));
    expect(await state(booking)).toMatchObject({ court_id: courtA4, total: 4000, revisions: 2, adjustments: 1, attempts: 1, refunds: 1, holds: 0 });
    expect(await refunds(booking)).toMatchObject([{ amount_minor: 3500, status: "succeeded", reason: "booking_price_reduction" }]);
    // The revision carries the destination evidence and the refund-backed decision.
    const revision = await currentRevision(booking);
    expect(revision).toMatchObject({ kind: "rescheduled", actor_scope: "admin", total_amount_minor: 4000,
      pricing_evidence: { slots: [{ hourlyMinor: 4000 }, { hourlyMinor: 4000 }] } });
    assert(result.ok); expect(revision.adjustment_id).toBe(result.adjustmentId);
    expect(revision.id).toBe(result.revisionId);
    // Requested, then completed with the verified amount; the refund itself is not announced twice.
    const [requested, completed, ...others] = await notices(booking);
    expect(others).toEqual([]);
    expect(requested).toMatchObject({ kind: "booking.change_refund_requested", event_key: `booking.change_refund_requested:${result.adjustmentId}` });
    expect(requested.body_text).toMatch(money("A refund of RON 35.00 has been requested."));
    expect(requested.body_text).toMatch(/Until then your current booking remains in place/);
    expect(completed).toMatchObject({ kind: "booking.rescheduled" });
    expect(completed.body_text).toMatch(money("New total: RON 40.00"));
    expect(completed.body_text).toMatch(money("The price reduction refund of RON 35.00 completed."));
    // A replayed refund webhook and a replayed request create nothing new.
    const [refund] = await database.query("SELECT id FROM public.payment_refunds WHERE booking_id=$1", [booking]);
    expect(await processBookingRefund(refund.id, { providerChanged: true })).toBe("succeeded");
    // The exact request, replayed against its original base, reports the applied revision.
    const original = (await database.query("SELECT previous_revision_id FROM public.booking_revisions WHERE id=$1", [revision.id]))[0];
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 600, accept: reduced },
      { ...await state(booking), current_revision_id: original.previous_revision_id }))
      .toEqual({ ok: true, changed: true, totalAmountMinor: 4000, revisionId: revision.id });
    expect(refundPayment).toHaveBeenCalledTimes(2);
    expect(await state(booking)).toMatchObject({ revisions: 2, adjustments: 1, refunds: 1 });
    expect(await notices(booking)).toHaveLength(2);
  });

  test("an uncertain refund keeps the original booking and blocks competing edits until it is verified", async () => {
    const date = nextDate(), booking = await courtBooking(courtA3, date), requestId = randomUUID();
    const base = await state(booking);
    // Stripe stays unreachable until the test verifies the refund.
    refundPayment.mockRejectedValue(new Error("network response lost"));
    const target = { locationId: locationA, courtId: courtA4, date, startMinute: 720, requestId, accept: true as const };
    const pending = await change(booking, admin, "admin", target, base);
    expect(pending).toMatchObject({ ok: true, changed: false, totalAmountMinor: 7500, adjustmentStatus: "pending", refundStatus: "pending_retry" });
    assert(pending.ok && pending.refundIds);
    // The original booking and reservation remain; the target is held for the change.
    expect(await state(booking)).toMatchObject({ court_id: courtA3, starts_at_minute: 600, total: 7500, revisions: 1, adjustments: 1, refunds: 1, holds: 1 });
    // Competing staff or customer changes cannot overwrite the pending refund-backed change.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 900, accept: quote("refund", {}) }))
      .toEqual({ ok: false, reason: "change_pending" });
    expect(await cancelCustomerBookingCommand(booking, customer, "owner")).toEqual({ outcome: "change_pending" });
    // The exact request replays its pending state without another refund.
    expect(await change(booking, admin, "admin", { ...target, accept: pending.financial! }, base))
      .toMatchObject({ ok: true, changed: false, adjustmentId: pending.adjustmentId, adjustmentStatus: "pending", refundIds: pending.refundIds });
    expect(await state(booking)).toMatchObject({ adjustments: 1, refunds: 1 });
    expect((await notices(booking)).map(notice => notice.kind)).toEqual(["booking.change_refund_requested"]);
    // The later verified refund (webhook or Admin check) applies the change exactly once.
    refundPayment.mockImplementation(async (request: { id: string }) => ({ status: "succeeded", providerRefundId: `re_${request.id}` }));
    expect(await processBookingRefund(pending.refundIds[0])).toBe("succeeded");
    expect(await processBookingRefund(pending.refundIds[0])).toBe("succeeded");
    expect(await state(booking)).toMatchObject({ court_id: courtA4, starts_at_minute: 720, total: 4000, revisions: 2, refunds: 1, holds: 0 });
    expect((await notices(booking)).map(notice => notice.kind)).toEqual(["booking.change_refund_requested", "booking.rescheduled"]);
    // Replaying the original request now reports the applied revision.
    expect(await change(booking, admin, "admin", { ...target, accept: pending.financial! }, base))
      .toMatchObject({ ok: true, changed: true, totalAmountMinor: 4000, revisionId: (await state(booking)).current_revision_id });
  });

  test("a definitively failed refund abandons the change and notifies the customer", async () => {
    const date = nextDate(), booking = await courtBooking(courtA3, date);
    const before = await state(booking);
    refundPayment.mockResolvedValueOnce({ status: "failed", providerRefundId: `re_${randomUUID()}`, retryable: false, failureReason: "charge_disputed" });
    const result = await change(booking, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 600, accept: true });
    expect(result).toMatchObject({ ok: true, changed: false, adjustmentStatus: "unsuccessful", refundStatus: "failed" });
    expect(await state(booking)).toMatchObject({ court_id: courtA3, total: 7500, revisions: 1, adjustments: 1, refunds: 1, holds: 0,
      current_revision_id: before.current_revision_id });
    expect(await refunds(booking)).toMatchObject([{ amount_minor: 3500, status: "voided" }]);
    expect((await notices(booking)).map(notice => notice.kind)).toEqual(["booking.change_refund_requested", "financial.modification_rejected"]);
    expect((await notices(booking))[1].body_text).toMatch(money("Amount involved: RON 35.00"));
    // Replaying the same request reports its decision; a new request may try again.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 600, accept: true }))
      .toMatchObject({ ok: true, changed: false, adjustmentStatus: "unsuccessful" });
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 600, requestId: randomUUID(), accept: true }))
      .toMatchObject({ ok: true, changed: true, adjustmentStatus: "applied", refundStatus: "succeeded" });
    expect(await refunds(booking)).toMatchObject([{ amount_minor: 3500, status: "voided" }, { amount_minor: 3500, status: "succeeded" }]);
  });

  test("multiple captures, partial refunds and repeated changes never reinstate waived amounts or refund twice", async () => {
    // Two hours at A3 (15000) paid by an original capture of 10000 and a later one of 5000.
    const date = nextDate(), booking = await courtBooking(courtA3, date, { hours: 2, captures: [10000, 5000] });
    // Partial failure: the newest capture's refund fails, the older one succeeds.
    const [older, newer] = (await database.query("SELECT id,amount_minor FROM public.payment_attempts WHERE booking_id=$1 ORDER BY created_at", [booking]));
    refundPayment.mockImplementation(async (request: { id: string; providerPaymentId: string }) => request.providerPaymentId === `pi_${newer.id}`
      ? { status: "failed", providerRefundId: `re_${request.id}`, retryable: false } : { status: "succeeded", providerRefundId: `re_${request.id}` });
    const first = await change(booking, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 600, accept: true });
    // 15000 → 8000: the 7000 refund draws the newest capture first.
    expect(first).toMatchObject({ ok: true, changed: false, adjustmentStatus: "pending", refundStatus: "failed",
      financial: { refundMinor: 7000, customerAmountMinor: 8000 } });
    expect(await refunds(booking)).toEqual(expect.arrayContaining([
      expect.objectContaining({ amount_minor: 5000, payment_attempt_id: newer.id, status: "failed" }),
      expect.objectContaining({ amount_minor: 2000, payment_attempt_id: older.id, status: "succeeded" })]));
    // Partial repayment cannot be undone: the original booking stays and the failure is announced.
    expect(await state(booking)).toMatchObject({ court_id: courtA3, total: 15000, revisions: 1, holds: 1 });
    expect((await notices(booking)).map(notice => notice.kind)).toEqual(["booking.change_refund_requested", "financial.refund_failed"]);
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 600, accept: quote("refund", {}) }))
      .toEqual({ ok: false, reason: "change_pending" });
    await database.query("DELETE FROM public.user_messages WHERE user_id=$1", [customer]);

    // A second booking completes the reduction, then is moved repeatedly.
    refundPayment.mockClear();
    refundPayment.mockImplementation(async (request: { id: string }) => ({ status: "succeeded", providerRefundId: `re_${request.id}` }));
    const repeated = await courtBooking(courtA3, nextDate(), { hours: 2, captures: [10000, 5000] });
    const day = (await state(repeated)).date;
    expect(await change(repeated, admin, "admin", { locationId: locationA, courtId: courtA4, date: day, startMinute: 600, accept: true }))
      .toMatchObject({ ok: true, changed: true, totalAmountMinor: 8000, adjustmentStatus: "applied", refundStatus: "succeeded" });
    // 8000 → A3 (15000): the club absorbs 7000; the reduced obligation is never reinstated.
    expect(await change(repeated, admin, "admin", { locationId: locationA, courtId: courtA3, date: day, startMinute: 600, accept: true }))
      .toMatchObject({ ok: true, changed: true, totalAmountMinor: 8000,
        financial: { consequence: "club_absorbs", currentAmountMinor: 8000, destinationAmountMinor: 15000, absorbedMinor: 7000 } });
    // 8000 → A1 (10000): still absorbed, never a charge.
    expect(await change(repeated, admin, "admin", { locationId: locationA, courtId: courtA1, date: day, startMinute: 600, accept: true }))
      .toMatchObject({ ok: true, totalAmountMinor: 8000, financial: { consequence: "club_absorbs", absorbedMinor: 2000 } });
    // 8000 → A4 at another time (8000): equal, no financial operation.
    expect(await change(repeated, admin, "admin", { locationId: locationA, courtId: courtA4, date: day, startMinute: 720 }))
      .toMatchObject({ ok: true, changed: true, totalAmountMinor: 8000, financial: { consequence: "none" } });
    // Only the one 7000 refund ever existed: collected 15000, refunded 7000, obligation 8000.
    const repeatedRefunds = await refunds(repeated);
    expect(repeatedRefunds).toHaveLength(2);
    expect(repeatedRefunds).toEqual(expect.arrayContaining([expect.objectContaining({ amount_minor: 5000, status: "succeeded" }),
      expect.objectContaining({ amount_minor: 2000, status: "succeeded" })]));
    expect(await state(repeated)).toMatchObject({ total: 8000, revisions: 5, adjustments: 3, attempts: 2, refunds: 2 });
    expect(refundPayment).toHaveBeenCalledTimes(2);
    expect((await adjustmentsOf(repeated)).map(row => [row.status, row.original_total, row.new_total, row.target.destinationTotalMinor]))
      .toEqual([["applied", 15000, 8000, 8000], ["applied", 8000, 8000, 15000], ["applied", 8000, 8000, 10000]]);
    expect((await notices(repeated)).map(notice => notice.kind)).toEqual(["booking.change_refund_requested", "booking.rescheduled",
      "booking.rescheduled", "booking.rescheduled", "booking.rescheduled"]);
  });

  test("a pay-at-club booking owes less instead of being refunded", async () => {
    const date = nextDate(), booking = await courtBooking(courtA3, date, { paymentMethod: "pay_at_club" });
    const reduced = quote("amount_reduced", { currentAmountMinor: 7500, destinationAmountMinor: 4000, customerAmountMinor: 4000 });
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 600, accept: reduced }))
      .toMatchObject({ ok: true, changed: true, totalAmountMinor: 4000, financial: reduced });
    expect(await state(booking)).toMatchObject({ court_id: courtA4, total: 4000, adjustments: 0, attempts: 0, refunds: 0 });
    expect(await currentRevision(booking)).toMatchObject({ total_amount_minor: 4000, payment_method: "pay_at_club",
      pricing_evidence: { slots: [{ hourlyMinor: 4000 }, { hourlyMinor: 4000 }] } });
    const [notice] = await notices(booking);
    expect(notice.body_text).toMatch(money("The amount due at the club is reduced from RON 75.00 to RON 40.00."));
    // A later dearer move keeps the reduced amount due.
    expect(await change(booking, admin, "admin", { locationId: locationB, courtId: courtB1, date, startMinute: 600, accept: true }))
      .toMatchObject({ ok: true, totalAmountMinor: 4000, financial: { consequence: "club_absorbs", absorbedMinor: 2000 } });
    expect(refundPayment).not.toHaveBeenCalled();
  });
});

describe("lessons", () => {
  test("the assigned Coach and an Admin reprice only the court component and keep the agreed coaching fee and provenance", async () => {
    const date = nextDate(), booking = await lesson(coach, date);
    const original = await currentRevision(booking);
    // The assigned Coach moves the lesson to a cheaper court: 10000 + 7500 → 10000 + 4000.
    expect(await change(booking, coach, "coach", { locationId: locationA, courtId: courtA4, date, startMinute: 600, accept: true }))
      .toMatchObject({ ok: true, changed: true, totalAmountMinor: 14000, adjustmentStatus: "applied",
        financial: { consequence: "refund", refundMinor: 3500, currentAmountMinor: 17500 } });
    const reduced = await currentRevision(booking);
    expect(reduced).toMatchObject({ actor_scope: "coach", total_amount_minor: 14000, coach_user_id: coach,
      pricing_evidence: { coaching: { ...original.pricing_evidence.coaching, courtRentalMinor: 4000, courtAmountMinor: 4000 } } });
    // An Admin reassigns it to a coach who does not offer the program, on a dearer court: absorbed.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 660, coachUserId: coach2, accept: true }))
      .toMatchObject({ ok: true, changed: true, totalAmountMinor: 14000,
        financial: { consequence: "club_absorbs", destinationAmountMinor: 15000, absorbedMinor: 1000 } });
    const reassigned = await currentRevision(booking);
    expect(await state(booking)).toMatchObject({ coach_user_id: coach2, court_id: courtA1, starts_at_minute: 660 });
    // The fee and its provenance never follow the reassignment; the evidence still explains the obligation.
    expect(reassigned).toMatchObject({ coach_user_id: coach2, coach_name: "Second Financial Coach", total_amount_minor: 14000,
      pricing_evidence: reduced.pricing_evidence });
    expect(reassigned.pricing_evidence.coaching).toMatchObject({ coachUserId: coach, locationId: locationA, amountMinor: fee, source: "coach" });
    // The former coach no longer manages the lesson once it is reassigned.
    const coachAttempt = await runOperationalBookingChange({ id: booking, expectedRevisionId: reassigned.id,
      expectedUpdatedAt: (await state(booking)).updated_at, overrideCoachRestrictions: false, save: false,
      locationId: locationA, courtId: courtA1, date, startMinute: 900 }, coach, "coach");
    expect(coachAttempt.ok).toBe(false);
    // Back at A4 the destination equals the obligation: the coach changes with no financial operation.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 720, coachUserId: coach }))
      .toMatchObject({ ok: true, changed: true, totalAmountMinor: 14000, financial: { consequence: "none" } });
    expect(await state(booking)).toMatchObject({ coach_user_id: coach, court_id: courtA4, starts_at_minute: 720 });
    expect(await currentRevision(booking)).toMatchObject({ coach_user_id: coach, coach_name: "Financial Coach", total_amount_minor: 14000 });
    // Every revision is preserved as written.
    expect((await database.query("SELECT to_jsonb(v) AS revision FROM public.booking_revisions v WHERE id=$1", [original.id]))[0].revision).toEqual(original);
  });

  test("a refund-backed reassignment assigns the new coach only after the verified refund", async () => {
    const date = nextDate(), booking = await lesson(coach, date);
    refundPayment.mockRejectedValueOnce(new Error("timeout"));
    const pending = await change(booking, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 720, coachUserId: coach2, accept: true });
    expect(pending).toMatchObject({ ok: true, changed: false, adjustmentStatus: "pending", refundStatus: "pending_retry",
      financial: { consequence: "refund", currentAmountMinor: 17500, destinationAmountMinor: 14000, refundMinor: 3500 } });
    assert(pending.ok && pending.refundIds);
    // The agreed coach and time stay until the refund is verified; the target holds name the new coach.
    expect(await state(booking)).toMatchObject({ coach_user_id: coach, court_id: courtA3, holds: 1 });
    expect(await database.query(`SELECT h.coach_user_id FROM public.court_reservations h JOIN public.booking_adjustments a ON a.id=h.adjustment_id
      WHERE a.booking_id=$1 AND h.status='held'`, [booking])).toEqual([{ coach_user_id: coach2 }]);
    expect(await processBookingRefund(pending.refundIds[0])).toBe("succeeded");
    expect(await state(booking)).toMatchObject({ coach_user_id: coach2, court_id: courtA4, starts_at_minute: 720, total: 14000, holds: 0 });
    const revision = await currentRevision(booking);
    expect(revision).toMatchObject({ coach_user_id: coach2, coach_name: "Second Financial Coach", actor_scope: "admin", total_amount_minor: 14000,
      pricing_evidence: { coaching: { coachUserId: coach, amountMinor: fee, courtAmountMinor: 4000 } } });
  });
});

// The booking's live adjustment holds: placement, coach and whether the court is occupied.
const holdsOf = async (bookingId: string) => database.query(`SELECT h.court_id,h.starts_at_minute,h.ends_at_minute,h.coach_user_id,h.occupies_court
  FROM public.court_reservations h JOIN public.booking_adjustments a ON a.id=h.adjustment_id
  WHERE a.booking_id=$1 AND h.status='held' ORDER BY h.starts_at_minute`, [bookingId]) as Promise<{ court_id: string; starts_at_minute: number;
    ends_at_minute: number; coach_user_id: string | null; occupies_court: boolean }[]>;
// In-app Coach messages about any of the booking's revisions, by recipient and kind.
const coachNotices = async (bookingId: string) => database.query(`SELECT m.user_id,m.kind,m.body_text FROM public.user_messages m
  JOIN public.booking_revisions v ON m.event_key LIKE ('coaching.%:' || v.id::text) WHERE v.booking_id=$1 ORDER BY m.kind,m.user_id`,
[bookingId]) as Promise<{ user_id: string; kind: string; body_text: string }[]>;
const succeed = async (request: { id: string }) => ({ status: "succeeded", providerRefundId: `re_${request.id}` });
const dayAfter = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
// Coach messages never disclose prices, payments, refunds or the customer.
function expectNoFinancialDisclosure(messages: { body_text: string }[]) {
  for (const message of messages) {
    expect(message.body_text).not.toMatch(/RON|refund|price|total|payment/i);
    expect(message.body_text).not.toContain(customerEmail);
  }
}

describe("refund-backed coach reassignment", () => {
  test("same court, overlapping interval: the original lesson stays, the new coach is held coach-only until the verified refund", async () => {
    // Agreed at A1 for 7500; A1 now costs 5000, so any A1 destination refunds 2500.
    const date = nextDate(), booking = await lesson(coach, date, courtA1, 600, 7500);
    const base = await state(booking);
    refundPayment.mockRejectedValue(new Error("network response lost"));
    const target = { locationId: locationA, courtId: courtA1, date, startMinute: 630, coachUserId: coach2 };
    // The preview quotes the refund and the save that accepts it is recorded, never refused as unavailable.
    expect(await change(booking, admin, "admin", { ...target, save: false })).toMatchObject({ ok: true, changed: true,
      financial: { consequence: "refund", currentAmountMinor: 17500, customerAmountMinor: 15000, refundMinor: 2500 } });
    const pending = await change(booking, admin, "admin", { ...target, accept: true }, base);
    expect(pending).toMatchObject({ ok: true, changed: false, adjustmentStatus: "pending", refundStatus: "pending_retry" });
    assert(pending.ok && pending.refundIds && pending.financial);
    // The original court, time and coach remain; the new coach is held over the whole target.
    expect(await state(booking)).toMatchObject({ coach_user_id: coach, court_id: courtA1, starts_at_minute: 600, total: 17500, revisions: 1 });
    expect(await holdsOf(booking)).toEqual([
      { court_id: courtA1, starts_at_minute: 630, ends_at_minute: 660, coach_user_id: coach2, occupies_court: false },
      { court_id: courtA1, starts_at_minute: 660, ends_at_minute: 690, coach_user_id: coach2, occupies_court: true }]);
    // No other booking can take the replacement coach, or court A1, during the target.
    const other = await lesson(coach3, date, courtA4, 900);
    expect(await change(other, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 600, coachUserId: coach2 }))
      .toEqual({ ok: false, reason: "coach-booked" });
    const courtOnly = await courtBooking(courtA4, date, { startMinute: 1020 });
    for (const startMinute of [600, 660])
      expect(await change(courtOnly, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute }))
        .toEqual({ ok: false, reason: "court-unavailable" });
    // PostgreSQL itself refuses the replacement coach elsewhere, and a coach-only row outside a change.
    for (const [statement, constraint] of [
      [`INSERT INTO public.court_reservations(court_id,booking_date,starts_at_minute,ends_at_minute,status,coach_user_id)
        VALUES('${courtA4}','${date}',600,660,'active','${coach2}')`, "court_reservation_coach_no_overlap"],
      [`INSERT INTO public.court_reservations(court_id,booking_date,starts_at_minute,ends_at_minute,status,coach_user_id,occupies_court)
        VALUES('${courtA4}','${date}',1200,1260,'active','${coach3}',false)`, "court_reservation_coach_only_hold"]] as const) {
      const failure = await database.query(statement).then(() => null, (error: unknown) => normalizeDatabaseError(error));
      expect(failure?.constraint).toBe(constraint);
    }
    // Nothing is announced to either coach while the refund is unresolved; the exact request replays.
    expect(await coachNotices(booking)).toEqual([]);
    expect((await notices(booking)).map(notice => notice.kind)).toEqual(["booking.change_refund_requested"]);
    expect(await change(booking, admin, "admin", { ...target, accept: pending.financial }, base))
      .toMatchObject({ ok: true, changed: false, adjustmentId: pending.adjustmentId, adjustmentStatus: "pending" });
    // The verified refund (here a repeated webhook) applies the placement and coach exactly once.
    refundPayment.mockImplementation(succeed);
    expect(await processBookingRefund(pending.refundIds[0])).toBe("succeeded");
    expect(await processBookingRefund(pending.refundIds[0], { providerChanged: true })).toBe("succeeded");
    expect(await state(booking)).toMatchObject({ coach_user_id: coach2, court_id: courtA1, starts_at_minute: 630, total: 15000,
      revisions: 2, adjustments: 1, refunds: 1, holds: 0 });
    expect(await currentRevision(booking)).toMatchObject({ coach_user_id: coach2, coach_name: "Second Financial Coach", starts_at_minute: 630 });
    const customerNotices = await notices(booking);
    expect(customerNotices.map(notice => notice.kind)).toEqual(["booking.change_refund_requested", "booking.rescheduled"]);
    expect(customerNotices[1].body_text).toContain("Coach: Second Financial Coach");
    expect(customerNotices[1].body_text).toMatch(money("The price reduction refund of RON 25.00 completed."));
    const coaches = await coachNotices(booking);
    expect(coaches.map(message => [message.user_id, message.kind])).toEqual([[coach2, "coaching.assigned"], [coach, "coaching.unassigned"]]);
    expect(coaches[0].body_text).toMatch(/now assigned to you[\s\S]*Time: 10:30–11:30/);
    expect(coaches[1].body_text).toMatch(/no longer assigned to you[\s\S]*Time: 10:00–11:00/);
    expectNoFinancialDisclosure(coaches);
    // A replayed request reports the applied revision and records nothing new.
    expect(await change(booking, admin, "admin", { ...target, accept: pending.financial }, base))
      .toMatchObject({ ok: true, changed: true, revisionId: (await state(booking)).current_revision_id });
    expect(await coachNotices(booking)).toHaveLength(2);
    expect(await notices(booking)).toHaveLength(2);
    // The holds were replaced by the applied lesson: coach2 is occupied exactly at its new time.
    expect(await change(other, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 600, coachUserId: coach2 }))
      .toEqual({ ok: false, reason: "coach-booked" });
    expect(await change(other, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 690, coachUserId: coach2 }))
      .toMatchObject({ ok: true, changed: true });
  });

  test("same court, overlapping time: a coach-only hold; a definitive refund failure abandons it, a success applies it", async () => {
    const date = nextDate(), booking = await lesson(coach, date, courtA1, 600, 7500);
    const before = await state(booking);
    // Identical court and time only reassigns the coach: the agreed price stands, with no refund.
    const identical = { locationId: locationA, courtId: courtA1, date, startMinute: 600, coachUserId: coach2, save: false };
    expect(await change(booking, admin, "admin", identical)).toMatchObject({ ok: true, changed: true, financial: { consequence: "none" } });
    const target = { locationId: locationA, courtId: courtA1, date, startMinute: 630, coachUserId: coach2 };
    refundPayment.mockRejectedValueOnce(new Error("timeout"));
    const pending = await change(booking, admin, "admin", { ...target, accept: true });
    expect(pending).toMatchObject({ ok: true, changed: false, adjustmentStatus: "pending", financial: { refundMinor: 2500 } });
    assert(pending.ok && pending.refundIds);
    expect(await holdsOf(booking)).toEqual([
      { court_id: courtA1, starts_at_minute: 630, ends_at_minute: 660, coach_user_id: coach2, occupies_court: false },
      { court_id: courtA1, starts_at_minute: 660, ends_at_minute: 690, coach_user_id: coach2, occupies_court: true }]);
    // The provider definitively rejects the refund: nothing moved, the change and its hold are abandoned.
    refundPayment.mockResolvedValue({ status: "failed", providerRefundId: `re_${randomUUID()}`, retryable: false, failureReason: "charge_disputed" });
    expect(await processBookingRefund(pending.refundIds[0])).toBe("failed");
    expect(await state(booking)).toMatchObject({ coach_user_id: coach, court_id: courtA1, starts_at_minute: 600, total: 17500, revisions: 1,
      holds: 0, current_revision_id: before.current_revision_id });
    expect(await refunds(booking)).toMatchObject([{ amount_minor: 2500, status: "voided" }]);
    expect((await adjustmentsOf(booking)).map(row => row.status)).toEqual(["unsuccessful"]);
    expect((await notices(booking)).map(notice => notice.kind)).toEqual(["booking.change_refund_requested", "financial.modification_rejected"]);
    expect(await coachNotices(booking)).toEqual([]);
    // The abandoned hold no longer occupies the replacement coach.
    const other = await lesson(coach3, date, courtA4, 900);
    expect(await change(other, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 600, coachUserId: coach2 }))
      .toMatchObject({ ok: true, changed: true });
    // A refund that succeeds at once applies the coach-only reassignment in the same request.
    refundPayment.mockImplementation(succeed);
    const later = await lesson(coach, nextDate(), courtA1, 600, 7500), day = (await state(later)).date;
    expect(await change(later, admin, "admin", { ...target, date: day, accept: true }))
      .toMatchObject({ ok: true, changed: true, adjustmentStatus: "applied", refundStatus: "succeeded", totalAmountMinor: 15000 });
    expect(await state(later)).toMatchObject({ coach_user_id: coach2, court_id: courtA1, starts_at_minute: 630, total: 15000, holds: 0 });
    const coaches = await coachNotices(later);
    expect(coaches.map(message => [message.user_id, message.kind])).toEqual([[coach2, "coaching.assigned"], [coach, "coaching.unassigned"]]);
    expectNoFinancialDisclosure(coaches);
  });

  test("adjacent, different-date and different-court targets hold the court and the new coach together", async () => {
    refundPayment.mockRejectedValue(new Error("network response lost"));
    for (const destination of [(date: string) => ({ courtId: courtA1, date, startMinute: 660 }),
      (date: string) => ({ courtId: courtA1, date: dayAfter(date), startMinute: 600 }),
      (date: string) => ({ courtId: courtA4, date, startMinute: 630 })]) {
      const date = nextDate(), booking = await lesson(coach, date, courtA1, 600, 7500), target = destination(date);
      expect(await change(booking, admin, "admin", { locationId: locationA, ...target, coachUserId: coach2, accept: true }))
        .toMatchObject({ ok: true, changed: false, adjustmentStatus: "pending" });
      expect(await state(booking)).toMatchObject({ coach_user_id: coach, court_id: courtA1, starts_at_minute: 600 });
      expect(await holdsOf(booking)).toEqual([{ court_id: target.courtId, starts_at_minute: target.startMinute,
        ends_at_minute: target.startMinute + 60, coach_user_id: coach2, occupies_court: true }]);
    }
  });

  test("a conflicting reservation of the replacement coach rejects the preview and the save alike", async () => {
    const date = nextDate(), booking = await lesson(coach, date, courtA1, 600, 7500);
    await lesson(coach2, date, courtA4, 630);
    const before = await state(booking);
    for (const startMinute of [600, 630]) {
      const target = { locationId: locationA, courtId: courtA1, date, startMinute, coachUserId: coach2 };
      expect(await change(booking, admin, "admin", { ...target, save: false })).toEqual({ ok: false, reason: "coach-booked" });
      expect(await change(booking, admin, "admin", { ...target, accept: quote("refund", { currentAmountMinor: 17500,
        destinationAmountMinor: 15000, customerAmountMinor: 15000, refundMinor: 2500 }) })).toEqual({ ok: false, reason: "coach-booked" });
    }
    expect(await state(booking)).toEqual(before);
    expect(refundPayment).not.toHaveBeenCalled();
  });

  test("competing refund-backed reassignments to one coach: one holds the coach, the other is refused without a refund", async () => {
    refundPayment.mockRejectedValue(new Error("network response lost"));
    const date = nextDate();
    const first = await lesson(coach, date, courtA1, 600, 7500), second = await lesson(coach3, date, courtA4, 600, 7500);
    // Each moves within its own court time (coach-only over the overlap): both need coach2 at 10:30–11:30.
    const targets = [[first, { locationId: locationA, courtId: courtA1, date, startMinute: 630, coachUserId: coach2 }],
      [second, { locationId: locationA, courtId: courtA4, date, startMinute: 630, coachUserId: coach2 }]] as const;
    const quoted = [];
    for (const [booking, target] of targets) {
      const preview = await change(booking, admin, "admin", { ...target, save: false });
      assert(preview.ok && preview.financial);
      quoted.push({ booking, target, base: await state(booking), financial: preview.financial });
    }
    const outcomes = await settled(quoted.map(({ booking, target, base, financial }) =>
      change(booking, admin, "admin", { ...target, accept: financial }, base)));
    expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter(outcome => !outcome.ok)).toEqual([{ ok: false, reason: "coach-booked" }]);
    const winner = quoted[outcomes.findIndex(outcome => outcome.ok)].booking, loser = quoted[outcomes.findIndex(outcome => !outcome.ok)].booking;
    expect((await holdsOf(winner)).every(hold => hold.coach_user_id === coach2)).toBe(true);
    expect(await state(loser)).toMatchObject({ adjustments: 0, refunds: 0, holds: 0, revisions: 1 });
    expect(refundPayment).toHaveBeenCalledOnce();
  });
});

describe("coach reassignment notifications", () => {
  test("an immediate reassignment notifies the customer, the previous and the replacement coach once", async () => {
    const date = nextDate(), booking = await lesson(coach, date, courtA1, 600);
    const target = { locationId: locationA, courtId: courtA1, date, startMinute: 660, coachUserId: coach2, requestId: randomUUID() };
    const base = await state(booking);
    expect(await change(booking, admin, "admin", target, base)).toMatchObject({ ok: true, changed: true, financial: { consequence: "none" } });
    const coaches = await coachNotices(booking);
    expect(coaches.map(message => [message.user_id, message.kind])).toEqual([[coach2, "coaching.assigned"], [coach, "coaching.unassigned"]]);
    expectNoFinancialDisclosure(coaches);
    const [customerNotice] = await notices(booking);
    expect(customerNotice).toMatchObject({ kind: "booking.rescheduled" });
    expect(customerNotice.body_text).toContain("Coach: Second Financial Coach");
    // A replay records nothing; a later same-coach move keeps the single existing Coach message.
    expect(await change(booking, admin, "admin", target, base)).toMatchObject({ ok: true, changed: true });
    expect(await coachNotices(booking)).toHaveLength(2);
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 780 }))
      .toMatchObject({ ok: true, changed: true });
    expect((await coachNotices(booking)).map(message => [message.user_id, message.kind]))
      .toEqual([[coach2, "coaching.assigned"], [coach2, "coaching.rescheduled"], [coach, "coaching.unassigned"]]);
  });
});

describe("coach-only reassignment and court rental terms", () => {
  // Every revision's pricing evidence and total, oldest first.
  const revisionTerms = async (bookingId: string) => database.query(`SELECT total_amount_minor AS total,pricing_evidence AS evidence,
    coach_user_id FROM public.booking_revisions WHERE booking_id=$1 ORDER BY revision_number`, [bookingId]) as Promise<
    { total: number; evidence: { coaching: Record<string, unknown> }; coach_user_id: string }[]>;

  test("reassigning only the coach keeps the agreed price, evidence and payments, whatever the current pricing", async () => {
    // Agreed at today's rate, above it (A1 was 7500, now 5000) and below it (A3 was 3000, now 7500).
    for (const [courtId, agreedRental] of [[courtA1, rates[courtA1]], [courtA1, 7500], [courtA3, 3000]] as const) {
      const date = nextDate(), booking = await lesson(coach, date, courtId, 600, agreedRental);
      const [original] = await revisionTerms(booking);
      const target = { locationId: locationA, courtId, date, startMinute: 600, coachUserId: coach2 };
      const unchanged = quote("none", { currentAmountMinor: fee + agreedRental, destinationAmountMinor: fee + agreedRental,
        customerAmountMinor: fee + agreedRental });
      expect(await change(booking, admin, "admin", { ...target, save: false })).toMatchObject({ ok: true, changed: true, financial: unchanged });
      expect(await change(booking, admin, "admin", target)).toMatchObject({ ok: true, changed: true, totalAmountMinor: fee + agreedRental,
        financial: unchanged });
      expect(await state(booking)).toMatchObject({ coach_user_id: coach2, court_id: courtId, starts_at_minute: 600, total: fee + agreedRental,
        revisions: 2, adjustments: 0, refunds: 0, holds: 0, attempts: 1 });
      const [, reassigned] = await revisionTerms(booking);
      expect(reassigned).toEqual({ ...original, coach_user_id: coach2 });
      // The customer learns of the new coach at an unchanged price, with no financial outcome.
      const [notice] = await notices(booking);
      expect(notice.body_text).toContain("Coach: Second Financial Coach");
      expect(notice.body_text).toContain("Total price (unchanged)");
      expect(notice.body_text).not.toMatch(/covers the difference|reduced|refund/);
    }
    expect(refundPayment).not.toHaveBeenCalled();
  });

  test("court rental included in the lesson price: no court adjustment on any court, date or time", async () => {
    const date = nextDate(), booking = await lesson(coach, date, courtA3, 600, rates[courtA3], true);
    expect(await state(booking)).toMatchObject({ total: fee });
    // Cheaper court, dearer court on another day, then another coach at the same placement.
    for (const target of [{ courtId: courtA4, date, startMinute: 600 }, { courtId: courtA1, date: dayAfter(date), startMinute: 720 },
      { courtId: courtA1, date: dayAfter(date), startMinute: 720, coachUserId: coach2 }]) {
      const [actor, capacity] = target.coachUserId ? [admin, "admin" as const] : [coach, "coach" as const];
      expect(await change(booking, actor, capacity, { locationId: locationA, ...target })).toMatchObject({ ok: true, changed: true, totalAmountMinor: fee, financial: { consequence: "none" } });
    }
    expect(await state(booking)).toMatchObject({ court_id: courtA1, coach_user_id: coach2, total: fee, revisions: 4, adjustments: 0, refunds: 0 });
    // An unchanged price keeps the agreed evidence; the charged court amount stays zero.
    expect((await revisionTerms(booking)).map(row => [row.total, row.evidence.coaching.courtRentalMinor, row.evidence.coaching.courtAmountMinor]))
      .toEqual(Array(4).fill([fee, 7500, 0]));
    expect(refundPayment).not.toHaveBeenCalled();
  });

  test("court rental charged separately: cheaper refunds, dearer is absorbed, repeated changes never refund twice or reprice a coach-only move", async () => {
    const date = nextDate(), booking = await lesson(coach, date);
    // A3 → A4: 17500 → 14000, the 3500 difference is refunded.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 600, accept: true }))
      .toMatchObject({ ok: true, totalAmountMinor: 14000, refundStatus: "succeeded", financial: { consequence: "refund", refundMinor: 3500 } });
    // A4 → A1 later (15000): absorbed, the reduced obligation stays.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 660, accept: true }))
      .toMatchObject({ ok: true, totalAmountMinor: 14000, financial: { consequence: "club_absorbs", absorbedMinor: 1000 } });
    // Another coach at A1 11:00 again: no second absorption, refund or charge.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 660, coachUserId: coach2 }))
      .toMatchObject({ ok: true, changed: true, totalAmountMinor: 14000, financial: { consequence: "none" } });
    // Back to A4 at another time (14000): equal, no financial operation.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 780 }))
      .toMatchObject({ ok: true, totalAmountMinor: 14000, financial: { consequence: "none" } });
    // A3 (17500) once more after the refund: still absorbed, never charged.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA3, date, startMinute: 840, accept: true }))
      .toMatchObject({ ok: true, totalAmountMinor: 14000, financial: { consequence: "club_absorbs", destinationAmountMinor: 17500, absorbedMinor: 3500 } });
    expect(await state(booking)).toMatchObject({ court_id: courtA3, coach_user_id: coach2, total: 14000, revisions: 6, adjustments: 3, refunds: 1, attempts: 1 });
    expect(await refunds(booking)).toMatchObject([{ amount_minor: 3500, status: "succeeded", reason: "booking_price_reduction" }]);
    expect(refundPayment).toHaveBeenCalledOnce();
    // The agreed coaching fee and its provenance never change.
    for (const row of await revisionTerms(booking))
      expect(row.evidence.coaching).toMatchObject({ amountMinor: fee, coachUserId: coach, locationId: locationA, courtRentalIncluded: false });
  });

  test("after an earlier partial refund, a further reduction refunds only the new difference and a coach-only move nothing", async () => {
    const date = nextDate(), booking = await lesson(coach, date);
    // A3 → A1: 17500 → 15000, a partial refund of 2500.
    expect(await change(booking, coach, "coach", { locationId: locationA, courtId: courtA1, date, startMinute: 600, accept: true }))
      .toMatchObject({ ok: true, totalAmountMinor: 15000, financial: { refundMinor: 2500 } });
    // A1 → A4: 15000 → 14000 refunds only the further 1000.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 660, accept: true }))
      .toMatchObject({ ok: true, totalAmountMinor: 14000, financial: { currentAmountMinor: 15000, refundMinor: 1000 } });
    // Another coach at the same placement: no refund of the remaining funds, no charge.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 660, coachUserId: coach3 }))
      .toMatchObject({ ok: true, totalAmountMinor: 14000, financial: { consequence: "none", refundMinor: 0 } });
    expect(await state(booking)).toMatchObject({ coach_user_id: coach3, total: 14000, refunds: 2, adjustments: 2, attempts: 1 });
    expect((await refunds(booking)).map(row => [row.amount_minor, row.status])).toEqual([[2500, "succeeded"], [1000, "succeeded"]]);
  });

  test("Coach messages about same-coach reschedules carry the lesson details but no customer financial outcome", async () => {
    const date = nextDate(), booking = await lesson(coach, date);
    // A refund-backed cheaper court, then an absorbed dearer court, both by the assigned Coach.
    expect(await change(booking, coach, "coach", { locationId: locationA, courtId: courtA4, date, startMinute: 600, accept: true }))
      .toMatchObject({ ok: true, refundStatus: "succeeded" });
    expect(await change(booking, coach, "coach", { locationId: locationA, courtId: courtA1, date, startMinute: 720, accept: true }))
      .toMatchObject({ ok: true, financial: { consequence: "club_absorbs" } });
    // The customer is told of the refund and the absorbed difference.
    const customerNotices = (await notices(booking)).filter(notice => notice.kind === "booking.rescheduled").map(notice => notice.body_text);
    expect(customerNotices[0]).toMatch(money("The price reduction refund of RON 35.00 completed."));
    expect(customerNotices[1]).toMatch(/covers the difference/);
    const coaches = await coachNotices(booking);
    expect(coaches.map(message => [message.user_id, message.kind])).toEqual([[coach, "coaching.rescheduled"], [coach, "coaching.rescheduled"]]);
    expect(coaches.map(message => message.body_text)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Your assigned coaching lesson was rescheduled[\s\S]*Court: A4[\s\S]*Previous time: 10:00–11:00/),
      expect.stringMatching(/^Your assigned coaching lesson was rescheduled[\s\S]*Court: A1[\s\S]*Time: 12:00–13:00/)]));
    expectNoFinancialDisclosure(coaches);
  });
});

describe("concurrency", () => {
  test("competing reductions from one quote: exactly one refund-backed change and one refund", async () => {
    const date = nextDate(), booking = await courtBooking(courtA3, date);
    const base = await state(booking);
    const outcomes = await settled([
      change(booking, admin, "admin", { locationId: locationA, courtId: courtA4, date, startMinute: 600, accept: true }, base),
      change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 720, accept: true }, base),
    ]);
    const winners = outcomes.filter(outcome => outcome.ok);
    expect(winners).toHaveLength(1);
    for (const loser of outcomes.filter(outcome => !outcome.ok)) expect(["stale", "change_pending"]).toContain(loser.reason);
    expect(await state(booking)).toMatchObject({ revisions: 2, adjustments: 1, refunds: 1, attempts: 1 });
    expect(refundPayment).toHaveBeenCalledOnce();
  });

  test("competing absorbed changes: one applies, the other leaves no decision behind", async () => {
    const date = nextDate(), booking = await courtBooking(courtA1, date);
    const base = await state(booking);
    const outcomes = await settled([
      change(booking, admin, "admin", { locationId: locationA, courtId: courtA3, date, startMinute: 600, accept: true }, base),
      change(booking, admin, "admin", { locationId: locationB, courtId: courtB1, date, startMinute: 720, accept: true }, base),
    ]);
    expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter(outcome => !outcome.ok)).toEqual([{ ok: false, reason: "stale" }]);
    expect(await state(booking)).toMatchObject({ revisions: 2, adjustments: 1, refunds: 0, attempts: 1, total: 5000 });
  });
});


describe("Admin cancellation explanations", () => {
  test("a cancellation without a refund stores its explanation once in existing history", async () => {
    const booking = await courtBooking(courtA1, nextDate(), { paymentMethod: "pay_at_club" });
    expect(await cancelCustomerBookingCommand(booking, admin, "admin", "  Court maintenance  "))
      .toMatchObject({ outcome: "cancelled", refundIds: [] });
    expect(await cancelCustomerBookingCommand(booking, admin, "admin", "changed retry"))
      .toMatchObject({ outcome: "cancelled" });
    const records = await adjustmentsOf(booking);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "applied", target: { cancellationExplanation: "Court maintenance" } });
    expect((await currentRevision(booking)).adjustment_id).toBe(records[0].id);
    expect((await notices(booking)).filter(n => n.kind === "booking.cancelled")).toHaveLength(1);
    expect((await notices(booking))[0].body_text).toContain("Cancellation explanation: Court maintenance");
  });

  test("refund-backed lesson cancellation preserves the first explanation through retries and notifies the Coach without finances", async () => {
    const booking = await lesson(coach, nextDate());
    const request = await cancelCustomerBookingCommand(booking, admin, "admin", "Coach illness");
    assert(request.outcome === "cancellation_pending");
    const retry = await cancelCustomerBookingCommand(booking, admin, "admin", "Different retry");
    expect(retry).toMatchObject({ outcome: "cancellation_pending", adjustmentId: request.adjustmentId, refundIds: request.refundIds });
    expect(await state(booking)).toMatchObject({ status: "active", revisions: 1 });
    refundPayment.mockImplementation(async (input: { id: string }) => ({ status: "pending", providerRefundId: `re_${input.id}` }));
    expect(await processBookingRefund(request.refundIds[0])).toBe("pending");
    expect(await state(booking)).toMatchObject({ status: "active", revisions: 1 });
    refundPayment.mockImplementation(async (input: { id: string }) => ({ status: "succeeded", providerRefundId: `re_${input.id}` }));
    expect(await processBookingRefund(request.refundIds[0])).toBe("succeeded");
    expect(await processBookingRefund(request.refundIds[0])).toBe("succeeded");
    expect(await state(booking)).toMatchObject({ status: "cancelled", revisions: 2, adjustments: 1, refunds: 1 });
    expect((await notices(booking)).filter(n => n.kind === "booking.cancelled")).toHaveLength(1);
    expect((await notices(booking)).find(n => n.kind === "booking.cancelled")?.body_text).toContain("Coach illness");
    const coachNotices = await database.query("SELECT body_text FROM public.user_messages WHERE user_id=$1 AND kind='coaching.cancelled' AND strpos(href,$2)>0", [coach, booking]);
    expect(coachNotices).toHaveLength(1);
    expect(coachNotices[0].body_text).toContain("Cancellation explanation: Coach illness");
    expectNoFinancialDisclosure(coachNotices);
    expect((await adjustmentsOf(booking))[0].target.cancellationExplanation).toBe("Coach illness");
  });

  test("oversized and non-Admin explanations are rejected before writes", async () => {
    const booking = await courtBooking(courtA1, nextDate(), { paymentMethod: "pay_at_club" });
    const before = await state(booking);
    expect(await cancelCustomerBookingCommand(booking, admin, "admin", "x".repeat(501))).toEqual({ outcome: "unavailable" });
    expect(await cancelCustomerBookingCommand(booking, customer, "admin", "forged")).toEqual({ outcome: "unavailable" });
    expect(await cancelCustomerBookingCommand(booking, customer, "owner", "forged")).toEqual({ outcome: "unavailable" });
    expect(await state(booking)).toEqual(before);
  });
});
