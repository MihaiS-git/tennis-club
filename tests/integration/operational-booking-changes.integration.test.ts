import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { DataSource } from "typeorm";
import { afterAll, assert, beforeAll, describe, expect, test, vi } from "vitest";
import { bookingRescheduleInputSchema, changeBookingOperationallyCommand, rescheduleCustomerBookingCommand,
  rescheduleLessonAsCoachCommand } from "@/lib/bookings/commands";
import { operationalChangeInputSchema, type OperationalCapacity } from "@/lib/bookings/operational-policy";
import { findAdminBookingDetails } from "@/lib/db/repositories/bookings.repository";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { inTransaction } from "@/lib/db/transaction";
import { cleanupBookingEvidence, insertBookingRecords } from "../local/booking-fixtures";
import { ensureIntegrationAdminAnchor } from "./admin-anchor";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { settled } from "./concurrency";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/reservations/revalidation", () => ({ revalidateCourtActivity: vi.fn() }));

const editorActor = vi.hoisted(() => ({ admin: vi.fn(), coach: vi.fn() }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: editorActor.admin }));
vi.mock("@/lib/coaching/authorization", () => ({ requireActiveCoach: editorActor.coach }));
import { loadOperationalBookingDay } from "@/lib/bookings/operational-availability";

// A controlled reservation clock, by default the database clock. afterTarget switches it
// once target validation finishes: time that passes while a change waits and validates.
const clock = vi.hoisted(() => ({ now: null as string | null, afterTarget: null as string | null }));
vi.mock("@/lib/db/repositories/reservations.repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db/repositories/reservations.repository")>();
  return { ...original, readReservationClockTime: async (...args: Parameters<typeof original.readReservationClockTime>) =>
    clock.now ?? original.readReservationClockTime(...args) };
});
vi.mock("@/lib/bookings/operational", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/bookings/operational")>();
  return { ...original, scheduleOperationalTarget: async (...args: Parameters<typeof original.scheduleOperationalTarget>) => {
    const scheduled = await original.scheduleOperationalTarget(...args);
    if (clock.afterTarget) clock.now = clock.afterTarget;
    return scheduled;
  } };
});

// Stage 1 staff operational changes against real PostgreSQL: no Server Action, no provider.
// Locations (Europe/Bucharest, RON, open and priced all day): A public with A1, A2 (5000/h)
// and A3 (7000/h); B active but not public with B1 (5000/h); E charges EUR. Every coach is
// assigned to A and B except "elsewhere"; "busy" has no working hours at all.
const service = localFixtureClient();
let database: DataSource;
let previousEmailSettings: { official_email: string; sender_name: string; emails_enabled: boolean } | undefined;
const userIds: string[] = [];
const [locationA, locationB, locationE, locationArchived] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const [courtA1, courtA2, courtA3, courtB1, courtE1, courtArchived] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const courts = [courtA1, courtA2, courtA3, courtB1, courtE1, courtArchived];
const locations = [locationA, locationB, locationE, locationArchived];
const [program, otherProgram] = [randomUUID(), randomUUID()];
let admin: string, coach: string, coach2: string, unassigned: string, adminCoach: string, customer: string, revokedCoach: string;
const fee = 10000;

async function account(roles: ("coach" | "admin")[] = []) {
  const email = `operational-${randomUUID()}@example.test`;
  const { data, error } = await service.auth.admin.createUser({ email, password: "operational-password-123", email_confirm: true });
  assert.strictEqual(error, null); assert.ok(data.user);
  userIds.push(data.user.id);
  for (const role of roles) await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,$2)", [data.user.id, role]);
  return data.user.id;
}

beforeAll(async () => {
  expect(process.env.TEST_SUPABASE_PROJECT).toBe("tennis-club-tests");
  database = await getDataSource();
  [previousEmailSettings] = await database.query("SELECT official_email,sender_name,emails_enabled FROM public.club_settings WHERE id=true");
  await database.query("UPDATE public.club_settings SET official_email='',sender_name='',emails_enabled=false WHERE id=true");
  await ensureIntegrationAdminAnchor(service);
  admin = await account(["admin"]);
  coach = await account(["coach"]);
  coach2 = await account(["coach"]);
  unassigned = await account(["coach"]);
  adminCoach = await account(["admin", "coach"]);
  revokedCoach = await account(["coach"]);
  customer = await account();
  await database.query(`INSERT INTO public.locations(id,name,slug,timezone,currency,is_active,is_public) VALUES
    ($1,'Operational A',($1::uuid)::text,'Europe/Bucharest','RON',true,true),($2,'Operational B',($2::uuid)::text,'Europe/Bucharest','RON',true,false),
    ($3,'Operational E',($3::uuid)::text,'Europe/Bucharest','EUR',true,true),($4,'Operational archived',($4::uuid)::text,'Europe/Bucharest','RON',true,true)`,
  locations);
  await database.query(`INSERT INTO public.courts(id,location_id,name,slug,surface,environment,is_active) VALUES
    ($1,$7,'A1','a1','clay','outdoor',true),($2,$7,'A2','a2','clay','outdoor',true),($3,$7,'A3','a3','clay','outdoor',true),
    ($4,$8,'B1','b1','clay','outdoor',true),($5,$9,'E1','e1','clay','outdoor',true),($6,$10,'X1','x1','clay','outdoor',true)`,
  [...courts, ...locations]);
  for (const location of locations) {
    const [schedule] = await database.query("INSERT INTO public.opening_hours_schedules(location_id,starts_on) VALUES($1,'2000-01-01') RETURNING id", [location]);
    await database.query(`INSERT INTO public.location_opening_hours(location_id,schedule_id,weekday,opens_at_minute,closes_at_minute)
      SELECT $1,$2,weekday,0,1440 FROM generate_series(0,6) AS weekday`, [location, schedule.id]);
    const [ruleSet] = await database.query("INSERT INTO public.pricing_rule_sets(location_id) VALUES($1) RETURNING id", [location]);
    await database.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
      SELECT $1,$2,c.id,'outdoor',weekday,0,1440,CASE WHEN c.id=$3 THEN 7000 ELSE 5000 END FROM generate_series(0,6) AS weekday, public.courts c
      WHERE c.location_id=$1`, [location, ruleSet.id, courtA3]);
  }
  // The archived location is archived only after its configuration exists.
  await database.query("UPDATE public.locations SET archived_at=now(),is_active=false WHERE id=$1", [locationArchived]);
  await database.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,min_participants,max_participants,court_rental_included,is_active) VALUES
    ($1,'Operational private','','private',1,1,true,true),($2,'Operational other','','private',1,1,true,true)`, [program, otherProgram]);
  await database.query("INSERT INTO public.coaching_program_durations(program_id,duration_minutes) VALUES($1,60),($2,60)", [program, otherProgram]);
  await database.query(`INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages,is_public) VALUES
    ($1,'Operational Coach','','','{}','{}',true),($2,'Second Operational Coach','','','{}','{}',false),($3,'Unassigned Coach','','','{}','{}',true),
    ($4,'Admin Coach','','','{}','{}',true),($5,'Revoked Coach','','','{}','{}',true)`, [coach, coach2, unassigned, adminCoach, revokedCoach]);
  // Program compatibility never limits an operational change: coach2 offers only the other program.
  await database.query(`INSERT INTO public.coach_programs(coach_user_id,program_id) VALUES($1,$3),($2,$4),($5,$3),($6,$3)`,
    [coach, coach2, program, otherProgram, adminCoach, revokedCoach]);
  await database.query(`INSERT INTO public.coach_locations(coach_user_id,location_id)
    SELECT c,l FROM unnest($1::uuid[]) c CROSS JOIN unnest($2::uuid[]) l`, [[coach, coach2, adminCoach, revokedCoach], [locationA, locationB]]);
  await database.query("INSERT INTO public.coach_locations(coach_user_id,location_id) VALUES($1,$2)", [unassigned, locationE]);
  // Working hours every day: 08:00–18:00 at A and 18:00–22:00 at B.
  await database.query(`INSERT INTO public.coach_weekly_availability(coach_user_id,location_id,weekday,start_minute,end_minute,valid_from)
    SELECT c,w.location_id,d,w.start_minute,w.end_minute,'2000-01-01' FROM unnest($1::uuid[]) c CROSS JOIN generate_series(0,6) d
    CROSS JOIN (VALUES($2::uuid,480,1080),($3::uuid,1080,1320)) AS w(location_id,start_minute,end_minute)`,
  [[coach, coach2, adminCoach, revokedCoach], locationA, locationB]);
});

