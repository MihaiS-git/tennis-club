import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DataSource, EntityManager, QueryRunner } from "typeorm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import * as repository from "@/lib/db/repositories/reservations.repository";
import * as accounts from "@/lib/db/repositories/accounts.repository";
import { lockConfigurationForWrite, lockLocations } from "@/lib/db/repositories/clubs.repository";
import { createDirectReservation, editDirectReservationAsAdmin, cancelDirectReservationAsAdmin } from "@/lib/reservations/service";
import { editOwnDirectReservation, cancelOwnDirectReservation } from "@/lib/reservations/personal-service";
import { localMinute, localToday } from "@/lib/courts/local-time";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

let database: DataSource;
let service: SupabaseClient;
let admin: SupabaseClient, coach: SupabaseClient;
let adminId: string, coachId: string;
const userIds: string[] = [];
const locationId = randomUUID(), otherLocationId = randomUUID(), courtId = randomUUID(), secondCourtId = randomUUID();
const date = "2099-10-15", now = new Date("2099-10-14T12:00:00Z");
const input = { locationId, courtId, date, startMinute: 600, endMinute: 660, reason: "Training" };

beforeAll(async () => {
  const url = process.env.DATABASE_URL!;
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url).hostname);
  vi.stubEnv("DATABASE_URL", url); vi.stubEnv("DATABASE_POOL_MAX", "8");
  database = await getDataSource(); service = localFixtureClient(); await ensureIntegrationAdminAnchor(service);
  async function actor(role: "admin" | "coach") {
    const email = `reservation-${role}-${randomUUID()}@example.test`, password = "reservation-race-password-123";
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull(); if (!created.data.user) throw new Error("Missing actor");
    const id = created.data.user.id; userIds.push(id);
    await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,$2)", [id, role]);
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    return { id, client };
  }
  const a = await actor("admin"), c = await actor("coach"); admin = a.client; adminId = a.id; coach = c.client; coachId = c.id;
  for (const id of [locationId, otherLocationId]) {
    await database.query("INSERT INTO public.locations(id,name,slug,timezone) VALUES($1,'Race fixture',$2,'UTC')", [id, `reservation-${id}`]);
  }
  for (const id of [courtId, secondCourtId]) {
    await database.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,$3,$4,'clay','outdoor')",
      [id, locationId, id === courtId ? "Court 1" : "Court 2", `court-${id}`]);
  }
});

