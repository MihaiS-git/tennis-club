import { randomUUID } from "node:crypto";
import { afterAll, assert, beforeAll, expect, test, vi } from "vitest";
import type { DataSource, QueryRunner } from "typeorm";
import { getDataSource } from "@/lib/db/data-source";
import { insertCustomerReservation } from "@/lib/db/repositories/reservations.repository";
import { insertBookingRecords } from "../../local/booking-fixtures";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";

// PostgreSQL guarantees for coaching occupancy: one coach per lesson time across
// courts and locations, alongside the unchanged court exclusion.
const service = localFixtureClient();
let database: DataSource;
const userIds: string[] = [];
const [locationA, locationB] = [randomUUID(), randomUUID()];
const [courtA1, courtA2, courtB1] = [randomUUID(), randomUUID(), randomUUID()];
const program = randomUUID();
let coach: string, otherCoach: string, member: string;
const date = "2099-11-02";

async function account() {
  const { data, error } = await service.auth.admin.createUser({
    email: `coaching-reservation-${randomUUID()}@example.test`, password: "coaching-reservation-password-123", email_confirm: true,
  });
  assert.strictEqual(error, null); assert.ok(data.user);
  userIds.push(data.user.id);
  return data.user.id;
}

beforeAll(async () => {
  expect(process.env.TEST_SUPABASE_PROJECT).toBe("tennis-club-tests");
  expect(new URL(process.env.DATABASE_URL!).port).toBe("55322");
  // Separate contender and observer connections for the concurrency test.
  vi.stubEnv("DATABASE_POOL_MAX", "4");
  database = await getDataSource();
  [coach, otherCoach, member] = [await account(), await account(), await account()];
  await database.query(`INSERT INTO public.locations(id,name,slug,timezone) VALUES
    ($1,'Coaching occupancy A',($1::uuid)::text,'UTC'),($2,'Coaching occupancy B',($2::uuid)::text,'UTC')`, [locationA, locationB]);
  await database.query(`INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES
    ($1,$4,'A1','a1','hard','outdoor'),($2,$4,'A2','a2','hard','outdoor'),($3,$5,'B1','b1','hard','outdoor')`,
  [courtA1, courtA2, courtB1, locationA, locationB]);
  for (const id of [coach, otherCoach]) await database.query(`INSERT INTO public.coach_profiles
    (user_id,display_name,bio,qualifications,specialties,languages) VALUES($1,'Occupancy Coach','','','{}','{}')`, [id]);
  await database.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,court_rental_included)
    VALUES($1,'Private lesson','','private',false)`, [program]);
});

afterAll(async () => {
  if (!database) return;
  try {
    const courts = [courtA1, courtA2, courtB1];
    await database.query("DELETE FROM public.court_reservations WHERE court_id=ANY($1::uuid[])", [courts]);
    await database.query("DELETE FROM public.coaching_programs WHERE id=$1", [program]);
    await database.query("DELETE FROM public.coach_profiles WHERE user_id=ANY($1::uuid[])", [userIds]);
    await database.query("DELETE FROM public.courts WHERE id=ANY($1::uuid[])", [courts]);
    await database.query("DELETE FROM public.locations WHERE id=ANY($1::uuid[])", [[locationA, locationB]]);
    await cleanupAuthFixtures(service, userIds);
  } finally { await database.destroy(); }
});

type Occupancy = { court: string; start: number; end: number; coach?: string | null; status?: "active" | "held"; day?: string };
async function occupy(runner: QueryRunner, value: Occupancy) {
  const id = randomUUID();
  await runner.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at,coach_user_id)
    VALUES($1,$2,$3,$4,$5,$6::public.court_reservation_status,CASE WHEN $6::text='held' THEN now()+interval '10 minutes' END,$7)`,
  [id, value.court, value.day ?? date, value.start, value.end, value.status ?? "active", value.coach ?? null]);
  return id;
}

// Each expected failure is isolated by a savepoint so the surrounding fixture survives.
async function rejects(runner: QueryRunner, action: () => Promise<unknown>, code: string, constraint?: string) {
  await runner.query("SAVEPOINT expected_failure");
  try {
    await expect(action()).rejects.toMatchObject({ driverError: constraint ? { code, constraint } : { code } });
  } finally { await runner.query("ROLLBACK TO SAVEPOINT expected_failure"); }
}