async function removeFixtures() {
  const coaches = userIds;
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
        await manager.query("DELETE FROM public.coach_programs WHERE coach_user_id=ANY($1::uuid[])", [coaches]);
        await manager.query("DELETE FROM public.coach_locations WHERE coach_user_id=ANY($1::uuid[])", [coaches]);
        await manager.query("DELETE FROM public.coach_profiles WHERE user_id=ANY($1::uuid[])", [coaches]);
        await manager.query("DELETE FROM public.coaching_program_durations WHERE program_id=ANY($1::uuid[])", [[program, otherProgram]]);
        await manager.query("DELETE FROM public.coaching_programs WHERE id=ANY($1::uuid[])", [[program, otherProgram]]);
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

// Each test books its own far-future date, so fixtures never collide.
let dayOffset = 0;
const nextDate = () => {
  const day = new Date(Date.UTC(2106, 0, 4 + 7 * dayOffset++));
  return day.toISOString().slice(0, 10);
};

async function courtBooking(courtId: string, date: string, startMinute = 600, endMinute = 660, total = 5000,
  paymentMethod: "online" | "pay_at_club" = "pay_at_club") {
  const reservationId = randomUUID(), bookingId = randomUUID();
  await inTransaction(async manager => {
    await manager.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,'active',$6)`, [reservationId, courtId, date, startMinute, endMinute, customer]);
    await insertBookingRecords(manager, { id: bookingId, reservation_id: reservationId, account_user_id: customer, customer_name: "Operational Customer",
      customer_email: "operational-customer@example.test", customer_phone: "+40 700", total_amount_minor: total, currency: "RON",
      payment_method: paymentMethod, cancellation_notice_minutes: 1440 });
  });
  return bookingId;
}

// An online lesson whose program includes court rental: its obligation is the agreed fee
// wherever it moves, so the Stage 1 equal-obligation path applies.
async function lesson(lessonCoach: string, date: string, startMinute = 600, courtId = courtA1, locationId = locationA) {
  const reservationId = randomUUID(), bookingId = randomUUID();
  const slots = [startMinute, startMinute + 30].map(minute => ({ minute, ruleId: randomUUID(), ruleSetId: randomUUID(), hourlyMinor: 5000, startsOn: null, endsOn: null }));
  const evidence = { version: 1, rounding: "half-hour-sum-round", courtState: "outdoor", slots,
    coaching: { participantCount: 1, pricePerPersonMinor: fee, programId: program, coachUserId: lessonCoach, locationId, durationMinutes: 60,
      source: "club", amountMinor: fee, currency: "RON", courtRentalIncluded: true, courtRentalMinor: 5000, courtAmountMinor: 0 } };
  await inTransaction(async manager => {
    await manager.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,coach_user_id,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,'active',$6,$7)`, [reservationId, courtId, date, startMinute, startMinute + 60, lessonCoach, customer]);
    await insertBookingRecords(manager, { id: bookingId, reservation_id: reservationId, account_user_id: customer, customer_name: "Operational Customer",
      customer_email: "operational-customer@example.test", customer_phone: "+40 700", total_amount_minor: fee, currency: "RON", payment_method: "online",
      cancellation_notice_minutes: 1440, pricing_evidence: evidence,
      coaching: { coach_user_id: lessonCoach, coaching_program_id: program, coach_name: "Agreed Coach", coaching_program_name: "Operational private" } });
  });
  return bookingId;
}

async function state(bookingId: string) {
  const [row] = await database.query(`SELECT r.id AS reservation_id,r.court_id,r.booking_date::text AS date,r.starts_at_minute,r.ends_at_minute,r.coach_user_id,
      r.status,to_json(r.updated_at)#>>'{}' AS updated_at,b.current_revision_id,
      (SELECT count(*)::int FROM public.booking_revisions v WHERE v.booking_id=b.id) AS revisions,
      (SELECT count(*)::int FROM public.booking_adjustments a WHERE a.booking_id=b.id) AS adjustments,
      (SELECT count(*)::int FROM public.payment_attempts p WHERE p.booking_id=b.id) AS attempts,
      (SELECT count(*)::int FROM public.payment_refunds f WHERE f.booking_id=b.id) AS refunds
    FROM public.checkout_records b JOIN public.court_reservations r ON r.id=b.reservation_id WHERE b.id=$1`, [bookingId]);
  return row as { reservation_id: string; court_id: string; date: string; starts_at_minute: number; ends_at_minute: number;
    coach_user_id: string | null; status: string; updated_at: string; current_revision_id: string; revisions: number;
    adjustments: number; attempts: number; refunds: number };
}
const currentRevision = async (bookingId: string) => (await database.query(`SELECT to_jsonb(v) AS revision FROM public.booking_revisions v
  JOIN public.checkout_records b ON b.current_revision_id=v.id WHERE b.id=$1`, [bookingId]))[0].revision;

type Target = { locationId: string; courtId: string; date: string; startMinute: number; coachUserId?: string; overrideCoachRestrictions?: boolean;
  requestId?: string; save?: boolean };
async function change(bookingId: string, actor: string, capacity: OperationalCapacity, target: Target, base?: Awaited<ReturnType<typeof state>>) {
  const current = base ?? await state(bookingId);
  const input = operationalChangeInputSchema.parse({ id: bookingId, expectedRevisionId: current.current_revision_id,
    expectedUpdatedAt: current.updated_at, overrideCoachRestrictions: false, save: true, ...target });
  return changeBookingOperationallyCommand(input, actor, capacity);
}
const unchanged = async (bookingId: string, before: Awaited<ReturnType<typeof state>>) => expect(await state(bookingId)).toEqual(before);