async function clearReservations() {
  await database.query("DELETE FROM public.bookings WHERE reservation_id IN (SELECT id FROM public.court_reservations WHERE court_id = ANY($1::uuid[]))", [[courtId, secondCourtId]]);
  await database.query("DELETE FROM public.court_reservations WHERE court_id = ANY($1::uuid[])", [[courtId, secondCourtId]]);
}
beforeEach(async () => {
  await clearReservations();
  await database.query("UPDATE public.courts SET is_active=true,location_id=$2 WHERE id=ANY($1::uuid[])", [[courtId, secondCourtId], locationId]);
  await database.query("UPDATE public.locations SET is_active=true,archived_at=null,timezone='UTC' WHERE id=$1", [locationId]);
  await database.query("UPDATE public.users SET status='active' WHERE id=$1", [coachId]);
  await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'coach') ON CONFLICT DO NOTHING", [coachId]);
  await database.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [locationId]);
  await database.query("INSERT INTO public.location_opening_hours(location_id,weekday,opens_at_minute,closes_at_minute) VALUES($1,3,0,1440)", [locationId]);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try {
    if (database) {
      await clearReservations();
      await database.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [locationId]);
      await database.query("DELETE FROM public.courts WHERE id=ANY($1::uuid[])", [[courtId, secondCourtId]]);
      await database.query("DELETE FROM public.locations WHERE id=ANY($1::uuid[])", [[locationId, otherLocationId]]);
      await cleanupAuthFixtures(service, userIds);
    }
  } finally { if (database?.isInitialized) await database.destroy(); vi.unstubAllEnvs(); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function backend(manager: EntityManager) {
  const rows: unknown = await manager.query("SELECT pg_backend_pid() AS pid");
  return z.array(z.object({ pid: z.number() })).length(1).parse(rows)[0].pid;
}
async function waitForBlock(pid: number) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows: unknown = await database.query("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid]);
    if (z.array(z.object({ pid: z.number() })).parse(rows).length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected PostgreSQL wait-for edge was not observed");
}
async function reservation() {
  const rows: unknown = await database.query("SELECT id FROM public.court_reservations WHERE court_id=$1 AND status='active' ORDER BY starts_at_minute", [courtId]);
  const id = z.array(z.object({ id: z.uuid() })).parse(rows)[0]?.id;
  if (!id) throw new Error("Missing reservation");
  const row = await inTransaction((manager) => repository.findReservationForUpdate(manager, id));
  if (!row) throw new Error("Missing reservation");
  return row;
}
async function seed() { expect(await createDirectReservation(input, coach, now)).toEqual({ ok: true }); return reservation(); }
async function runner(): Promise<QueryRunner> {
  const runner = database.createQueryRunner(); await runner.connect(); await runner.startTransaction(); return runner;
}

// Services run actual TypeORM transactions; spies only control acquisition order.
test("same-slot real creates yield one success, one exact overlap result and one active row", async () => {
  const write = vi.spyOn(repository,"insertDirectReservation");
  const results = await Promise.all([createDirectReservation(input, admin, now), createDirectReservation(input, coach, now)]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(write).toHaveBeenCalledTimes(1);
  expect(results.find((result) => !result.ok)).toEqual({ ok: false,
    message: "That court is no longer available for the selected time. Choose another interval." });
  const rows: unknown = await database.query("SELECT count(*)::integer AS count FROM public.court_reservations WHERE court_id=$1 AND status='active'", [courtId]);
  expect(rows).toEqual([{ count: 1 }]);
});

test("lossless tokens match PostgREST and reject differences confined to PostgreSQL microseconds", async () => {
  const row = await seed();
  await database.query("UPDATE public.court_reservations SET updated_at='2026-10-01T12:00:00.123456Z' WHERE id=$1", [row.id]);
  const read = await inTransaction((manager) => repository.findReservationForUpdate(manager, row.id, "2026-10-01T12:00:00.123457Z"));
  expect(read?.updated_at).toBe("2026-10-01T12:00:00.123456+00:00"); expect(read?.token_matches).toBe(false);
  expect((await service.from("court_reservations").select("updated_at").eq("id", row.id).single()).data?.updated_at).toBe(read?.updated_at);
  expect(await editOwnDirectReservation({ kind: "reason", id: row.id, expectedUpdatedAt: "2026-10-01T12:00:00.123457Z", reason: "Overwrite" }, coach, now))
    .toMatchObject({ ok: false, stale: true });
  expect((await reservation()).reason).toBe("Training");
  // A future old token proves the monotonic floor rather than only clock advancement.
  await database.query("UPDATE public.court_reservations SET updated_at='2100-01-01T00:00:00.000001Z' WHERE id=$1", [row.id]);
  const current = await reservation();
  expect(await editOwnDirectReservation({ kind: "reason", id: row.id, expectedUpdatedAt: current.updated_at, reason: "Training" }, coach, now)).toEqual({ ok: true });
  expect((await reservation()).updated_at).toBe("2100-01-01T00:00:00.000002+00:00");
});

test("forced failure after completed updates rolls back schedule, reason, token and lifecycle", async () => {
  const original = await seed();
  await expect(inTransaction(async (manager) => {
    await repository.findReservationForUpdate(manager, original.id);
    await repository.updateDirectReservationSchedule(manager, original.id, { ...input, courtId: secondCourtId, startMinute: 720, endMinute: 780, reason: "Changed" });
    await repository.cancelDirectReservation(manager, original.id, adminId, await repository.readReservationClockTime(manager));
    await manager.query("SELECT 1 / 0");
  })).rejects.toThrow("division by zero");
  expect(await reservation()).toEqual(original);
});

test.each(["cancel-first"])("edit/cancel preserves lifecycle with forced %s acquisition", async (order) => {
  const original = await seed(); const acquired = deferred<number>(), release = deferred<void>();
  // At 11:00 the original 10:00 start would reject cancellation. The edited
  // 12:00 start must therefore be read after the wait for cancellation to pass.
  if (order === "edit-first") vi.spyOn(repository, "readReservationClockTime")
    .mockResolvedValueOnce("2099-10-15T11:00:00+00:00");
  const update = repository.updateDirectReservationSchedule, cancel = repository.cancelDirectReservation;
  if (order === "cancel-first") vi.spyOn(repository, "cancelDirectReservation").mockImplementationOnce(async (...args) => {
    await cancel(...args); acquired.resolve(await backend(args[0])); await release.promise;
  });
  else vi.spyOn(repository, "updateDirectReservationSchedule").mockImplementationOnce(async (...args) => {
    await update(...args); acquired.resolve(await backend(args[0])); await release.promise;
  });
  const save = () => editDirectReservationAsAdmin({ kind: "schedule", id: original.id, expectedUpdatedAt: original.updated_at,
    schedule: { courtId, date, startMinute: 720, endMinute: 780, reason: "Moved" } }, admin, now);
  const first = order === "cancel-first" ? cancelDirectReservationAsAdmin(original.id, admin) : save();
  const pid = await acquired.promise;
  const second = order === "cancel-first" ? save() : cancelDirectReservationAsAdmin(original.id, admin);
  try { await waitForBlock(pid); } finally { release.resolve(); }
  const [a, b] = await Promise.all([first, second]); expect(a.ok).toBe(true);
  if (order === "cancel-first") expect(b).toEqual({ ok: false, message: "This reservation is no longer available to edit." });
  else expect(b.ok).toBe(true);
  const final = await inTransaction((manager) => repository.findReservationForUpdate(manager, original.id));
  expect(final).toMatchObject({ status: "cancelled", cancelled_by_user_id: adminId, cancelled_at: expect.any(String),
    starts_at_minute: order === "edit-first" ? 720 : 600, reason: order === "edit-first" ? "Moved" : "Training" });
});

test("owner/Admin cancellation contenders produce exactly one success without rewriting metadata", async () => {
  const row = await seed();
  const results = await Promise.all([cancelOwnDirectReservation(row.id, coach), cancelDirectReservationAsAdmin(row.id, admin)]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toEqual({ ok: false, message: "This reservation is no longer available to cancel." });
  const final = await inTransaction((manager) => repository.findReservationForUpdate(manager, row.id));
  expect(final).toMatchObject({ status: "cancelled", created_by_user_id: coachId, cancelled_at: expect.any(String),
    cancelled_by_user_id: results[0].ok ? coachId : adminId });
});

async function changeHours(manager: EntityManager, closes: number) {
  await lockConfigurationForWrite(manager); await lockLocations(manager, [locationId]);
  await manager.query("UPDATE public.location_opening_hours SET closes_at_minute=$2 WHERE location_id=$1", [locationId, closes]);
}
test.each(["create"])("%s reader first blocks Phase 3 writer and commits coherent old hours", async (kind) => {
  const row = kind === "schedule" ? await seed() : null;
  const acquired = deferred<number>(), release = deferred<void>(); const fence = accounts.lockReservationActorFacts;
  vi.spyOn(accounts, "lockReservationActorFacts").mockImplementationOnce(async (...args) => {
    const facts = await fence(...args); acquired.resolve(await backend(args[0])); await release.promise; return facts;
  });
  const reader = row ? editOwnDirectReservation({ kind: "schedule", id: row.id, expectedUpdatedAt: row.updated_at,
    schedule: { courtId, date, startMinute: 720, endMinute: 780, reason: "Moved" } }, coach, now)
    : createDirectReservation({ ...input, startMinute: 720, endMinute: 780 }, coach, now);
  const pid = await acquired.promise;
  const writer = inTransaction((manager) => changeHours(manager, 720));
  try { await waitForBlock(pid); } finally { release.resolve(); }
  expect(await reader).toMatchObject({ ok: true }); await writer;
  expect((await reservation()).starts_at_minute).toBe(720);
});

test.each(["create"])("Phase 3 writer first makes %s use coherent new hours", async (kind) => {
  const row = kind === "schedule" ? await seed() : null;
  const writer = await runner();
  try {
    await changeHours(writer.manager, 720); const pid = await backend(writer.manager);
    const reader = row ? editOwnDirectReservation({ kind: "schedule", id: row.id, expectedUpdatedAt: row.updated_at,
      schedule: { courtId, date, startMinute: 720, endMinute: 780, reason: "Moved" } }, coach, now)
      : createDirectReservation({ ...input, startMinute: 720, endMinute: 780 }, coach, now);
    await waitForBlock(pid); await writer.commitTransaction();
    expect(await reader).toEqual({ ok: false, message: "Choose an interval within one opening-hours period." });
    if (row) expect((await reservation()).updated_at).toBe(row.updated_at);
  } finally { if (writer.isTransactionActive) await writer.rollbackTransaction(); await writer.release(); }
});

test.each(["role"])("%s change committed before actor fence denies the already-authorized create", async (kind) => {
  const reached = deferred<void>(), release = deferred<void>(); const fence = accounts.lockReservationActorFacts;
  vi.spyOn(accounts, "lockReservationActorFacts").mockImplementationOnce(async (...args) => {
    reached.resolve(); await release.promise; return fence(...args);
  });
  const mutation = createDirectReservation(input, coach, now); await reached.promise;
  try {
    if (kind === "role") await database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code='coach'", [coachId]);
    else await database.query("UPDATE public.users SET status='suspended' WHERE id=$1", [coachId]);
  } finally { release.resolve(); }
  expect(await mutation).toEqual({ ok: false, message: "Unable to reserve this court. Try again." });
  const rows: unknown = await database.query("SELECT id FROM public.court_reservations WHERE court_id=$1", [courtId]); expect(rows).toEqual([]);
});

test.each(["status"])("%s change after actor fence waits for reservation transaction", async (kind) => {
  const reached = deferred<number>(), release = deferred<void>(); const fence = accounts.lockReservationActorFacts;
  vi.spyOn(accounts, "lockReservationActorFacts").mockImplementationOnce(async (...args) => {
    const result = await fence(...args); reached.resolve(await backend(args[0])); await release.promise; return result;
  });
  const mutation = createDirectReservation(input, coach, now), pid = await reached.promise;
  const change = kind === "role" ? database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code='coach'", [coachId])
    : database.query("UPDATE public.users SET status='suspended' WHERE id=$1", [coachId]);
  try { await waitForBlock(pid); } finally { release.resolve(); }
  expect(await mutation).toEqual({ ok: true }); await change;
});

test("reason-only parent discovery retries in a fresh transaction after a court move", async () => {
  const row = await seed(); const reached = deferred<void>(), release = deferred<void>(); const discovery = repository.findReservationParent;
  vi.spyOn(repository, "findReservationParent").mockImplementationOnce(async (...args) => {
    const parent = await discovery(...args); reached.resolve(); await release.promise; return parent;
  });
  const save = editOwnDirectReservation({ kind: "reason", id: row.id, expectedUpdatedAt: row.updated_at, reason: "After move" }, coach, now);
  await reached.promise;
  try {
    await inTransaction(async (manager) => {
      await lockConfigurationForWrite(manager); await lockLocations(manager, [locationId, otherLocationId]);
      await manager.query("UPDATE public.courts SET location_id=$2 WHERE id=$1", [courtId, otherLocationId]);
    });
  } finally { release.resolve(); }
  expect(await save).toEqual({ ok: true }); expect(repository.findReservationParent).toHaveBeenCalledTimes(2);
});

test("owner reason-only edits retain inactive-resource exception while Admin and cancellation reject", async () => {
  const row = await seed(); await database.query("UPDATE public.courts SET is_active=false WHERE id=$1", [courtId]);
  expect(await editDirectReservationAsAdmin({ kind: "reason", id: row.id, expectedUpdatedAt: row.updated_at, reason: "Admin" }, admin, now)).toMatchObject({ ok: false });
  expect(await editOwnDirectReservation({ kind: "reason", id: row.id, expectedUpdatedAt: row.updated_at, reason: "Owner" }, coach, now)).toEqual({ ok: true });
  expect(await cancelOwnDirectReservation(row.id, coach)).toMatchObject({ ok: false });
});

test("trusted direct paths reject linked booking even with a forged matching creator", async () => {
  const row = await seed();
  await database.query(`INSERT INTO public.bookings(reservation_id,customer_name,customer_email,customer_phone,total_amount_minor,currency,cancellation_notice_minutes)
    VALUES($1,'Customer','customer@example.test','123',5000,'RON',1440)`, [row.id]);
  for (const actor of [admin, coach]) {
    expect(await editOwnDirectReservation({ kind: "reason", id: row.id, expectedUpdatedAt: row.updated_at, reason: "Wrong domain" }, actor, now)).toMatchObject({ ok: false });
    expect(await cancelOwnDirectReservation(row.id, actor)).toMatchObject({ ok: false });
  }
  expect(await editDirectReservationAsAdmin({ kind: "reason", id: row.id, expectedUpdatedAt: row.updated_at, reason: "Wrong domain" }, admin, now)).toMatchObject({ ok: false });
  expect(await cancelDirectReservationAsAdmin(row.id, admin)).toMatchObject({ ok: false });
  expect(await reservation()).toEqual(row);
});

test("Admin cancellation rejects started rows while owner can cancel before end using database time", async () => {
  const clock = new Date(), zone = ["UTC", "America/Los_Angeles", "Asia/Tokyo"].find((zone) => localMinute(zone, clock) >= 120 && localMinute(zone, clock) <= 1260)!;
  await database.query("UPDATE public.locations SET timezone=$2 WHERE id=$1", [locationId, zone]);
  const start = Math.floor(localMinute(zone, clock) / 30) * 30 - 30, id = randomUUID();
  await database.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,reason,created_by_user_id)
    VALUES($1,$2,$3,$4,$5,'Live',$6)`, [id, courtId, localToday(zone, clock), start, start + 120, coachId]);
  expect(await cancelDirectReservationAsAdmin(id, admin)).toEqual({ ok: false, message: "This reservation is no longer available to cancel." });
  expect(await cancelOwnDirectReservation(id, coach)).toEqual({ ok: true });
});

async function hold(start: number) {
  const id = randomUUID(), bookingId = randomUUID();
  await database.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at)
    VALUES($1,$2,$3,$4,$5,'held',clock_timestamp()+interval '10 minutes')`, [id, courtId, date, start, start + 60]);
  await database.query(`INSERT INTO public.bookings(id,reservation_id,customer_name,customer_email,customer_phone,total_amount_minor,currency,status,payment_method,cancellation_notice_minutes)
    VALUES($1,$2,'Held customer','held@example.test','123',5000,'RON','pending_payment','online',1440)`, [bookingId, id]);
  await database.query(`INSERT INTO public.payment_attempts(booking_id,method,provider,amount_minor,currency,status,expires_at)
    VALUES($1,'online','netopia',5000,'RON','pending',clock_timestamp()+interval '10 minutes')`, [bookingId]);
  return id;
}
test.each(["schedule"])("direct %s preserves live-hold exclusion and explicit application expiry", async (kind) => {
  const row = kind === "schedule" ? await seed() : null, heldId = await hold(720);
  // Assert release before the reservation statement that would invoke the old
  // lazy-expiry trigger, so the trigger cannot supply the tested behavior.
  if (kind === "create") {
    const insert=repository.insertDirectReservation;
    vi.spyOn(repository,"insertDirectReservation").mockImplementationOnce(async (...args)=>{
      expect(await repository.findReservationForUpdate(args[0],heldId)).toMatchObject({status:"released"});
      return insert(...args);
    });
  } else {
    const update=repository.updateDirectReservationSchedule;
    vi.spyOn(repository,"updateDirectReservationSchedule").mockImplementationOnce(async (...args)=>{
      expect(await repository.findReservationForUpdate(args[0],heldId)).toMatchObject({status:"released"});
      return update(...args);
    });
  }
  const save = () => row ? editOwnDirectReservation({ kind: "schedule", id: row.id, expectedUpdatedAt: row.updated_at,
    schedule: { courtId, date, startMinute: 720, endMinute: 780, reason: "Moved" } }, coach, now)
    : createDirectReservation({ ...input, startMinute: 720, endMinute: 780 }, coach, now);
  expect(await save()).toMatchObject({ ok: false, message: expect.stringContaining("no longer available") });
  await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [heldId]);
  expect(await save()).toEqual({ ok: true });
  const held = await inTransaction((manager) => repository.findReservationForUpdate(manager, heldId));
  expect(held).toMatchObject({ status: "released", hold_expires_at: null });
  const rows: unknown = await database.query("SELECT b.status,p.status AS payment_status FROM public.bookings b JOIN public.payment_attempts p ON p.booking_id=b.id WHERE b.reservation_id=$1", [heldId]);
  expect(rows).toEqual([{ status: "expired", payment_status: "expired" }]);
});

test("Admin cancellation rejects exact start equality and accepts the preceding microsecond", async () => {
  const row = await seed();
  const clock = vi.spyOn(repository, "readReservationClockTime");
  clock.mockResolvedValueOnce("2099-10-15T10:00:00+00:00");
  expect(await cancelDirectReservationAsAdmin(row.id, admin)).toEqual({ ok: false, message: "This reservation is no longer available to cancel." });
  clock.mockResolvedValueOnce("2099-10-15T09:59:59.999999+00:00");
  expect(await cancelDirectReservationAsAdmin(row.id, admin)).toEqual({ ok: true });
  const cancelled = await inTransaction((manager) => repository.findReservationForUpdate(manager, row.id));
  expect(cancelled?.cancelled_at).toBe("2099-10-15T09:59:59.999999+00:00");
});