async function inRollback(work: (runner: QueryRunner) => Promise<void>) {
  const runner = database.createQueryRunner();
  await runner.startTransaction();
  try { await work(runner); } finally { await runner.rollbackTransaction(); await runner.release(); }
}

test("schema exposes the coach exclusion beside the unchanged court exclusion", async () => {
  const constraints: { conname: string; definition: string }[] = await database.query(`SELECT conname,pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid='public.court_reservations'::regclass AND contype='x' ORDER BY conname`);
  expect(constraints.map(row => row.conname)).toEqual(["court_reservation_coach_no_overlap", "court_reservation_no_overlap"]);
  expect(constraints[0].definition).toContain("coach_user_id WITH =");
  expect(constraints[0].definition).toContain("(coach_user_id IS NOT NULL)");
  expect(constraints[1].definition).toContain("court_id WITH =");
  const reservation = database.getMetadata("public.court_reservations");
  expect(reservation.findColumnWithPropertyName("coachUserId")).toMatchObject({ databaseName: "coach_user_id", isNullable: true });
  const revision = database.getMetadata("public.booking_revisions");
  for (const [property, column] of [["coachUserId", "coach_user_id"], ["coachingProgramId", "coaching_program_id"],
    ["coachName", "coach_name"], ["coachingProgramName", "coaching_program_name"]])
    expect(revision.findColumnWithPropertyName(property)).toMatchObject({ databaseName: column, isNullable: true });
});

test("one coach cannot hold or teach overlapping lessons on different courts or locations", () => inRollback(async (runner) => {
  const first = await occupy(runner, { court: courtA1, start: 600, end: 660, coach, status: "held" });
  for (const conflict of [
    { court: courtA2, start: 630, end: 690 }, { court: courtB1, start: 600, end: 660 },
    { court: courtB1, start: 540, end: 720, status: "held" as const },
  ]) await rejects(runner, () => occupy(runner, { ...conflict, coach }), "23P01", "court_reservation_coach_no_overlap");
  // Adjacent lessons, another date, another coach and ordinary bookings at the same time are allowed.
  await occupy(runner, { court: courtA2, start: 660, end: 720, coach });
  await occupy(runner, { court: courtB1, start: 600, end: 660, coach, day: "2099-11-03" });
  await occupy(runner, { court: courtA2, start: 600, end: 660, coach: otherCoach });
  await occupy(runner, { court: courtB1, start: 720, end: 780 });
  // Released or cancelled occupancy no longer occupies the coach.
  await runner.query("UPDATE public.court_reservations SET status='released',hold_expires_at=NULL WHERE id=$1", [first]);
  await occupy(runner, { court: courtB1, start: 600, end: 660, coach, status: "held" });
  const lesson = await occupy(runner, { court: courtA1, start: 780, end: 840, coach });
  await runner.query("UPDATE public.court_reservations SET status='cancelled',cancelled_at=now(),cancelled_by_user_id=$2 WHERE id=$1", [lesson, member]);
  await occupy(runner, { court: courtB1, start: 780, end: 840, coach });
  // A released hold cannot become active again over the coach's newer lesson.
  await rejects(runner, () => runner.query("UPDATE public.court_reservations SET status='active' WHERE id=$1", [first]),
    "23P01", "court_reservation_coach_no_overlap");
}));

test("court exclusion still applies to coaching occupancy", () => inRollback(async (runner) => {
  await occupy(runner, { court: courtA1, start: 600, end: 690, coach, status: "held" });
  await rejects(runner, () => occupy(runner, { court: courtA1, start: 630, end: 720 }), "23P01", "court_reservation_no_overlap");
  await rejects(runner, () => occupy(runner, { court: courtA1, start: 660, end: 720, coach: otherCoach }), "23P01", "court_reservation_no_overlap");
  await occupy(runner, { court: courtA1, start: 690, end: 750 });
  await rejects(runner, () => occupy(runner, { court: courtA1, start: 720, end: 780, coach: otherCoach }), "23P01", "court_reservation_no_overlap");
}));

