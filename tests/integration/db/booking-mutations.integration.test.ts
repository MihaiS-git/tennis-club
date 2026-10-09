import type { BookingEmailEvent } from "@/lib/notifications/booking-email";
const sent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notifications/booking-email", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/notifications/booking-email")>(), sendBookingNotification: sent,
}));
const emails = (id: string): BookingEmailEvent[] => sent.mock.calls.map(([event]) => event).filter(event => event.payload.booking_id === id);
import { randomUUID } from "node:crypto";
import type { DataSource, EntityManager, QueryRunner } from "typeorm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { getDataSource } from "@/lib/db/data-source";
import { expirePaymentHolds, expirePaymentHoldsAtLocation } from "@/lib/payments/hold-expiry";
import { inTransaction } from "@/lib/db/transaction";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import * as accounts from "@/lib/db/repositories/accounts.repository";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import * as payments from "@/lib/db/repositories/payments.repository";
import { cancelCustomerBookingCommand, readCustomerBookingEditContext } from "@/lib/bookings/commands";
import { runBookingReschedule } from "@/lib/bookings/reschedule";
import { localFixtureClient, cleanupAuthFixtures } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";
import { processOnlinePaymentEvent, settleOnlinePayment } from "@/lib/payments/service";
import { prepareAdminRefund, prepareAutomaticRefund, commitAdminRefund, commitAutomaticRefund, type AdminRefundClaim } from "@/lib/payments/refund-commands";