// An abandoned online checkout whose hold expired a minute ago with its payment attempt still
// pending. A provider payment id marks a submitted payment: its expired hold stays protected.
async function expiredCheckout(courtId: string, date: string, startMinute: number, providerPaymentId: string | null = null) {
  const reservation = randomUUID(), booking = randomUUID(), attempt = randomUUID();
  await inTransaction(async manager => {
    await manager.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,'held',clock_timestamp()-interval '1 minute',$6)`, [reservation, courtId, date, startMinute, startMinute + 60, customer]);
    await insertBookingRecords(manager, { id: booking, reservation_id: reservation, customer_name: "Abandoned", customer_email: "abandoned@example.test",
      customer_phone: "+40 700", total_amount_minor: 5000, currency: "RON", payment_method: "online", cancellation_notice_minutes: 1440,
      status: "pending_payment" });
    await manager.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at)
      VALUES($1,$2,'online','stripe',$3,5000,'RON','pending',clock_timestamp()-interval '2 minutes')`, [attempt, booking, providerPaymentId]);
  });
  return { reservation, attempt };
}

// An unpaid customer proposal on the booking: a pending adjustment, its pending payment
// attempt and its target hold. An expired one is past its payment window.
async function proposal(bookingId: string, courtId: string, date: string, startMinute: number, expired: boolean) {
  const adjustment = randomUUID(), attempt = randomUUID();
  const target = { courtId, date, startMinute, endMinute: startMinute + 60, expectedUpdatedAt: "fixture", courtName: "Target",
    locationName: "Operational A", timezone: "Europe/Bucharest" };
  await inTransaction(async manager => {
    await manager.query(`INSERT INTO public.booking_adjustments(id,booking_id,base_revision_id,actor_id,scope,request_key,target,original_total,new_total,currency,status,expires_at)
      SELECT $1,b.id,b.current_revision_id,$2,'owner',$3,$4::jsonb,5000,6000,'RON','pending',
        clock_timestamp()+CASE WHEN $6 THEN interval '-1 minute' ELSE interval '10 minutes' END
      FROM public.checkout_records b WHERE b.id=$5`, [adjustment, customer, randomUUID(), JSON.stringify(target), bookingId, expired]);
    await manager.query(`INSERT INTO public.court_reservations(court_id,adjustment_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at)
      SELECT $1,id,$2,$3,$4,'held',expires_at FROM public.booking_adjustments WHERE id=$5`, [courtId, date, startMinute, startMinute + 60, adjustment]);
    await manager.query(`INSERT INTO public.payment_attempts(id,booking_id,adjustment_id,method,provider,amount_minor,currency,status,expires_at)
      VALUES($1,$2,$3,'online','stripe',1000,'RON','pending',clock_timestamp()+interval '10 minutes')`, [attempt, bookingId, adjustment]);
  });
  return { adjustment, attempt };
}

// Every row a change's hold expiry could touch, with its state and last update.
async function evidence(input: { reservations: string[]; adjustments: string[]; attempts: string[] }) {
  return {
    reservations: await database.query(`SELECT id,status,to_json(hold_expires_at)#>>'{}' AS hold_expires_at,to_json(updated_at)#>>'{}' AS updated_at
      FROM public.court_reservations WHERE id=ANY($1::uuid[]) OR adjustment_id=ANY($2::uuid[]) ORDER BY id`, [input.reservations, input.adjustments]),
    adjustments: await database.query(`SELECT id,status,to_json(updated_at)#>>'{}' AS updated_at
      FROM public.booking_adjustments WHERE id=ANY($1::uuid[]) ORDER BY id`, [input.adjustments]),
    attempts: await database.query(`SELECT id,status,to_json(completed_at)#>>'{}' AS completed_at,to_json(updated_at)#>>'{}' AS updated_at
      FROM public.payment_attempts WHERE id=ANY($1::uuid[]) ORDER BY id`, [input.attempts]),
  };
}
const statusOf = async (table: "court_reservations" | "booking_adjustments" | "payment_attempts", id: string) =>
  (await database.query(`SELECT status FROM public.${table} WHERE id=$1`, [id]))[0].status as string;

// Completed-change notifications recorded for any of the booking's revisions.
const rescheduleNotices = async (bookingId: string) => (await database.query(`SELECT
    (SELECT count(*)::int FROM public.user_messages m JOIN public.booking_revisions v ON m.event_key IN ('booking.rescheduled:' || v.id, 'coaching.rescheduled:' || v.id)
      WHERE v.booking_id=$1) + (SELECT count(*)::int FROM public.email_deliveries d JOIN public.booking_revisions v
      ON d.event_key='booking.rescheduled:' || v.id WHERE v.booking_id=$1) AS count`, [bookingId]))[0].count as number;

// The booking's original start (Europe/Bucharest) shifted by a number of milliseconds.
const originalStartPlus = async (date: string, startMinute: number, milliseconds: number) => {
  const [{ epoch }] = await database.query(`SELECT extract(epoch FROM ($1::date + make_interval(mins => $2)) AT TIME ZONE 'Europe/Bucharest')::float8 AS epoch`,
    [date, startMinute]);
  return new Date(epoch * 1000 + milliseconds).toISOString();
};

describe("authorization", () => {
  test("an Admin moves another customer's court booking across locations at an equal obligation", async () => {
    const date = nextDate(), booking = await courtBooking(courtA1, date);
    const original = await currentRevision(booking);
    const result = await change(booking, admin, "admin", { locationId: locationB, courtId: courtB1, date, startMinute: 720 });
    expect(result).toMatchObject({ ok: true, changed: true, totalAmountMinor: 5000 });
    expect(await state(booking)).toMatchObject({ court_id: courtB1, date, starts_at_minute: 720, ends_at_minute: 780, revisions: 2,
      adjustments: 0, attempts: 0, refunds: 0 });
    // The new revision records the operational placement and actor; the agreed price evidence is carried, not repriced.
    expect(await currentRevision(booking)).toMatchObject({ kind: "rescheduled", actor_scope: "admin", actor_user_id: admin,
      location_id: locationB, court_id: courtB1, location_name: "Operational B", total_amount_minor: 5000, pricing_evidence: original.pricing_evidence,
      previous_revision_id: original.id });
  });

  test("a Coach manages only their currently assigned lesson, and the permission follows a reassignment", async () => {
    const date = nextDate(), booking = await lesson(coach, date);
    // Another coach, an Admin+Coach acting as Coach, and the customer's court booking are refused.
    for (const [actor, capacity] of [[coach2, "coach"], [adminCoach, "coach"], [customer, "admin"], [customer, "coach"]] as const)
      expect(await change(booking, actor, capacity, { locationId: locationA, courtId: courtA1, date, startMinute: 660 }))
        .toEqual({ ok: false, reason: "unavailable" });
    const court = await courtBooking(courtA2, date);
    expect(await change(court, coach, "coach", { locationId: locationA, courtId: courtA2, date, startMinute: 900 }))
      .toEqual({ ok: false, reason: "unavailable" });
    expect(await findAdminBookingDetails(database.manager, booking, coach)).toMatchObject({ coach_user_id: coach });
    expect(await findAdminBookingDetails(database.manager, booking, coach2)).toBeNull();
    // The assigned coach reassigns their own lesson; ownership moves with it.
    expect(await change(booking, coach, "coach", { locationId: locationA, courtId: courtA1, date, startMinute: 600, coachUserId: coach2 }))
      .toMatchObject({ ok: true, changed: true });
    // Coach-facing editor reads follow both persisted assignment references too.
    expect(await findAdminBookingDetails(database.manager, booking, coach)).toBeNull();
    expect(await findAdminBookingDetails(database.manager, booking, coach2)).toMatchObject({ coach_user_id: coach2 });
    expect(await change(booking, coach, "coach", { locationId: locationA, courtId: courtA1, date, startMinute: 660 }))
      .toEqual({ ok: false, reason: "unavailable" });
    expect(await change(booking, coach2, "coach", { locationId: locationA, courtId: courtA1, date, startMinute: 660 }))
      .toMatchObject({ ok: true, changed: true });
    // An Admin+Coach account acting as Admin manages any lesson.
    expect(await change(booking, adminCoach, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 720 }))
      .toMatchObject({ ok: true, changed: true });
  });

  test("a revoked role or suspended account is observed under the booking's locks", async () => {
    const date = nextDate(), booking = await lesson(revokedCoach, date);
    await database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code='coach'", [revokedCoach]);
    const before = await state(booking);
    expect(await change(booking, revokedCoach, "coach", { locationId: locationA, courtId: courtA1, date, startMinute: 660 }))
      .toEqual({ ok: false, reason: "unavailable" });
    // A destination coach without the role is ineligible even for an Admin.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 600, coachUserId: revokedCoach }))
      .toEqual({ ok: false, reason: "coach_ineligible" });
    await unchanged(booking, before);
    const suspended = await account(["admin"]);
    await database.query("UPDATE public.users SET status='suspended' WHERE id=$1", [suspended]);
    expect(await change(booking, suspended, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 660 }))
      .toEqual({ ok: false, reason: "unavailable" });
    await unchanged(booking, before);
  });
});