test("concurrent competing lessons for one coach admit exactly one winner", async () => {
  const [first, second, observer] = [database.createQueryRunner(), database.createQueryRunner(), database.createQueryRunner()];
  await first.connect(); await second.connect(); await observer.connect();
  const pid = async (runner: QueryRunner) => (await runner.query("SELECT pg_backend_pid() AS pid"))[0].pid as number;
  // PostgreSQL's wait-for graph proves the second insert waited on the first transaction.
  const waitForBlock = async (blocker: number, waiter: number) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const rows: { pid: number }[] = await observer.query(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))", [blocker]);
      if (rows.some(row => row.pid === waiter)) return;
    }
    throw new Error("Expected PostgreSQL lock wait was not observed.");
  };
  let competing: Promise<unknown> | undefined;
  try {
    // Read each PID first: a connection with a blocked statement queues later queries.
    const [firstPid, secondPid] = [await pid(first), await pid(second)];
    for (const outcome of ["commit", "rollback"] as const) {
      const start = outcome === "commit" ? 900 : 1020;
      await first.startTransaction(); await second.startTransaction();
      await occupy(first, { court: courtA1, start, end: start + 60, coach, status: "held" });
      competing = occupy(second, { court: courtB1, start: start + 30, end: start + 90, coach, status: "held" })
        .then(() => "inserted", (error: unknown) => error);
      await waitForBlock(firstPid, secondPid);
      if (outcome === "commit") {
        await first.commitTransaction();
        expect(await competing).toMatchObject({ driverError: { code: "23P01", constraint: "court_reservation_coach_no_overlap" } });
        await second.rollbackTransaction();
      } else {
        await first.rollbackTransaction();
        expect(await competing).toBe("inserted");
        await second.commitTransaction();
      }
    }
    expect(await observer.query(`SELECT court_id,starts_at_minute FROM public.court_reservations
      WHERE coach_user_id=$1 AND booking_date=$2 ORDER BY starts_at_minute`, [coach, date]))
      .toEqual([{ court_id: courtA1, starts_at_minute: 900 }, { court_id: courtB1, starts_at_minute: 1050 }]);
  } finally {
    if (first.isTransactionActive) await first.rollbackTransaction();
    if (competing) await Promise.allSettled([competing]);
    if (second.isTransactionActive) await second.rollbackTransaction();
    await first.release(); await second.release(); await observer.release();
  }
});

test("ordinary court reservations and bookings are unchanged", () => inRollback(async (runner) => {
  const reservation = randomUUID();
  await insertCustomerReservation(runner.manager, { id: reservation, courtId: courtA2, date: "2099-11-04", startMinute: 600,
    endMinute: 660, status: "held", holdExpiresAt: new Date(Date.now() + 600_000).toISOString() });
  // Coachless rows never compare equal in the coach exclusion.
  await occupy(runner, { court: courtB1, start: 600, end: 660, day: "2099-11-04", status: "held" });
  const booking = randomUUID();
  await insertBookingRecords(runner.manager, { id: booking, reservation_id: reservation, account_user_id: member, customer_name: "Customer",
    customer_email: "ordinary@example.test", customer_phone: "123", total_amount_minor: 5000, currency: "EUR",
    payment_method: "online", cancellation_notice_minutes: 1440, status: "pending_payment" });
  await runner.query("SET CONSTRAINTS ALL IMMEDIATE");
  expect(await runner.query("SELECT coach_user_id FROM public.court_reservations WHERE id=$1", [reservation])).toEqual([{ coach_user_id: null }]);
  expect(await runner.query(`SELECT coach_user_id,coaching_program_id,coach_name,coaching_program_name
    FROM public.booking_revisions WHERE booking_id=$1`, [booking]))
    .toEqual([{ coach_user_id: null, coaching_program_id: null, coach_name: null, coaching_program_name: null }]);
  await rejects(runner, () => occupy(runner, { court: courtA2, start: 630, end: 690, day: "2099-11-04" }), "23P01", "court_reservation_no_overlap");
}));