let database: DataSource;
let service: ReturnType<typeof localFixtureClient>;
let actorId: string;
const locationId = randomUUID(), otherLocationId = randomUUID(), courtId = randomUUID(), secondCourtId = randomUUID(), ruleSetId = randomUUID();
const date = "2099-10-15";
beforeAll(async () => {
  const url = process.env.DATABASE_URL!;
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url).hostname);
  vi.stubEnv("DATABASE_URL", url); vi.stubEnv("DATABASE_POOL_MAX", "8");
  database = await getDataSource(); service = localFixtureClient(); await ensureIntegrationAdminAnchor(service);
  const user = await service.auth.admin.createUser({ email: `phase6-${randomUUID()}@example.test`, password: "phase6-test-password-123", email_confirm: true });
  if (!user.data.user) throw new Error("Missing actor"); actorId = user.data.user.id;
  for (const id of [locationId, otherLocationId]) await database.query(
    "INSERT INTO public.locations(id,name,slug,timezone,currency) VALUES($1,'Phase 6',$2,'UTC','RON')", [id, `phase6-${id}`]);
  for (const id of [courtId, secondCourtId]) await database.query(
    "INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'Court',$3,'clay','outdoor')", [id, locationId, `court-${id}`]);
  await database.query("INSERT INTO public.pricing_rule_sets(id,location_id) VALUES($1,$2)", [ruleSetId, locationId]);
});
async function clear() {
  await database.query("DELETE FROM public.bookings WHERE reservation_id IN (SELECT id FROM public.court_reservations WHERE court_id=ANY($1::uuid[]))", [[courtId, secondCourtId]]);
  await database.query("DELETE FROM public.court_reservations WHERE court_id=ANY($1::uuid[])", [[courtId, secondCourtId]]);
}
beforeEach(async () => {
  await clear(); sent.mockReset();
  await database.query("UPDATE public.users SET status='active' WHERE id=$1", [actorId]);
  await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin'),($1,'coach') ON CONFLICT DO NOTHING", [actorId]);
  await database.query("UPDATE public.courts SET location_id=$2,is_active=true WHERE id=ANY($1::uuid[])", [[courtId,secondCourtId],locationId]);
  await database.query("UPDATE public.locations SET timezone='UTC',is_active=true,archived_at=null,currency='RON' WHERE id=$1", [locationId]);
  await database.query("DELETE FROM public.location_pricing_rules WHERE location_id=$1", [locationId]);
  await database.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [locationId]);
  await database.query("DELETE FROM public.court_coverage_periods WHERE court_id=ANY($1::uuid[])", [[courtId,secondCourtId]]);
  await database.query("INSERT INTO public.location_opening_hours(location_id,weekday,opens_at_minute,closes_at_minute) SELECT $1,i,0,1440 FROM generate_series(0,6) i", [locationId]);
  await database.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
    SELECT $1,$2,c,s,i,0,1440,CASE WHEN s='covered' THEN 7000 ELSE 5000 END
    FROM unnest($3::uuid[]) c CROSS JOIN unnest(ARRAY['outdoor','covered']) s CROSS JOIN generate_series(0,6) i`, [locationId,ruleSetId,[courtId,secondCourtId]]);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try {
    if (database?.isInitialized) {
      await clear(); sent.mockReset();
      await database.query("DELETE FROM public.pricing_rule_sets WHERE id=$1", [ruleSetId]);
      await database.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [locationId]);
      await database.query("DELETE FROM public.court_coverage_periods WHERE court_id=ANY($1::uuid[])", [[courtId,secondCourtId]]);
      await database.query("DELETE FROM public.courts WHERE id=ANY($1::uuid[])", [[courtId,secondCourtId]]);
      await database.query("DELETE FROM public.locations WHERE id=ANY($1::uuid[])", [[locationId,otherLocationId]]);
      await cleanupAuthFixtures(service, [actorId]);
    }
  } finally { if (database?.isInitialized) await database.destroy(); vi.unstubAllEnvs(); }
});
async function seed(start = 600, paid = false, pending = false) {
  const id = randomUUID(), reservationId = randomUUID(), attemptId = randomUUID();
  await database.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at)
    VALUES($1,$2,$3,$4,$4+60,$5::public.court_reservation_status,CASE WHEN $5::text='held' THEN clock_timestamp()+interval '10 minutes' ELSE NULL END)`,
    [reservationId,courtId,date,start,pending ? "held" : "active"]);
  await database.query(`INSERT INTO public.bookings(id,reservation_id,account_user_id,customer_name,customer_email,customer_phone,
    total_amount_minor,currency,cancellation_notice_minutes,status,payment_method)
    VALUES($1,$2,$3,'Customer','immutable@example.test','123',5000,'RON',1440,$4,$5)`,
    [id,reservationId,actorId,pending ? "pending_payment" : "confirmed",paid || pending ? "online" : "pay_at_club"]);
  if (paid || pending) await database.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at,completed_at)
    VALUES($1,$2,'online','stripe',$3,5000,'RON',$4::text,clock_timestamp()+interval '10 minutes',CASE WHEN $4::text='succeeded' THEN clock_timestamp() ELSE NULL END)`,
    [attemptId,id,`pi-${attemptId}`,pending ? "pending" : "succeeded"]);
  return { id, reservationId, attemptId };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
async function edit(f: Fixture, extra = {}) {
  const context = await readCustomerBookingEditContext(f.id,date,actorId,"owner");
  if (!context) throw new Error("Missing edit context");
  return { id: f.id, expectedBookingUpdatedAt: context.booking_updated_at, expectedUpdatedAt: context.updated_at,
    courtId: secondCourtId,date,startMinute:720,endMinute:780,save:true,expectedTotal:5000,priceAcknowledged:true,...extra };
}
const save = (input: unknown, scope: "owner" | "admin" = "owner") => runBookingReschedule(input,service,actorId,scope);
const cancel = (f: Fixture, scope: "owner" | "admin" = "owner", choice: boolean | null = null) => cancelCustomerBookingCommand(f.id,actorId,scope,choice);
async function state(f: Fixture) {
  const booking = await inTransaction(m => bookings.findBookingForUpdate(m,f.id));
  const reservation = await inTransaction(m => reservations.findReservationForUpdate(m,f.reservationId));
  const refunds: unknown = await database.query("SELECT * FROM public.payment_refunds WHERE booking_id=$1", [f.id]);
  const events = emails(f.id);
  return { booking,reservation,refunds,events };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; }); return { promise,resolve };
}
async function pid(manager: EntityManager) {
  const rows: unknown = await manager.query("SELECT pg_backend_pid() AS pid");
  return z.array(z.object({ pid:z.number() })).length(1).parse(rows)[0].pid;
}
async function waitForBlock(blocker: number) {
  const deadline = Date.now()+8000;
  while (Date.now()<deadline) {
    const rows: unknown = await database.query("SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [blocker]);
    if (z.array(z.object({ pid:z.number() })).parse(rows).length) return;
    await new Promise(r => setTimeout(r,10));
  }
  throw new Error("Expected PostgreSQL blocking edge");
}
async function runner(): Promise<QueryRunner> {
  const r = database.createQueryRunner(); await r.connect(); await r.startTransaction(); return r;
}
// Pause after the first command owns the booking; observe the second connection
// blocked in PostgreSQL before releasing, rather than relying on a timing sleep.
async function serialize<T,U>(first: () => Promise<T>, second: () => Promise<U>) {
  const locked = deferred(), release = deferred(); let blocker = 0;
  const original = bookings.findBookingForUpdate;
  const spy = vi.spyOn(bookings,"findBookingForUpdate").mockImplementationOnce(async (...args) => {
    const row = await original(...args); blocker = await pid(args[0]); locked.resolve(); await release.promise; return row;
  });
  const a = first(); await locked.promise; const b = second();
  try { await waitForBlock(blocker); } finally { release.resolve(); }
  const results = await Promise.all([a,b]); spy.mockRestore(); return results;
}

test.each([false,true])("cancel/cancel serializes lifecycle, replay and notifications (paid=%s)", async paid => {
  const f = await seed(600,paid);
  const [a,b] = await serialize(() => cancel(f),() => cancel(f));
  expect(a.outcome).toBe("cancelled"); expect(b.outcome).toBe(paid ? "cancelled" : "unavailable");
  if (paid) expect(b.refund_id).toBe(a.refund_id);
  expect(await state(f)).toMatchObject({ booking:{status:"cancelled"},reservation:{status:"cancelled"},
    refunds:paid ? [expect.objectContaining({amount_minor:5000})] : [],events:[expect.objectContaining({event_kind:"customer_cancelled"})] });
});
test("same submitted tokens serialize into success then stale", async () => {
  const f = await seed(), input = await edit(f);
  const results = await serialize(() => save(input),() => save(input));
  expect(results[0]).toEqual({ok:true,totalAmountMinor:5000}); expect(results[1]).toMatchObject({reason:"stale"});
});
test.each(["reschedule"])("cancel/reschedule sees authoritative state with %s first", async first => {
  const f = await seed(), input = await edit(f);
  if (first === "cancel") {
    const results = await serialize(() => cancel(f),() => save(input));
    expect(results[0].outcome).toBe("cancelled"); expect(results[1]).toMatchObject({ok:false,message:"This booking is no longer available to edit."});
    expect((await state(f)).reservation).toMatchObject({court_id:courtId,starts_at_minute:600,status:"cancelled"});
  } else {
    const results = await serialize(() => save(input),() => cancel(f));
    expect(results[0].ok).toBe(true); expect(results[1].outcome).toBe("cancelled");
    expect((await state(f)).reservation).toMatchObject({court_id:secondCourtId,starts_at_minute:720,status:"cancelled"});
  }
});
test("same target reschedules serialize and reject the loser before its SQL update", async () => {
  const a = await seed(), b = await seed(660), before = [await state(a),await state(b)];
  const inputs = [await edit(a),await edit(b)];
  const write = vi.spyOn(reservations,"updateCustomerReservationSchedule");
  const results = await serialize(() => save(inputs[0]), () => save(inputs[1]));
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(results.find(r => !r.ok)).toEqual({ok:false,message:"That court is no longer available. The booking has not changed."});
  expect(write).toHaveBeenCalledTimes(1);
  const loser = results[0].ok ? 1 : 0; expect(await state(loser===0 ? a : b)).toEqual(before[loser]);
});
test.each(["booking"])("%s stale comparison preserves microseconds and precedes target validation", async token => {
  const f = await seed();
  if (token === "booking") await database.query("UPDATE public.bookings SET total_amount_minor=5000 WHERE id=$1",[f.id]);
  // Reservation can carry a known future token; booking token is maintained by the application.
  await database.query("UPDATE public.court_reservations SET updated_at='2098-01-01T00:00:00.123456Z' WHERE id=$1",[f.reservationId]);
  const input = await edit(f);
  const key = token === "booking" ? "expectedBookingUpdatedAt" : "expectedUpdatedAt";
  const t = input[key]; const changed = t.replace(/(?:\.(\d+))?\+00:00$/,(_,fraction:string|undefined) => `.${String(Number((fraction??"").padEnd(6,"0"))+1).padStart(6,"0")}+00:00`);
  expect(changed).not.toBe(t);
  expect(await save({...input,[key]:changed,courtId:randomUUID()})).toMatchObject({reason:"stale"});
});
test("reservation monotonic floor and booking transaction-now timestamp are preserved; same schedule emits no event", async () => {
  const f = await seed();
  await database.query("UPDATE public.court_reservations SET updated_at='2098-01-01T00:00:00.123456Z' WHERE id=$1",[f.reservationId]);
  const input = await edit(f,{courtId,startMinute:600,endMinute:660});
  let transactionNow = "";
  const original = bookings.updateBookingRescheduleTotal;
  vi.spyOn(bookings,"updateBookingRescheduleTotal").mockImplementation(async (...args) => {
    transactionNow = await reservations.readReservationTransactionTime(args[0]); await original(...args);
  });
  expect(await save(input)).toEqual({ok:true,totalAmountMinor:5000});
  const s = await state(f); expect(s.booking?.updated_at).toBe(transactionNow);
  expect(s.reservation?.updated_at).toBe("2098-01-01T00:00:00.123457+00:00"); expect(s.events).toEqual([]);
});
test.each(["booking", "reservation"])("cancellation rollback after %s write restores all rows and sends no mail", async step => {
  const f = await seed(600,true), before = await state(f);
  const target = step === "booking" ? bookings : reservations;
  if (target === bookings) {
    const write = bookings.updateBookingCancellationStatus;
    vi.spyOn(bookings,"updateBookingCancellationStatus").mockImplementationOnce(async (...args) => { await write(...args); throw new Error("Injected failure"); });
  } else {
    const write = reservations.updateCustomerReservationCancellation;
    vi.spyOn(reservations,"updateCustomerReservationCancellation").mockImplementationOnce(async (...args) => { await write(...args); throw new Error("Injected failure"); });
  }
  await expect(cancel(f)).rejects.toThrow("Injected failure"); expect(await state(f)).toEqual(before);
});
test.each(["reservation", "total"])("reschedule rollback after %s write restores all rows and sends no mail", async step => {
  const f = await seed(), input = await edit(f), before = await state(f);
  if (step === "reservation") {
    const write = reservations.updateCustomerReservationSchedule;
    vi.spyOn(reservations,"updateCustomerReservationSchedule").mockImplementationOnce(async (...args) => { await write(...args); throw new Error("Injected failure"); });
  } else {
    const write = bookings.updateBookingRescheduleTotal;
    vi.spyOn(bookings,"updateBookingRescheduleTotal").mockImplementationOnce(async (...args) => { await write(...args); throw new Error("Injected failure"); });
  }
  expect(await save(input)).toEqual({ok:false,message:"Unable to reschedule this booking. Try again."}); expect(await state(f)).toEqual(before);
});
test.each([8000,3000])("paid reschedule total %s preserves payment evidence; cancellation refunds original amount", async price => {
  const f = await seed(600,true); const attempts: unknown = await database.query("SELECT * FROM public.payment_attempts WHERE booking_id=$1",[f.id]);
  await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=$2 WHERE location_id=$1 AND court_state='outdoor'",[locationId,price]);
  expect(await save(await edit(f,{expectedTotal:price}))).toEqual({ok:true,totalAmountMinor:price});
  expect(await database.query("SELECT * FROM public.payment_attempts WHERE booking_id=$1",[f.id])).toEqual(attempts);
  expect((await state(f)).refunds).toEqual([]);
  await cancel(f); expect((await state(f)).refunds).toEqual([expect.objectContaining({amount_minor:5000,currency:"RON",payment_attempt_id:f.attemptId})]);
});

test.each(["court", "pricing"])("configuration %s writer first yields coherent new facts", async kind => {
  const f = await seed(), input = await edit(f);
  const writer = await runner(); let pending: ReturnType<typeof save> | undefined;
  try {
    await clubs.lockConfigurationForWrite(writer.manager); await clubs.lockLocations(writer.manager,[locationId,otherLocationId]);
    pending = save(input); await waitForBlock(await pid(writer.manager));
    if (kind === "court") {
      await writer.query("DELETE FROM public.location_pricing_rules WHERE court_id=$1",[secondCourtId]);
      await writer.query("UPDATE public.courts SET location_id=$2 WHERE id=$1",[secondCourtId,otherLocationId]);
    }
    if (kind === "hours") {
      await writer.query("DELETE FROM public.location_pricing_rules WHERE location_id=$1",[locationId]);
      await writer.query("UPDATE public.location_opening_hours SET closes_at_minute=660 WHERE location_id=$1",[locationId]);
    }
    if (kind === "coverage") await writer.query("INSERT INTO public.court_coverage_periods(court_id,starts_on,ends_on) VALUES($1,$2,$2)",[secondCourtId,date]);
    if (kind === "pricing") {
      await writer.query("DELETE FROM public.location_pricing_rules WHERE court_id=$1 AND court_state='outdoor'",[secondCourtId]);
      await writer.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
        VALUES($1,$2,$3,'outdoor',3,0,750,6000),($1,$2,$3,'outdoor',3,750,1440,10000)`,[locationId,ruleSetId,secondCourtId]);
    }
    await writer.commitTransaction();
    const result = await pending;
    if (kind === "court" || kind === "hours") expect(result).toEqual({ok:false,message:"This booking or interval is no longer available to reschedule."});
    else expect(result).toMatchObject({ok:false,reason:"price_changed",totalAmountMinor:kind === "coverage" ? 7000 : 8000});
  } finally {
    if (writer.isTransactionActive) await writer.rollbackTransaction(); if (pending) await Promise.allSettled([pending]); await writer.release();
  }
});
test.each(["pricing"])("reschedule first blocks configuration %s writer and uses coherent old facts", async kind => {
  const f = await seed(), input = await edit(f), locked=deferred(), release=deferred(); let blocker=0;
  const original = clubs.lockConfigurationForRead;
  vi.spyOn(clubs,"lockConfigurationForRead").mockImplementationOnce(async m => {
    await original(m); blocker=await pid(m); locked.resolve(); await release.promise;
  });
  const mutation = save(input); await locked.promise;
  const writer = await runner(); let write: Promise<void> | undefined;
  try {
    write=(async () => {
      await clubs.lockConfigurationForWrite(writer.manager); await clubs.lockLocations(writer.manager,[locationId,otherLocationId]);
      if (kind === "court") await writer.query("UPDATE public.courts SET is_active=false WHERE id=$1",[secondCourtId]);
      if (kind === "hours") {
        await writer.query("DELETE FROM public.location_pricing_rules WHERE location_id=$1",[locationId]);
        await writer.query("UPDATE public.location_opening_hours SET opens_at_minute=30 WHERE location_id=$1",[locationId]);
      }
      if (kind === "coverage") await writer.query("INSERT INTO public.court_coverage_periods(court_id,starts_on,ends_on) VALUES($1,$2,$2)",[secondCourtId,date]);
      if (kind === "pricing") await writer.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=9000 WHERE location_id=$1",[locationId]);
      await writer.commitTransaction();
    })();
    await waitForBlock(blocker); release.resolve(); expect(await mutation).toEqual({ok:true,totalAmountMinor:5000}); await write;
  } finally {
    release.resolve(); await Promise.allSettled([mutation]); if (write) await Promise.allSettled([write]);
    if (writer.isTransactionActive) await writer.rollbackTransaction(); await writer.release();
  }
});