describe("target validation", () => {
  test("forged, inactive, cross-currency and contradictory targets are rejected without writing", async () => {
    const date = nextDate(), booking = await courtBooking(courtA1, date), lessonBooking = await lesson(coach, date, 900);
    const before = await state(booking);
    for (const [target, reason] of [
      [{ locationId: locationA, courtId: courtB1 }, "invalid_target"], // court of another location
      [{ locationId: randomUUID(), courtId: courtA1 }, "invalid_target"],
      [{ locationId: locationArchived, courtId: courtArchived }, "invalid_target"],
      [{ locationId: locationE, courtId: courtE1 }, "cross_currency"],
      [{ locationId: locationA, courtId: courtA2, coachUserId: coach }, "invalid_target"], // a court booking never names a coach
    ] as const) expect(await change(booking, admin, "admin", { date, startMinute: 720, ...target })).toEqual({ ok: false, reason });
    await unchanged(booking, before);
    const lessonBefore = await state(lessonBooking);
    expect(await change(lessonBooking, admin, "admin", { locationId: locationA, courtId: courtA2, date, startMinute: 900, coachUserId: randomUUID() }))
      .toEqual({ ok: false, reason: "coach_ineligible" });
    expect(await change(lessonBooking, admin, "admin", { locationId: locationA, courtId: courtA2, date, startMinute: 900, coachUserId: customer }))
      .toEqual({ ok: false, reason: "coach_ineligible" });
    await unchanged(lessonBooking, lessonBefore);
  });

  test("a different destination price needs its quoted financial consequence accepted", async () => {
    const date = nextDate(), booking = await courtBooking(courtA1, date);
    const before = await state(booking);
    const financial = { consequence: "club_absorbs", currency: "RON", currentAmountMinor: 5000, destinationAmountMinor: 7000,
      customerAmountMinor: 5000, refundMinor: 0, absorbedMinor: 2000 };
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA3, date, startMinute: 600 }))
      .toEqual({ ok: false, reason: "financial_confirmation_required", financial });
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA3, date, startMinute: 600, save: false }))
      .toEqual({ ok: true, changed: true, totalAmountMinor: 5000, revisionId: before.current_revision_id, financial });
    await unchanged(booking, before);
  });

  test("a preview writes nothing and an identical placement is a no-op", async () => {
    const date = nextDate(), booking = await courtBooking(courtA1, date);
    const before = await state(booking);
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA2, date, startMinute: 900, save: false }))
      .toMatchObject({ ok: true, changed: true });
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 600 }))
      .toEqual({ ok: true, changed: false, totalAmountMinor: 5000, revisionId: before.current_revision_id });
    await unchanged(booking, before);
  });

  test("valid local times only across the spring DST gap and at midnight", async () => {
    // The last Sunday of March 2106 in Bucharest skips 03:00–04:00.
    const march = new Date(Date.UTC(2106, 2, 31));
    march.setUTCDate(31 - march.getUTCDay());
    const dst = march.toISOString().slice(0, 10);
    const booking = await courtBooking(courtA1, nextDate());
    const before = await state(booking);
    for (const startMinute of [150, 180]) expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date: dst, startMinute }))
      .toEqual({ ok: false, reason: "invalid-time" });
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date: dst, startMinute: 1410 }))
      .toEqual({ ok: false, reason: "invalid-time" });
    await unchanged(booking, before);
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date: dst, startMinute: 1380 }))
      .toMatchObject({ ok: true, changed: true });
    expect(await state(booking)).toMatchObject({ date: dst, starts_at_minute: 1380, ends_at_minute: 1440 });
  });
});