test("coaching references and historical snapshots are structurally complete", () => inRollback(async (runner) => {
  // Occupancy may name only a coach with a coaching profile, which then cannot be removed.
  await rejects(runner, () => occupy(runner, { court: courtA1, start: 600, end: 660, coach: member }), "23503", "court_reservations_coach_user_id_fkey");
  const reservation = await occupy(runner, { court: courtA1, start: 600, end: 660, coach });
  await rejects(runner, () => runner.query("DELETE FROM public.coach_profiles WHERE user_id=$1", [coach]),
    "23503", "court_reservations_coach_user_id_fkey");

  const booking = randomUUID();
  await insertBookingRecords(runner.manager, { id: booking, reservation_id: reservation, account_user_id: member, customer_name: "Customer",
    customer_email: "lesson@example.test", customer_phone: "123", total_amount_minor: 9000, currency: "EUR",
    payment_method: "online", cancellation_notice_minutes: 1440 });
  const [{ current_revision_id: head }] = await runner.query("SELECT current_revision_id FROM public.bookings WHERE id=$1", [booking]);
  // Append a successor revision carrying the coaching terms (the head stays valid only after the pointer moves).
  const append = (values: { coachId: string | null; programId: string | null; coachName: string | null; programName: string | null }) => {
    const id = randomUUID();
    return runner.query(`INSERT INTO public.booking_revisions(id,booking_id,revision_number,previous_revision_id,operation_key,intent_hash,
        kind,booking_state,location_id,court_id,location_name,court_name,timezone,booking_date,starts_at_minute,ends_at_minute,
        customer_name,customer_email,customer_phone,total_amount_minor,currency,payment_method,cancellation_notice_minutes,
        actor_user_id,actor_scope,recorded_at,pricing_evidence,coach_user_id,coaching_program_id,coach_name,coaching_program_name)
      SELECT $1,booking_id,2,id,'coaching-probe','probe','rescheduled','confirmed',location_id,court_id,location_name,court_name,
        timezone,booking_date,starts_at_minute,ends_at_minute,customer_name,customer_email,customer_phone,total_amount_minor,currency,
        payment_method,cancellation_notice_minutes,actor_user_id,actor_scope,recorded_at,pricing_evidence,$3,$4,$5,$6
      FROM public.booking_revisions WHERE id=$2`, [id, head, values.coachId, values.programId, values.coachName, values.programName])
      .then(() => id);
  };
  const complete = { coachId: coach, programId: program, coachName: "Occupancy Coach", programName: "Private lesson" };
  for (const partial of [{ ...complete, programId: null }, { ...complete, coachId: null }, { ...complete, coachName: null },
    { ...complete, programName: " " }, { ...complete, coachName: "x".repeat(101) },
    { coachId: null, programId: null, coachName: "Occupancy Coach", programName: null }])
    await rejects(runner, () => append(partial), "23514", "booking_revisions_coaching");
  await rejects(runner, () => append({ ...complete, coachId: member }), "23503", "booking_revisions_coach_fkey");
  await rejects(runner, () => append({ ...complete, programId: randomUUID() }), "23503", "booking_revisions_coaching_program_fkey");

  const revision = await append(complete);
  await runner.query("UPDATE public.bookings SET current_revision_id=$1 WHERE id=$2", [revision, booking]);
  await runner.query("SET CONSTRAINTS ALL IMMEDIATE");
  expect(await runner.query(`SELECT coach_user_id,coaching_program_id,coach_name,coaching_program_name
    FROM public.booking_revisions WHERE id=$1`, [revision]))
    .toEqual([{ coach_user_id: coach, coaching_program_id: program, coach_name: "Occupancy Coach", coaching_program_name: "Private lesson" }]);
  // Historical coaching snapshots are immutable and keep their coach and program.
  await rejects(runner, () => runner.query("UPDATE public.booking_revisions SET coach_name='Renamed' WHERE id=$1", [revision]),
    "23514");
  await rejects(runner, () => runner.query("DELETE FROM public.coaching_programs WHERE id=$1", [program]),
    "23503", "booking_revisions_coaching_program_fkey");
}));