async function expiredNoticeFixture() {
  const f = await seed();
  const tomorrow = new Date(Date.now()+86400000).toISOString().slice(0,10);
  await database.query("UPDATE public.court_reservations SET booking_date=$2 WHERE id=$1",[f.reservationId,tomorrow]);
  await database.query("UPDATE public.bookings SET cancellation_notice_minutes=43200 WHERE id=$1",[f.id]);
  return f;
}
test.each(["status", "coach"])("actor %s change before fence changes policy", async kind => {
  const f = kind === "coach" ? await expiredNoticeFixture() : await seed();
  if (kind === "coach") await database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code='admin'",[actorId]);
  const waiting=deferred(), release=deferred(); const original=accounts.lockReservationActorFacts;
  vi.spyOn(accounts,"lockReservationActorFacts").mockImplementationOnce(async (...args) => {
    waiting.resolve(); await release.promise; return original(...args);
  });
  const mutation=cancel(f,kind === "admin" ? "admin" : "owner"); await waiting.promise;
  if (kind === "status") await database.query("UPDATE public.users SET status='suspended' WHERE id=$1",[actorId]);
  else await database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code=$2",[actorId,kind]);
  release.resolve(); expect(await mutation).toMatchObject({outcome:kind === "status" ? "inactive" : kind === "coach" ? "notice_required" : "unavailable"});
  expect((await state(f)).booking?.status).toBe("confirmed");
});
test.each(["status", "coach"])("actor %s change after fence waits", async kind => {
  const f = kind === "coach" ? await expiredNoticeFixture() : await seed();
  if (kind === "coach") await database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code='admin'",[actorId]);
  const locked=deferred(), release=deferred(); let blocker=0; const original=accounts.lockReservationActorFacts;
  vi.spyOn(accounts,"lockReservationActorFacts").mockImplementationOnce(async (...args) => {
    const actor=await original(...args); blocker=await pid(args[0]); locked.resolve(); await release.promise; return actor;
  });
  const mutation=cancel(f,kind === "admin" ? "admin" : "owner"); await locked.promise;
  const change=kind === "status" ? database.query("UPDATE public.users SET status='suspended' WHERE id=$1",[actorId])
    : database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code=$2",[actorId,kind]);
  try { await waitForBlock(blocker); } finally { release.resolve(); }
  expect((await mutation).outcome).toBe("cancelled"); await change;
});

// Feed a deterministic full-precision database clock AFTER an observed row-lock
// wait. This avoids minute-long sleeps while proving the command never uses a
// pre-lock application clock or the earlier transaction now().
test.each(["cutoff", "target"])("post-lock wall clock rejects elapsed %s boundary", async kind => {
  const f = await seed(), input=await edit(f);
  await database.query("DELETE FROM public.user_roles WHERE user_id=$1",[actorId]);
  const blocker=await runner(); let mutation: Promise<unknown> | undefined;
  try {
    await bookings.findBookingForUpdate(blocker.manager,f.id);
    const after=kind === "cutoff" ? "2099-10-14T10:00:00.000001+00:00" : kind === "original"
      ? "2099-10-15T10:00:00+00:00" : "2099-10-15T12:00:00+00:00";
    // For target expiry, original booking is later than target and notice is zero.
    if (kind === "target") {
      await blocker.query("UPDATE public.court_reservations SET starts_at_minute=900,ends_at_minute=960 WHERE id=$1",[f.reservationId]);
      await blocker.query("UPDATE public.bookings SET cancellation_notice_minutes=0 WHERE id=$1",[f.id]);
      const b=await bookings.findBookingForUpdate(blocker.manager,f.id); const r=await reservations.findReservationForUpdate(blocker.manager,f.reservationId);
      input.expectedBookingUpdatedAt=b!.updated_at; input.expectedUpdatedAt=r!.updated_at;
    }
    vi.spyOn(reservations,"readReservationClockTime").mockResolvedValue(after);
    mutation=kind === "target" ? save(input) : cancel(f);
    await waitForBlock(await pid(blocker.manager)); await blocker.commitTransaction();
    const result=await mutation;
    if (kind === "target") expect(result).toEqual({ok:false,message:"This booking or interval is no longer available to reschedule."});
    else expect(result).toMatchObject({outcome:kind === "cutoff" ? "notice_required" : "started"});
    expect((await state(f)).booking?.status).toBe("confirmed");
  } finally {
    if (blocker.isTransactionActive) await blocker.rollbackTransaction(); if (mutation) await Promise.allSettled([mutation]); await blocker.release();
  }
});