describe("lesson scheduling and revisions", () => {
  test("a reassignment-only change records a revision and keeps the commercial provenance", async () => {
    const date = nextDate(), booking = await lesson(coach, date);
    const original = await currentRevision(booking);
    // Program compatibility is ignored: coach2 offers only another program, and is not public.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 600, coachUserId: coach2 }))
      .toMatchObject({ ok: true, changed: true, totalAmountMinor: fee });
    expect(await state(booking)).toMatchObject({ court_id: courtA1, starts_at_minute: 600, coach_user_id: coach2, revisions: 2 });
    const reassigned = await currentRevision(booking);
    expect(reassigned).toMatchObject({ coach_user_id: coach2, coach_name: "Second Operational Coach", coaching_program_id: program,
      coaching_program_name: "Operational private", total_amount_minor: fee, actor_scope: "admin" });
    // The agreed price still names the coach and location it was agreed for.
    expect(reassigned.pricing_evidence).toEqual(original.pricing_evidence);
    expect(reassigned.pricing_evidence.coaching).toMatchObject({ coachUserId: coach, locationId: locationA, participantCount: 1, durationMinutes: 60 });
    // The earlier revision is still readable and unchanged.
    expect((await database.query("SELECT to_jsonb(v) AS revision FROM public.booking_revisions v WHERE id=$1", [original.id]))[0].revision).toEqual(original);
    // A lesson moved to another location carries its program, duration and participants.
    expect(await change(booking, admin, "admin", { locationId: locationB, courtId: courtB1, date, startMinute: 1140 }))
      .toMatchObject({ ok: true, changed: true });
    expect(await currentRevision(booking)).toMatchObject({ location_id: locationB, court_id: courtB1, coach_user_id: coach2,
      starts_at_minute: 1140, ends_at_minute: 1200, pricing_evidence: original.pricing_evidence });
  });

  test("Coach restrictions are enforced unless the actor may override them; occupancy never is", async () => {
    const date = nextDate(), booking = await lesson(coach, date);
    const before = await state(booking);
    // 06:00 is outside working hours.
    expect(await change(booking, coach, "coach", { locationId: locationA, courtId: courtA1, date, startMinute: 360 }))
      .toEqual({ ok: false, reason: "coach-unavailable" });
    // A Coach may not override another coach's restrictions when reassigning.
    expect(await change(booking, coach, "coach", { locationId: locationA, courtId: courtA1, date, startMinute: 360, coachUserId: coach2,
      overrideCoachRestrictions: true })).toEqual({ ok: false, reason: "override_denied" });
    // An unassigned location is a configurable restriction too.
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 600, coachUserId: unassigned }))
      .toEqual({ ok: false, reason: "coach-unavailable" });
    await unchanged(booking, before);
    // A Coach overrides their own; an Admin any coach's.
    expect(await change(booking, coach, "coach", { locationId: locationA, courtId: courtA1, date, startMinute: 360, overrideCoachRestrictions: true }))
      .toMatchObject({ ok: true, changed: true });
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 360, coachUserId: unassigned,
      overrideCoachRestrictions: true })).toMatchObject({ ok: true, changed: true });
    expect(await state(booking)).toMatchObject({ coach_user_id: unassigned, starts_at_minute: 360 });
    // Coach and court occupancy (including live holds) are never overridable.
    const other = await lesson(coach, date, 900, courtA2);
    const blocked = await state(booking);
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 900, coachUserId: coach,
      overrideCoachRestrictions: true })).toEqual({ ok: false, reason: "coach-booked" });
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA2, date, startMinute: 900,
      overrideCoachRestrictions: true })).toEqual({ ok: false, reason: "court-unavailable" });
    await database.query(`INSERT INTO public.court_reservations(court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at,created_by_user_id)
      VALUES($1,$2,1080,1140,'held',clock_timestamp()+interval '1 hour',$3)`, [courtA1, date, customer]);
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 1080,
      overrideCoachRestrictions: true })).toEqual({ ok: false, reason: "court-unavailable" });
    await unchanged(booking, blocked);
    expect((await state(other)).revisions).toBe(1);
  });

  test("an expired unpaid hold no longer blocks the destination", async () => {
    const date = nextDate(), booking = await courtBooking(courtA1, date);
    // An abandoned checkout: a pending booking whose hold expired without a payment attempt.
    const hold = randomUUID();
    await inTransaction(async manager => {
      await manager.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at,created_by_user_id)
        VALUES($1,$2,$3,840,900,'held',clock_timestamp()-interval '1 minute',$4)`, [hold, courtA2, date, customer]);
      await insertBookingRecords(manager, { reservation_id: hold, customer_name: "Abandoned", customer_email: "abandoned@example.test",
        customer_phone: "+40 700", total_amount_minor: 5000, currency: "RON", payment_method: "online", cancellation_notice_minutes: 1440,
        status: "pending_payment" });
    });
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA2, date, startMinute: 840 })).toMatchObject({ ok: true, changed: true });
    expect(await state(booking)).toMatchObject({ court_id: courtA2, starts_at_minute: 840 });
    expect(await database.query("SELECT status FROM public.court_reservations WHERE id=$1", [hold])).toEqual([{ status: "released" }]);
  });

  test("a pending change, a started booking and a stale request are refused", async () => {
    const date = nextDate(), booking = await courtBooking(courtA1, date);
    // A customer proposal still inside its payment window is bound to the current revision.
    const pending = await courtBooking(courtA3, date, 600, 660, 7000);
    const open = await proposal(pending, courtA3, date, 780, false);
    const pendingBefore = await state(pending), openBefore = await evidence({ reservations: [], adjustments: [open.adjustment], attempts: [open.attempt] });
    for (const save of [true, false]) expect(await change(pending, admin, "admin", { locationId: locationA, courtId: courtA3, date, startMinute: 900, save }))
      .toEqual({ ok: false, reason: "change_pending" });
    await unchanged(pending, pendingBefore);
    expect(await evidence({ reservations: [], adjustments: [open.adjustment], attempts: [open.attempt] })).toEqual(openBefore);
    expect(await statusOf("booking_adjustments", open.adjustment)).toBe("pending");
    const stale = await state(booking);
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA2, date, startMinute: 600 })).toMatchObject({ ok: true });
    const after = await state(booking);
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 720 }, stale))
      .toEqual({ ok: false, reason: "stale" });
    await unchanged(booking, after);
    const past = await courtBooking(courtA1, "2001-01-01");
    expect(await change(past, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 600 }))
      .toEqual({ ok: false, reason: "started" });
  });

  test("an operation key replays its own result and is never reused for another intent", async () => {
    const date = nextDate(), booking = await courtBooking(courtA1, date), requestId = randomUUID();
    const base = await state(booking);
    const first = await change(booking, admin, "admin", { locationId: locationA, courtId: courtA2, date, startMinute: 600, requestId }, base);
    assert(first.ok);
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA2, date, startMinute: 600, requestId }, base))
      .toEqual({ ok: true, changed: true, totalAmountMinor: 5000, revisionId: first.revisionId });
    expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA2, date, startMinute: 660, requestId }, base))
      .toEqual({ ok: false, reason: "operation_key_reused" });
    expect((await state(booking)).revisions).toBe(2);
  });

  test("the Coach reschedule command shares the foundation and keeps its own rules", async () => {
    const date = nextDate(), booking = await lesson(coach, date, 1140, courtB1, locationB);
    const before = await state(booking);
    const edit = { id: booking, expectedRevisionId: before.current_revision_id, expectedUpdatedAt: before.updated_at, courtId: courtB1, date,
      startMinute: 1200, endMinute: 1260, save: true, expectedTotal: null, priceAcknowledged: false };
    // An active non-public location is operational configuration, not a public offer.
    expect(await rescheduleLessonAsCoachCommand(edit, coach)).toEqual({ ok: true, totalAmountMinor: fee });
    expect(await currentRevision(booking)).toMatchObject({ actor_scope: "coach", starts_at_minute: 1200, coach_user_id: coach,
      coach_name: "Agreed Coach", total_amount_minor: fee });
    const moved = await state(booking);
    expect(await rescheduleLessonAsCoachCommand({ ...edit, expectedRevisionId: moved.current_revision_id, expectedUpdatedAt: moved.updated_at,
      startMinute: 300, endMinute: 360 }, coach)).toEqual({ ok: false, message: "The coach is not available at the selected time." });
    expect(await rescheduleLessonAsCoachCommand({ ...edit, expectedRevisionId: moved.current_revision_id, expectedUpdatedAt: moved.updated_at,
      courtId: randomUUID() }, coach)).toEqual({ ok: false, message: "A coaching lesson keeps its original court. Choose a new date or start time." });
    await unchanged(booking, moved);
  });
});

describe("rejected and previewed changes leave financial state as found", () => {
  test("only an accepted change expires holds, proposals and payment attempts, at both locations", async () => {
    const date = nextDate(), booking = await courtBooking(courtA1, date);
    // The booking's own unpaid proposal has passed its payment window; abandoned checkouts at
    // the origin and the destination have expired holds; a submitted payment protects another.
    const own = await proposal(booking, courtA2, date, 720, true);
    const atA = await expiredCheckout(courtA2, date, 840), atB = await expiredCheckout(courtB1, date, 840);
    const submitted = await expiredCheckout(courtA1, date, 960, `pi_operational_${randomUUID()}`);
    await courtBooking(courtA2, date, 1080, 1140);
    await courtBooking(courtB1, date, 1080, 1140);
    const rows = { reservations: [atA.reservation, atB.reservation, submitted.reservation], adjustments: [own.adjustment],
      attempts: [own.attempt, atA.attempt, atB.attempt, submitted.attempt] };
    const before = await state(booking), found = await evidence(rows);
    const stale = { ...before, current_revision_id: randomUUID() };
    const equal = { consequence: "none", currency: "RON", currentAmountMinor: 5000, destinationAmountMinor: 5000,
      customerAmountMinor: 5000, refundMinor: 0, absorbedMinor: 0 } as const;
    const absorbed = { ...equal, consequence: "club_absorbs", destinationAmountMinor: 7000, absorbedMinor: 2000 } as const;
    for (const [target, reason, base] of [
      [{ locationId: locationA, courtId: courtA3, startMinute: 600 }, { ok: false, reason: "financial_confirmation_required", financial: absorbed }],
      [{ locationId: locationA, courtId: courtA3, startMinute: 600, save: false },
        { ok: true, changed: true, totalAmountMinor: 5000, revisionId: before.current_revision_id, financial: absorbed }],
      [{ locationId: locationA, courtId: courtA2, startMinute: 840 }, { ok: false, reason: "stale" }, stale],
      [{ locationId: locationB, courtId: courtB1, startMinute: 840 }, { ok: false, reason: "stale" }, stale],
      [{ locationId: locationA, courtId: courtA2, startMinute: 1080 }, { ok: false, reason: "court-unavailable" }],
      [{ locationId: locationB, courtId: courtB1, startMinute: 1080 }, { ok: false, reason: "court-unavailable" }],
      // An expired hold with a submitted payment still occupies its court.
      [{ locationId: locationA, courtId: courtA1, startMinute: 960 }, { ok: false, reason: "court-unavailable" }],
      // Previews over the expired holds validate as the change would, then write nothing.
      [{ locationId: locationA, courtId: courtA2, startMinute: 840, save: false }, { ok: true, changed: true, totalAmountMinor: 5000, revisionId: before.current_revision_id, financial: equal }],
      [{ locationId: locationB, courtId: courtB1, startMinute: 840, save: false }, { ok: true, changed: true, totalAmountMinor: 5000, revisionId: before.current_revision_id, financial: equal }],
    ] as const) {
      expect(await change(booking, admin, "admin", { date, ...target }, base)).toEqual(reason);
      await unchanged(booking, before);
      expect(await evidence(rows)).toEqual(found);
    }
    expect(await statusOf("booking_adjustments", own.adjustment)).toBe("pending");
    expect(await rescheduleNotices(booking)).toBe(0);
    // The accepted cross-location move expires everything unprotected at both locations.
    expect(await change(booking, admin, "admin", { locationId: locationB, courtId: courtB1, date, startMinute: 840 }))
      .toMatchObject({ ok: true, changed: true });
    expect(await state(booking)).toMatchObject({ court_id: courtB1, starts_at_minute: 840, revisions: 2 });
    expect(await statusOf("booking_adjustments", own.adjustment)).toBe("expired");
    for (const attempt of [own.attempt, atA.attempt, atB.attempt]) expect(await statusOf("payment_attempts", attempt)).toBe("expired");
    for (const reservation of [atA.reservation, atB.reservation]) expect(await statusOf("court_reservations", reservation)).toBe("released");
    expect(await database.query("SELECT DISTINCT status FROM public.court_reservations WHERE adjustment_id=$1", [own.adjustment]))
      .toEqual([{ status: "released" }]);
    expect(await statusOf("court_reservations", submitted.reservation)).toBe("held");
    expect(await statusOf("payment_attempts", submitted.attempt)).toBe("pending");
  });

  // Customer and Coach rescheduling share the same provisional hold expiry.
  const edit = (bookingId: string, base: Awaited<ReturnType<typeof state>>, target: { courtId: string; date: string; startMinute: number;
    save?: boolean; expectedTotal?: number | null; priceAcknowledged?: boolean; expectedRevisionId?: string }) =>
    bookingRescheduleInputSchema.parse({ id: bookingId, expectedRevisionId: base.current_revision_id, expectedUpdatedAt: base.updated_at,
      endMinute: target.startMinute + 60, save: true, expectedTotal: null, priceAcknowledged: false, ...target });

  test("only an accepted customer reschedule expires holds, proposals and payment attempts", async () => {
    const date = nextDate(), booking = await courtBooking(courtA1, date);
    const own = await proposal(booking, courtA2, date, 720, true);
    const atA = await expiredCheckout(courtA2, date, 840);
    const submitted = await expiredCheckout(courtA1, date, 960, `pi_customer_${randomUUID()}`);
    await courtBooking(courtA2, date, 1080, 1140);
    // An online booking without its captured total cannot change price: a financial rejection.
    const unpaid = await courtBooking(courtA1, date, 1200, 1260, 5000, "online");
    const rows = { reservations: [atA.reservation, submitted.reservation], adjustments: [own.adjustment],
      attempts: [own.attempt, atA.attempt, submitted.attempt] };
    const before = await state(booking), unpaidBefore = await state(unpaid), found = await evidence(rows);
    const stale = { ok: false, reason: "stale", message: "This booking has changed since you opened it. Close and reopen its details." };
    const taken = { ok: false, message: "That court is no longer available. The booking has not changed." };
    for (const [id, base, target, result] of [
      [booking, before, { courtId: courtA2, date, startMinute: 840, expectedTotal: 5000, expectedRevisionId: randomUUID() }, stale],
      [booking, before, { courtId: courtA2, date, startMinute: 1080, expectedTotal: 5000 }, taken],
      // An expired hold with a submitted payment still occupies its court.
      [booking, before, { courtId: courtA1, date, startMinute: 960, expectedTotal: 5000 }, taken],
      [booking, before, { courtId: courtA3, date, startMinute: 840, expectedTotal: 5000, priceAcknowledged: true },
        { ok: false, reason: "price_changed", totalAmountMinor: 7000, message: "The price has changed. Confirm the new total before saving." }],
      [unpaid, unpaidBefore, { courtId: courtA3, date, startMinute: 840, expectedTotal: 7000, priceAcknowledged: true },
        { ok: false, message: "This booking has an unresolved financial balance. Contact the club before changing its price." }],
      // Quotes over the expired holds validate as the change would, then write nothing.
      [booking, before, { courtId: courtA2, date, startMinute: 840, save: false }, { ok: true, totalAmountMinor: 5000 }],
      [booking, before, { courtId: courtA3, date, startMinute: 840, save: false }, { ok: true, totalAmountMinor: 7000 }],
    ] as const) {
      expect(await rescheduleCustomerBookingCommand(edit(id, base, target), customer)).toEqual(result);
      await unchanged(booking, before);
      await unchanged(unpaid, unpaidBefore);
      expect(await evidence(rows)).toEqual(found);
    }
    expect(await statusOf("booking_adjustments", own.adjustment)).toBe("pending");
    expect(await rescheduleCustomerBookingCommand(edit(booking, before, { courtId: courtA2, date, startMinute: 840, expectedTotal: 5000 }), customer))
      .toEqual({ ok: true, totalAmountMinor: 5000 });
    expect(await state(booking)).toMatchObject({ court_id: courtA2, starts_at_minute: 840, revisions: 2 });
    expect(await statusOf("booking_adjustments", own.adjustment)).toBe("expired");
    for (const attempt of [own.attempt, atA.attempt]) expect(await statusOf("payment_attempts", attempt)).toBe("expired");
    expect(await statusOf("court_reservations", atA.reservation)).toBe("released");
    expect(await database.query("SELECT DISTINCT status FROM public.court_reservations WHERE adjustment_id=$1", [own.adjustment]))
      .toEqual([{ status: "released" }]);
    expect(await statusOf("court_reservations", submitted.reservation)).toBe("held");
    expect(await statusOf("payment_attempts", submitted.attempt)).toBe("pending");
  });

  test("a customer's valid unpaid proposal survives rejected and previewed replacements and is superseded by an accepted one", async () => {
    const date = nextDate(), booking = await courtBooking(courtA1, date);
    const open = await proposal(booking, courtA2, date, 720, false);
    await courtBooking(courtA2, date, 1080, 1140);
    const rows = { reservations: [], adjustments: [open.adjustment], attempts: [open.attempt] };
    const before = await state(booking), found = await evidence(rows);
    for (const [target, result] of [
      [{ courtId: courtA2, date, startMinute: 1080, expectedTotal: 5000 }, { ok: false, message: "That court is no longer available. The booking has not changed." }],
      [{ courtId: courtA3, date, startMinute: 840, expectedTotal: 5000, priceAcknowledged: true },
        { ok: false, reason: "price_changed", totalAmountMinor: 7000, message: "The price has changed. Confirm the new total before saving." }],
      [{ courtId: courtA3, date, startMinute: 840, save: false }, { ok: true, totalAmountMinor: 7000 }],
    ] as const) {
      expect(await rescheduleCustomerBookingCommand(edit(booking, before, target), customer)).toEqual(result);
      await unchanged(booking, before);
      expect(await evidence(rows)).toEqual(found);
    }
    expect(await rescheduleCustomerBookingCommand(edit(booking, before, { courtId: courtA3, date, startMinute: 840, expectedTotal: 7000,
      priceAcknowledged: true }), customer)).toEqual({ ok: true, totalAmountMinor: 7000 });
    expect(await state(booking)).toMatchObject({ court_id: courtA3, starts_at_minute: 840, revisions: 2 });
    expect(await statusOf("booking_adjustments", open.adjustment)).toBe("cancelled");
    expect(await statusOf("payment_attempts", open.attempt)).toBe("expired");
    expect(await database.query("SELECT DISTINCT status FROM public.court_reservations WHERE adjustment_id=$1", [open.adjustment]))
      .toEqual([{ status: "released" }]);
  });

  test("only an accepted Coach reschedule expires holds, proposals and payment attempts", async () => {
    const date = nextDate(), booking = await lesson(coach, date, 600);
    const own = await proposal(booking, courtA2, date, 720, true);
    const atA = await expiredCheckout(courtA1, date, 840);
    const submitted = await expiredCheckout(courtA1, date, 960, `pi_coach_${randomUUID()}`);
    await courtBooking(courtA1, date, 720, 780);
    await lesson(coach, date, 1020, courtA2);
    const rows = { reservations: [atA.reservation, submitted.reservation], adjustments: [own.adjustment],
      attempts: [own.attempt, atA.attempt, submitted.attempt] };
    const before = await state(booking), found = await evidence(rows);
    const taken = { ok: false, message: "That court is no longer available. The booking has not changed." };
    for (const [target, result] of [
      [{ courtId: courtA1, date, startMinute: 840, expectedRevisionId: randomUUID() },
        { ok: false, reason: "stale", message: "This lesson has changed since you opened it. Close and reopen its details." }],
      [{ courtId: courtA1, date, startMinute: 720 }, taken],
      [{ courtId: courtA1, date, startMinute: 960 }, taken],
      [{ courtId: courtA1, date, startMinute: 1020 },
        { ok: false, message: "The coach is no longer available at the selected time. The booking has not changed." }],
      [{ courtId: courtA1, date, startMinute: 840, save: false }, { ok: true, totalAmountMinor: fee }],
    ] as const) {
      expect(await rescheduleLessonAsCoachCommand(edit(booking, before, target), coach)).toEqual(result);
      await unchanged(booking, before);
      expect(await evidence(rows)).toEqual(found);
    }
    expect(await statusOf("booking_adjustments", own.adjustment)).toBe("pending");
    expect(await rescheduleLessonAsCoachCommand(edit(booking, before, { courtId: courtA1, date, startMinute: 840 }), coach))
      .toEqual({ ok: true, totalAmountMinor: fee });
    expect(await state(booking)).toMatchObject({ court_id: courtA1, starts_at_minute: 840, revisions: 2, adjustments: 1, attempts: 1, refunds: 0 });
    expect(await statusOf("booking_adjustments", own.adjustment)).toBe("expired");
    for (const attempt of [own.attempt, atA.attempt]) expect(await statusOf("payment_attempts", attempt)).toBe("expired");
    expect(await statusOf("court_reservations", atA.reservation)).toBe("released");
    expect(await statusOf("court_reservations", submitted.reservation)).toBe("held");
    expect(await statusOf("payment_attempts", submitted.attempt)).toBe("pending");
  });
});

describe("start-time eligibility", () => {
  test("a booking whose start passes while its change validates is not moved", async () => {
    const date = nextDate(), later = nextDate(), booking = await courtBooking(courtA1, date);
    const own = await proposal(booking, courtA2, date, 720, true);
    const rows = { reservations: [], adjustments: [own.adjustment], attempts: [own.attempt] };
    const before = await state(booking), found = await evidence(rows);
    // Eligible when the request starts; the original start passes during target validation.
    clock.afterTarget = await originalStartPlus(date, 600, 1);
    try {
      expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA2, date: later, startMinute: 600 }))
        .toEqual({ ok: false, reason: "started" });
    } finally { clock.afterTarget = null; clock.now = null; }
    await unchanged(booking, before);
    expect(await evidence(rows)).toEqual(found);
    expect(await rescheduleNotices(booking)).toBe(0);
  });

  test("a change completed just before the original start is accepted", async () => {
    const date = nextDate(), later = nextDate(), booking = await courtBooking(courtA1, date);
    clock.afterTarget = await originalStartPlus(date, 600, -1);
    try {
      expect(await change(booking, admin, "admin", { locationId: locationA, courtId: courtA2, date: later, startMinute: 600 }))
        .toMatchObject({ ok: true, changed: true });
    } finally { clock.afterTarget = null; clock.now = null; }
    expect(await state(booking)).toMatchObject({ court_id: courtA2, date: later, starts_at_minute: 600, revisions: 2 });
  });

  test("a lesson whose start passes during validation keeps its coach and placement", async () => {
    const date = nextDate(), booking = await lesson(coach, date);
    const before = await state(booking);
    clock.afterTarget = await originalStartPlus(date, 600, 1);
    try {
      expect(await change(booking, coach, "coach", { locationId: locationB, courtId: courtB1, date: nextDate(), startMinute: 1140 }))
        .toEqual({ ok: false, reason: "started" });
    } finally { clock.afterTarget = null; clock.now = null; }
    await unchanged(booking, before);
    expect(await rescheduleNotices(booking)).toBe(0);
  });
});

describe("concurrency", () => {
  test("competing moves to one court interval: exactly one wins, the other leaves no partial state", async () => {
    const date = nextDate(), first = await courtBooking(courtA1, date, 600, 660), second = await courtBooking(courtB1, date, 600, 660);
    const secondBefore = await state(second);
    const results = await settled([
      change(first, admin, "admin", { locationId: locationA, courtId: courtA2, date, startMinute: 900 }),
      change(second, admin, "admin", { locationId: locationA, courtId: courtA2, date, startMinute: 900 }),
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    const loser = results.findIndex(result => !result.ok);
    expect(results[loser]).toEqual({ ok: false, reason: "court-unavailable" });
    if (loser === 1) await unchanged(second, secondBefore);
  });

  test("opposite-direction cross-location moves serialize without deadlock", async () => {
    const date = nextDate(), atA = await courtBooking(courtA1, date, 600, 660), atB = await courtBooking(courtB1, date, 600, 660);
    for (let round = 0; round < 3; round++) {
      const [left, right] = [await state(atA), await state(atB)];
      const start = 720 + 120 * round;
      const results = await settled([
        change(atA, admin, "admin", { locationId: left.court_id === courtA1 ? locationB : locationA, courtId: left.court_id === courtA1 ? courtB1 : courtA1, date, startMinute: start }, left),
        change(atB, admin, "admin", { locationId: right.court_id === courtB1 ? locationA : locationB, courtId: right.court_id === courtB1 ? courtA1 : courtB1, date, startMinute: start + 60 }, right),
      ]);
      expect(results).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
    }
  });

  test("competing reassignments to one coach: the coach is never double-booked", async () => {
    const date = nextDate(), first = await lesson(coach, date, 600, courtA1), second = await lesson(adminCoach, date, 1140, courtB1, locationB);
    const results = await settled([
      // The Admin overrides coach2's hours for both; coach occupancy still applies.
      change(first, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 900, coachUserId: coach2, overrideCoachRestrictions: true }),
      change(second, admin, "admin", { locationId: locationB, courtId: courtB1, date, startMinute: 900, coachUserId: coach2, overrideCoachRestrictions: true }),
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)).toEqual({ ok: false, reason: "coach-booked" });
    expect(await database.query(`SELECT count(*)::int AS count FROM public.court_reservations WHERE coach_user_id=$1 AND booking_date=$2 AND status='active'`,
      [coach2, date])).toEqual([{ count: 1 }]);
  });

  test("a reassignment racing the former coach's own change leaves one consistent outcome", async () => {
    const date = nextDate(), booking = await lesson(coach, date);
    const base = await state(booking);
    const [reassigned, moved] = await settled([
      change(booking, admin, "admin", { locationId: locationA, courtId: courtA1, date, startMinute: 600, coachUserId: coach2 }, base),
      change(booking, coach, "coach", { locationId: locationA, courtId: courtA1, date, startMinute: 720 }, base),
    ]);
    expect([reassigned.ok, moved.ok].filter(Boolean)).toHaveLength(1);
    // The loser sees either a stale base (the Admin after the Coach's move) or, once
    // reassigned, no longer the Coach's lesson.
    expect(["stale", "unavailable"]).toContain(([reassigned, moved].find(result => !result.ok) as { reason: string }).reason);
    expect((await state(booking)).revisions).toBe(2);
  });
});

test("visual editor excludes its own occupancy, protects other intervals and reads private destinations", async () => {
  clock.now = null;
  editorActor.admin.mockResolvedValue({ userId: admin });
  const date = nextDate(), id = await courtBooking(courtA1, date, 600, 690);
  await courtBooking(courtA2, date, 630, 690);
  const before = await state(id);
  const result = await loadOperationalBookingDay({ id, locationId: locationA, date }, "admin");
  assert.ok(!("ok" in result));
  expect(result.starts).toContainEqual({ courtId: courtA1, startMinute: 600 });
  expect(result.starts).not.toContainEqual({ courtId: courtA2, startMinute: 600 });
  expect(result.day.courts.find(row => row.court.id === courtA2)?.cells[result.day.times.indexOf(630)]).toBe("booked");
  expect(JSON.stringify(result)).not.toMatch(/Operational Customer|operational-customer@example/);
  const other = await loadOperationalBookingDay({ id, locationId: locationB, date: nextDate() }, "admin");
  assert.ok(!("ok" in other));
  expect(other.starts).toContainEqual({ courtId: courtB1, startMinute: 600 });
  expect(await loadOperationalBookingDay({ id, locationId: locationE, date }, "admin")).toEqual({ ok: false, message: "Bookings cannot move between currencies." });
  await unchanged(id, before);
});

test("visual lesson starts follow staff capacity, replacement availability and global Coach occupancy", async () => {
  editorActor.admin.mockResolvedValue({ userId: admin });
  editorActor.coach.mockResolvedValue({ userId: coach });
  const date = nextDate(), id = await lesson(coach, date);
  await lesson(coach2, date, 1140, courtB1, locationB);
  const starts = async (capacity: OperationalCapacity, coachUserId: string) => {
    const result = await loadOperationalBookingDay({ id, locationId: locationA, date, coachUserId }, capacity);
    assert.ok(!("ok" in result)); return result.starts;
  };
  expect(await starts("coach", coach)).toContainEqual({ courtId: courtA1, startMinute: 1200 });
  expect(await starts("coach", coach2)).not.toContainEqual({ courtId: courtA1, startMinute: 1200 });
  expect(await starts("admin", coach2)).toContainEqual({ courtId: courtA1, startMinute: 1200 });
  expect(await starts("admin", coach2)).not.toContainEqual({ courtId: courtA1, startMinute: 1140 });
  expect(await starts("coach", coach2)).toContainEqual({ courtId: courtA1, startMinute: 600 });
  editorActor.coach.mockResolvedValue({ userId: coach2 });
  expect(await loadOperationalBookingDay({ id, locationId: locationA, date }, "coach")).toEqual({ ok: false, message: "This booking is no longer available to edit." });
  editorActor.admin.mockRejectedValue(new Error("unauthorized"));
  await expect(loadOperationalBookingDay({ id, locationId: locationA, date }, "admin")).rejects.toThrow("unauthorized");
});