test.each(["cancel","reschedule"])("pending/held rejects %s; settlement first then supplies confirmed evidence", async kind => {
  const f=await seed(600,false,true);
  const input={id:f.id,expectedBookingUpdatedAt:"2000-01-01T00:00:00Z",expectedUpdatedAt:"2000-01-01T00:00:00Z",
    courtId:secondCourtId,date,startMinute:720,endMinute:780,save:true,expectedTotal:5000,priceAcknowledged:true};
  const denied=kind === "cancel" ? await cancel(f) : await save(input);
  expect(denied).toMatchObject(kind === "cancel" ? {outcome:"unavailable"} : {ok:false,message:"This booking is no longer available to edit."});
  const blocker=await runner(); let settlement: Promise<string> | undefined;
  try {
    await bookings.findBookingForUpdate(blocker.manager,f.id);
    settlement=settleOnlinePayment({attemptId:f.attemptId,provider:"stripe",providerPaymentId:`pi-${f.attemptId}`,outcome:"succeeded"});
    await waitForBlock(await pid(blocker.manager)); await blocker.commitTransaction(); expect(await settlement).toBe("succeeded");
    const result=kind === "cancel" ? await cancel(f) : await save(await edit(f));
    expect(result).toMatchObject(kind === "cancel" ? {outcome:"cancelled"} : {ok:true});
    // A retained duplicate must not reopen occupancy or overwrite the schedule/evidence.
    const before=await state(f), attempts: unknown=await database.query("SELECT * FROM public.payment_attempts WHERE id=$1",[f.attemptId]);
    await settleOnlinePayment({attemptId:f.attemptId,provider:"stripe",providerPaymentId:`pi-${f.attemptId}`,outcome:"succeeded"});
    expect(await state(f)).toEqual(before); expect(await database.query("SELECT * FROM public.payment_attempts WHERE id=$1",[f.attemptId])).toEqual(attempts);
  } finally { if (blocker.isTransactionActive) await blocker.rollbackTransaction(); if (settlement) await Promise.allSettled([settlement]); await blocker.release(); }
});
test.each(["cancel","reschedule"])("%s first safely serializes retained late/duplicate settlement", async kind => {
  const f=await seed(600,true), input=await edit(f);
  const [a,b]=await serialize<unknown,string>(() => kind === "cancel" ? cancel(f) : save(input),
    () => settleOnlinePayment({attemptId:f.attemptId,provider:"stripe",providerPaymentId:`pi-${f.attemptId}`,outcome:"succeeded"}));
  expect(a).toMatchObject(kind === "cancel" ? {outcome:"cancelled"} : {ok:true}); expect(typeof b).toBe("string");
  expect((await state(f)).reservation).toMatchObject(kind === "cancel" ? {status:"cancelled"} : {court_id:secondCourtId,starts_at_minute:720});
  expect(await database.query("SELECT amount_minor,currency,status FROM public.payment_attempts WHERE id=$1",[f.attemptId]))
    .toEqual([{amount_minor:5000,currency:"RON",status:"succeeded"}]);
});

test("Phase 6 refund replay serializes with TypeORM claim and result without changing financial evidence", async () => {
  const f=await seed(600,true), cancelled=await cancel(f);
  if (!cancelled.refund_id) throw new Error("Missing refund");
  await database.query("UPDATE public.payment_refunds SET status='pending_retry' WHERE id=$1",[cancelled.refund_id]);
  const blocker=await runner(); let preparation: ReturnType<typeof prepareAdminRefund> | undefined;
  try {
    await bookings.findBookingForUpdate(blocker.manager,f.id);
    preparation=prepareAdminRefund("retry",cancelled.refund_id,actorId);
    const replay=cancel(f); await waitForBlock(await pid(blocker.manager)); await blocker.commitTransaction();
    const prepared=await preparation;
    expect(prepared.outcome).toBe("ready"); expect(await replay).toEqual(cancelled);
    if (prepared.outcome!=="ready") throw new Error("Missing claim");
    const results=await Promise.all([cancel(f),commitAdminRefund(prepared.claim,{status:"succeeded",providerRefundId:"re-phase8",lastError:null})]);
    expect(results).toEqual([cancelled,"succeeded"]);
    expect((await state(f)).refunds).toEqual([expect.objectContaining({id:cancelled.refund_id,amount_minor:5000,currency:"RON",status:"succeeded"})]);
  } finally { if (blocker.isTransactionActive) await blocker.rollbackTransaction(); if (preparation) await Promise.allSettled([preparation]); await blocker.release(); }
});

test("changed cancellation parent retries in a fresh transaction without locking a second location after booking", async () => {
  const f=await seed(), parents:string[]=[], transactions:string[]=[];
  const original=bookings.discoverBookingLocation;
  vi.spyOn(bookings,"discoverBookingLocation").mockImplementation(async (...args) => {
    const parent=await original(...args);
    const tx:unknown=await args[0].query("SELECT txid_current()::text AS id");
    transactions.push(z.array(z.object({id:z.string()})).length(1).parse(tx)[0].id);
    if (parent) parents.push(parent.location_id);
    if (parents.length===1) {
      await database.query("DELETE FROM public.location_pricing_rules WHERE court_id=$1",[courtId]);
      await database.query("UPDATE public.courts SET location_id=$2 WHERE id=$1",[courtId,otherLocationId]);
    }
    return parent;
  });
  expect((await cancel(f)).outcome).toBe("cancelled"); expect(parents).toEqual([locationId,otherLocationId]);
  expect(new Set(transactions).size).toBe(2);
});
test.each(["cutoff", "at-start"])("cancellation exact %s boundary retains fractional precision", async boundary => {
  const f=await seed(); await database.query("DELETE FROM public.user_roles WHERE user_id=$1",[actorId]);
  if (boundary.includes("start")) await database.query("UPDATE public.bookings SET cancellation_notice_minutes=0 WHERE id=$1",[f.id]);
  const checkedAt=boundary === "cutoff" ? "2099-10-14T10:00:00+00:00" : boundary === "after-cutoff"
    ? "2099-10-14T10:00:00.000001+00:00" : boundary === "before-start"
      ? "2099-10-15T09:59:59.999999+00:00" : "2099-10-15T10:00:00+00:00";
  vi.spyOn(reservations,"readReservationClockTime").mockResolvedValue(checkedAt);
  expect((await cancel(f)).outcome).toBe(boundary === "after-cutoff" ? "notice_required" : boundary === "at-start" ? "started" : "cancelled");
  if (boundary === "before-start") expect((await state(f)).reservation?.cancelled_at).toBe(checkedAt);
});
test("quote never writes; price-only same-schedule save emits no reschedule event", async () => {
  const f=await seed(), input=await edit(f,{courtId,startMinute:600,endMinute:660,expectedTotal:9000});
  await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=9000 WHERE court_id=$1",[courtId]);
  const before=await state(f);
  expect(await save({...input,save:false})).toEqual({ok:true,totalAmountMinor:9000}); expect(await state(f)).toEqual(before);
  expect(await save(input)).toEqual({ok:true,totalAmountMinor:9000});
  expect((await state(f)).booking?.total_amount_minor).toBe(9000); expect((await state(f)).events).toEqual([]);
});
test("target active hold blocks until its persisted expiry, and ordinary reads never expire it", async () => {
  const f=await seed(), input=await edit(f);
  const holdId=randomUUID();
  await database.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at)
    VALUES($1,$2,$3,720,780,'held',clock_timestamp()+interval '10 minutes')`,[holdId,secondCourtId,date]);
  expect(await save({...input,save:false})).toEqual({ok:false,message:"That court is no longer available. The booking has not changed."});
  await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[holdId]);
  expect(await save({...input,save:false})).toEqual({ok:true,totalAmountMinor:5000});
  expect(await database.query("SELECT status FROM public.court_reservations WHERE id=$1",[holdId])).toEqual([{status:"held"}]);
});

test.each(["cutoff", "target"])("advancing PostgreSQL wall clock crosses %s during an observed lock wait", async kind => {
  const f=await seed(); await database.query("DELETE FROM public.user_roles WHERE user_id=$1",[actorId]);
  if (kind !== "cutoff") await database.query("UPDATE public.bookings SET cancellation_notice_minutes=0 WHERE id=$1",[f.id]);
  if (kind === "target") await database.query("UPDATE public.court_reservations SET starts_at_minute=900,ends_at_minute=960 WHERE id=$1",[f.reservationId]);
  const input=await edit(f), boundary=kind === "cutoff" ? "2099-10-14T10:00:00Z"
    : kind === "original" ? "2099-10-15T10:00:00Z" : "2099-10-15T12:00:00Z";
  // Advance a real database wall clock near the future fixture's boundary.
  // PostgreSQL, rather than an application Date or a fixed mocked result,
  // supplies both the offset and every subsequent advancing time projection.
  const offsets:unknown=await database.query("SELECT ($1::timestamptz-clock_timestamp()-interval '150 milliseconds')::text AS delta",[boundary]);
  const delta=z.array(z.object({delta:z.string()})).length(1).parse(offsets)[0].delta;
  vi.spyOn(reservations,"readReservationClockTime").mockImplementation(async manager => {
    const rows:unknown=await manager.query(`SELECT replace(((clock_timestamp()+$1::interval) AT TIME ZONE 'UTC')::text,' ','T') || '+00:00' AS instant`,[delta]);
    return z.array(z.object({instant:z.string()})).length(1).parse(rows)[0].instant;
  });
  const blocker=await runner(); let mutation:Promise<unknown>|undefined;
  try {
    await bookings.findBookingForUpdate(blocker.manager,f.id);
    mutation=kind === "target" ? save(input) : cancel(f); await waitForBlock(await pid(blocker.manager));
    const deadline=Date.now()+5000; let crossed=false;
    while (Date.now()<deadline) {
      const rows:unknown=await database.query("SELECT clock_timestamp()+$1::interval>$2::timestamptz AS crossed",[delta,boundary]);
      if (z.array(z.object({crossed:z.boolean()})).length(1).parse(rows)[0].crossed) { crossed=true; break; }
      await new Promise(resolve => setTimeout(resolve,5));
    }
    expect(crossed).toBe(true); await blocker.commitTransaction();
    expect(await mutation).toMatchObject(kind === "target" ? {ok:false,message:"This booking or interval is no longer available to reschedule."}
      : {outcome:kind === "cutoff" ? "notice_required" : "started"});
    expect((await state(f)).booking?.status).toBe("confirmed");
  } finally {
    if (blocker.isTransactionActive) await blocker.rollbackTransaction(); if (mutation) await Promise.allSettled([mutation]); await blocker.release();
  }
});

function paymentEvent(f: Fixture, outcome: "succeeded" | "retryable_failed" | "cancelled" = "succeeded", eventId = randomUUID()) {
  return { provider: "stripe" as const, attemptId:f.attemptId,providerPaymentId:`pi-${f.attemptId}`,
    eventId,outcome,amountMinor:5000,currency:"RON" };
}
async function settlementState(f: Fixture) {
  return { aggregate:await state(f),attempts:await database.query("SELECT * FROM public.payment_attempts WHERE id=$1",[f.attemptId]),
    receipts:await database.query("SELECT * FROM public.payment_provider_events WHERE attempt_id=$1 ORDER BY event_id",[f.attemptId]) };
}

test.each(["retryable_failed"] as const)("concurrent distinct success/%s events serialize once and retain both receipts", async outcome => {
  const f=await seed(600,false,true), success=paymentEvent(f), other=paymentEvent(f,outcome);
  const locked=deferred(), release=deferred(); let blocker=0; const original=bookings.lockSettlementBooking;
  vi.spyOn(bookings,"lockSettlementBooking").mockImplementationOnce(async (...args) => {
    const row=await original(...args); blocker=await pid(args[0]); locked.resolve(); await release.promise; return row;
  });
  const a=processOnlinePaymentEvent(success); await locked.promise; const b=processOnlinePaymentEvent(other);
  try { await waitForBlock(blocker); } finally { release.resolve(); }
  expect(await Promise.all([a,b])).toEqual(["succeeded","succeeded"]);
  const result=await settlementState(f);
  expect(result.aggregate).toMatchObject({booking:{status:"confirmed"},reservation:{status:"active"},events:[{event_kind:"confirmed"}]});
  expect(result.receipts).toHaveLength(2);
});

test.each(["currency", "outcome"])("changed duplicate %s evidence rejects without changing any persisted state", async field => {
  const f=await seed(600,false,true), event=paymentEvent(f);
  expect(await processOnlinePaymentEvent(event)).toBe("succeeded"); const before=await settlementState(f);
  const changed={...event,...(field === "amount" ? {amountMinor:1} : field === "currency" ? {currency:"EUR"} : {outcome:"cancelled" as const})};
  await expect(processOnlinePaymentEvent(changed)).rejects.toThrow("Changed payment event evidence.");
  expect(await settlementState(f)).toEqual(before);
});

test("global provider-event key collision rolls back a different booking's provisional confirmation", async () => {
  const a=await seed(600,false,true), b=await seed(720,false,true), key=randomUUID();
  // Different parents permit simultaneous settlement, preserving coverage of
  // the global receipt PK race and rollback of provisional lifecycle writes.
  await database.query("DELETE FROM public.location_pricing_rules WHERE court_id=$1",[secondCourtId]);
  await database.query("UPDATE public.courts SET location_id=$2 WHERE id=$1",[secondCourtId,otherLocationId]);
  await database.query("UPDATE public.court_reservations SET court_id=$2 WHERE id=$1",[b.reservationId,secondCourtId]);
  const before=await settlementState(b), inserted=deferred(), release=deferred(); let blocker=0;
  const original=payments.insertProviderEventReceipt;
  vi.spyOn(payments,"insertProviderEventReceipt").mockImplementationOnce(async (...args) => {
    const result=await original(...args); blocker=await pid(args[0]); inserted.resolve(); await release.promise; return result;
  });
  const winner=processOnlinePaymentEvent(paymentEvent(a,"succeeded",key)); await inserted.promise;
  // Attach a rejection handler immediately while the unique index blocks.
  const loser=processOnlinePaymentEvent(paymentEvent(b,"succeeded",key)); const rejected=expect(loser).rejects.toThrow("Changed payment event evidence.");
  try { await waitForBlock(blocker); } finally { release.resolve(); }
  expect(await winner).toBe("succeeded"); await rejected;
  expect(await settlementState(b)).toEqual(before);
  const winnerState=await settlementState(a); expect(winnerState.receipts).toHaveLength(1); expect(winnerState.aggregate.events).toHaveLength(1);
  await expect(processOnlinePaymentEvent(paymentEvent(b,"succeeded",key))).rejects.toThrow("Changed payment event evidence.");
  expect(await settlementState(b)).toEqual(before);
});

test("currency mismatch retains financial evidence and identical replay preserves later resolution", async () => {
  const f=await seed(600,false,true), event={...paymentEvent(f),currency:"eur"}, before=await state(f);
  expect(await processOnlinePaymentEvent(event)).toBe("amount_mismatch"); expect(await state(f)).toEqual(before);
  expect(await database.query("SELECT currency,settlement_result,reconciliation_required FROM public.payment_provider_events WHERE event_id=$1",[event.eventId]))
    .toEqual([{currency:"EUR",settlement_result:"amount_mismatch",reconciliation_required:true}]);
  // Simulate the retained Admin persistence boundary's resolution columns.
  await database.query("UPDATE public.payment_provider_events SET reconciliation_required=false,resolved_at=clock_timestamp(),resolved_by_user_id=$2 WHERE event_id=$1",[event.eventId,actorId]);
  const resolved=await settlementState(f); expect(await processOnlinePaymentEvent(event)).toBe("amount_mismatch");
  expect(await settlementState(f)).toEqual(resolved);
});

test("failure after lifecycle and receipt insertion rolls back the entire settlement", async () => {
  const f=await seed(600,false,true), event=paymentEvent(f), before=await settlementState(f), insert=payments.insertProviderEventReceipt;
  const spy=vi.spyOn(payments,"insertProviderEventReceipt").mockImplementationOnce(async (...args) => {
    await insert(...args); throw new Error("Injected settlement rollback");
  });
  await expect(processOnlinePaymentEvent(event)).rejects.toThrow("Injected settlement rollback"); spy.mockRestore();
  expect(await settlementState(f)).toEqual(before);
  expect(await processOnlinePaymentEvent(event)).toBe("succeeded");
  const committed=await settlementState(f); expect(committed.receipts).toHaveLength(1); expect(committed.aggregate.events).toHaveLength(1);
});

test("settlement lock wait crosses persisted hold deadline; expiry and replacement never reclaim occupancy", async () => {
  const f=await seed(600,false,true), blocker=await runner(); let settlement:Promise<string>|undefined;
  try {
    await bookings.findBookingForUpdate(blocker.manager,f.id);
    await blocker.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",[f.reservationId]);
    settlement=processOnlinePaymentEvent(paymentEvent(f)); await waitForBlock(await pid(blocker.manager));
    // Poll the real wall clock; no simulated application/transaction clock.
    while (!(await blocker.query("SELECT clock_timestamp()>=hold_expires_at AS elapsed FROM public.court_reservations WHERE id=$1",[f.reservationId]))[0].elapsed)
      await new Promise(resolve=>setTimeout(resolve,5));
    // SKIP LOCKED expiry must not invert settlement's booking/reservation locks.
    await expirePaymentHolds();
    await blocker.commitTransaction(); expect(await settlement).toBe("expired");
    expect((await settlementState(f)).aggregate).toMatchObject({booking:{status:"expired"},reservation:{status:"released"},events:[]});
    const replacement=await seed(600,false,true), before=await settlementState(replacement);
    expect(await processOnlinePaymentEvent(paymentEvent(f))).toBe("expired"); expect(await settlementState(replacement)).toEqual(before);
  } finally { if (blocker.isTransactionActive) await blocker.rollbackTransaction(); if (settlement) await Promise.allSettled([settlement]); await blocker.release(); }
});

test.each(["expiry"])("%s first serializes hold cleanup and application replacement insertion without deadlock", async first => {
  const f=await seed(600,false,true), locked=deferred(), release=deferred();
  if (first === "settlement") {
    const original=bookings.lockSettlementBooking;
    vi.spyOn(bookings,"lockSettlementBooking").mockImplementationOnce(async (...args)=>{
      const b=await original(...args); locked.resolve(); await release.promise; return b;
    });
    const settlement=processOnlinePaymentEvent(paymentEvent(f)); await locked.promise;
    try { await expirePaymentHolds(); } finally { release.resolve(); }
    expect(await settlement).toBe("succeeded");
    await expect(seed(600,false,true)).rejects.toThrow();
    expect((await state(f)).reservation?.status).toBe("active");
  } else {
    await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.reservationId]);
    // Trusted writes explicitly expire holds before inserting a replacement.
    await expirePaymentHolds();
    const replacement=await seed(600,false,true), before=await settlementState(replacement);
    expect(await processOnlinePaymentEvent(paymentEvent(f))).toBe("expired"); expect(await settlementState(replacement)).toEqual(before);
    expect((await state(f)).events).toEqual([]);
  }
});

test.each(["reschedule"])("receipt-bearing settlement waits for Phase 6 %s and preserves original financial authority", async kind => {
  const f=await seed(600,true), input=await edit(f);
  const [mutation,result]=await serialize<unknown,string>(()=>kind === "cancel" ? cancel(f) : save({...input,expectedTotal:5000}),
    ()=>processOnlinePaymentEvent(paymentEvent(f)));
  expect(mutation).toMatchObject(kind === "cancel" ? {outcome:"cancelled"} : {ok:true}); expect(result).toBe("succeeded");
  const before=await state(f);
  await database.query("UPDATE public.bookings SET total_amount_minor=7000 WHERE id=$1",[f.id]);
  expect(await processOnlinePaymentEvent(paymentEvent(f))).toBe("succeeded");
  expect(await processOnlinePaymentEvent({...paymentEvent(f),amountMinor:7000})).toBe("amount_mismatch");
  expect((await state(f)).reservation).toEqual(before.reservation);
  expect((await state(f)).events).toEqual(before.events);
  expect(await database.query("SELECT amount_minor,currency,status FROM public.payment_attempts WHERE id=$1",[f.attemptId]))
    .toEqual([{amount_minor:5000,currency:"RON",status:"succeeded"}]);
});

test("deadline crossed after policy read is fenced at the lifecycle write and re-evaluated as expiry", async () => {
  const f=await seed(600,false,true);
  await database.query("UPDATE public.payment_attempts SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",[f.attemptId]);
  const original=payments.updateSettlementAttempt;
  vi.spyOn(payments,"updateSettlementAttempt").mockImplementationOnce(async (...args)=>{
    // The application already decided success. Advance the actual database
    // clock past the attempt deadline before executing its conditional UPDATE.
    while (!(await args[0].query("SELECT clock_timestamp()>=expires_at AS elapsed FROM public.payment_attempts WHERE id=$1",[f.attemptId]))[0].elapsed)
      await new Promise(resolve=>setTimeout(resolve,5));
    return original(...args);
  });
  expect(await processOnlinePaymentEvent(paymentEvent(f))).toBe("expired");
  expect(await settlementState(f)).toMatchObject({aggregate:{booking:{status:"expired"},reservation:{status:"released",hold_expires_at:null},events:[]},
    attempts:[{status:"expired"}],receipts:[{settlement_result:"expired",reconciliation_required:true}]});
});

test("webhook identity requires the attached provider reference and ignores unrelated attempt evidence", async () => {
  const f=await seed(600,false,true), before=await settlementState(f);
  expect(await processOnlinePaymentEvent({...paymentEvent(f),providerPaymentId:"wrong-reference"})).toBe("unavailable");
  expect(await processOnlinePaymentEvent({...paymentEvent(f),attemptId:randomUUID()})).toBe("unavailable");
  expect(await settlementState(f)).toEqual(before);
  await database.query("UPDATE public.payment_attempts SET provider_payment_id=NULL WHERE id=$1",[f.attemptId]);
  const unattached=await settlementState(f);
  expect(await processOnlinePaymentEvent(paymentEvent(f))).toBe("unavailable"); expect(await settlementState(f)).toEqual(unattached);
  // Bare trusted settlement deliberately retains the NULL-reference allowance.
  expect(await settleOnlinePayment({attemptId:f.attemptId,provider:"stripe",providerPaymentId:`pi-${f.attemptId}`,outcome:"succeeded"})).toBe("succeeded");
  expect((await settlementState(f)).receipts).toEqual([]);
});

test("expiry holding aggregate locks wins against waiting settlement with durable late-success evidence", async () => {
  const f=await seed(600,false,true);
  await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.reservationId]);
  const expiry=await runner(); let settlement:Promise<string>|undefined;
  try {
    await clubs.lockLocations(expiry.manager,[locationId]);
    await expirePaymentHoldsAtLocation(expiry.manager,locationId);
    settlement=processOnlinePaymentEvent(paymentEvent(f)); await waitForBlock(await pid(expiry.manager));
    await expiry.commitTransaction(); expect(await settlement).toBe("expired");
    expect(await settlementState(f)).toMatchObject({aggregate:{booking:{status:"expired"},reservation:{status:"released"},events:[]},
      receipts:[{settlement_result:"expired",reconciliation_required:true}]});
  } finally { if (expiry.isTransactionActive) await expiry.rollbackTransaction(); if (settlement) await Promise.allSettled([settlement]); await expiry.release(); }
});

async function refundFixture() {
  const f=await seed(600,true), result=await cancel(f);
  if (!result.refund_id) throw new Error("Missing refund");
  await database.query("UPDATE public.payment_refunds SET status='pending_retry' WHERE id=$1",[result.refund_id]);
  return {...f, refundId:result.refund_id};
}
async function claimRefund(id:string): Promise<AdminRefundClaim> {
  const prepared=await prepareAdminRefund("retry",id,actorId);
  if (prepared.outcome!=="ready") throw new Error(`Unexpected ${prepared.outcome}`);
  return prepared.claim;
}
const successResult={status:"succeeded" as const,providerRefundId:"re-phase8",lastError:null};

test("Phase 8 concurrent claims yield one lease and one busy; takeover fences the old token", async () => {
  const f=await refundFixture();
  const results=await Promise.all([prepareAdminRefund("retry",f.refundId,actorId),prepareAdminRefund("retry",f.refundId,actorId)]);
  expect(results.map(r=>r.outcome).sort()).toEqual(["busy","ready"]);
  const ready=results.find(r=>r.outcome==="ready"); if (ready?.outcome!=="ready") throw new Error("Missing lease");
  // PostgreSQL microseconds survive the projection and eligibility remains on
  // the database wall clock rather than Date.parse or transaction-start now().
  await database.query("UPDATE public.payment_refunds SET admin_lease_until='2099-01-01T00:00:00.123456Z' WHERE id=$1",[f.refundId]);
  const precise=await prepareAutomaticRefund(f.refundId);
  expect(precise?.admin_lease_until).toBe("2099-01-01T00:00:00.123456+00:00");
  expect(await prepareAdminRefund("retry",f.refundId,actorId)).toEqual({outcome:"busy"});
  await database.query("UPDATE public.payment_refunds SET admin_lease_until=clock_timestamp()-interval '1 microsecond' WHERE id=$1",[f.refundId]);
  const replacement=await claimRefund(f.refundId);
  expect(replacement.token).not.toBe(ready.claim.token);
  await expect(commitAdminRefund(ready.claim,successResult)).rejects.toThrow("Stale refund lease");
  expect((await prepareAutomaticRefund(f.refundId))?.admin_lease_token).toBe(replacement.token);
  expect(await commitAdminRefund(replacement,successResult)).toBe("succeeded");
});

test.each(["role"])("Phase 8 transaction fence rejects %s change while preparation waits on the aggregate", async kind => {
  const f=await refundFixture(),blocker=await runner(); let preparing: ReturnType<typeof prepareAdminRefund> | undefined;
  try {
    await bookings.lockSettlementBooking(blocker.manager,f.id);
    preparing=prepareAdminRefund("retry",f.refundId,actorId);
    // Register rejection before releasing the blocking transaction.
    const rejected=expect(preparing).rejects.toThrow("Admin authorization changed");
    await waitForBlock(await pid(blocker.manager));
    if (kind==="role") await database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code='admin'",[actorId]);
    else await database.query("UPDATE public.users SET status='suspended' WHERE id=$1",[actorId]);
    await blocker.commitTransaction(); await rejected;
    const refund=await prepareAutomaticRefund(f.refundId);
    expect(refund).toMatchObject({status:"pending_retry",admin_lease_token:null,admin_lease_actor_id:null});
  } finally { if (blocker.isTransactionActive) await blocker.rollbackTransaction(); if (preparing) await Promise.allSettled([preparing]); await blocker.release(); }
});

test.each(["failed", "pending_retry"] as const)("Phase 8 automatic success wins against an in-flight Admin %s result", async status => {
  const f=await refundFixture(),claim=await claimRefund(f.refundId),blocker=await runner();
  let committing: ReturnType<typeof commitAdminRefund> | undefined;
  try {
    await bookings.lockSettlementBooking(blocker.manager,f.id);
    committing=commitAdminRefund(claim,{status,providerRefundId:"re-phase8",lastError:"provider_refund_failed"});
    await waitForBlock(await pid(blocker.manager));
    // Automatic never needs the booking lock held by this connection.
    expect(await commitAutomaticRefund(f.refundId,successResult)).toBe("succeeded");
    expect((await prepareAutomaticRefund(f.refundId))?.admin_lease_token).toBe(claim.token);
    await blocker.commitTransaction(); expect(await committing).toBe("succeeded");
    expect((await state(f)).refunds).toEqual([expect.objectContaining({status:"succeeded",provider_refund_id:"re-phase8",last_error:null,admin_lease_token:null})]);
  } finally { if (blocker.isTransactionActive) await blocker.rollbackTransaction(); if (committing) await Promise.allSettled([committing]); await blocker.release(); }
});

test("Phase 8 rejects conflicting established provider identity without clearing a lease", async () => {
  const f=await refundFixture(),claim=await claimRefund(f.refundId);
  await commitAutomaticRefund(f.refundId,successResult);
  const before=await state(f);
  await expect(commitAdminRefund(claim,{...successResult,providerRefundId:"re-conflict"})).rejects.toThrow("Conflicting provider refund identity");
  await expect(commitAutomaticRefund(f.refundId,{...successResult,providerRefundId:"re-conflict"})).rejects.toThrow("Conflicting provider refund identity");
  expect(await state(f)).toEqual(before);
});

async function lateRefundFixture() {
  const f=await seed(600,false,true);
  await settleOnlinePayment({attemptId:f.attemptId,provider:"stripe",providerPaymentId:`pi-${f.attemptId}`,outcome:"cancelled"});
  const eventId=`phase8-${randomUUID()}`;
  const evidence={provider:"stripe" as const,eventId,attemptId:f.attemptId,providerPaymentId:`pi-${f.attemptId}`,outcome:"succeeded" as const,amountMinor:5000,currency:"RON"};
  await processOnlinePaymentEvent(evidence);
  return {...f,eventId,evidence};
}

test("Phase 8 event validation failure rolls back refund success, lease clearing and event attribution", async () => {
  const f=await lateRefundFixture(),prepared=await prepareAdminRefund("reconcile",f.eventId,actorId);
  if (prepared.outcome!=="ready") throw new Error("Missing claim");
  const before=await state(f),events=await database.query("SELECT * FROM public.payment_provider_events WHERE attempt_id=$1",[f.attemptId]);
  const original=payments.writeRefundEventResolution;
  const injection=vi.spyOn(payments,"writeRefundEventResolution").mockImplementationOnce(async (...args)=>{
    await original(...args);
    // Force a real affected-row-count violation after the first resolution.
    await original(args[0],[{provider:"stripe",event_id:"missing-evidence"}],args[2],args[3]);
  });
  await expect(commitAdminRefund(prepared.claim,successResult)).rejects.toThrow(); injection.mockRestore();
  expect(await state(f)).toEqual(before);
  expect(await database.query("SELECT * FROM public.payment_provider_events WHERE attempt_id=$1",[f.attemptId])).toEqual(events);
  expect(await commitAdminRefund(prepared.claim,successResult)).toBe("succeeded");
  const resolved=await database.query("SELECT * FROM public.payment_provider_events WHERE attempt_id=$1",[f.attemptId]);
  expect(await prepareAdminRefund("reconcile",f.eventId,actorId)).toEqual({outcome:"resolved",bookingId:f.id});
  expect(await database.query("SELECT * FROM public.payment_provider_events WHERE attempt_id=$1",[f.attemptId])).toEqual(resolved);
});

test("Phase 8 lease eligibility uses wall time after actor-lock wait, not transaction start", async () => {
  const f=await refundFixture();
  await database.query("UPDATE public.payment_refunds SET admin_lease_token=$2,admin_lease_actor_id=$3,admin_lease_until=clock_timestamp()+interval '250 milliseconds' WHERE id=$1",[f.refundId,randomUUID(),actorId]);
  const blocker=await runner(); let preparing: ReturnType<typeof prepareAdminRefund> | undefined;
  try {
    await blocker.manager.query("SELECT role_code FROM public.user_roles WHERE user_id=$1 AND role_code='admin' FOR UPDATE",[actorId]);
    preparing=prepareAdminRefund("retry",f.refundId,actorId);
    await waitForBlock(await pid(blocker.manager));
    const deadline=Date.now()+3000;
    while (true) {
      const rows:unknown=await database.query("SELECT admin_lease_until <= clock_timestamp() AS reclaimable FROM public.payment_refunds WHERE id=$1",[f.refundId]);
      if (z.array(z.object({reclaimable:z.boolean()})).length(1).parse(rows)[0].reclaimable) break;
      if (Date.now()>deadline) throw new Error("Lease did not expire");
      await new Promise(done=>setTimeout(done,10));
    }
    await blocker.commitTransaction();
    const result=await preparing; expect(result.outcome).toBe("ready");
    if (result.outcome!=="ready") throw new Error("Missing claim");
    const lease:unknown=await database.query("SELECT admin_lease_until-clock_timestamp() BETWEEN interval '299 seconds' AND interval '300 seconds' AS five_minutes FROM public.payment_refunds WHERE id=$1",[f.refundId]);
    expect(lease).toEqual([{five_minutes:true}]);
  } finally { if (blocker.isTransactionActive) await blocker.rollbackTransaction(); if (preparing) await Promise.allSettled([preparing]); await blocker.release(); }
});

test.each(["amount", "capture"])("automatic refund rejects changed %s evidence before a provider result write", async field => {
  const f=await refundFixture(),before=await state(f),read=payments.findRefundCaptureEvidence;
  vi.spyOn(payments,"findRefundCaptureEvidence").mockImplementation(async (...args)=>{
    const evidence=await read(...args),p=evidence.payment;
    if(!p) throw new Error("Missing original payment");
    return {payment:{...p,...(field==="amount" ? {amount_minor:1} : field==="currency" ? {currency:"EUR"}
      : field==="provider" ? {provider:"netopia" as const} : field==="payment-id" ? {provider_payment_id:"pi_other"}
      : field==="booking" ? {booking_id:randomUUID()} : {status:"expired"})},events:[]};
  });
  const write=vi.spyOn(payments,"writeRefundResult");
  await expect(prepareAutomaticRefund(f.refundId)).rejects.toThrow("Refund financial evidence changed");
  await expect(commitAutomaticRefund(f.refundId,successResult)).rejects.toThrow("Refund financial evidence changed");
  expect(write).not.toHaveBeenCalled();expect(await state(f)).toEqual(before);
});
test("automatic refund completion fences the original snapshot and cannot regress a succeeded refund or replace its provider ID", async () => {
  const f=await refundFixture(),prepared=await prepareAutomaticRefund(f.refundId);
  if(!prepared) throw new Error("Missing refund");
  const write=vi.spyOn(payments,"writeRefundResult");
  await expect(commitAutomaticRefund(f.refundId,successResult,{...prepared,created_at:"2000-01-01T00:00:00.000001+00:00"}))
    .rejects.toThrow("Refund financial evidence changed");expect(write).not.toHaveBeenCalled();
  expect(await commitAutomaticRefund(f.refundId,successResult,prepared)).toBe("succeeded");const before=await state(f);write.mockClear();
  expect(await commitAutomaticRefund(f.refundId,{...successResult,status:"pending_retry"},prepared)).toBe("succeeded");
  await expect(commitAutomaticRefund(f.refundId,{...successResult,providerRefundId:"re_other"},prepared))
    .rejects.toThrow("Conflicting provider refund identity");
  expect(write).not.toHaveBeenCalled();expect(await state(f)).toEqual(before);
});
test("expiry skips a busy payment attempt without partial lifecycle changes and succeeds on a later poll", async () => {
  const f=await seed(600,false,true);await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.reservationId]);
  const before=await settlementState(f),blocker=await runner();
  try {
    await payments.lockSettlementAttempt(blocker.manager,f.attemptId);
    expect(await expirePaymentHolds({locationId})).toBe(0);expect(await settlementState(f)).toEqual(before);
    await blocker.commitTransaction();expect(await expirePaymentHolds({locationId})).toBe(1);
    expect(await expirePaymentHolds({locationId})).toBe(0);
    expect(await settlementState(f)).toMatchObject({aggregate:{booking:{status:"expired"},reservation:{status:"released"}},attempts:[{status:"expired"}]});
  } finally {if(blocker.isTransactionActive)await blocker.rollbackTransaction();await blocker.release();}
});
test.each(["reservation"])("TypeScript expiry failure after %s write rolls back the complete aggregate", async stage => {
  const f=await seed(600,false,true);await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.reservationId]);
  const before=await settlementState(f);
  if(stage==="booking") {
    const write=bookings.updateSettlementBookingStatus;
    vi.spyOn(bookings,"updateSettlementBookingStatus").mockImplementationOnce(async (...args)=>{await write(...args);throw new Error("Expiry rollback");});
  } else if(stage==="attempt") {
    const write=payments.expirePendingAttempt;
    vi.spyOn(payments,"expirePendingAttempt").mockImplementationOnce(async (...args)=>{await write(...args);throw new Error("Expiry rollback");});
  } else {
    const write=reservations.updateSettlementReservationStatus;
    vi.spyOn(reservations,"updateSettlementReservationStatus").mockImplementationOnce(async (...args)=>{await write(...args);throw new Error("Expiry rollback");});
  }
  await expect(expirePaymentHolds({courtId})).rejects.toThrow("Expiry rollback");expect(await settlementState(f)).toEqual(before);
  expect(await expirePaymentHolds({courtId})).toBe(1);
});
test("expiry never releases an inconsistent successfully captured hold", async () => {
  const f=await seed(600,false,true);
  await database.query("UPDATE public.payment_attempts SET status='succeeded',completed_at=clock_timestamp() WHERE id=$1",[f.attemptId]);
  await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.reservationId]);
  const before=await settlementState(f);
  expect(await expirePaymentHolds({courtId})).toBe(0);expect(await settlementState(f)).toEqual(before);
});

test("settlement parent rediscovery rolls back before retrying in a fresh transaction", async () => {
  const f=await seed(600,false,true),discover=payments.discoverSettlementParent;
  const read=vi.spyOn(payments,"discoverSettlementParent").mockImplementationOnce(async (...args)=>{
    const parent=await discover(...args);if(!parent)throw new Error("Missing parent");
    return {...parent,location_id:otherLocationId};
  });
  const parents=vi.spyOn(clubs,"lockLocations");
  expect(await processOnlinePaymentEvent(paymentEvent(f))).toBe("succeeded");
  expect(read).toHaveBeenCalledTimes(2);expect(read.mock.calls[0][0]).not.toBe(read.mock.calls[1][0]);
  expect(parents.mock.calls.map(args=>args[1])).toEqual([[otherLocationId],[locationId]]);
});
test("settlement rejects conflicting occupancy before its lifecycle writes and keeps late capture evidence", async () => {
  const f=await seed(600,false,true),before=await state(f);
  vi.spyOn(reservations,"findCheckoutOccupancy").mockResolvedValue([{court_id:courtId,booking_date:date,starts_at_minute:600,ends_at_minute:660}]);
  const write=vi.spyOn(payments,"updateSettlementAttempt");
  expect(await processOnlinePaymentEvent(paymentEvent(f))).toBe("unavailable");expect(write).not.toHaveBeenCalled();
  expect(await state(f)).toEqual(before);
  expect(await database.query("SELECT settlement_result,reconciliation_required FROM public.payment_provider_events WHERE attempt_id=$1",[f.attemptId]))
    .toEqual([{settlement_result:"unavailable",reconciliation_required:true}]);
});
