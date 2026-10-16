import { bookingNotifications } from "../booking-notification-fixtures";
import { appendBookingContractFixture } from "../checkout-fixtures";
import * as revisions from "@/lib/db/repositories/booking-revisions.repository";
import * as refundProcessing from "@/lib/payments/refunds";
import * as refundExecutions from "@/lib/db/repositories/refund-executions.repository";
import { insertBookingRecords, setAdjustmentExpiryFixture, setPaymentAttemptExpiryFixture } from "../../local/booking-fixtures";
import { cleanupBookingFixtures } from "../checkout-fixtures";
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DataSource, EntityManager, QueryRunner } from "typeorm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { getDataSource } from "@/lib/db/data-source";
import { expirePaymentHolds, expirePaymentHoldsAtLocation } from "@/lib/payments/hold-expiry";
import { revokeCheckoutCapability } from "@/lib/db/repositories/payments.repository";
import { inTransaction } from "@/lib/db/transaction";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import * as accounts from "@/lib/db/repositories/accounts.repository";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import * as payments from "@/lib/db/repositories/payments.repository";
import { cancelCustomerBookingCommand, resolveRefundBackedAdjustment, readCustomerBookingEditContext } from "@/lib/bookings/commands";
import { runBookingReschedule } from "@/lib/bookings/reschedule";
import { localFixtureClient, cleanupAuthFixtures } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";
import { processOnlinePaymentEvent, settleOnlinePayment } from "@/lib/payments/service";
import { checkOnlinePayment, readOnlineCheckout, abandonOnlineCheckout, startOnlineCheckout, resolveAuthorizedCheckoutPayment } from "@/lib/payments/checkout";
import { readAdjustmentStatus, dismissAdjustment } from "@/lib/payments/booking-adjustments";
import { adjustmentAttempt, findAdjustment, listAdjustmentRefunds as adjustmentRefunds, listBookingsWithLivePayment } from "@/lib/db/repositories/booking-adjustments.repository";
import { readFinancialHistory } from "@/lib/payments/financial-history";
import { buildBookingRevision } from "@/lib/bookings/revision";
import { bookingFinancials, allocateBookingRefund } from "@/lib/payments/financials";
import { stripeAdapter } from "@/lib/payments/providers/stripe/adapter";
import { prepareRefund, initiateRefundExecution, commitRefundExecution, type RefundExecutionClaim } from "@/lib/payments/refund-commands";
import { deliverPendingBookingNotifications } from "@/lib/notifications/booking-delivery";
import { isolateNotificationQueue } from "../booking-notification-fixtures";

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
  await cleanupBookingFixtures({ courtIds: [courtId, secondCourtId] });
  await database.query("DELETE FROM public.court_reservations WHERE court_id=ANY($1::uuid[])", [[courtId, secondCourtId]]);
}
beforeEach(async () => {
  await clear();
  await database.query("UPDATE public.users SET status='active' WHERE id=$1", [actorId]);
  await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin'),($1,'coach') ON CONFLICT DO NOTHING", [actorId]);
  await database.query("UPDATE public.courts SET location_id=$2,is_active=true WHERE id=ANY($1::uuid[])", [[courtId,secondCourtId],locationId]);
  await database.query("UPDATE public.locations SET timezone='UTC',is_active=true,is_public=true,archived_at=null,currency='RON' WHERE id=$1", [locationId]);
  await database.query("DELETE FROM public.location_pricing_rules WHERE location_id=$1", [locationId]);
  await database.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [locationId]);
  await database.query("DELETE FROM public.court_coverage_periods WHERE court_id=ANY($1::uuid[])", [[courtId,secondCourtId]]);
  await database.query("WITH baseline AS (INSERT INTO public.opening_hours_schedules(location_id,starts_on) SELECT $1,DATE '0001-01-01' WHERE NOT EXISTS (SELECT 1 FROM public.opening_hours_schedules WHERE location_id=$1) RETURNING id) INSERT INTO public.location_opening_hours(schedule_id,location_id,weekday,opens_at_minute,closes_at_minute) SELECT coalesce((SELECT id FROM public.opening_hours_schedules WHERE location_id=$1 LIMIT 1),(SELECT id FROM baseline)),$1,i,0,1440 FROM generate_series(0,6) i", [locationId]);
  await database.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
    SELECT $1,$2,c,s,i,0,1440,CASE WHEN s='covered' THEN 7000 ELSE 5000 END
    FROM unnest($3::uuid[]) c CROSS JOIN unnest(ARRAY['outdoor','covered']) s CROSS JOIN generate_series(0,6) i`, [locationId,ruleSetId,[courtId,secondCourtId]]);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try {
    if (database?.isInitialized) {
      await clear();
      await database.query("DELETE FROM public.pricing_rule_sets WHERE id=$1", [ruleSetId]);
      await database.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [locationId]);
      await database.query("DELETE FROM public.court_coverage_periods WHERE court_id=ANY($1::uuid[])", [[courtId,secondCourtId]]);
      await database.query("DELETE FROM public.courts WHERE id=ANY($1::uuid[])", [[courtId,secondCourtId]]);
      await database.query("DELETE FROM public.locations WHERE id=ANY($1::uuid[])", [[locationId,otherLocationId]]);
      await cleanupAuthFixtures(service, [actorId]);
    }
  } finally { if (database?.isInitialized) await database.destroy(); vi.unstubAllEnvs(); }
});
async function seed(start = 600, paid = false, pending = false, contract = { date, notice: 1440 }, owner: string | null = actorId,
  providerAttached = true, ageSeconds = 0) {
  const id = randomUUID(), reservationId = randomUUID(), attemptId = randomUUID();
  await database.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at)
    VALUES($1,$2,$3,$4,$4+60,$5::public.court_reservation_status,CASE WHEN $5::text='held' THEN clock_timestamp()+interval '10 minutes' ELSE NULL END)`,
    [reservationId,courtId,contract.date,start,pending ? "held" : "active"]);
  await database.transaction(manager => insertBookingRecords(manager, { id: id, reservation_id: reservationId, account_user_id: owner, customer_name: "Customer", customer_email: "immutable@example.test", customer_phone: "123", total_amount_minor: 5000, currency: "RON", cancellation_notice_minutes: contract.notice, status: pending ? "pending_payment" : "confirmed", payment_method: paid || pending ? "online" : "pay_at_club" }));
  if (paid || pending) await database.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at,completed_at,created_at)
    VALUES($1,$2,'online','stripe',$3,5000,'RON',$4::text,clock_timestamp()+interval '10 minutes',CASE WHEN $4::text='succeeded' THEN clock_timestamp() ELSE NULL END,clock_timestamp()-make_interval(secs=>$5))`,
    [attemptId,id,providerAttached ? `pi-${attemptId}` : null,pending ? "pending" : "succeeded",ageSeconds]);
  if (paid) await database.query(`INSERT INTO public.payment_capture_receipts
    (payment_attempt_id,provider,provider_payment_id,provider_capture_id,amount_minor,currency)
    VALUES($1,'stripe',$2,$2,5000,'RON')`, [attemptId,`pi-${attemptId}`]);
  return { id, reservationId, attemptId };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
async function edit(f: Fixture, extra = {}) {
  const context = await readCustomerBookingEditContext(f.id,date,actorId);
  if (!context) throw new Error("Missing edit context");
  return { id: f.id, expectedRevisionId: context.current_revision_id, expectedUpdatedAt: context.updated_at,
    courtId: secondCourtId,date,startMinute:720,endMinute:780,save:true,expectedTotal:5000,priceAcknowledged:true,...extra };
}
const emails = (id: string) => bookingNotifications(database.manager, id);
const save = (input: unknown) => runBookingReschedule(input,actorId);
const cancel = (f: Fixture, scope: "owner" | "admin" = "owner") => cancelCustomerBookingCommand(f.id,actorId,scope);
// Fixture provider observations are committed through the real execution commands;
// refund-backed occupancy/revisions are applied only after all obligations settle.
async function settleRefundRequest(request: { refundIds: string[]; adjustmentId?: string }) {
  for (const id of request.refundIds) {
    const prepared = await prepareRefund(id);
    if (prepared.outcome === "terminal") { expect(prepared.status).toBe("succeeded"); continue; }
    if (prepared.outcome !== "ready") throw new Error("Missing refund claim");
    await initiateRefundExecution(prepared.claim);
    expect(await commitRefundExecution(prepared.claim, { kind: "verified", status: "succeeded", providerRefundId: `re_${id}` }))
      .toMatchObject({ status: "succeeded" });
  }
  if (request.adjustmentId) expect(await resolveRefundBackedAdjustment(request.adjustmentId)).toBe("applied");
}
async function completeCancellation(f: Fixture, scope: "owner" | "admin" = "owner") {
  const request = await cancel(f, scope);
  if (request.outcome !== "cancellation_pending") return request;
  await settleRefundRequest(request);
  return cancel(f, scope);
}
async function state(f: Fixture) {
  const booking = await inTransaction(m => bookings.findBookingForUpdate(m,f.id));
  const reservation = await inTransaction(m => reservations.findReservationForUpdate(m,f.reservationId));
  const refunds: unknown = await database.query("SELECT * FROM public.payment_refunds WHERE booking_id=$1", [f.id]);
  const events = await emails(f.id);
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
  expect(a.outcome).toBe(paid ? "cancellation_pending" : "cancelled"); expect(b.outcome).toBe(a.outcome);
  expect(b).toEqual(a);
  expect(a).toMatchObject({ refundIds: paid ? [expect.any(String)] : [] });
  if (a.outcome === "cancellation_pending") {
    expect(await state(f)).toMatchObject({ booking: { status: "confirmed" }, reservation: { status: "active" }, events: [] });
    await settleRefundRequest(a);
  }
  expect(await state(f)).toMatchObject({ booking:{status:"cancelled"},reservation:{status:"cancelled"},
    refunds:paid ? [expect.objectContaining({amount_minor:5000})] : [],events:[expect.objectContaining({subject:"Booking cancelled"})] });
  const history = await database.query("SELECT id,kind,operation_key,intent_hash FROM public.booking_revisions WHERE booking_id=$1 ORDER BY revision_number", [f.id]);
  expect(history).toEqual([expect.objectContaining({kind:"created"}),
    expect.objectContaining({kind:"cancelled",operation_key:"cancellation",intent_hash:"cancellation"})]);
  expect((await state(f)).booking?.current_revision_id).toBe(history[1].id);
  const before = await state(f);
  expect(await cancel(f)).toMatchObject({ outcome: "cancelled", refundIds: a.outcome === "cancellation_pending" ? a.refundIds : [] });
  expect(await state(f)).toEqual(before);
  expect(await database.query("SELECT id,kind,operation_key,intent_hash FROM public.booking_revisions WHERE booking_id=$1 ORDER BY revision_number", [f.id])).toEqual(history);
});
test.each(["owner", "admin"] as const)("%s notification snapshots preserve committed history across resource renames", async scope => {
  const f = await seed();
  const original = (await state(f)).booking!.revision;
  try {
    await database.query("UPDATE public.locations SET name='Renamed Club',timezone='Europe/Bucharest' WHERE id=$1", [locationId]);
    await database.query("UPDATE public.courts SET name='Renamed Court' WHERE id=$1", [courtId]);
    expect(await cancel(f, scope)).toMatchObject({ outcome: "cancelled" });
    expect(await emails(f.id)).toEqual([expect.objectContaining({ to: original.customerEmail,
      subject: "Booking cancelled", text: expect.stringContaining(`Location: ${original.locationName}`) })]);
    expect((await emails(f.id))[0].text).toContain(`Schedule: ${original.bookingDate}, 10:00–11:00, ${original.courtName}`);
    expect(await cancel(f, scope)).toMatchObject({ outcome: "cancelled" });
    expect(await emails(f.id)).toHaveLength(1);
  } finally {
    await database.query("UPDATE public.locations SET name='Phase 6',timezone='UTC' WHERE id=$1", [locationId]);
    await database.query("UPDATE public.courts SET name='Court' WHERE id=$1", [courtId]);
  }
});
test("same submitted tokens serialize into success then stale", async () => {
  const f = await seed(), input = await edit(f);
  const results = await serialize(() => save(input),() => save(input));
  expect(results[0]).toEqual({ok:true,totalAmountMinor:5000}); expect(results[1]).toMatchObject({ok:true});
});
test.each(["cancel", "reschedule"])("cancel/reschedule sees authoritative state with %s first", async first => {
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
  const history = await database.query("SELECT id,kind FROM public.booking_revisions WHERE booking_id=$1 ORDER BY revision_number", [f.id]);
  expect(history.map((row: {kind:string}) => row.kind)).toEqual(first === "cancel"
    ? ["created","cancelled"] : ["created","rescheduled","cancelled"]);
  expect((await state(f)).booking?.current_revision_id).toBe(history.at(-1).id);
  expect((await emails(f.id)).map(e => e.subject)).toEqual(first === "cancel"
    ? ["Booking cancelled"] : ["Booking rescheduled","Booking cancelled"]);
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
test("stale revision identity precedes target validation", async () => {
  const f=await seed(),input=await edit(f);
  expect(await save({...input,expectedRevisionId:randomUUID(),courtId:randomUUID()})).toMatchObject({reason:"stale"});
});
test("identical saves leave booking, occupancy, revisions and mail unchanged", async () => {
  const f = await seed(), before = await state(f);
  const input = await edit(f,{courtId,startMinute:600,endMinute:660});
  expect(await save(input)).toEqual({ok:true,totalAmountMinor:5000});
  expect(await state(f)).toEqual(before);
  expect(await database.query("SELECT revision_number FROM public.booking_revisions WHERE booking_id=$1",[f.id])).toEqual([{revision_number:1}]);
});
test.each(["booking", "reservation"])("cancellation rollback after %s write restores all rows and sends no mail", async step => {
  const f = await seed(600,true), request = await cancel(f);
  if (request.outcome !== "cancellation_pending") throw new Error("Missing pending cancellation");
  for (const id of request.refundIds) {
    const claim = await claimRefund(id);
    await commitRefundExecution(claim, { ...successResult, providerRefundId: `re_${id}` });
  }
  const before = await state(f);
  const target = step === "booking" ? bookings : reservations;
  if (target === bookings) {
    const write = revisions.advanceRevision;
    vi.spyOn(revisions,"advanceRevision").mockImplementationOnce(async (...args) => { await write(...args); throw new Error("Injected failure"); });
  } else {
    const write = reservations.updateCustomerReservationCancellation;
    vi.spyOn(reservations,"updateCustomerReservationCancellation").mockImplementationOnce(async (...args) => { await write(...args); throw new Error("Injected failure"); });
  }
  await expect(resolveRefundBackedAdjustment(request.adjustmentId)).rejects.toThrow("Injected failure");
  expect(await state(f)).toEqual(before);
  expect(await database.query("SELECT status FROM public.booking_adjustments WHERE id=$1",[request.adjustmentId])).toEqual([{status:"pending"}]);
});
test.each(["reservation", "total"])("reschedule rollback after %s write restores all rows and sends no mail", async step => {
  const f = await seed(), input = await edit(f), before = await state(f);
  if (step === "reservation") {
    const write = reservations.updateCustomerReservationSchedule;
    vi.spyOn(reservations,"updateCustomerReservationSchedule").mockImplementationOnce(async (...args) => { await write(...args); throw new Error("Injected failure"); });
  } else {
    const write = revisions.advanceRevision;
    vi.spyOn(revisions,"advanceRevision").mockImplementationOnce(async (...args) => { await write(...args); throw new Error("Injected failure"); });
  }
  expect(await save(input)).toEqual({ok:false,message:"Unable to reschedule this booking. Try again."}); expect(await state(f)).toEqual(before);
});
test.each([8000,3000])("paid reschedule total %s records adjustment funds; cancellation preserves original capture", async price => {
  simulatedStripe();
  const f = await seed(600,true);
  const originalAttempt = await database.query("SELECT * FROM public.payment_attempts WHERE id=$1", [f.attemptId]);
  await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=$2 WHERE location_id=$1 AND court_state='outdoor'",[locationId,price]);
  const result = await save(await edit(f,{expectedTotal:price}));
  expect(result).toMatchObject({ok:true,totalAmountMinor:price,adjustmentStatus:price>5000 ? "pending" : "applied"});
  expect((await state(f)).booking?.total_amount_minor).toBe(price>5000 ? 5000 : price);
  expect(await database.query("SELECT count(*)::integer AS count FROM public.booking_revisions WHERE booking_id=$1",[f.id])).toEqual([{count:price>5000 ? 1 : 2}]);
  expect(await database.query("SELECT * FROM public.payment_attempts WHERE id=$1",[f.attemptId])).toEqual(originalAttempt);
  await cancel(f);
  const rows: {amount_minor:number}[] = await database.query("SELECT amount_minor FROM public.payment_refunds WHERE booking_id=$1",[f.id]);
  expect(rows.reduce((sum,r)=>sum+r.amount_minor,0)).toBe(5000);
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
  const tomorrow = new Date(Date.now()+86400000).toISOString().slice(0,10);
  // Seed occupancy and its authoritative revision together; moving occupancy
  // alone leaves the immutable contract's start in 2099 and notice unexpired.
  return seed(600, false, false, { date: tomorrow, notice: 43200 });
}
async function cancellationEvidence(f: Fixture) {
  return { ...await state(f), revisions: await database.query(
    "SELECT * FROM public.booking_revisions WHERE booking_id=$1 ORDER BY revision_number", [f.id]) };
}
async function rescheduleEvidence(f: Fixture) {
  return { ...await cancellationEvidence(f),
    attempts: await database.query("SELECT * FROM public.payment_attempts WHERE booking_id=$1 ORDER BY id", [f.id]),
    providerEvents: await database.query("SELECT * FROM public.payment_provider_events WHERE attempt_id IN (SELECT id FROM public.payment_attempts WHERE booking_id=$1) ORDER BY provider,event_id", [f.id]),
    adjustments: await database.query("SELECT * FROM public.booking_adjustments WHERE booking_id=$1 ORDER BY id", [f.id]) };
}
async function expectContractOccupancy(f: Fixture, start: number, notice: number) {
  const { booking, reservation } = await state(f);
  expect(booking).toMatchObject({ id: f.id, reservation_id: f.reservationId, status: "confirmed",
    revision: { id: booking?.current_revision_id, bookingId: f.id, bookingState: "confirmed",
      timezone: "UTC", courtId, bookingDate: date, startMinute: start, endMinute: start + 60,
      cancellationNoticeMinutes: notice, totalAmountMinor: 5000, currency: "RON" } });
  expect(reservation).toMatchObject({ id: f.reservationId, court_id: courtId, booking_date: date,
    starts_at_minute: start, ends_at_minute: start + 60, status: "active" });
  expect(booking?.revision.pricingEvidence.slots.map(s => s.minute)).toEqual([start, start + 30]);
}
test.each(["status", "coach"])("actor %s change before fence changes policy", async kind => {
  const f = kind === "coach" ? await expiredNoticeFixture() : await seed();
  if (kind === "coach") await database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code='admin'",[actorId]);
  const before = await cancellationEvidence(f);
  const waiting=deferred(), release=deferred(); const original=accounts.lockReservationActorFacts;
  vi.spyOn(accounts,"lockReservationActorFacts").mockImplementationOnce(async (...args) => {
    waiting.resolve(); await release.promise; return original(...args);
  });
  const mutation=cancel(f,kind === "admin" ? "admin" : "owner"); await waiting.promise;
  if (kind === "status") await database.query("UPDATE public.users SET status='suspended' WHERE id=$1",[actorId]);
  else await database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code=$2",[actorId,kind]);
  release.resolve(); expect(await mutation).toMatchObject({outcome:kind === "status" ? "inactive" : kind === "coach" ? "notice_required" : "unavailable"});
  expect(await cancellationEvidence(f)).toEqual(before);
});
test.each(["current coach", "revoked coach", "ordinary owner"])("owner cancellation notice uses %s facts", async kind => {
  const f = await expiredNoticeFixture();
  await database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code='admin'", [actorId]);
  if (kind === "ordinary owner") await database.query("DELETE FROM public.user_roles WHERE user_id=$1", [actorId]);
  const before = await cancellationEvidence(f);
  if (kind === "revoked coach") await database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code='coach'", [actorId]);
  expect((await cancel(f)).outcome).toBe(kind === "current coach" ? "cancelled" : "notice_required");
  if (kind === "current coach") expect((await state(f)).booking?.revision.actorScope).toBe("coach_owner");
  else expect(await cancellationEvidence(f)).toEqual(before);
});
test.each(["customer", "guest"])("Coach cannot cancel another %s booking through owner or Admin scope", async kind => {
  await database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code='admin'", [actorId]);
  const other = await service.auth.admin.createUser({ email: `coach-boundary-${randomUUID()}@example.test`,
    password: "coach-boundary-test-password-123", email_confirm: true });
  if (!other.data.user) throw new Error("Missing other owner");
  const otherId = other.data.user.id;
  let f: Fixture | undefined;
  try {
    f = await seed(600, false, false, undefined, kind === "guest" ? null : otherId);
    // Even a matching booking contact does not establish account ownership.
    const actor = await service.auth.admin.getUserById(actorId);
    if (!actor.data.user?.email) throw new Error("Missing actor email");
    await appendBookingContractFixture(f.id, { customer_email: actor.data.user.email });
    const before = await cancellationEvidence(f);
    for (const scope of ["owner", "admin"] as const) expect((await cancel(f, scope)).outcome).toBe("unavailable");
    expect(await cancellationEvidence(f)).toEqual(before);
  } finally {
    if (f) await cleanupBookingFixtures({ bookingIds: [f.id] });
    await cleanupAuthFixtures(service, [otherId]);
  }
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
  // Target starts at noon; the accepted original must still be eligible then.
  // Seed occupancy AND its revision at 15:00, with zero notice, together.
  const start = kind === "target" ? 900 : 600, notice = kind === "target" ? 0 : 1440;
  const f = await seed(start, true, false, { date, notice }), input=await edit(f);
  await expectContractOccupancy(f, start, notice);
  const before = await rescheduleEvidence(f);
  await database.query("DELETE FROM public.user_roles WHERE user_id=$1",[actorId]);
  const blocker=await runner(); let mutation: Promise<unknown> | undefined;
  try {
    await bookings.findBookingForUpdate(blocker.manager,f.id);
    const after=kind === "cutoff" ? "2099-10-14T10:00:00.000001+00:00" : kind === "original"
      ? "2099-10-15T10:00:00+00:00" : "2099-10-15T12:00:00+00:00";
    vi.spyOn(reservations,"readReservationClockTime").mockResolvedValue(after);
    mutation=kind === "target" ? save(input) : cancel(f);
    await waitForBlock(await pid(blocker.manager)); await blocker.commitTransaction();
    const result=await mutation;
    if (kind === "target") expect(result).toEqual({ok:false,message:"This booking or interval is no longer available to reschedule."});
    else expect(result).toMatchObject({outcome:kind === "cutoff" ? "notice_required" : "started"});
    expect(await rescheduleEvidence(f)).toEqual(before);
  } finally {
    if (blocker.isTransactionActive) await blocker.rollbackTransaction(); if (mutation) await Promise.allSettled([mutation]); await blocker.release();
  }
});

test.each(["cancel","reschedule"])("pending/held rejects %s; settlement first then supplies confirmed evidence", async kind => {
  const refundPayment = vi.spyOn(stripeAdapter, "refundPayment");
  const f=await seed(600,false,true);
  const input={id:f.id,expectedRevisionId:randomUUID(),expectedUpdatedAt:"2000-01-01T00:00:00Z",
    courtId:secondCourtId,date,startMinute:720,endMinute:780,save:true,expectedTotal:5000,priceAcknowledged:true};
  const denied=kind === "cancel" ? await cancel(f) : await save(input);
  expect(denied).toMatchObject(kind === "cancel" ? {outcome:"unavailable"} : {ok:false,message:"This booking is no longer available to edit."});
  const blocker=await runner(); let settlement: Promise<string> | undefined;
  try {
    await bookings.findBookingForUpdate(blocker.manager,f.id);
    settlement=processOnlinePaymentEvent(paymentEvent(f));
    await waitForBlock(await pid(blocker.manager)); await blocker.commitTransaction(); expect(await settlement).toBe("succeeded");
    const result=kind === "cancel" ? await cancel(f) : await save(await edit(f));
    expect(result).toMatchObject(kind === "cancel" ? {outcome:"cancellation_pending"} : {ok:true});
    // A retained duplicate must not reopen occupancy or overwrite the schedule/evidence.
    const before=await state(f), attempts: unknown=await database.query("SELECT * FROM public.payment_attempts WHERE id=$1",[f.attemptId]);
    await processOnlinePaymentEvent(paymentEvent(f));
    expect(await state(f)).toEqual(before); expect(await database.query("SELECT * FROM public.payment_attempts WHERE id=$1",[f.attemptId])).toEqual(attempts);
    expect(refundPayment).not.toHaveBeenCalled();
  } finally { if (blocker.isTransactionActive) await blocker.rollbackTransaction(); if (settlement) await Promise.allSettled([settlement]); await blocker.release(); }
});
test.each(["cancel","reschedule","admin cancellation"])("%s first safely serializes retained late/duplicate settlement", async kind => {
  const f=await seed(600,true), input=await edit(f);
  const cancellation = kind !== "reschedule";
  const [a,b]=await serialize<unknown,string>(() => kind === "admin cancellation" ? cancel(f,"admin")
    : cancellation ? cancel(f) : save(input),
    () => processOnlinePaymentEvent(paymentEvent(f)));
  expect(a).toMatchObject(cancellation ? {outcome:"cancellation_pending"} : {ok:true}); expect(typeof b).toBe("string");
  expect((await state(f)).reservation).toMatchObject(cancellation ? {status:"active"} : {court_id:secondCourtId,starts_at_minute:720});
  if (kind === "admin cancellation") expect((await state(f)).refunds).toEqual([expect.objectContaining({ amount_minor:5000 })]);
  expect(await database.query("SELECT amount_minor,currency,status FROM public.payment_attempts WHERE id=$1",[f.attemptId]))
    .toEqual([{amount_minor:5000,currency:"RON",status:"succeeded"}]);
});

test("Phase 6 refund replay serializes with TypeORM claim and result without changing financial evidence", async () => {
  const f=await seed(600,true), cancelled=await cancel(f);
  if (cancelled.outcome !== "cancellation_pending" || !cancelled.refundIds[0]) throw new Error("Missing refund");
  await database.query("UPDATE public.payment_refunds SET status='pending_retry' WHERE id=$1",[cancelled.refundIds[0]]);
  const blocker=await runner(); let preparation: ReturnType<typeof prepareRefund> | undefined;
  try {
    await bookings.findBookingForUpdate(blocker.manager,f.id);
    preparation=prepareRefund(cancelled.refundIds[0]);
    const replay=cancel(f); await waitForBlock(await pid(blocker.manager)); await blocker.commitTransaction();
    const prepared=await preparation;
    expect(prepared.outcome).toBe("ready"); expect(await replay).toEqual(cancelled);
    if (prepared.outcome!=="ready") throw new Error("Missing claim");
    await initiateRefundExecution(prepared.claim);
    const results=await Promise.all([cancel(f),commitRefundExecution(prepared.claim,{kind:"verified",status:"succeeded",providerRefundId:"re-phase8"})]);
    expect(results).toEqual([cancelled,{status:"succeeded",notice:null}]);
    expect((await state(f)).refunds).toEqual([expect.objectContaining({id:cancelled.refundIds[0],amount_minor:5000,currency:"RON",status:"succeeded"})]);
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
  expect((await completeCancellation(f)).outcome).toBe("cancelled"); expect(parents).toEqual([locationId,otherLocationId]);
  expect(new Set(transactions).size).toBe(2);
});
test.each(["cutoff", "at-start"])("cancellation exact %s boundary retains fractional precision", async boundary => {
  const f=await seed(); await database.query("DELETE FROM public.user_roles WHERE user_id=$1",[actorId]);
  if (boundary.includes("start")) await appendBookingContractFixture(f.id, { cancellation_notice_minutes: 0 });
  const checkedAt=boundary === "cutoff" ? "2099-10-14T10:00:00+00:00" : boundary === "after-cutoff"
    ? "2099-10-14T10:00:00.000001+00:00" : boundary === "before-start"
      ? "2099-10-15T09:59:59.999999+00:00" : "2099-10-15T10:00:00+00:00";
  vi.spyOn(reservations,"readReservationClockTime").mockResolvedValue(checkedAt);
  expect((await cancel(f)).outcome).toBe(boundary === "after-cutoff" ? "notice_required" : boundary === "at-start" ? "started" : "cancelled");
  if (boundary === "before-start") expect((await state(f)).reservation?.cancelled_at).toBe(checkedAt);
});

const rescheduleBoundaries = [
  { boundary: "one microsecond before notice", instant: "2099-10-14T09:59:59.999999+00:00", ordinary: true, staff: true },
  { boundary: "exact notice deadline", instant: "2099-10-14T10:00:00+00:00", ordinary: true, staff: true },
  { boundary: "one microsecond after notice", instant: "2099-10-14T10:00:00.000001+00:00", ordinary: false, staff: true },
  { boundary: "one microsecond before start", instant: "2099-10-15T09:59:59.999999+00:00", ordinary: false, staff: true },
  { boundary: "exact booking start", instant: "2099-10-15T10:00:00+00:00", ordinary: false, staff: false },
  { boundary: "one microsecond after start", instant: "2099-10-15T10:00:00.000001+00:00", ordinary: false, staff: false },
];
test.each(["ordinary", "coach", "admin"].flatMap(role => rescheduleBoundaries.map(b => ({ ...b, role }))))(
  "$role reschedule at $boundary preserves eligibility before target availability", async ({ role, instant, ordinary, staff }) => {
    const f = await seed(600, true), input = await edit(f);
    await expectContractOccupancy(f, 600, 1440);
    await database.query("DELETE FROM public.user_roles WHERE user_id=$1", [actorId]);
    if (role !== "ordinary") await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,$2)", [actorId, role]);
    const before = await rescheduleEvidence(f);
    const availability = vi.spyOn(clubs, "listCheckoutLocationCourts");
    vi.spyOn(reservations, "readReservationClockTime").mockResolvedValue(instant);
    const allowed = role === "ordinary" ? ordinary : staff;
    expect(await save(input)).toEqual(allowed ? { ok: true, totalAmountMinor: 5000 }
      : { ok: false, message: "The rescheduling window for this booking has closed." });
    if (allowed) {
      const after = await rescheduleEvidence(f);
      expect(after.booking?.revision).toMatchObject({ bookingDate: date, startMinute: 720, endMinute: 780,
        courtId: secondCourtId, previousRevisionId: before.booking?.current_revision_id,
        actorScope: role === "ordinary" ? "customer" : role === "coach" ? "coach_owner" : "admin_owner" });
      expect(after.reservation).toMatchObject({ booking_date: date, starts_at_minute: 720, ends_at_minute: 780, court_id: secondCourtId });
      expect(after.revisions).toHaveLength(2);
      expect(after.attempts).toEqual(before.attempts);
      expect(after.refunds).toEqual(before.refunds);
      expect(after.providerEvents).toEqual(before.providerEvents);
    } else {
      expect(availability).not.toHaveBeenCalled();
      expect(await rescheduleEvidence(f)).toEqual(before);
    }
  });

test.each([
  { boundary: "one microsecond before", instant: "2099-10-15T11:59:59.999999+00:00", allowed: true },
  { boundary: "exactly at", instant: "2099-10-15T12:00:00+00:00", allowed: false },
  { boundary: "one microsecond after", instant: "2099-10-15T12:00:00.000001+00:00", allowed: false },
])("eligible original reschedule $boundary target start", async ({ instant, allowed }) => {
  const f = await seed(900, true, false, { date, notice: 0 }), input = await edit(f);
  await expectContractOccupancy(f, 900, 0);
  await database.query("DELETE FROM public.user_roles WHERE user_id=$1", [actorId]);
  const before = await rescheduleEvidence(f);
  vi.spyOn(reservations, "readReservationClockTime").mockResolvedValue(instant);
  expect(await save(input)).toEqual(allowed ? { ok: true, totalAmountMinor: 5000 }
    : { ok: false, message: "This booking or interval is no longer available to reschedule." });
  if (!allowed) expect(await rescheduleEvidence(f)).toEqual(before);
});

test("eligible original rejects occupied target without changing contract, occupancy or financial evidence", async () => {
  const f = await seed(900, true, false, { date, notice: 0 }), input = await edit(f);
  await expectContractOccupancy(f, 900, 0);
  await database.query("DELETE FROM public.user_roles WHERE user_id=$1", [actorId]);
  const targetId = randomUUID();
  await database.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute)
    VALUES($1,$2,$3,720,780)`, [targetId, secondCourtId, date]);
  const before = await rescheduleEvidence(f);
  const targetBefore = await database.query("SELECT * FROM public.court_reservations WHERE id=$1", [targetId]);
  vi.spyOn(reservations, "readReservationClockTime").mockResolvedValue("2099-10-15T11:59:59.999999+00:00");
  const write = vi.spyOn(reservations, "updateCustomerReservationSchedule");
  expect(await save(input)).toEqual({ ok: false, message: "That court is no longer available. The booking has not changed." });
  expect(write).not.toHaveBeenCalled();
  expect(await rescheduleEvidence(f)).toEqual(before);
  expect(await database.query("SELECT * FROM public.court_reservations WHERE id=$1", [targetId])).toEqual(targetBefore);
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
  const start = kind === "target" ? 900 : 600, notice = kind === "target" ? 0 : 1440;
  const f=await seed(start, true, false, { date, notice });
  await expectContractOccupancy(f, start, notice);
  const before = await rescheduleEvidence(f);
  await database.query("DELETE FROM public.user_roles WHERE user_id=$1",[actorId]);
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
    expect(await rescheduleEvidence(f)).toEqual(before);
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
  const locked=deferred(), release=deferred(); let blocker=0; const original=bookings.findBookingForUpdate;
  vi.spyOn(bookings,"findBookingForUpdate").mockImplementationOnce(async (...args) => {
    const row=await original(...args); blocker=await pid(args[0]); locked.resolve(); await release.promise; return row;
  });
  const a=processOnlinePaymentEvent(success); await locked.promise; const b=processOnlinePaymentEvent(other);
  try { await waitForBlock(blocker); } finally { release.resolve(); }
  expect(await Promise.all([a,b])).toEqual(["succeeded","succeeded"]);
  const result=await settlementState(f);
  expect(result.aggregate).toMatchObject({booking:{status:"confirmed"},reservation:{status:"active"},events:[{subject:"Booking confirmed"}]});
  expect(result.receipts).toHaveLength(2);
});

test.each(["currency", "outcome"])("changed duplicate %s evidence rejects without changing any persisted state", async field => {
  const f=await seed(600,false,true), event=paymentEvent(f);
  expect(await processOnlinePaymentEvent(event)).toBe("succeeded"); const before=await settlementState(f);
  const changed={...event,...(field === "amount" ? {amountMinor:1} : field === "currency" ? {currency:"EUR"} : {outcome:"cancelled" as const})};
  await expect(processOnlinePaymentEvent(changed)).rejects.toThrow(
    field === "currency" ? "Changed provider capture evidence." : "Changed payment event evidence.");
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
    expect((await settlementState(f)).aggregate).toMatchObject({booking:{status:"expired"},reservation:{status:"released"},events:[expect.objectContaining({subject:"Payment received after checkout ended"})]});
    const replacement=await seed(600,false,true), before=await settlementState(replacement);
    expect(await processOnlinePaymentEvent(paymentEvent(f))).toBe("expired"); expect(await settlementState(replacement)).toEqual(before);
  } finally { if (blocker.isTransactionActive) await blocker.rollbackTransaction(); if (settlement) await Promise.allSettled([settlement]); await blocker.release(); }
});

test.each(["expiry"])("%s first serializes hold cleanup and application replacement insertion without deadlock", async first => {
  const f=await seed(600,false,true), locked=deferred(), release=deferred();
  if (first === "settlement") {
    const original=bookings.findBookingForUpdate;
    vi.spyOn(bookings,"findBookingForUpdate").mockImplementationOnce(async (...args)=>{
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
    // The customer is told once that the late payment is being refunded.
    expect((await state(f)).events).toEqual([expect.objectContaining({subject:"Payment received after checkout ended"})]);
  }
});

test.each(["reschedule"])("receipt-bearing settlement waits for Phase 6 %s and preserves original financial authority", async kind => {
  const f=await seed(600,true), input=await edit(f);
  const [mutation,result]=await serialize<unknown,string>(()=>kind === "cancel" ? cancel(f) : save({...input,expectedTotal:5000}),
    ()=>processOnlinePaymentEvent(paymentEvent(f)));
  expect(mutation).toMatchObject(kind === "cancel" ? {outcome:"cancelled"} : {ok:true}); expect(result).toBe("succeeded");
  const before=await state(f);
  await appendBookingContractFixture(f.id, { total_amount_minor: 7000 });
  expect(await processOnlinePaymentEvent(paymentEvent(f))).toBe("succeeded");
  await expect(processOnlinePaymentEvent({...paymentEvent(f),amountMinor:7000})).rejects.toThrow("Changed provider capture evidence");
  expect((await state(f)).reservation).toEqual(before.reservation);
  expect((await state(f)).events).toEqual(before.events);
  expect(await database.query("SELECT amount_minor,currency,status FROM public.payment_attempts WHERE id=$1",[f.attemptId]))
    .toEqual([{amount_minor:5000,currency:"RON",status:"succeeded"}]);
});

test("deadline crossed after policy read is fenced at the lifecycle write and re-evaluated as expiry", async () => {
  const f=await seed(600,false,true);
  await database.transaction(async manager => {
    const [{ expires_at }]: { expires_at: string }[] = await manager.query("SELECT (clock_timestamp()+interval '150 milliseconds')::text AS expires_at");
    await setPaymentAttemptExpiryFixture(manager, f.attemptId, expires_at);
  });
  const original=payments.updateSettlementAttempt;
  vi.spyOn(payments,"updateSettlementAttempt").mockImplementationOnce(async (...args)=>{
    // The application already decided success. Advance the actual database
    // clock past the attempt deadline before executing its conditional UPDATE.
    while (!(await args[0].query("SELECT clock_timestamp()>=expires_at AS elapsed FROM public.payment_attempts WHERE id=$1",[f.attemptId]))[0].elapsed)
      await new Promise(resolve=>setTimeout(resolve,5));
    return original(...args);
  });
  expect(await processOnlinePaymentEvent(paymentEvent(f))).toBe("expired");
  expect(await settlementState(f)).toMatchObject({aggregate:{booking:{status:"expired"},reservation:{status:"released",hold_expires_at:null},events:[expect.objectContaining({subject:"Payment received after checkout ended"})]},
    attempts:[{status:"expired"}],receipts:[{settlement_result:"expired",reconciliation_required:true}]});
});

test("webhook identity requires the attached provider reference and ignores unrelated attempt evidence", async () => {
  const f=await seed(600,false,true,undefined,actorId,false);
  await database.query("UPDATE public.payment_attempts SET provider_payment_id=$2 WHERE id=$1",[f.attemptId,`pi-${f.attemptId}`]);
  const before=await settlementState(f);
  expect(await processOnlinePaymentEvent({...paymentEvent(f),providerPaymentId:"wrong-reference"})).toBe("unavailable");
  expect(await processOnlinePaymentEvent({...paymentEvent(f),attemptId:randomUUID()})).toBe("unavailable");
  expect(await settlementState(f)).toEqual(before);
  const other=await seed(720,false,true,undefined,actorId,false), unattached=await settlementState(other);
  expect(await processOnlinePaymentEvent(paymentEvent(other))).toBe("unavailable"); expect(await settlementState(other)).toEqual(unattached);
  await expect(settleOnlinePayment({attemptId:other.attemptId,provider:"stripe",providerPaymentId:`pi-${other.attemptId}`,outcome:"succeeded"}))
    .rejects.toThrow("verified capture evidence");
  expect((await settlementState(other)).receipts).toEqual([]);
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
    expect(await settlementState(f)).toMatchObject({aggregate:{booking:{status:"expired"},reservation:{status:"released"},events:[expect.objectContaining({subject:"Payment received after checkout ended"})]},
      receipts:[{settlement_result:"expired",reconciliation_required:true}]});
  } finally { if (expiry.isTransactionActive) await expiry.rollbackTransaction(); if (settlement) await Promise.allSettled([settlement]); await expiry.release(); }
});

async function refundFixture() {
  const f=await seed(600,true), result=await cancel(f);
  if (result.outcome !== "cancellation_pending" || !result.refundIds[0]) throw new Error("Missing refund");
  await database.query("UPDATE public.payment_refunds SET status='pending_retry' WHERE id=$1",[result.refundIds[0]]);
  return {...f, refundId:result.refundIds[0]};
}
async function claimRefund(id:string): Promise<RefundExecutionClaim> {
  const prepared=await prepareRefund(id);
  if (prepared.outcome!=="ready") throw new Error(`Unexpected ${prepared.outcome}`);
  await initiateRefundExecution(prepared.claim);
  return prepared.claim;
}
const successResult={kind:"verified" as const,status:"succeeded" as const,providerRefundId:"re-phase8"};

test("concurrent refund claims share one execution; takeover retains microsecond precision and stale facts", async () => {
  const f=await refundFixture();
  const results=await Promise.all([prepareRefund(f.refundId),prepareRefund(f.refundId)]);
  expect(results.map(r=>r.outcome).sort()).toEqual(["busy","ready"]);
  const ready=results.find(r=>r.outcome==="ready"); if (ready?.outcome!=="ready") throw new Error("Missing lease");
  const claim=ready.claim;
  await initiateRefundExecution(claim);
  await database.query("UPDATE public.refund_executions SET lease_until='2099-01-01T00:00:00.123456Z' WHERE id=$1",[claim.execution.id]);
  expect(await database.query("SELECT lease_until AT TIME ZONE 'UTC' = timestamp '2099-01-01 00:00:00.123456' AS precise FROM public.refund_executions WHERE id=$1",[claim.execution.id])).toEqual([{precise:true}]);
  expect(await prepareRefund(f.refundId)).toMatchObject({outcome:"busy"});
  await database.query("UPDATE public.refund_executions SET lease_until=clock_timestamp()-interval '1 microsecond' WHERE id=$1",[claim.execution.id]);
  const replacement=await claimRefund(f.refundId);
  expect(replacement.execution.id).toBe(claim.execution.id); expect(replacement.token).not.toBe(claim.token);
  await inTransaction(manager=>refundExecutions.recordRefundExecutionCheck(manager,{refundId:f.refundId,executionId:claim.execution.id,
    token:replacement.token,checkedAt:new Date(),lastError:"current_worker",releaseLease:false}));
  expect(await commitRefundExecution(claim,successResult)).toMatchObject({status:"succeeded",notice:null});
  expect((await refundExecutions.listRefundExecutions(database.manager,f.refundId))[0]).toMatchObject({
    leaseToken:replacement.token,lastError:"current_worker",terminalResult:"succeeded",providerRefundId:"re-phase8"});
  expect(await commitRefundExecution(replacement,successResult)).toMatchObject({status:"succeeded",notice:null});
  expect((await refundExecutions.listRefundExecutions(database.manager,f.refundId))[0].leaseToken).toBeNull();
  expect(await prepareRefund(f.refundId)).toMatchObject({outcome:"terminal",status:"succeeded",notice:null});
});

test("automatic preparation is independent of Admin roles and attributes no manual initiator", async () => {
  const f=await refundFixture(),blocker=await runner(); let preparing: ReturnType<typeof prepareRefund> | undefined;
  try {
    await bookings.findBookingForUpdate(blocker.manager,f.id);
    preparing=prepareRefund(f.refundId);
    await waitForBlock(await pid(blocker.manager));
    await database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code='admin'",[actorId]);
    await blocker.commitTransaction();
    const result=await preparing;
    if(result.outcome!=="ready") throw new Error("Missing automatic claim");
    expect(result.claim.actorId).toBeNull();
    expect(result.claim.execution.initiatedByUserId).toBeNull();
    expect(await refundExecutions.listRefundExecutions(database.manager,f.refundId)).toHaveLength(1);
  } finally { if (blocker.isTransactionActive) await blocker.rollbackTransaction(); if (preparing) await Promise.allSettled([preparing]); await blocker.release(); }
});

test("an automatic claim blocks another worker from issuing a competing operation", async () => {
  const f=await refundFixture(),claim=await claimRefund(f.refundId);
  expect(await prepareRefund(f.refundId)).toMatchObject({outcome:"busy"});
  expect(await commitRefundExecution(claim,successResult)).toMatchObject({status:"succeeded",notice:null});
  const before=await state(f);
  expect(await prepareRefund(f.refundId)).toMatchObject({outcome:"terminal",status:"succeeded",notice:null});
  expect((await state(f)).refunds).toEqual(before.refunds);
  expect(await refundExecutions.listRefundExecutions(database.manager,f.refundId)).toHaveLength(1);
});

test("completion rejects conflicting established provider identity without rewriting history", async () => {
  const f=await refundFixture(),claim=await claimRefund(f.refundId);
  await commitRefundExecution(claim,successResult);
  const before=await state(f),history=await refundExecutions.listRefundExecutions(database.manager,f.refundId);
  await expect(commitRefundExecution(claim,{...successResult,providerRefundId:"re-conflict"})).rejects.toThrow("Conflicting provider refund identity");
  expect(await state(f)).toEqual(before);
  expect(await refundExecutions.listRefundExecutions(database.manager,f.refundId)).toEqual(history);
});

async function lateRefundFixture() {
  const f=await seed(600,false,true);
  await settleOnlinePayment({attemptId:f.attemptId,provider:"stripe",providerPaymentId:`pi-${f.attemptId}`,outcome:"cancelled"});
  const eventId=`phase8-${randomUUID()}`;
  const evidence={provider:"stripe" as const,eventId,attemptId:f.attemptId,providerPaymentId:`pi-${f.attemptId}`,outcome:"succeeded" as const,amountMinor:5000,currency:"RON"};
  await processOnlinePaymentEvent(evidence);
  return {...f,eventId,evidence};
}

test("receipt-resolution failure rolls back execution success, obligation status and lease clearing together", async () => {
  // The compensation obligation commits atomically with the late capture receipt.
  const f=await lateRefundFixture(),refundId=(await payments.findCheckoutRefund(database.manager,f.attemptId))?.id;
  if (!refundId) throw new Error("Missing compensation refund");
  const prepared=await prepareRefund(refundId);
  if (prepared.outcome!=="ready") throw new Error("Missing claim");
  await initiateRefundExecution(prepared.claim);
  const before=await state(f),history=await refundExecutions.listRefundExecutions(database.manager,prepared.claim.refund.id);
  const events=await database.query("SELECT * FROM public.payment_provider_events WHERE attempt_id=$1",[f.attemptId]);
  const original=payments.writeRefundEventResolution;
  const injection=vi.spyOn(payments,"writeRefundEventResolution").mockImplementationOnce(async (...args)=>{
    await original(...args);
    await original(args[0],[{provider:"stripe",event_id:"missing-evidence"}],args[2],args[3]);
  });
  await expect(commitRefundExecution(prepared.claim,successResult)).rejects.toThrow(); injection.mockRestore();
  expect(await state(f)).toEqual(before);
  expect(await refundExecutions.listRefundExecutions(database.manager,prepared.claim.refund.id)).toEqual(history);
  expect(await database.query("SELECT * FROM public.payment_provider_events WHERE attempt_id=$1",[f.attemptId])).toEqual(events);
  expect(await commitRefundExecution(prepared.claim,successResult)).toMatchObject({status:"succeeded",notice:null});
  const resolved=await database.query("SELECT * FROM public.payment_provider_events WHERE attempt_id=$1",[f.attemptId]);
  expect(await prepareRefund(refundId)).toMatchObject({outcome:"terminal",status:"succeeded"});
  expect(await database.query("SELECT * FROM public.payment_provider_events WHERE attempt_id=$1",[f.attemptId])).toEqual(resolved);
});

test("lease eligibility uses database wall time after aggregate-lock wait", async () => {
  const f=await refundFixture(),old=await claimRefund(f.refundId);
  await database.query("UPDATE public.refund_executions SET lease_until=clock_timestamp()+interval '250 milliseconds' WHERE id=$1",[old.execution.id]);
  const blocker=await runner(); let preparing: ReturnType<typeof prepareRefund> | undefined;
  try {
    await bookings.findBookingForUpdate(blocker.manager,f.id);
    preparing=prepareRefund(f.refundId);
    await waitForBlock(await pid(blocker.manager));
    const deadline=Date.now()+3000;
    while (!(await database.query("SELECT lease_until <= clock_timestamp() AS reclaimable FROM public.refund_executions WHERE id=$1",[old.execution.id]))[0].reclaimable) {
      if(Date.now()>deadline) throw new Error("Lease did not expire"); await new Promise(done=>setTimeout(done,10));
    }
    await blocker.commitTransaction(); const result=await preparing;
    if(result.outcome!=="ready") throw new Error("Missing claim");
    expect(result.claim.execution.id).toBe(old.execution.id);
    expect(await database.query("SELECT lease_until-clock_timestamp() BETWEEN interval '299 seconds' AND interval '300 seconds' AS five_minutes FROM public.refund_executions WHERE id=$1",[old.execution.id])).toEqual([{five_minutes:true}]);
  } finally { if(blocker.isTransactionActive) await blocker.rollbackTransaction(); if(preparing) await Promise.allSettled([preparing]); await blocker.release(); }
});

test.each(["amount", "capture"])("refund preparation and completion reject changed %s evidence", async field => {
  const f=await refundFixture(),claim=await claimRefund(f.refundId),before=await state(f),read=payments.findRefundCaptureEvidence;
  vi.spyOn(payments,"findRefundCaptureEvidence").mockImplementation(async (...args)=>{
    const evidence=await read(...args); if(!evidence.payment) throw new Error("Missing original payment");
    return { payment:{...evidence.payment,...(field==="amount" ? {amount_minor:1}:{})}, events:[],
      captures:field==="capture" ? evidence.captures.map(capture=>({...capture,amountMinor:1})) : evidence.captures };
  });
  const write=vi.spyOn(payments,"writeRefundStatus");
  await expect(prepareRefund(f.refundId)).rejects.toThrow("Refund financial evidence changed");
  await expect(commitRefundExecution(claim,successResult)).rejects.toThrow("Refund financial evidence changed");
  expect(write).not.toHaveBeenCalled();expect(await state(f)).toEqual(before);
});
test("completion fences obligation and execution snapshots and cannot regress verified success", async () => {
  const f=await refundFixture(),claim=await claimRefund(f.refundId);
  await expect(commitRefundExecution({...claim,refund:{...claim.refund,created_at:"2000-01-01T00:00:00.000001+00:00"}},successResult))
    .rejects.toThrow("Refund financial evidence changed");
  await expect(commitRefundExecution({...claim,execution:{...claim.execution,idempotencyKey:"different"}},successResult))
    .rejects.toThrow("Refund execution request changed");
  expect(await commitRefundExecution(claim,successResult)).toMatchObject({status:"succeeded",notice:null});
  const history=await refundExecutions.listRefundExecutions(database.manager,f.refundId);
  expect(await commitRefundExecution(claim,{kind:"error",evidence:{kind:"lookup_failed",operation:"retrieve",providerRefundId:"re-phase8"}})).toMatchObject({status:"succeeded",notice:null});
  await expect(commitRefundExecution(claim,{...successResult,providerRefundId:"re_other"})).rejects.toThrow("Conflicting provider refund identity");
  const latest=await refundExecutions.listRefundExecutions(database.manager,f.refundId);
  expect(latest.map(e=>({result:e.terminalResult,id:e.providerRefundId,completed:e.completedAt})))
    .toEqual(history.map(e=>({result:e.terminalResult,id:e.providerRefundId,completed:e.completedAt})));
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
  await database.query(`INSERT INTO public.payment_capture_receipts
    (payment_attempt_id,provider,provider_payment_id,provider_capture_id,amount_minor,currency)
    VALUES($1,'stripe',$2,$2,5000,'RON')`, [f.attemptId,`pi-${f.attemptId}`]);
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


// Simulated Stripe only; every adjustment, hold, allocation and receipt uses real PostgreSQL.
function simulatedStripe() {
  const outcomes = new Map<string, "pending" | "processing" | "authorized" | "succeeded" | "cancelled">();
  vi.spyOn(stripeAdapter,"createPayment").mockImplementation(async p => {
    outcomes.set(`pi_${p.id}`, "pending");
    return { providerPaymentId: `pi_${p.id}`, presentation: { kind:"stripe",clientSecret:`pi_${p.id}_secret`,publishableKey:"pk_test_Fixture" } };
  });
  vi.spyOn(stripeAdapter,"resumePayment").mockImplementation(async p => ({ kind:"stripe",clientSecret:`${p.providerPaymentId}_secret`,publishableKey:"pk_test_Fixture" }));
  vi.spyOn(stripeAdapter,"readPayment").mockImplementation(async p => {
    const rows: {amount_minor:number}[] = await database.query("SELECT amount_minor FROM public.payment_attempts WHERE id=$1",[p.id]);
    const status=outcomes.get(p.providerPaymentId) ?? "pending";
    return {status,amountMinor:rows[0].amount_minor,currency:"RON",providerCaptureId:status==="succeeded" ? p.providerPaymentId:null,live:status==="processing"};
  });
  vi.spyOn(stripeAdapter,"cancelPayment").mockImplementation(async p => { outcomes.set(p.providerPaymentId,"cancelled"); return "cancelled"; });
  vi.spyOn(stripeAdapter,"dismissPayment").mockImplementation(async p => {
    const status = outcomes.get(p.providerPaymentId) ?? "pending";
    if (status === "processing") return "live";
    if (status === "succeeded") return "succeeded";
    outcomes.set(p.providerPaymentId,"cancelled"); return "cancelled";
  });
  vi.spyOn(stripeAdapter,"refundPayment").mockImplementation(async p => ({ providerRefundId:`re_${p.id}`,status:"succeeded" }));
  return outcomes;
}
// Production holds start with the cutoff as their lease; keep the fixture consistent.
async function expireAdjustmentFixture(id: string, at = "2020-01-01T00:00:00Z") {
  await database.transaction(m => setAdjustmentExpiryFixture(m, id, at));
  await database.query("UPDATE public.court_reservations SET hold_expires_at=$2 WHERE adjustment_id=$1 AND status='held'",[id,at]);
}
async function captureAdjustment(id: string, eventId = randomUUID()) {
  const attempt = await adjustmentAttempt(database.manager,id);
  if (!attempt?.providerPaymentId) throw new Error("Missing adjustment payment");
  return processOnlinePaymentEvent({attemptId:attempt.id,provider:"stripe",providerPaymentId:attempt.providerPaymentId,
    eventId,outcome:"succeeded",amountMinor:attempt.amountMinor,currency:"RON"});
}
test("paid 50 → 75 → 100 → 75 → cancellation preserves all captures and refunds only remaining funds", async () => {
  simulatedStripe();
  const f = await seed(600,false,true);
  expect(await processOnlinePaymentEvent({attemptId:f.attemptId,provider:"stripe",providerPaymentId:`pi-${f.attemptId}`,
    eventId:randomUUID(),outcome:"succeeded",amountMinor:5000,currency:"RON"})).toBe("succeeded");
  const original = await database.query("SELECT * FROM public.payment_attempts WHERE id=$1",[f.attemptId]);
  for (const [end,total] of [[690,7500],[720,10000]]) {
    const count = (await emails(f.id)).length;
    const input = await edit(f,{courtId,startMinute:600,endMinute:end,expectedTotal:total,requestId:randomUUID()});
    const result = await save(input);
    expect(result).toMatchObject({ok:true,adjustmentStatus:"pending",totalAmountMinor:total});
    if (!result.ok || !result.adjustmentId || !result.checkout) throw new Error("No checkout");
    const current = await state(f);
    expect(current.reservation?.ends_at_minute).toBe(end-30);
    const attempt = await adjustmentAttempt(database.manager,result.adjustmentId);
    expect(attempt?.amountMinor).toBe(2500);
    // The extra half-hour is protected before capture.
    await expect(database.query(`INSERT INTO public.court_reservations(court_id,booking_date,starts_at_minute,ends_at_minute)
      VALUES($1,$2,$3,$3+60)`,[courtId,date,end-30])).rejects.toMatchObject({code:"23P01"});
    expect(await save(input)).toMatchObject({ok:true,adjustmentId:result.adjustmentId});
    expect(await emails(f.id)).toHaveLength(count);
    const eventId=randomUUID();
    expect(await captureAdjustment(result.adjustmentId,eventId)).toBe("succeeded");
    expect(await captureAdjustment(result.adjustmentId,eventId)).toBe("succeeded");
    expect(await captureAdjustment(result.adjustmentId)).toBe("succeeded");
    expect(await emails(f.id)).toHaveLength(count + 1);
    expect((await emails(f.id)).at(-1)?.text).toContain(`Booking total: ${(total / 100).toFixed(2)} RON`);
    expect((await emails(f.id)).at(-1)?.text).toContain(`Previous: ${date}, 10:00–${end === 690 ? "11:00" : "11:30"}, Court`);
    expect((await state(f)).booking?.total_amount_minor).toBe(total);
    expect((await state(f)).reservation?.ends_at_minute).toBe(end);
  }
  const cheaper = await save(await edit(f,{courtId,startMinute:600,endMinute:690,expectedTotal:7500,requestId:randomUUID()}));
  expect(cheaper).toMatchObject({ok:true,adjustmentStatus:"applied",refundStatus:"succeeded"});
  expect(await database.query("SELECT * FROM public.payment_attempts WHERE id=$1",[f.attemptId])).toEqual(original);
  let facts = await bookingFinancials(database.manager,f.id);
  expect(facts).toMatchObject({captured:10000,refunded:2500,netPaid:7500,refundable:7500});
  const cancelled=await completeCancellation(f);
  expect(cancelled.outcome).toBe("cancelled");
  facts=await bookingFinancials(database.manager,f.id);
  expect(facts.obligated).toBe(10000);
  const history=await database.query("SELECT id,previous_revision_id,revision_number,kind,total_amount_minor,starts_at_minute,ends_at_minute,customer_email FROM public.booking_revisions WHERE booking_id=$1 ORDER BY revision_number",[f.id]);
  expect(history.map((r: {revision_number:number;kind:string;total_amount_minor:number;ends_at_minute:number})=>[r.revision_number,r.kind,r.total_amount_minor,r.ends_at_minute]))
    .toEqual([[1,"created",5000,660],[2,"confirmed",5000,660],[3,"rescheduled",7500,690],[4,"rescheduled",10000,720],[5,"rescheduled",7500,690],[6,"cancelled",7500,690]]);
  expect(history[0].previous_revision_id).toBeNull();
  for(let i=1;i<history.length;i++) expect(history[i].previous_revision_id).toBe(history[i-1].id);
  expect((await state(f)).booking?.current_revision_id).toBe(history[5].id);
  expect(facts.refunds.filter(r => r.reason === "booking_price_reduction")).toEqual([
    expect.objectContaining({ contextRevisionId: history[3].id, adjustmentId: cheaper.ok ? cheaper.adjustmentId : null }),
  ]);
  for (const refund of facts.refunds.filter(r => r.reason === "booking_cancellation"))
    expect(refund).toMatchObject({ reason: "booking_cancellation", contextRevisionId: history[4].id });
  expect((await state(f)).reservation).toMatchObject({starts_at_minute:600,ends_at_minute:690,status:"cancelled"});
  expect(await cancel(f)).toMatchObject({outcome:"cancelled"});
  expect((await emails(f.id)).map(e => e.subject)).toEqual(["Booking confirmed", "Booking rescheduled", "Booking rescheduled",
    "Booking rescheduled", "Booking cancelled"]);
  expect(await database.query("SELECT count(*)::integer AS count FROM public.booking_revisions WHERE booking_id=$1",[f.id])).toEqual([{count:6}]);

  for(const p of facts.captures) expect(facts.refunds.filter(r=>r.paymentAttemptId===p.id).reduce((n,r)=>n+r.amountMinor,0)).toBeLessThanOrEqual(p.amountMinor);
});

test.each(["cancelled","expired","conflict","price","suspended"])("unapplied surcharge %s preserves original and compensates late capture", async mode => {
  simulatedStripe();
  const f=await seed(600,true), before=await state(f);
  const result=await save(await edit(f,{courtId,startMinute:600,endMinute:690,expectedTotal:7500,requestId:randomUUID()}));
  if(!result.ok || !result.adjustmentId || !result.checkout) throw new Error("No pending adjustment");
  if(mode==="cancelled") await dismissAdjustment(result.adjustmentId);
  if(mode==="expired") await database.transaction(m => setAdjustmentExpiryFixture(m, result.adjustmentId!, "2020-01-01"));
  if(mode==="conflict") {
    await database.query("UPDATE public.court_reservations SET status='released',hold_expires_at=NULL WHERE adjustment_id=$1",[result.adjustmentId]);
    await database.query("INSERT INTO public.court_reservations(court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,$2,660,720)",[courtId,date]);
  }
  if(mode==="price") await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=6000 WHERE court_id=$1 AND court_state='outdoor'",[courtId]);
  if(mode==="suspended") await database.query("UPDATE public.users SET status='suspended' WHERE id=$1",[actorId]);
  expect(await captureAdjustment(result.adjustmentId)).toBe("expired");
  const after=await state(f);
  expect(after.booking).toEqual(before.booking); expect(after.reservation).toEqual(before.reservation);
  expect(await emails(f.id)).toMatchObject([{ subject: "Booking change not completed",
    text: expect.stringContaining("additional payment you made for this change is being refunded") }]);
  expect(await bookingFinancials(database.manager,f.id)).toMatchObject({captured:7500,refunded:2500,netPaid:5000});
  expect((await bookingFinancials(database.manager, f.id)).refunds).toEqual([
    expect.objectContaining({ reason: "failed_adjustment_compensation", contextRevisionId: before.booking!.current_revision_id,
      adjustmentId: result.adjustmentId, paymentAttemptId: result.checkout.attemptId }),
  ]);
  await captureAdjustment(result.adjustmentId);
  expect((await bookingFinancials(database.manager,f.id)).refunds).toHaveLength(1);
});

test("partial refund uncertainty is durable and a later refund check succeeds without allocating duplicate money", async () => {
  simulatedStripe();
  const f=await seed(600,true);
  await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=3000 WHERE court_id=$1 AND court_state='outdoor'",[secondCourtId]);
  vi.mocked(stripeAdapter.refundPayment).mockRejectedValueOnce(new Error("Network uncertainty"));
  const result=await save(await edit(f,{expectedTotal:3000,requestId:randomUUID()}));
  expect(result).toMatchObject({ok:true,adjustmentStatus:"pending",refundStatus:"pending_retry"});
  if(!result.ok || !result.refundIds?.[0]) throw new Error("No refund obligation");
  expect(await bookingFinancials(database.manager,f.id)).toMatchObject({captured:5000,refunded:0,obligated:2000,refundable:3000});
  // A later Stripe refund webhook (or Admin check) replays the unconfirmed request.
  expect(await refundProcessing.processBookingRefund(result.refundIds[0])).toBe("succeeded");
  expect(await bookingFinancials(database.manager,f.id)).toMatchObject({refunded:2000,netPaid:3000});
  await cancel(f); expect((await bookingFinancials(database.manager,f.id)).obligated).toBe(5000);
});

test("an exact replay returns the same modification; a new request discards the unpaid one and its intent", async () => {
  const outcomes=simulatedStripe(); const f=await seed(600,true);
  const input=await edit(f,{courtId,startMinute:600,endMinute:690,expectedTotal:7500,requestId:randomUUID()});
  const first=await save(input); if(!first.ok || !first.adjustmentId || !first.checkout) throw new Error("No adjustment");
  expect(await save(input)).toMatchObject({ok:true,adjustmentId:first.adjustmentId,adjustmentStatus:"pending"});
  const fresh=await save({...input,requestId:randomUUID()}); if(!fresh.ok || !fresh.adjustmentId) throw new Error("No fresh adjustment");
  expect(fresh).toMatchObject({adjustmentStatus:"pending"}); expect(fresh.adjustmentId).not.toBe(first.adjustmentId);
  expect((await findAdjustment(database.manager,first.adjustmentId))?.status).toBe("cancelled");
  expect((await adjustmentAttempt(database.manager,first.adjustmentId))?.status).toBe("cancelled");
  expect(outcomes.get(`pi_${first.checkout.attemptId}`)).toBe("cancelled");
  expect(await database.query("SELECT status FROM public.court_reservations WHERE adjustment_id=$1",[first.adjustmentId])).toEqual([{status:"released"}]);
  await expect(readOnlineCheckout({attemptId:first.checkout.attemptId,token:first.checkout.token})).rejects.toThrow();
  // A capture of the discarded intent is compensated, never applied.
  expect(await captureAdjustment(first.adjustmentId)).toBe("expired");
  expect((await state(f)).reservation?.ends_at_minute).toBe(660);
  expect((await bookingFinancials(database.manager,f.id)).refunds).toEqual([expect.objectContaining({adjustmentId:first.adjustmentId,amountMinor:2500})]);
});


test("definitively failed partial refund is not replaced without affirmative retryable evidence", async () => {
  simulatedStripe(); const f=await seed(600,true);
  await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=3000 WHERE court_id=$1 AND court_state='outdoor'",[secondCourtId]);
  vi.mocked(stripeAdapter.refundPayment).mockResolvedValueOnce({providerRefundId:"re_definitively_failed",status:"failed"});
  const result=await save(await edit(f,{expectedTotal:3000,requestId:randomUUID()}));
  expect(result).toMatchObject({ok:true,refundStatus:"failed"});
  if(!result.ok || !result.refundIds?.[0]) throw new Error("Missing refund");
  const before=await refundExecutions.listRefundExecutions(database.manager,result.refundIds[0]);
  expect(await prepareRefund(result.refundIds[0])).toMatchObject({outcome:"terminal",status:"voided"});
  expect(await refundExecutions.listRefundExecutions(database.manager,result.refundIds[0])).toEqual(before);
  expect(before).toMatchObject([{executionNumber:1,terminalResult:"failed",providerRefundId:"re_definitively_failed"}]);
  expect(await bookingFinancials(database.manager,f.id)).toMatchObject({refunded:0});
});


test("retryable payment failure and an unknown provider outcome preserve original occupancy", async () => {
  simulatedStripe(); const f=await seed(600,true),original=await state(f);
  const result=await save(await edit(f,{courtId,startMinute:600,endMinute:690,expectedTotal:7500,requestId:randomUUID()}));
  if(!result.ok || !result.adjustmentId || !result.checkout) throw new Error("Missing surcharge");
  const attempt=await adjustmentAttempt(database.manager,result.adjustmentId); if(!attempt?.providerPaymentId) throw new Error("Missing payment");
  expect(await processOnlinePaymentEvent({attemptId:attempt.id,provider:"stripe",providerPaymentId:attempt.providerPaymentId,
    outcome:"retryable_failed",eventId:randomUUID(),amountMinor:2500,currency:"RON"})).toBe("pending");
  expect((await state(f)).booking).toEqual(original.booking); expect((await state(f)).reservation).toEqual(original.reservation);
  vi.mocked(stripeAdapter.readPayment).mockRejectedValueOnce(new Error("Timeout"));
  expect(await readOnlineCheckout({attemptId:result.checkout.attemptId,token:result.checkout.token})).toMatchObject({status:"pending_payment",paymentStatus:"unknown",paymentUncertain:true});
  expect((await bookingFinancials(database.manager,f.id)).captured).toBe(5000);
});

test("uncertain dismissal never resurrects the modification; expiry releases it and a late capture is refunded", async () => {
  simulatedStripe(); const f=await seed(600,true),original=await state(f);
  const result=await save(await edit(f,{courtId,startMinute:600,endMinute:690,expectedTotal:7500,requestId:randomUUID()}));
  if(!result.ok || !result.adjustmentId || !result.checkout) throw new Error("Missing surcharge");
  vi.mocked(stripeAdapter.dismissPayment).mockRejectedValue(new Error("Unknown dismissal"));
  await dismissAdjustment(result.adjustmentId);
  await expect(readOnlineCheckout({attemptId:result.checkout.attemptId,token:result.checkout.token})).rejects.toThrow();
  const context=await readCustomerBookingEditContext(f.id,date,actorId);
  expect(context).not.toHaveProperty("pending_adjustment_id");
  expect(await listBookingsWithLivePayment(database.manager,[f.id])).toEqual(new Set());
  await expireAdjustmentFixture(result.adjustmentId);
  await readAdjustmentStatus(database.manager,result.adjustmentId);
  expect((await adjustmentAttempt(database.manager,result.adjustmentId))?.status).toBe("expired");
  expect(await database.query("SELECT status FROM public.court_reservations WHERE adjustment_id=$1",[result.adjustmentId])).toEqual([{status:"released"}]);
  expect(await captureAdjustment(result.adjustmentId)).toBe("expired");
  expect((await state(f)).booking).toEqual(original.booking); expect((await state(f)).reservation).toEqual(original.reservation);
  expect(await bookingFinancials(database.manager,f.id)).toMatchObject({netPaid:5000,refunded:2500});
});

test.each(["coach","admin"] as const)("%s can modify only their own booking", async role => {
  simulatedStripe(); const f=await seed(600,true);
  if(role==="coach") await database.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code='admin'",[actorId]);
  const result=await save(await edit(f,{courtId,startMinute:600,endMinute:690,expectedTotal:7500,requestId:randomUUID()}));
  if(!result.ok || !result.adjustmentId) throw new Error("Missing adjustment");
  expect(await captureAdjustment(result.adjustmentId)).toBe("succeeded");
  expect((await state(f)).booking?.revision.actorScope).toBe(role==="coach" ? "coach_owner" : "admin_owner");
  const guest = await seed(840, true, false, undefined, null);
  await expect(readCustomerBookingEditContext(guest.id,date,actorId)).rejects.toThrow();
});

test("expiry crossing the final SQL write rolls back the move and durably compensates the capture", async () => {
  simulatedStripe(); const f=await seed(600,true),original=await state(f);
  const result=await save(await edit(f,{courtId,startMinute:600,endMinute:690,expectedTotal:7500,requestId:randomUUID()}));
  if(!result.ok || !result.adjustmentId) throw new Error("Missing adjustment");
  await database.transaction(m => setAdjustmentExpiryFixture(m, result.adjustmentId!, new Date(Date.now()+100).toISOString()));
  const write=revisions.advanceRevision;
  vi.spyOn(revisions,"advanceRevision").mockImplementationOnce(async (...args)=>{ await database.query("SELECT pg_sleep(0.2)"); return write(...args); });
  expect(await captureAdjustment(result.adjustmentId)).toBe("expired");
  expect((await state(f)).booking).toEqual(original.booking); expect((await state(f)).reservation).toEqual(original.reservation);
  expect(await bookingFinancials(database.manager,f.id)).toMatchObject({netPaid:5000,refunded:2500});
});


test("initial checkout capability cannot cancel a managed adjustment or override an Admin cancellation", async () => {
  simulatedStripe(); const f=await seed(600,false,true,undefined,actorId,false);
  const initial=await startOnlineCheckout(f.attemptId);
  await processOnlinePaymentEvent({attemptId:f.attemptId,provider:"stripe",providerPaymentId:`pi_${f.attemptId}`,
    eventId:randomUUID(),outcome:"succeeded",amountMinor:5000,currency:"RON"});
  const result=await save(await edit(f,{courtId,startMinute:600,endMinute:690,expectedTotal:7500,requestId:randomUUID()}));
  if(!result.ok || !result.checkout) throw new Error("Missing adjustment");
  await expect(abandonOnlineCheckout({attemptId:initial.attemptId,token:initial.token})).rejects.toThrow("booking management");
  expect((await state(f)).booking?.status).toBe("confirmed");
  await expect(abandonOnlineCheckout({attemptId:result.checkout.attemptId,token:result.checkout.token})).rejects.toThrow("booking management");
  await dismissAdjustment(result.adjustmentId!);
  expect((await completeCancellation(f,"admin")).outcome).toBe("cancelled");
  await expect(abandonOnlineCheckout({attemptId:initial.attemptId,token:initial.token})).rejects.toThrow("booking management");
  expect((await bookingFinancials(database.manager,f.id)).refunds).toEqual([expect.objectContaining({ amountMinor:5000 })]);
});

test("Admin ledger projects 50 + 25 - 25 as three financial identities with 50 net collected", async () => {
  simulatedStripe();
  const f = await seed(600, true);
  const result = await save(await edit(f, { courtId, startMinute: 600, endMinute: 690, expectedTotal: 7500, requestId: randomUUID() }));
  if (!result.ok || !result.adjustmentId) throw new Error("Missing surcharge");
  expect(await captureAdjustment(result.adjustmentId)).toBe("succeeded");
  expect(await save(await edit(f, { courtId, startMinute: 600, endMinute: 660, expectedTotal: 5000, requestId: randomUUID() })))
    .toMatchObject({ ok: true, refundStatus: "succeeded" });
  expect(await bookingFinancials(database.manager, f.id)).toMatchObject({ captured: 7500, refunded: 2500, netPaid: 5000 });
  const allocation = await bookingFinancials(database.manager, f.id);
  expect(allocation.refunds[0]).toMatchObject({ paymentAttemptId: (await adjustmentAttempt(database.manager, result.adjustmentId))?.id, amountMinor: 2500, capturedAmountMinor: 2500 });
  const query = { page: 1, status: "all", provider: "all", method: "all", attention: false, search: "", sort: "date", direction: "asc",
    bookingId: f.id, attentionRefundStatuses: ["pending_retry", "failed"] };
  const schema = z.object({ total: z.number(), rows: z.array(z.object({ transaction_kind: z.enum(["payment", "refund", "booking"]),
    transaction_id: z.uuid(), payment_attempt_id: z.uuid(), amount_minor: z.number(), operation_label: z.string(),
    refunded_minor: z.number(), transaction_status: z.string(), provider_payment_id: z.string(),
    refund: z.object({ provider_refund_id: z.string() }).nullable() })) });
  const ledger = schema.parse(await readFinancialHistory(database.manager, query));
  expect(ledger.total).toBe(3);
  expect(ledger.rows.map(row => [row.operation_label, row.amount_minor])).toEqual([
    ["Booking payment", 5000], ["Modification payment", 2500], ["Price reduction refund", 2500],
  ]);
  expect(new Set(ledger.rows.map(row => row.transaction_id)).size).toBe(3);
  expect(ledger.rows[0]).toMatchObject({ transaction_id: f.attemptId, refunded_minor: 0 });
  expect(ledger.rows[1].refunded_minor).toBe(2500);
  expect(ledger.rows[2].payment_attempt_id).toBe(ledger.rows[1].transaction_id);
  for (const row of ledger.rows) {
    const detail = schema.parse(await readFinancialHistory(database.manager,
      { ...query, transaction: { kind: row.transaction_kind, id: row.transaction_id } }));
    expect(detail.total).toBe(1); expect(detail.rows).toEqual([row]);
  }
});


// Financial commands run under the same booking/location serialization as their
// workflow callers; the allocator itself never owns a transaction.
async function allocateFor(f: Fixture, amount: number, operationKey: string, onlyAttemptId?: string) {
  return inTransaction(async manager => {
    await clubs.lockLocations(manager, [locationId]);
    await bookings.lockCheckoutBooking(manager, f.id);
    return allocateBookingRefund(manager, { bookingId: f.id, amount, operationKey, actorId, onlyAttemptId,
      reason: "late_capture_compensation", contextRevisionId: (await revisions.findInitialRevision(manager, f.id)).id });
  });
}

async function seedAdditionalCapture(f: Fixture) {
  const id = randomUUID();
  await database.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,
    amount_minor,currency,status,expires_at,completed_at,created_at)
    VALUES($1,$2,'online','stripe',$3,2500,'RON','succeeded',clock_timestamp()+interval '10 minutes',
      clock_timestamp(),clock_timestamp()+interval '1 second')`, [id,f.id,`pi-${id}`]);
  await database.query(`INSERT INTO public.payment_capture_receipts
    (payment_attempt_id,provider,provider_payment_id,provider_capture_id,amount_minor,currency)
    VALUES($1,'stripe',$2,$2,2500,'RON')`, [id,`pi-${id}`]);
  return id;
}

test("refund allocation splits a larger obligation newest-first and replays the exact persisted rows", async () => {
  const f = await seed(600,true), additionalId = await seedAdditionalCapture(f);
  const ids = await allocateFor(f,6000,"larger-refund");
  const rows = await database.query("SELECT * FROM public.payment_refunds WHERE booking_id=$1 ORDER BY amount_minor",[f.id]);
  expect(rows).toMatchObject([
    { id: ids[0], payment_attempt_id: additionalId, amount_minor: 2500, captured_amount_minor: 2500 },
    { id: ids[1], payment_attempt_id: f.attemptId, amount_minor: 3500, captured_amount_minor: 5000 },
  ]);
  expect((await allocateFor(f,6000,"larger-refund")).sort()).toEqual([...ids].sort());
  expect(await database.query("SELECT * FROM public.payment_refunds WHERE booking_id=$1 ORDER BY amount_minor",[f.id])).toEqual(rows);
});

test.each(["succeeded","pending","failed"])("previous %s partial obligation reserves funds for allocation and cancellation", async status => {
  const f = await seed(600,true), additionalId = await seedAdditionalCapture(f);
  const [id] = await allocateFor(f,1000,"previous-partial");
  await database.query("UPDATE public.payment_refunds SET status=$2 WHERE id=$1",[id,status]);
  const [nextId] = await allocateFor(f,1500,"next-partial");
  expect(await database.query("SELECT payment_attempt_id,amount_minor FROM public.payment_refunds WHERE id=$1",[nextId]))
    .toEqual([{ payment_attempt_id: additionalId, amount_minor: 1500 }]);
  const cancelled = await cancel(f);
  expect(cancelled.outcome).toBe("cancellation_pending");
  const facts = await bookingFinancials(database.manager,f.id);
  expect(facts).toMatchObject({captured:7500,obligated:7500,refundable:0});
  expect(facts.refunds.find(r=>r.reason === "booking_cancellation")).toMatchObject({paymentAttemptId:f.attemptId,amountMinor:5000});
});

test("concurrent refund allocations serialize capacity and roll back the insufficient command", async () => {
  const f = await seed(600,true);
  const results = await Promise.allSettled([allocateFor(f,3000,"first"),allocateFor(f,3000,"second")]);
  expect(results.filter(r=>r.status === "fulfilled")).toHaveLength(1);
  const failed = results.find(r=>r.status === "rejected");
  expect(failed?.status === "rejected" && failed.reason).toMatchObject({reason:"insufficient_funds"});
  expect(await bookingFinancials(database.manager,f.id)).toMatchObject({captured:5000,obligated:3000,refundable:2000});
});

test("concurrent replay returns one operation identity and never allocates its money twice", async () => {
  const f = await seed(600,true);
  const [first,second] = await Promise.all([allocateFor(f,3000,"same-command"),allocateFor(f,3000,"same-command")]);
  expect(second).toEqual(first);
  expect((await bookingFinancials(database.manager,f.id)).refunds).toHaveLength(1);
});

test("late capture uses matching provider receipt while uncertain or mismatched attempts cannot fund refunds", async () => {
  const f = await seed(600,false,true);
  await expect(allocateFor(f,5000,"uncertain",f.attemptId)).rejects.toMatchObject({reason:"insufficient_funds"});
  await settleOnlinePayment({attemptId:f.attemptId,provider:"stripe",providerPaymentId:`pi-${f.attemptId}`,outcome:"cancelled"});
  await processOnlinePaymentEvent({attemptId:f.attemptId,provider:"stripe",providerPaymentId:`pi-${f.attemptId}`,
    eventId:randomUUID(),outcome:"succeeded",amountMinor:7500,currency:"RON"});
  await expect(allocateFor(f,5000,"mismatch",f.attemptId)).rejects.toMatchObject({reason:"insufficient_funds"});
  await expect(processOnlinePaymentEvent({attemptId:f.attemptId,provider:"stripe",providerPaymentId:`pi-${f.attemptId}`,
    eventId:randomUUID(),outcome:"succeeded",amountMinor:5000,currency:"RON"})).rejects.toThrow("Changed provider capture evidence");
  const exact=await seed(720,false,true);
  await settleOnlinePayment({attemptId:exact.attemptId,provider:"stripe",providerPaymentId:`pi-${exact.attemptId}`,outcome:"cancelled"});
  await processOnlinePaymentEvent({attemptId:exact.attemptId,provider:"stripe",providerPaymentId:`pi-${exact.attemptId}`,
    eventId:randomUUID(),outcome:"succeeded",amountMinor:5000,currency:"RON"});
  // Verified capture already allocates compensation in its settlement commit.
  const [refundId] = await allocateFor(exact,5000,"cancellation",exact.attemptId);
  await expect(allocateFor(exact,5000,"late-capture",exact.attemptId)).rejects.toMatchObject({reason:"insufficient_funds"});
  expect(await database.query("SELECT amount_minor,captured_amount_minor,payment_attempt_id FROM public.payment_refunds WHERE id=$1",[refundId]))
    .toEqual([{amount_minor:5000,captured_amount_minor:5000,payment_attempt_id:exact.attemptId}]);
  expect((await state(exact)).reservation?.status).toBe("released");
});

test("expired checkout capture commits one compensation obligation and retains its pending revision", async () => {
  vi.spyOn(stripeAdapter, "refundPayment").mockImplementation(async refund => ({
    status: "succeeded", providerRefundId: `re-${refund.id}`,
  }));
  const f = await seed(600, false, true);
  const originalRevision = (await state(f)).booking!.revision;
  await database.query("UPDATE public.court_reservations SET hold_expires_at='2020-01-01' WHERE id=$1", [f.reservationId]);
  await expirePaymentHolds();
  const replacement = await seed(600, false, true), replacementBefore = await state(replacement);
  const event = paymentEvent(f);
  expect(await processOnlinePaymentEvent(event)).toBe("expired");
  const accepted = await cancellationEvidence(f);
  expect(accepted.booking).toMatchObject({ status: "expired", current_revision_id: originalRevision.id, revision: originalRevision });
  expect(accepted.reservation).toMatchObject({ status: "released", hold_expires_at: null });
  expect(accepted.revisions).toHaveLength(1);
  expect(accepted.refunds).toEqual([expect.objectContaining({ payment_attempt_id: f.attemptId,
    operation_key: "cancellation", amount_minor: 5000, captured_amount_minor: 5000, status: "succeeded",
    reason: "late_capture_compensation", context_revision_id: originalRevision.id })]);
  expect(accepted.events).toEqual([expect.objectContaining({subject:"Payment received after checkout ended"})]);
  expect(await database.query("SELECT id,status,amount_minor,provider_payment_id FROM public.payment_attempts WHERE id=$1", [f.attemptId]))
    .toEqual([{ id: f.attemptId, status: "expired", amount_minor: 5000, provider_payment_id: event.providerPaymentId }]);
  expect(await database.query("SELECT outcome,amount_minor,currency FROM public.payment_provider_events WHERE event_id=$1", [event.eventId]))
    .toEqual([{ outcome: "succeeded", amount_minor: 5000, currency: "RON" }]);
  expect(await processOnlinePaymentEvent(event)).toBe("expired");
  expect(await processOnlinePaymentEvent(paymentEvent(f))).toBe("expired");
  // Verified provider cancellation resolves the attempt without rewriting the
  // expired booking, its pending revision, or the late-capture compensation.
  expect(await processOnlinePaymentEvent(paymentEvent(f, "cancelled"))).toBe("cancelled");
  expect(await database.query("SELECT status FROM public.payment_attempts WHERE id=$1", [f.attemptId]))
    .toEqual([{ status: "cancelled" }]);
  const cancelled = await cancellationEvidence(f);
  expect(Date.parse(cancelled.booking!.updated_at)).toBeGreaterThanOrEqual(Date.parse(accepted.booking!.updated_at));
  expect(cancelled).toEqual({ ...accepted, booking: { ...accepted.booking, updated_at: cancelled.booking!.updated_at } });
  expect(await state(replacement)).toEqual(replacementBefore);
  expect(stripeAdapter.refundPayment).toHaveBeenCalledOnce();
});

test("late capture compensation persistence failure rolls back its receipt and retries once", async () => {
  vi.spyOn(stripeAdapter, "refundPayment").mockImplementation(async refund => ({
    status: "succeeded", providerRefundId: `re-${refund.id}`,
  }));
  const f = await seed(600, false, true);
  await database.query("UPDATE public.court_reservations SET hold_expires_at='2020-01-01' WHERE id=$1", [f.reservationId]);
  await expirePaymentHolds();
  const before = await settlementState(f), event = paymentEvent(f);
  const insert = payments.insertRefundAllocations;
  vi.spyOn(payments, "insertRefundAllocations").mockImplementationOnce(async (...args) => {
    await insert(...args); throw new Error("Injected compensation persistence failure");
  });
  await expect(processOnlinePaymentEvent(event)).rejects.toThrow("Injected compensation persistence failure");
  expect(await settlementState(f)).toEqual(before);
  expect(stripeAdapter.refundPayment).not.toHaveBeenCalled();
  expect(await processOnlinePaymentEvent(event)).toBe("expired");
  expect((await state(f)).refunds).toEqual([expect.objectContaining({ amount_minor: 5000, status: "succeeded" })]);
  expect((await settlementState(f)).receipts).toHaveLength(1);
  expect((await cancellationEvidence(f)).revisions).toHaveLength(1);
});

test("Pay-at-club outstanding debt is never allocated as collected online funds", async () => {
  const f = await seed();
  await database.query(`INSERT INTO public.payment_attempts(id,booking_id,method,amount_minor,currency,status)
    VALUES($1,$2,'pay_at_club',5000,'RON','due')`,[f.attemptId,f.id]);
  await expect(allocateFor(f,1,"refund-debt")).rejects.toMatchObject({reason:"insufficient_funds"});
  expect(await cancel(f)).toMatchObject({outcome:"cancelled",refundIds:[]});
  expect((await bookingFinancials(database.manager,f.id)).refunds).toEqual([]);
});

test("stable operation identity replays once and rejects changed intent",async()=>{
  const f=await seed(),requestId=randomUUID(),input=await edit(f,{requestId});
  expect(await save(input)).toMatchObject({ok:true});expect(await save(input)).toMatchObject({ok:true});
  expect(await save({...input,startMinute:780,endMinute:840})).toMatchObject({ok:false,message:expect.stringContaining("different booking details")});
  expect(await database.query("SELECT revision_number,operation_key FROM public.booking_revisions WHERE booking_id=$1 ORDER BY revision_number",[f.id]))
    .toEqual([{revision_number:1,operation_key:"created"},{revision_number:2,operation_key:requestId}]);
});

// These are persistence facts, separate from the future Admin history projection.
test.each(["applied", "unsuccessful"] as const)("proposal display facts survive rename and %s settlement", async outcome => {
  simulatedStripe();
  const f = await seed(600, true), base = (await state(f)).booking!.revision;
  await database.query("UPDATE public.courts SET name='Proposed Court' WHERE id=$1", [secondCourtId]);
  await database.query("UPDATE public.locations SET name='Proposed Location' WHERE id=$1", [locationId]);
  const result = await save(await edit(f, { endMinute: 810, expectedTotal: 7500, requestId: randomUUID() }));
  if (!result.ok || !result.adjustmentId) throw new Error("Missing proposal");
  const before = await findAdjustment(database.manager, result.adjustmentId);
  expect(before?.target).toMatchObject({ courtId: secondCourtId, date, startMinute: 720, endMinute: 810,
    courtName: "Proposed Court", locationName: "Proposed Location", timezone: "UTC" });
  expect(before?.baseRevisionId).toBe(base.id);
  await database.query("UPDATE public.courts SET name='Renamed Court' WHERE id=$1", [secondCourtId]);
  await database.query("UPDATE public.locations SET name='Renamed Location',timezone='Europe/Bucharest' WHERE id=$1", [locationId]);
  if (outcome === "unsuccessful") await database.query("UPDATE public.users SET status='suspended' WHERE id=$1", [actorId]);
  expect(await captureAdjustment(result.adjustmentId)).toBe(outcome === "applied" ? "succeeded" : "expired");
  const after = await findAdjustment(database.manager, result.adjustmentId);
  expect(after?.target).toEqual(before?.target);
  expect(after?.status).toBe(outcome);
  const contract = (await state(f)).booking!.revision;
  if (outcome === "applied") expect(contract).toMatchObject({ adjustmentId: result.adjustmentId,
    courtName: "Renamed Court", locationName: "Renamed Location", timezone: "Europe/Bucharest" });
  else expect(contract).toEqual(base);
});

test("late compensation retains original request context after subsequent checkout abandonment and replay", async () => {
  simulatedStripe();
  const f = await seed(600, false, true), initial = (await state(f)).booking!.revision;
  const token = "a".repeat(64);
  const { createHash } = await import("node:crypto");
  await database.query("UPDATE public.payment_attempts SET checkout_token_hash=$2 WHERE id=$1",
    [f.attemptId, createHash("sha256").update(token).digest("hex")]);
  await database.query("UPDATE public.court_reservations SET hold_expires_at='2020-01-01' WHERE id=$1", [f.reservationId]);
  await expirePaymentHolds({ courtId });
  const event = paymentEvent(f);
  expect(await processOnlinePaymentEvent(event)).toBe("expired");
  const before = await database.query("SELECT * FROM public.payment_refunds WHERE booking_id=$1", [f.id]);
  expect(before).toEqual([expect.objectContaining({ reason: "late_capture_compensation", context_revision_id: initial.id })]);
  await abandonOnlineCheckout({ attemptId: f.attemptId, token });
  expect((await state(f)).booking!.revision).toMatchObject({ kind: "cancelled", cancellationCause: "checkout_abandoned" });
  expect((await payments.findCheckoutAttempt(database.manager, f.attemptId))?.status).toBe("cancelled");
  // A distinct late event sees the provider cancellation; the refund still
  // belongs to the original expired request, not the abandonment revision.
  expect(await processOnlinePaymentEvent({ ...event, eventId: randomUUID() })).toBe("cancelled");
  expect(await database.query("SELECT * FROM public.payment_refunds WHERE booking_id=$1", [f.id])).toEqual(before);
});

test("known capture abandonment keeps cancellation context during later provider observation", async () => {
  simulatedStripe();
  const f = await seed(600, false, true), token = "b".repeat(64);
  const { createHash } = await import("node:crypto");
  await database.query("UPDATE public.payment_attempts SET checkout_token_hash=$2 WHERE id=$1",
    [f.attemptId, createHash("sha256").update(token).digest("hex")]);
  const event = paymentEvent(f);
  expect(await processOnlinePaymentEvent(event)).toBe("succeeded");
  await abandonOnlineCheckout({ attemptId: f.attemptId, token });
  const cancellation = (await state(f)).booking!.revision;
  const before = await database.query("SELECT * FROM public.payment_refunds WHERE booking_id=$1", [f.id]);
  expect(before).toEqual([expect.objectContaining({ reason: "booking_cancellation", context_revision_id: cancellation.id })]);
  expect(await processOnlinePaymentEvent({ ...event, eventId: randomUUID() })).toBe("succeeded");
  expect(await database.query("SELECT * FROM public.payment_refunds WHERE booking_id=$1", [f.id])).toEqual(before);
});

test("refund context conflicts reject replay; obligation insertion failure rolls back its revision and occupancy", async () => {
  simulatedStripe();
  const f = await seed(600, true), original = await state(f);
  await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=3000 WHERE court_id=$1 AND court_state='outdoor'", [secondCourtId]);
  const insert = payments.insertRefundAllocations;
  const fault = vi.spyOn(payments, "insertRefundAllocations").mockImplementationOnce(async (...args) => {
    await insert(...args); throw new Error("Injected obligation failure");
  });
  expect(await save(await edit(f, { expectedTotal: 3000, requestId: randomUUID() }))).toMatchObject({ ok: false });
  expect(await state(f)).toEqual(original);
  expect(await database.query("SELECT * FROM public.payment_refunds WHERE booking_id=$1", [f.id])).toEqual([]);
  expect(await database.query("SELECT * FROM public.booking_adjustments WHERE booking_id=$1", [f.id])).toEqual([]);
  fault.mockRestore();
  const result = await save(await edit(f, { expectedTotal: 3000, requestId: randomUUID() }));
  if (!result.ok || !result.adjustmentId) throw new Error("Missing accepted reduction");
  await expect(inTransaction(async manager => {
    await clubs.lockLocations(manager, [locationId]);
    await bookings.lockCheckoutBooking(manager, f.id);
    return allocateBookingRefund(manager, { bookingId: f.id, amount: 2000, operationKey: result.adjustmentId!,
      adjustmentId: result.adjustmentId, actorId, reason: "failed_adjustment_compensation", contextRevisionId: original.booking!.current_revision_id });
  })).rejects.toThrow("Refund operation context changed");
  expect((await bookingFinancials(database.manager, f.id)).refunds).toHaveLength(1);
});

test("database rejects cross-booking refund context and immutable fact rewrites while permitting execution state", async () => {
  simulatedStripe();
  const f = await seed(600, true), other = await seed(660, true);
  const result = await save(await edit(f, { endMinute: 810, expectedTotal: 7500, requestId: randomUUID() }));
  if (!result.ok || !result.adjustmentId) throw new Error("Missing proposal");
  expect((await completeCancellation(f)).outcome).toBe("cancelled");
  const [refund] = await database.query("SELECT * FROM public.payment_refunds WHERE booking_id=$1", [f.id]);
  const otherRevision = (await state(other)).booking!.current_revision_id;
  const runner = database.createQueryRunner();
  await runner.startTransaction();
  try {
    const rejects = async (sql: string, args: unknown[], code = "23514") => {
      await runner.query("SAVEPOINT invalid_context");
      try { await expect(runner.query(sql, args)).rejects.toMatchObject({ code }); }
      finally { await runner.query("ROLLBACK TO SAVEPOINT invalid_context"); }
    };
    for (const change of ["reason='late_capture_compensation'", "context_revision_id=gen_random_uuid()", "id=gen_random_uuid()",
      "booking_id=gen_random_uuid()", "payment_attempt_id=gen_random_uuid()", "adjustment_id=gen_random_uuid()",
      "operation_key='different'", "amount_minor=amount_minor-1", "captured_amount_minor=captured_amount_minor+1",
      "currency='EUR'", "provider_payment_id='different'", "requested_by_user_id=NULL", "created_at=created_at+interval '1 second'"])
      await rejects(`UPDATE public.payment_refunds SET ${change} WHERE id=$1`, [refund.id]);
    for (const change of ["target=jsonb_set(target,'{courtName}','\"Different\"')", "base_revision_id=gen_random_uuid()",
      "original_total=original_total+1", "new_total=new_total+1", "request_key='different'", "expires_at=expires_at+interval '1 second'"])
      await rejects(`UPDATE public.booking_adjustments SET ${change} WHERE id=$1`, [result.adjustmentId]);
    await runner.query("SAVEPOINT cross_booking");
    await runner.query(`INSERT INTO public.payment_refunds(booking_id,payment_attempt_id,operation_key,provider,provider_payment_id,
      amount_minor,captured_amount_minor,currency,reason,context_revision_id)
      VALUES($1,$2,'cross','stripe',$3,1,5000,'RON','booking_cancellation',$4)`, [f.id,f.attemptId,`pi-${f.attemptId}`,otherRevision]);
    await expect(runner.query("SET CONSTRAINTS payment_refunds_context_revision_fkey IMMEDIATE")).rejects.toMatchObject({ code: "23503" });
    await runner.query("ROLLBACK TO SAVEPOINT cross_booking");
    await rejects(`INSERT INTO public.payment_refunds(booking_id,payment_attempt_id,operation_key,provider,provider_payment_id,amount_minor,currency)
      VALUES($1,$2,'missing-context','stripe',$3,1,'RON')`, [f.id,f.attemptId,`pi-${f.attemptId}`], "23502");
    await runner.query("UPDATE public.payment_refunds SET status='pending_retry',updated_at=now() WHERE id=$1", [refund.id]);
    expect(await runner.query("SELECT reason,context_revision_id,status FROM public.payment_refunds WHERE id=$1", [refund.id]))
      .toEqual([{ reason: "booking_cancellation", context_revision_id: refund.context_revision_id, status: "pending_retry" }]);
    await runner.query("UPDATE public.booking_adjustments SET status='expired',updated_at=now() WHERE id=$1", [result.adjustmentId]);
  } finally { await runner.rollbackTransaction(); await runner.release(); }
});

test.each(["checkout", "adjustment"] as const)("late capture compensation obligation commits with its receipt and preserves %s source context", async origin => {
  simulatedStripe();
  // Model the missing obligation before any provider execution is dispatched.
  const deferredProcessing=vi.spyOn(refundProcessing,"processBookingRefund").mockResolvedValue("pending_retry");
  const f = await seed(600, origin === "adjustment", origin === "checkout");
  const base = (await state(f)).booking!.revision;
  let eventId: ReturnType<typeof randomUUID>, adjustmentId: string | undefined;
  if (origin === "adjustment") {
    const result = await save(await edit(f, { endMinute: 810, expectedTotal: 7500, requestId: randomUUID() }));
    if (!result.ok || !result.adjustmentId) throw new Error("Missing proposal");
    adjustmentId = result.adjustmentId;
    await database.transaction(m => setAdjustmentExpiryFixture(m, adjustmentId!, "2020-01-01"));
    eventId = randomUUID();
    expect(await captureAdjustment(adjustmentId, eventId)).toBe("expired");
  } else {
    await database.query("UPDATE public.court_reservations SET hold_expires_at='2020-01-01' WHERE id=$1", [f.reservationId]);
    await expirePaymentHolds({ courtId });
    const event = paymentEvent(f); eventId = event.eventId;
    expect(await processOnlinePaymentEvent(event)).toBe("expired");
  }
  deferredProcessing.mockRestore();
  expect(await database.query("SELECT reconciliation_required FROM public.payment_provider_events WHERE event_id=$1", [eventId]))
    .toEqual([{ reconciliation_required: true }]);
  const [refund] = (await bookingFinancials(database.manager, f.id)).refunds;
  if (!refund) throw new Error("Missing compensation obligation");
  expect(await prepareRefund(refund.id)).toMatchObject({ outcome: "ready" });
  expect((await bookingFinancials(database.manager, f.id)).refunds).toEqual([
    expect.objectContaining({ contextRevisionId: base.id,
      reason: origin === "adjustment" ? "failed_adjustment_compensation" : "late_capture_compensation",
      adjustmentId: adjustmentId ?? null, operationKey: adjustmentId ?? "cancellation" }),
  ]);
});

const historyQuery = (bookingId: string) => ({ page: 1, status: "all", provider: "all", method: "all", attention: false,
  search: "", sort: "date", direction: "asc", bookingId, attentionRefundStatuses: ["pending_retry", "failed"] });
async function historyFor(f: Fixture) {
  const page = await readFinancialHistory(database.manager, historyQuery(f.id));
  for (const row of page.rows) {
    const detail = await readFinancialHistory(database.manager, { ...historyQuery(f.id), transaction: { kind: row.transaction_kind, id: row.transaction_id } });
    expect(detail.rows).toEqual([row]);
  }
  return page.rows;
}
function historicalDescription(row: Awaited<ReturnType<typeof historyFor>>[number]) {
  return { context: row.context, previous: row.previous_context, proposal: row.proposal,
    reason: row.refund?.reason ?? null, amount: row.amount_minor, currency: row.currency, provider: row.provider,
    reference: row.provider_payment_id, label: row.operation_label };
}

test("financial history preserves each 50 → 75 → 100 → 75 → cancellation operation after renames and contact changes", async () => {
  simulatedStripe();
  const f = await seed(600, false, true);
  const initial = (await state(f)).booking!.revision;
  expect(await processOnlinePaymentEvent(paymentEvent(f))).toBe("succeeded");
  const snapshots = new Map<string, ReturnType<typeof historicalDescription>>();
  const record = async () => {
    for (const row of await historyFor(f)) {
      const saved = snapshots.get(row.transaction_id);
      if (saved) expect(historicalDescription(row)).toEqual(saved);
      else snapshots.set(row.transaction_id, historicalDescription(row));
    }
  };
  await record();
  for (const [end, total, target] of [[810, 7500, secondCourtId], [840, 10000, courtId]] as const) {
    const result = await save(await edit(f, { courtId: target, startMinute: 720, endMinute: end, expectedTotal: total, requestId: randomUUID() }));
    if (!result.ok || !result.adjustmentId) throw new Error("Missing surcharge");
    expect(await captureAdjustment(result.adjustmentId)).toBe("succeeded");
    const accepted = (await state(f)).booking!.revision;
    const row = (await historyFor(f)).find(r => r.transaction_kind === "payment" && r.adjustment_id === result.adjustmentId);
    expect(row).toMatchObject({ context: { revisionId: accepted.id, source: "accepted_adjustment", totalAmountMinor: total,
      courtId: target, startMinute: 720, endMinute: end }, previous_context: { revisionId: accepted.previousRevisionId },
      proposal: { acceptedRevisionId: accepted.id, status: "applied" }, amount_minor: 2500 });
    await record();
  }
  const reduced = await save(await edit(f, { courtId: secondCourtId, startMinute: 720, endMinute: 810, expectedTotal: 7500, requestId: randomUUID() }));
  expect(reduced).toMatchObject({ ok: true, adjustmentStatus: "applied" });
  const reduction = (await state(f)).booking!.revision;
  const reductionBase = await revisions.findRevision(database.manager, reduction.previousRevisionId!);
  if (!reductionBase) throw new Error("Missing reduction base");
  expect((await historyFor(f)).find(r => r.refund?.reason === "booking_price_reduction"))
    .toMatchObject({ context: { revisionId: reductionBase.id, totalAmountMinor: 10000, courtId },
      refund: { context_revision_id: reductionBase.id, captured_amount_minor: 2500 }, operation_label: "Price reduction refund", amount_minor: 2500 });
  await record();
  await database.query("UPDATE public.courts SET name='Live renamed court' WHERE id=ANY($1::uuid[])", [[courtId,secondCourtId]]);
  await database.query("UPDATE public.locations SET name='Live renamed location' WHERE id=$1", [locationId]);
  // A controlled fixture appends contact facts; production booking writers are unchanged.
  await database.transaction(async manager => {
    const booking = await bookings.findBookingForUpdate(manager, f.id);
    if (!booking) throw new Error("Missing contact fixture booking");
    const revised = buildBookingRevision({ ...booking.revision, customerName: "Changed Customer",
      customerEmail: "new-contact@example.test", customerPhone: "456" }, {
      id: randomUUID(), bookingId: f.id, operationKey: randomUUID(), intentHash: "contact-fixture", kind: "rescheduled",
      bookingState: "confirmed", actorUserId: actorId, actorScope: "customer", recordedAt: new Date(),
      adjustmentId: null, cancellationCause: null,
    }, booking.revision);
    await revisions.advanceRevision(manager, { revision: revised, previousId: booking.current_revision_id, status: "confirmed" });
  });
  await record();
  expect((await completeCancellation(f)).outcome).toBe("cancelled");
  const cancelled = (await state(f)).booking!.revision;
  const rows = await historyFor(f);
  const original = rows.find(r => r.transaction_id === f.attemptId);
  expect(original).toMatchObject({ context: { revisionId: initial.id, bookingDate: date, startMinute: 600, endMinute: 660,
    customerName: "Customer", customerEmail: "immutable@example.test", customerPhone: "123",
    totalAmountMinor: 5000, courtId, courtName: initial.courtName, locationName: initial.locationName },
    current_booking: { revisionId: cancelled.id, status: "cancelled", totalAmountMinor: 7500,
      customerName: "Changed Customer", customerEmail: "new-contact@example.test", customerPhone: "456", courtId: secondCourtId } });
  for (const row of rows.filter(r => r.refund?.reason === "booking_cancellation"))
    expect(row).toMatchObject({ context: { revisionId: cancelled.previousRevisionId, bookingState: "confirmed", totalAmountMinor: 7500 },
      refund: { context_revision_id: cancelled.previousRevisionId, captured_amount_minor: row.amount_minor } });
  expect(rows).toHaveLength(6);
  expect(original?.financials).toMatchObject({ outstanding: 0 });
  expect(original?.financials.totals).toContainEqual(expect.objectContaining({
    currency: "RON", captured: 10000, refunded: 10000, refundObligations: 10000,
  }));
  await record();
  expect((await readFinancialHistory(database.manager, { ...historyQuery(f.id), search: "immutable@example.test" })).rows)
    .toHaveLength(4);
  expect((await readFinancialHistory(database.manager, { ...historyQuery(f.id), search: "new-contact@example.test" })).rows)
    .toHaveLength(2);
});

test("pending and failed surcharge history separates accepted base from the immutable proposed target", async () => {
  simulatedStripe();
  const f = await seed(600, true), base = (await state(f)).booking!.revision;
  await database.query("UPDATE public.courts SET name='Proposal target' WHERE id=$1", [secondCourtId]);
  const result = await save(await edit(f, { endMinute: 810, expectedTotal: 7500, requestId: randomUUID() }));
  if (!result.ok || !result.adjustmentId) throw new Error("Missing proposal");
  const pending = (await historyFor(f)).find(r => r.adjustment_id === result.adjustmentId);
  expect(pending).toMatchObject({ context: { revisionId: base.id, source: "adjustment_base", courtId },
    proposal: { status: "pending", acceptedRevisionId: null, courtId: secondCourtId, courtName: "Proposal target", totalAmountMinor: 7500 },
    previous_context: null, transaction_status: "pending" });
  await database.query("UPDATE public.courts SET name='Different live name' WHERE id=$1", [secondCourtId]);
  await database.query("UPDATE public.locations SET name='Different live location' WHERE id=$1", [locationId]);
  await database.query("UPDATE public.users SET status='suspended' WHERE id=$1", [actorId]);
  expect(await captureAdjustment(result.adjustmentId)).toBe("expired");
  const rows = await historyFor(f);
  const failedPayment = rows.find(r => r.transaction_id === pending?.transaction_id);
  expect(failedPayment).toMatchObject({ context: pending?.context, proposal: { status: "unsuccessful",
    acceptedRevisionId: null, courtName: "Proposal target" }, transaction_status: "succeeded", previous_context: null });
  const compensation = rows.find(r => r.transaction_kind === "refund");
  expect(compensation).toMatchObject({ operation_label: "Failed adjustment compensation",
    context: { revisionId: base.id, courtId }, refund: { reason: "failed_adjustment_compensation", context_revision_id: base.id, captured_amount_minor: 2500 },
    proposal: { status: "unsuccessful", acceptedRevisionId: null, courtId: secondCourtId } });
});

test("late compensation history remains an initial request after checkout abandonment", async () => {
  simulatedStripe();
  const f = await seed(600, false, true), initial = (await state(f)).booking!.revision;
  const token = "c".repeat(64), { createHash } = await import("node:crypto");
  await database.query("UPDATE public.payment_attempts SET checkout_token_hash=$2 WHERE id=$1", [f.attemptId,createHash("sha256").update(token).digest("hex")]);
  await database.query("UPDATE public.court_reservations SET hold_expires_at='2020-01-01' WHERE id=$1", [f.reservationId]);
  await expirePaymentHolds({ courtId });
  expect(await processOnlinePaymentEvent(paymentEvent(f))).toBe("expired");
  const before = await historyFor(f);
  const compensation = before.find(r => r.transaction_kind === "refund");
  expect(compensation).toMatchObject({ operation_label: "Late capture compensation",
    context: { revisionId: initial.id, bookingState: "pending_payment", confirmationRevisionId: null },
    refund: { reason: "late_capture_compensation", captured_amount_minor: 5000 }, proposal: null });
  expect(before.find(r => r.transaction_id === f.attemptId)).toMatchObject({ transaction_status: "expired",
    context: { revisionId: initial.id, confirmationRevisionId: null }, reconciliation: [{ outcome: "succeeded", reconciliation_required: false }] });
  await abandonOnlineCheckout({ attemptId: f.attemptId, token });
  const after = await historyFor(f);
  expect(after.map(historicalDescription)).toEqual(before.map(historicalDescription));
  expect(after.every(row => row.current_booking.status === "cancelled")).toBe(true);
});

test("Pay-at-club original debt and a booking without attempts use initial terms with a separate current summary", async () => {
  const f = await seed(), initial = (await state(f)).booking!.revision;
  await database.query("INSERT INTO public.payment_attempts(id,booking_id,method,amount_minor,currency,status) VALUES($1,$2,'pay_at_club',5000,'RON','due')", [f.attemptId,f.id]);
  expect(await save(await edit(f, { endMinute: 810, expectedTotal: 7500 }))).toMatchObject({ ok: true });
  const row = (await historyFor(f))[0];
  expect(row).toMatchObject({ amount_minor: 5000, transaction_status: "due", provider: null,
    context: { revisionId: initial.id, totalAmountMinor: 5000, startMinute: 600, endMinute: 660 },
    current_booking: { totalAmountMinor: 7500, startMinute: 720, endMinute: 810 }, financials: { totals: [], outstanding: 7500 } });
  const noAttempt = await seed(840), before = (await state(noAttempt)).booking!.revision;
  expect(await save(await edit(noAttempt, { startMinute: 960, endMinute: 1020 }))).toMatchObject({ ok: true });
  expect((await historyFor(noAttempt))[0]).toMatchObject({ transaction_kind: "booking", context: { revisionId: before.id,
    startMinute: 840, endMinute: 900 }, current_booking: { startMinute: 960, endMinute: 1020 } });
});



// Booking modification lifecycle: dismissal (X), provider liveness and lateness.
async function proposeSurcharge(f: Fixture) {
  const result = await save(await edit(f, { courtId, startMinute: 600, endMinute: 690, expectedTotal: 7500, requestId: randomUUID() }));
  if (!result.ok || !result.adjustmentId || !result.checkout) throw new Error("Missing surcharge");
  const attempt = await adjustmentAttempt(database.manager, result.adjustmentId);
  if (!attempt?.providerPaymentId) throw new Error("Missing payment");
  return { id: result.adjustmentId, checkout: result.checkout, attempt: { ...attempt, providerPaymentId: attempt.providerPaymentId } };
}
const holds = (id: string) => database.query("SELECT status,hold_expires_at FROM public.court_reservations WHERE adjustment_id=$1", [id]);
const appliedRevisions = async (f: Fixture) => (await database.query(
  "SELECT count(*)::integer AS count FROM public.booking_revisions WHERE booking_id=$1 AND kind='rescheduled'", [f.id]))[0].count;
async function failAdjustment(p: Awaited<ReturnType<typeof proposeSurcharge>>, eventId = randomUUID()) {
  return processOnlinePaymentEvent({ attemptId: p.attempt.id, provider: "stripe", providerPaymentId: p.attempt.providerPaymentId,
    outcome: "retryable_failed", eventId, amountMinor: 2500, currency: "RON" });
}

test("X before payment discards the modification, releases its hold, and the next Edit starts fresh", async () => {
  const outcomes = simulatedStripe(); const f = await seed(600, true), original = await state(f);
  const p = await proposeSurcharge(f);
  expect(await holds(p.id)).toEqual([expect.objectContaining({ status: "held" })]);
  await dismissAdjustment(p.id);
  expect(outcomes.get(p.attempt.providerPaymentId)).toBe("cancelled");
  expect((await findAdjustment(database.manager, p.id))?.status).toBe("cancelled");
  expect((await adjustmentAttempt(database.manager, p.id))?.status).toBe("cancelled");
  expect(await holds(p.id)).toEqual([{ status: "released", hold_expires_at: null }]);
  expect((await state(f)).booking).toEqual(original.booking);
  const context = await readCustomerBookingEditContext(f.id, date, actorId);
  expect(context).not.toHaveProperty("pending_adjustment_id");
  const next = await proposeSurcharge(f);
  expect(next.id).not.toBe(p.id);
});

test("decline keeps a retryable checkout; abandoning it discards the modification and later events never resurrect it", async () => {
  simulatedStripe(); const f = await seed(600, true), original = await state(f);
  const p = await proposeSurcharge(f);
  expect(await failAdjustment(p)).toBe("pending");
  expect((await findAdjustment(database.manager, p.id))?.status).toBe("pending");
  await dismissAdjustment(p.id);
  expect((await findAdjustment(database.manager, p.id))?.status).toBe("cancelled");
  expect(await holds(p.id)).toEqual([{ status: "released", hold_expires_at: null }]);
  expect(await failAdjustment(p)).toBe("cancelled");
  expect(await captureAdjustment(p.id)).toBe("expired");
  expect((await findAdjustment(database.manager, p.id))?.status).toBe("cancelled");
  expect((await state(f)).booking).toEqual(original.booking); expect((await state(f)).reservation).toEqual(original.reservation);
  expect((await bookingFinancials(database.manager, f.id)).refunds).toHaveLength(1);
});

test("processing at X keeps the hold blocked, then success within the cutoff applies exactly once", async () => {
  const outcomes = simulatedStripe(); const f = await seed(600, true);
  const p = await proposeSurcharge(f);
  outcomes.set(p.attempt.providerPaymentId, "processing");
  await dismissAdjustment(p.id);
  expect((await findAdjustment(database.manager, p.id))?.status).toBe("pending");
  expect(outcomes.get(p.attempt.providerPaymentId)).toBe("processing");
  await expect(readOnlineCheckout({ attemptId: p.checkout.attemptId, token: p.checkout.token })).rejects.toThrow();
  // The lease is bounded by the target start (2099-10-15 10:00 UTC).
  expect(await holds(p.id)).toEqual([{ status: "held", hold_expires_at: new Date("2099-10-15T10:00:00Z") }]);
  expect(await listBookingsWithLivePayment(database.manager, [f.id])).toEqual(new Set([f.id]));
  expect(await save(await edit(f, { courtId, startMinute: 600, endMinute: 720, expectedTotal: 10000, requestId: randomUUID() })))
    .toMatchObject({ ok: false, message: expect.stringContaining("still processing") });
  const eventId = randomUUID();
  expect(await captureAdjustment(p.id, eventId)).toBe("succeeded");
  expect(await captureAdjustment(p.id, eventId)).toBe("succeeded");
  expect(await captureAdjustment(p.id)).toBe("succeeded");
  expect(await appliedRevisions(f)).toBe(1);
  expect((await state(f)).reservation?.ends_at_minute).toBe(690);
  expect(await listBookingsWithLivePayment(database.manager, [f.id])).toEqual(new Set());
  expect((await bookingFinancials(database.manager, f.id)).refunds).toEqual([]);
});

test("processing at X then failure discards the modification, releases the hold and preserves the original", async () => {
  const outcomes = simulatedStripe(); const f = await seed(600, true), original = await state(f);
  const p = await proposeSurcharge(f);
  outcomes.set(p.attempt.providerPaymentId, "processing");
  await dismissAdjustment(p.id);
  outcomes.set(p.attempt.providerPaymentId, "pending");
  expect(await failAdjustment(p)).toBe("cancelled");
  expect((await findAdjustment(database.manager, p.id))?.status).toBe("cancelled");
  expect((await adjustmentAttempt(database.manager, p.id))?.status).toBe("failed");
  expect(await holds(p.id)).toEqual([{ status: "released", hold_expires_at: null }]);
  // The failed intent is cancelled after commit so it cannot be confirmed later.
  expect(outcomes.get(p.attempt.providerPaymentId)).toBe("cancelled");
  expect(await listBookingsWithLivePayment(database.manager, [f.id])).toEqual(new Set());
  expect((await state(f)).booking).toEqual(original.booking); expect((await state(f)).reservation).toEqual(original.reservation);
});

test("a live payment past the cutoff stays blocked; its late success is refunded exactly once and never applied", async () => {
  const outcomes = simulatedStripe(); const f = await seed(600, true), original = await state(f);
  const p = await proposeSurcharge(f);
  outcomes.set(p.attempt.providerPaymentId, "processing");
  await dismissAdjustment(p.id);
  await database.transaction(m => setAdjustmentExpiryFixture(m, p.id, "2020-01-01T00:00:00Z"));
  await expirePaymentHolds({ courtId });
  await readAdjustmentStatus(database.manager, p.id);
  expect(await holds(p.id)).toEqual([expect.objectContaining({ status: "held" })]);
  await expect(database.query(`INSERT INTO public.court_reservations(court_id,booking_date,starts_at_minute,ends_at_minute)
    VALUES($1,$2,660,720)`, [courtId, date])).rejects.toMatchObject({ code: "23P01" });
  const eventId = randomUUID();
  expect(await captureAdjustment(p.id, eventId)).toBe("expired");
  expect(await captureAdjustment(p.id, eventId)).toBe("expired");
  expect(await captureAdjustment(p.id)).toBe("expired");
  expect((await state(f)).booking).toEqual(original.booking); expect((await state(f)).reservation).toEqual(original.reservation);
  expect(await holds(p.id)).toEqual([{ status: "released", hold_expires_at: null }]);
  expect((await bookingFinancials(database.manager, f.id)).refunds).toEqual([
    expect.objectContaining({ adjustmentId: p.id, amountMinor: 2500, reason: "failed_adjustment_compensation" })]);
  expect(await appliedRevisions(f)).toBe(0);
});

test("cancel race at X: a payment that already succeeded is observed and applied once", async () => {
  simulatedStripe(); const f = await seed(600, true);
  const p = await proposeSurcharge(f);
  vi.mocked(stripeAdapter.dismissPayment).mockResolvedValueOnce("succeeded");
  vi.mocked(stripeAdapter.readPayment).mockResolvedValueOnce({ status: "succeeded", amountMinor: 2500, currency: "RON",
    providerCaptureId: p.attempt.providerPaymentId, live: false });
  await dismissAdjustment(p.id);
  expect((await findAdjustment(database.manager, p.id))?.status).toBe("applied");
  expect(await captureAdjustment(p.id)).toBe("succeeded");
  expect(await appliedRevisions(f)).toBe(1);
});

test("cancel race at X: a payment that moved to processing keeps the lease and is not cancelled", async () => {
  const outcomes = simulatedStripe(); const f = await seed(600, true);
  const p = await proposeSurcharge(f);
  vi.mocked(stripeAdapter.dismissPayment).mockResolvedValueOnce("live");
  await dismissAdjustment(p.id);
  expect(outcomes.get(p.attempt.providerPaymentId)).toBe("pending");
  expect((await findAdjustment(database.manager, p.id))?.status).toBe("pending");
  expect(await listBookingsWithLivePayment(database.manager, [f.id])).toEqual(new Set([f.id]));
});

test("status polling that observes processing records the live lease", async () => {
  const outcomes = simulatedStripe(); const f = await seed(600, true);
  const p = await proposeSurcharge(f);
  outcomes.set(p.attempt.providerPaymentId, "processing");
  expect(await readOnlineCheckout({ attemptId: p.checkout.attemptId, token: p.checkout.token }))
    .toMatchObject({ status: "pending_payment", paymentStatus: "processing" });
  expect(await listBookingsWithLivePayment(database.manager, [f.id])).toEqual(new Set([f.id]));
  // A later decline while the customer is present returns the lease to the cutoff.
  expect(await failAdjustment(p)).toBe("pending");
  expect(await listBookingsWithLivePayment(database.manager, [f.id])).toEqual(new Set());
});

test("initial-booking checkout expiry is unchanged by modification leases", async () => {
  const outcomes = simulatedStripe();
  const paid = await seed(840, true);
  const p = await proposeSurcharge(paid);
  outcomes.set(p.attempt.providerPaymentId, "processing");
  await dismissAdjustment(p.id);
  const initial = await seed(1080, false, true);
  const deadline = (await database.query("SELECT expires_at FROM public.payment_attempts WHERE id=$1", [initial.attemptId]))[0].expires_at;
  await database.query("UPDATE public.court_reservations SET hold_expires_at='2020-01-01' WHERE id=$1", [initial.reservationId]);
  expect(await expirePaymentHolds({ courtId })).toBe(1);
  expect((await state(initial)).booking?.status).toBe("expired");
  expect((await state(initial)).reservation?.status).toBe("released");
  expect(await database.query("SELECT status,expires_at FROM public.payment_attempts WHERE id=$1", [initial.attemptId]))
    .toEqual([{ status: "expired", expires_at: deadline }]);
  expect(await holds(p.id)).toEqual([expect.objectContaining({ status: "held" })]);
});

// Request-driven completion: no scheduler. A later trigger for the same refund (a
// signed Stripe refund webhook or the Admin "Check with Stripe" action) runs the
// same processBookingRefund. Real transactions, mocked provider only.
const webhookCheck = (id: string) => refundProcessing.processBookingRefund(id, { strict: true });
const adminCheck = (id: string) => refundProcessing.processBookingRefund(id, { actorId, retryRejected: true, strict: true });

test("request-driven: cancellation waits through an unconfirmed refund and a later Stripe refund webhook completes it", async () => {
  simulatedStripe();
  const f = await seed(600,true);
  const request = await cancel(f);
  expect(request.outcome).toBe("cancellation_pending");
  if (request.outcome !== "cancellation_pending") throw new Error("Missing pending request");
  vi.mocked(stripeAdapter.refundPayment).mockRejectedValueOnce(new Error("temporary timeout"));
  expect(await refundProcessing.processBookingRefund(request.refundIds[0])).toBe("pending_retry");
  expect(await state(f)).toMatchObject({ booking:{status:"confirmed"}, reservation:{status:"active"}, events:[] });
  expect(await webhookCheck(request.refundIds[0])).toBe("succeeded");
  expect(await state(f)).toMatchObject({ booking:{status:"cancelled"}, reservation:{status:"cancelled"},
    refunds:[expect.objectContaining({status:"succeeded",amount_minor:5000})], events:[expect.objectContaining({subject:"Booking cancelled"})] });
  expect(await webhookCheck(request.refundIds[0])).toBe("succeeded");
  expect(await emails(f.id)).toHaveLength(1);
  // The unconfirmed request was replayed under its original key, never re-created.
  expect(await database.query("SELECT id FROM public.refund_executions WHERE refund_id=$1",[request.refundIds[0]])).toHaveLength(1);
  const keys = vi.mocked(stripeAdapter.refundPayment).mock.calls.map(([call]) => call.idempotencyKey);
  expect(new Set(keys).size).toBe(1);
});

test("request-driven: definitive refund failure voids the obligation, preserves original booking and sends one important failure notice", async () => {
  simulatedStripe();
  const f=await seed(600,true), before=await state(f), request=await cancel(f);
  if(request.outcome!=="cancellation_pending") throw new Error("Missing pending request");
  vi.mocked(stripeAdapter.refundPayment).mockResolvedValueOnce({status:"failed",providerRefundId:"re_failed_independent"});
  expect(await refundProcessing.processBookingRefund(request.refundIds[0])).toBe("failed");
  // The abandoned change voided its obligation; a later webhook changes nothing.
  expect(await webhookCheck(request.refundIds[0])).toBe("voided");
  const after=await state(f);
  expect(after.booking).toEqual(before.booking); expect(after.reservation).toEqual(before.reservation);
  expect(after.refunds).toMatchObject([{status:"voided"}]);
  expect(await database.query("SELECT status FROM public.booking_adjustments WHERE id=$1",[request.adjustmentId])).toEqual([{status:"unsuccessful"}]);
  expect(await emails(f.id)).toMatchObject([{subject:"Booking cancellation not completed"}]);
  expect(await database.query("SELECT requires_acknowledgement,acknowledged_at FROM public.booking_notification_deliveries WHERE booking_id=$1",[f.id]))
    .toEqual([{requires_acknowledgement:true,acknowledged_at:null}]);
  expect(stripeAdapter.refundPayment).toHaveBeenCalledOnce();
});

test("request-driven: concurrent webhook and Admin checks dispatch one refund", async () => {
  simulatedStripe();
  const f=await seed(600,true), request=await cancel(f);
  if(request.outcome!=="cancellation_pending") throw new Error("Missing pending cancellation");
  vi.mocked(stripeAdapter.refundPayment).mockImplementation(async refund => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return { status: "succeeded", providerRefundId: `re_${refund.executionId}` };
  });
  const results=await Promise.allSettled([webhookCheck(request.refundIds[0]),adminCheck(request.refundIds[0])]);
  // The loser of the execution lease is told to retry (webhook 503 / Admin message); it never dispatches.
  expect(results.filter(result=>result.status==="fulfilled")).toEqual([{status:"fulfilled",value:"succeeded"}]);
  expect(results.filter(result=>result.status==="rejected")).toEqual([{status:"rejected",reason:expect.any(refundProcessing.RefundInProgressError)}]);
  expect(await webhookCheck(request.refundIds[0])).toBe("succeeded");
  expect((await state(f)).booking?.status).toBe("cancelled");
  expect(stripeAdapter.refundPayment).toHaveBeenCalledOnce();
  expect(await refundExecutions.listRefundExecutions(database.manager, request.refundIds[0])).toHaveLength(1);
  expect(await emails(f.id)).toHaveLength(1);
});

test("request-driven: partial refund success then definitive failure must not strand a cancelled booking with money owed", async () => {
  simulatedStripe();
  const f=await seed(600,true), additional=randomUUID();
  await database.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at,completed_at)
    VALUES($1,$2,'online','stripe',$3,2500,'RON','succeeded',clock_timestamp()+interval '10 minutes',clock_timestamp())`,[additional,f.id,`pi-${additional}`]);
  await database.query(`INSERT INTO public.payment_capture_receipts(payment_attempt_id,provider,provider_payment_id,provider_capture_id,amount_minor,currency)
    VALUES($1,'stripe',$2,$2,2500,'RON')`,[additional,`pi-${additional}`]);
  await appendBookingContractFixture(f.id,{total_amount_minor:7500});
  vi.mocked(stripeAdapter.refundPayment).mockImplementation(async p=>({providerRefundId:`re_${p.id}`,status:p.amountMinor===2500?"succeeded":"failed"}));
  const request=await cancel(f); if(request.outcome!=="cancellation_pending") throw new Error("Missing request");
  for(const id of request.refundIds) await refundProcessing.processBookingRefund(id);
  for(const id of request.refundIds) await webhookCheck(id);
  const after=await state(f);
  expect(after.refunds).toMatchObject(expect.arrayContaining([expect.objectContaining({status:"succeeded",amount_minor:2500}),expect.objectContaining({status:"failed",amount_minor:5000})]));
  expect(after.booking?.status).toBe("confirmed");
  expect(vi.mocked(stripeAdapter.refundPayment).mock.calls.filter(([call])=>call.amountMinor===2500)).toHaveLength(1);
});

test("request-driven: the committing request delivers its notification after commit and retries stay durable", async () => {
  simulatedStripe();
  const f=await seed(600,true), request=await cancel(f);
  if(request.outcome!=="cancellation_pending") throw new Error("Missing request");
  vi.stubEnv("BREVO_API_KEY", "simulated-brevo"); vi.stubEnv("BOOKING_MAIL_FROM", "bookings@example.test");
  const submitted: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = String(init?.body);
    if (body.includes(f.id)) submitted.push(body);
    return new Response(null, { status: body.includes(f.id) && submitted.length === 1 ? 503 : 201 });
  }));
  const restore = await isolateNotificationQueue(database.manager);
  try {
    await refundProcessing.processBookingRefund(request.refundIds[0]);
    expect((await state(f)).booking?.status).toBe("cancelled");
    expect(submitted).toHaveLength(1);
    const queued = await database.query("SELECT id,attempts,delivered_at,last_error FROM public.booking_notification_deliveries WHERE booking_id=$1", [f.id]);
    expect(queued).toMatchObject([{ attempts: 1, delivered_at: null, last_error: "unavailable" }]);
    // Not due yet: another financial request does not resend it early.
    await deliverPendingBookingNotifications();
    expect(submitted).toHaveLength(1);
    await database.query("UPDATE public.booking_notification_deliveries SET next_attempt_at=clock_timestamp() WHERE id=$1", [queued[0].id]);
    await deliverPendingBookingNotifications();
    expect(submitted).toHaveLength(2);
    expect(await database.query("SELECT attempts,delivered_at IS NOT NULL AS delivered,last_error FROM public.booking_notification_deliveries WHERE id=$1", [queued[0].id]))
      .toEqual([{ attempts: 2, delivered: true, last_error: null }]);
  } finally { await restore(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});

test("request-driven: failed surcharge payment preserves original booking and occupancy", async () => {
  simulatedStripe(); const f=await seed(600,true),before=await state(f);
  const result=await save(await edit(f,{endMinute:810,expectedTotal:7500,requestId:randomUUID()}));
  if(!result.ok || !result.adjustmentId) throw new Error("Missing surcharge");
  const attempt=await adjustmentAttempt(database.manager,result.adjustmentId);
  if(!attempt?.providerPaymentId) throw new Error("Missing attempt");
  await processOnlinePaymentEvent({attemptId:attempt.id,provider:"stripe",providerPaymentId:attempt.providerPaymentId,
    eventId:randomUUID(),outcome:"failed",amountMinor:2500,currency:"RON"});
  const after=await state(f);
  expect(after.booking).toEqual(before.booking);expect(after.reservation).toEqual(before.reservation);
  expect(await emails(f.id)).toEqual([]);
});

test.each(["succeeded","failed","temporary"] as const)("request-driven: refund-backed reduction with %s result",async outcome=>{
  simulatedStripe();const f=await seed(600,true),before=await state(f);
  await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=3000 WHERE court_id=$1 AND court_state='outdoor'",[secondCourtId]);
  if(outcome==="temporary")vi.mocked(stripeAdapter.refundPayment).mockRejectedValueOnce(new Error("network timeout"));
  else vi.mocked(stripeAdapter.refundPayment).mockResolvedValueOnce({status:outcome,providerRefundId:`re_reduction_${outcome}`});
  const result=await save(await edit(f,{expectedTotal:3000,requestId:randomUUID()}));
  expect(result.ok).toBe(true);
  if(outcome==="temporary"){
    expect(await state(f)).toMatchObject({booking:before.booking,reservation:before.reservation,events:[]});
    for(const refund of await adjustmentRefunds(database.manager,result.ok ? result.adjustmentId ?? "" : "")) await webhookCheck(refund.id);
  }
  const after=await state(f);
  if(outcome==="failed"){
    expect(after.booking).toEqual(before.booking);expect(after.reservation).toEqual(before.reservation);
    expect(after.refunds).toMatchObject([{status:"voided",amount_minor:2000}]);
    expect(await emails(f.id)).toMatchObject([{subject:"Booking change not completed"}]);
  }else{
    expect(after.booking).toMatchObject({status:"confirmed",total_amount_minor:3000});
    expect(after.reservation).toMatchObject({court_id:secondCourtId,starts_at_minute:720,ends_at_minute:780});
    expect(after.refunds).toMatchObject([{status:"succeeded",amount_minor:2000}]);
    expect(await emails(f.id)).toMatchObject([{subject:"Booking rescheduled"}]);
  }
});

test.each(["temporary", "retryable", "external"] as const)("verification: split cancellation with %s remainder preserves booking, money evidence and completed refunds", async failure => {
  simulatedStripe();
  const f = await seed(600, true), additional = randomUUID();
  await database.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at,completed_at)
    VALUES($1,$2,'online','stripe',$3,2500,'RON','succeeded',clock_timestamp()+interval '10 minutes',clock_timestamp())`, [additional, f.id, `pi-${additional}`]);
  await database.query(`INSERT INTO public.payment_capture_receipts(payment_attempt_id,provider,provider_payment_id,provider_capture_id,amount_minor,currency)
    VALUES($1,'stripe',$2,$2,2500,'RON')`, [additional, `pi-${additional}`]);
  await appendBookingContractFixture(f.id, { total_amount_minor: 7500 });
  const before = await state(f);
  const calls: string[] = [];
  let recovered = false;
  vi.mocked(stripeAdapter.refundPayment).mockImplementation(async request => {
    calls.push(request.id);
    if (request.amountMinor === 5000 && !recovered) {
      if (failure === "temporary") throw new Error("simulated temporary transport loss");
      return { status: "failed", providerRefundId: `re_${request.executionId}`,
        retryable: failure === "retryable", failureReason: failure === "retryable" ? "insufficient_funds" : "lost_or_stolen_card" };
    }
    return { status: "succeeded", providerRefundId: `re_${request.executionId}` };
  });
  const request = await cancel(f);
  if (request.outcome !== "cancellation_pending") throw new Error("Missing refund-backed cancellation");
  try {
    for (const id of request.refundIds) await refundProcessing.processBookingRefund(id);
    const pending = await state(f);
    expect(pending.booking).toEqual(before.booking);
    expect(pending.reservation).toEqual(before.reservation);
    expect(await bookingFinancials(database.manager, f.id)).toMatchObject({ captured: 7500, refunded: 2500, obligated: 7500, netPaid: 5000 });
    const history = await historyFor(f);
    expect(history[0].financials.totals).toContainEqual(expect.objectContaining({ captured: 7500, refunded: 2500, uncompletedRefundObligations: 5000 }));
    const successful = z.array(z.object({ id: z.uuid() })).length(1).parse(await database.query(
      "SELECT id FROM public.payment_refunds WHERE booking_id=$1 AND status='succeeded'", [f.id]))[0].id;
    expect(calls.filter(id => id === successful)).toHaveLength(1);
    recovered = true;
    // A webhook never replaces an execution after a retryable rejection; only an Admin check does.
    for (const id of request.refundIds) await webhookCheck(id);
    expect((await state(f)).booking?.status).toBe(failure === "temporary" ? "cancelled" : "confirmed");
    for (const id of request.refundIds) await adminCheck(id);
    expect(calls.filter(id => id === successful)).toHaveLength(1);
    if (failure === "external") {
      expect((await state(f)).booking).toEqual(before.booking);
      expect(await bookingFinancials(database.manager, f.id)).toMatchObject({ refunded: 2500, obligated: 7500, netPaid: 5000 });
      expect((await historyFor(f)).find(row => row.refund?.amount_minor === 5000)?.refund).toMatchObject({ status: "failed" });
    } else {
      expect(await state(f)).toMatchObject({ booking: { status: "cancelled" }, reservation: { status: "cancelled" } });
      expect(await bookingFinancials(database.manager, f.id)).toMatchObject({ refunded: 7500, netPaid: 0 });
    }
  } finally {
    await database.query("DELETE FROM public.booking_notification_deliveries WHERE message->>'text' LIKE $1", [`%${f.id}%`]);
  }
});

test("verification: concurrent duplicate webhooks and distinct replay events create one capture, revision and durable notification", async () => {
  simulatedStripe();
  const f = await seed(600, false, true);
  try {
    const event = paymentEvent(f);
    const results = await Promise.all([processOnlinePaymentEvent(event), processOnlinePaymentEvent(event),
      processOnlinePaymentEvent({ ...event, eventId: randomUUID() })]);
    expect(results).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(await database.query("SELECT id FROM public.payment_capture_receipts WHERE payment_attempt_id=$1", [f.attemptId])).toHaveLength(1);
    expect(await database.query("SELECT id FROM public.booking_revisions WHERE booking_id=$1 AND kind='confirmed'", [f.id])).toHaveLength(1);
    expect(await database.query("SELECT id FROM public.booking_notification_deliveries WHERE message->>'text' LIKE $1", [`%${f.id}%`])).toHaveLength(1);
  } finally {
    await database.query("DELETE FROM public.booking_notification_deliveries WHERE message->>'text' LIKE $1", [`%${f.id}%`]);
  }
});

test("verification: interrupted booking application after refund commit is completed by a later refund check without another refund", async () => {
  simulatedStripe();
  const f = await seed(600, true), request = await cancel(f);
  if (request.outcome !== "cancellation_pending") throw new Error("Missing pending cancellation");
  try {
    const failure = vi.spyOn(reservations, "updateCustomerReservationCancellation").mockRejectedValueOnce(new Error("simulated interruption"));
    expect(await refundProcessing.processBookingRefund(request.refundIds[0])).toBe("succeeded");
    failure.mockRestore();
    expect(await state(f)).toMatchObject({ booking: { status: "confirmed" }, reservation: { status: "active" },
      refunds: [expect.objectContaining({ status: "succeeded" })] });
    await webhookCheck(request.refundIds[0]); await webhookCheck(request.refundIds[0]);
    expect(await state(f)).toMatchObject({ booking: { status: "cancelled" }, reservation: { status: "cancelled" } });
    expect(stripeAdapter.refundPayment).toHaveBeenCalledOnce();
    expect(await database.query("SELECT id FROM public.booking_notification_deliveries WHERE message->>'text' LIKE $1", [`%${f.id}%`])).toHaveLength(1);
  } finally {
    await database.query("DELETE FROM public.booking_notification_deliveries WHERE message->>'text' LIKE $1", [`%${f.id}%`]);
  }
});

// Manual capture: a booking checkout authorizes only; the server captures inside the deadline.
function authorizedStripe(f: Fixture, capture: () => Promise<void> = async () => {}) {
  const outcomes = simulatedStripe();
  const intent = `pi-${f.attemptId}`;
  let status: "authorized" | "succeeded" | "cancelled" = "authorized";
  vi.mocked(stripeAdapter.readPayment).mockImplementation(async () => ({ status, amountMinor: 5000, currency: "RON",
    providerCaptureId: status === "succeeded" ? intent : null, live: false }));
  vi.spyOn(stripeAdapter, "capturePayment").mockImplementation(async () => {
    await capture();
    if (status === "authorized") status = "succeeded";
    return { status: status === "succeeded" ? "succeeded" : "cancelled", amountMinor: 5000, currency: "RON",
      providerCaptureId: status === "succeeded" ? intent : null };
  });
  vi.mocked(stripeAdapter.cancelPayment).mockImplementation(async () => {
    if (status === "authorized") status = "cancelled";
    return status === "succeeded" ? "succeeded" : "cancelled";
  });
  outcomes.clear();
  return { intent, status: () => status };
}
const holdOf = async (f: Fixture) => z.array(z.object({ hold: z.string().nullable(), deadline: z.string() })).parse(await database.query(
  `SELECT r.hold_expires_at::text AS hold,(p.expires_at+interval '120 seconds')::text AS deadline
   FROM public.court_reservations r JOIN public.payment_attempts p ON p.id=$2 WHERE r.id=$1`, [f.reservationId, f.attemptId]))[0];

test("a late authorization after the checkout deadline is cancelled at Stripe and never captured", async () => {
  const f = await seed(600, false, true), stripe = authorizedStripe(f);
  await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.reservationId]);
  expect(await resolveAuthorizedCheckoutPayment({ attemptId: f.attemptId, providerPaymentId: stripe.intent })).toBe("cancelled");
  expect(stripeAdapter.capturePayment).not.toHaveBeenCalled();
  expect(stripe.status()).toBe("cancelled");
  expect(await state(f)).toMatchObject({ booking: { status: "expired" }, reservation: { status: "released" }, refunds: [], events: [] });
  expect(await database.query("SELECT id FROM public.payment_capture_receipts WHERE payment_attempt_id=$1", [f.attemptId])).toEqual([]);
});

test("an authorization inside the deadline extends the hold by the capture grace, and concurrent webhook and poll confirm once", async () => {
  const f = await seed(600, false, true);
  let observedHold: Awaited<ReturnType<typeof holdOf>> | undefined;
  const stripe = authorizedStripe(f, async () => { observedHold ??= await holdOf(f); });
  const results = await Promise.all([resolveAuthorizedCheckoutPayment({ attemptId: f.attemptId, providerPaymentId: stripe.intent }),
    resolveAuthorizedCheckoutPayment({ attemptId: f.attemptId, providerPaymentId: stripe.intent })]);
  expect(results).toContain("succeeded");
  expect(results.every(result => result === "succeeded" || result === "processing")).toBe(true);
  expect(stripeAdapter.capturePayment).toHaveBeenCalledOnce();
  // Accepted before capture: the hold ends exactly at the attempt deadline plus the grace.
  expect(observedHold && Date.parse(observedHold.hold!.replace(" ", "T"))).toBe(observedHold && Date.parse(observedHold.deadline.replace(" ", "T")));
  expect(await state(f)).toMatchObject({ booking: { status: "confirmed" }, reservation: { status: "active" },
    events: [expect.objectContaining({ subject: "Booking confirmed" })] });
  expect(await database.query("SELECT id FROM public.payment_capture_receipts WHERE payment_attempt_id=$1", [f.attemptId])).toHaveLength(1);
  expect(await database.query("SELECT id FROM public.booking_revisions WHERE booking_id=$1 AND kind='confirmed'", [f.id])).toHaveLength(1);
  expect(stripeAdapter.cancelPayment).not.toHaveBeenCalled();
});

test("expiry/capture race: once accepted, the expiry sweep and customer cancellation cannot release the court mid-capture", async () => {
  const f = await seed(600, false, true), gate = deferred(), started = deferred();
  const stripe = authorizedStripe(f, async () => { started.resolve(); await gate.promise; });
  const resolving = resolveAuthorizedCheckoutPayment({ attemptId: f.attemptId, providerPaymentId: stripe.intent });
  await started.promise;
  // The attempt deadline passes while Stripe captures; durable acceptance keeps the hold.
  await database.transaction(m => setPaymentAttemptExpiryFixture(m, f.attemptId, new Date(Date.now() - 1000).toISOString()));
  await database.query(`UPDATE public.court_reservations r SET hold_expires_at=p.expires_at+interval '120 seconds'
    FROM public.payment_attempts p WHERE r.id=$1 AND p.id=$2`, [f.reservationId, f.attemptId]);
  await expirePaymentHolds({ courtId });
  expect(await state(f)).toMatchObject({ booking: { status: "pending_payment" }, reservation: { status: "held" } });
  const token = randomBytes(32).toString("hex");
  await database.query("UPDATE public.payment_attempts SET checkout_token_hash=$2 WHERE id=$1",
    [f.attemptId, createHash("sha256").update(token).digest("hex")]);
  await expect(abandonOnlineCheckout({ attemptId: f.attemptId, token })).rejects.toThrow("being confirmed");
  gate.resolve();
  expect(await resolving).toBe("succeeded");
  expect(await state(f)).toMatchObject({ booking: { status: "confirmed" }, reservation: { status: "active" }, refunds: [] });
});

test("accepted booking capture survives commit-to-dispatch delay and completion after grace with occupancy protected", async () => {
  const f = await seed(600, false, true), gate = deferred(), started = deferred();
  // Capture entry follows acceptance commit; delay the simulated provider dispatch.
  const stripe = authorizedStripe(f, async () => { started.resolve(); await gate.promise; });
  const resolving = resolveAuthorizedCheckoutPayment({ attemptId: f.attemptId, providerPaymentId: stripe.intent });
  await started.promise;
  await database.transaction(m => setPaymentAttemptExpiryFixture(m, f.attemptId, new Date(Date.now() - 121_000).toISOString()));
  await database.query(`UPDATE public.court_reservations r SET hold_expires_at=p.expires_at+interval '120 seconds'
    FROM public.payment_attempts p WHERE r.id=$1 AND p.id=$2`, [f.reservationId, f.attemptId]);
  await expirePaymentHolds({ courtId });
  expect(await state(f)).toMatchObject({ booking: { status: "pending_payment" }, reservation: { status: "held" } });
  expect(await reservations.listPublicDayOccupancy(database.manager, locationId, [courtId], date)).toHaveLength(1);
  expect(await reservations.findCheckoutOccupancy(database.manager, courtId, date)).toHaveLength(1);
  expect(await reservations.findReservationOccupancy(database.manager, { courtIds: [courtId] }, date, 0, 100))
    .toMatchObject([{ status: "held", capture_accepted: true }]);
  await expect(database.query(`INSERT INTO public.court_reservations(court_id,booking_date,starts_at_minute,ends_at_minute)
    VALUES($1,$2,600,660)`, [courtId, date])).rejects.toMatchObject({ code: "23P01" });
  vi.mocked(stripeAdapter.cancelPayment).mockResolvedValueOnce("processing");
  expect(await resolveAuthorizedCheckoutPayment({ attemptId: f.attemptId, providerPaymentId: stripe.intent })).toBe("processing");
  expect(stripeAdapter.capturePayment).toHaveBeenCalledOnce();
  expect(stripeAdapter.cancelPayment).toHaveBeenCalledOnce();
  expect(await state(f)).toMatchObject({ reservation: { status: "held" } });
  gate.resolve();
  expect(await resolving).toBe("succeeded");
  expect(await state(f)).toMatchObject({ booking: { status: "confirmed" }, reservation: { status: "active" }, refunds: [] });
  expect(await captureReceipts(f.attemptId)).toHaveLength(1);
});

test("an ambiguous accepted booking capture is observed without another application capture or cancellation", async () => {
  const f = await seed(600, false, true), stripe = authorizedStripe(f);
  vi.mocked(stripeAdapter.capturePayment).mockRejectedValueOnce(new Error("lost capture response"));
  await expect(resolveAuthorizedCheckoutPayment({ attemptId: f.attemptId, providerPaymentId: stripe.intent })).rejects.toThrow("lost capture response");
  expect(await resolveAuthorizedCheckoutPayment({ attemptId: f.attemptId, providerPaymentId: stripe.intent })).toBe("processing");
  expect(stripeAdapter.capturePayment).toHaveBeenCalledOnce();
  expect(stripeAdapter.cancelPayment).not.toHaveBeenCalled();
  expect(await state(f)).toMatchObject({ booking: { status: "pending_payment" }, reservation: { status: "held" }, refunds: [] });
  // Only a definitive provider cancellation frees the unresolved court.
  vi.mocked(stripeAdapter.readPayment).mockResolvedValue({ status: "cancelled", amountMinor: 5000,
    currency: "RON", providerCaptureId: null, live: false });
  expect(await resolveAuthorizedCheckoutPayment({ attemptId: f.attemptId, providerPaymentId: stripe.intent })).toBe("cancelled");
  expect(await state(f)).toMatchObject({ reservation: { status: "released" }, refunds: [] });
});

test("a late capture past the grace still never reclaims occupancy and is refunded with one customer notice", async () => {
  const f = await seed(600, false, true), gate = deferred(), started = deferred();
  const stripe = authorizedStripe(f, async () => { started.resolve(); await gate.promise; });
  const resolving = resolveAuthorizedCheckoutPayment({ attemptId: f.attemptId, providerPaymentId: stripe.intent });
  await started.promise;
  await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.reservationId]);
  await expirePaymentHolds({ courtId });
  gate.resolve();
  expect(await resolving).toBe("succeeded");
  expect(await state(f)).toMatchObject({ booking: { status: "expired" }, reservation: { status: "released" },
    refunds: [expect.objectContaining({ reason: "late_capture_compensation", status: "succeeded", amount_minor: 5000 })],
    events: [expect.objectContaining({ subject: "Payment received after checkout ended" })] });
});

// Manual capture for modification surcharges too: the customer only authorizes;
// the server captures inside the modification cutoff, otherwise cancels.
function authorizedSurcharge(capture: (providerPaymentId: string) => Promise<void> = async () => {}) {
  const outcomes = simulatedStripe();
  const amount = async (id: string) => z.array(z.object({ amount_minor: z.number() }))
    .parse(await database.query("SELECT amount_minor FROM public.payment_attempts WHERE id=$1", [id]))[0].amount_minor;
  vi.spyOn(stripeAdapter, "capturePayment").mockImplementation(async p => {
    await capture(p.providerPaymentId);
    if (outcomes.get(p.providerPaymentId) === "authorized") outcomes.set(p.providerPaymentId, "succeeded");
    const succeeded = outcomes.get(p.providerPaymentId) === "succeeded";
    return { status: succeeded ? "succeeded" : "cancelled", amountMinor: await amount(p.id), currency: "RON",
      providerCaptureId: succeeded ? p.providerPaymentId : null };
  });
  vi.mocked(stripeAdapter.cancelPayment).mockImplementation(async p => {
    if (outcomes.get(p.providerPaymentId) === "succeeded") return "succeeded";
    outcomes.set(p.providerPaymentId, "cancelled"); return "cancelled";
  });
  return outcomes;
}
async function surcharge(f: Fixture, extraHold = true) {
  if (!extraHold) await database.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=7500 WHERE location_id=$1 AND court_state='outdoor'", [locationId]);
  const result = await save(await edit(f, { courtId, startMinute: 600, endMinute: extraHold ? 690 : 660, expectedTotal: 7500, requestId: randomUUID() }));
  if (!result.ok || !result.adjustmentId || !result.checkout) throw new Error(`No surcharge checkout: ${JSON.stringify(result)}`);
  const attempt = await adjustmentAttempt(database.manager, result.adjustmentId);
  if (!attempt?.providerPaymentId) throw new Error("Missing surcharge payment");
  return { adjustmentId: result.adjustmentId, checkout: result.checkout,
    attempt: { id: attempt.id, providerPaymentId: attempt.providerPaymentId } };
}
const surchargeHolds = async (adjustmentId: string) => z.array(z.object({ status: z.string(), accepted: z.boolean().nullable() })).parse(
  await database.query(`SELECT r.status::text AS status,r.hold_expires_at=a.expires_at+interval '120 seconds' AS accepted
    FROM public.court_reservations r JOIN public.booking_adjustments a ON a.id=r.adjustment_id WHERE a.id=$1`, [adjustmentId]));
const captureReceipts = (attemptId: string) => database.query("SELECT id FROM public.payment_capture_receipts WHERE payment_attempt_id=$1", [attemptId]);

test("a surcharge is authorized only; concurrent webhook and status poll capture it once and apply the change once", async () => {
  const outcomes = authorizedSurcharge();
  const f = await seed(600, true), s = await surcharge(f), sent = (await emails(f.id)).length;
  // Same provider-neutral request as booking checkouts: the adapter always creates manual capture.
  expect(vi.mocked(stripeAdapter.createPayment).mock.calls.map(([call]) => call)).toEqual([{ id: s.attempt.id, amountMinor: 2500, currency: "RON" }]);
  outcomes.set(s.attempt.providerPaymentId, "authorized");
  const [webhook, poll] = await Promise.all([
    resolveAuthorizedCheckoutPayment({ attemptId: s.attempt.id, providerPaymentId: s.attempt.providerPaymentId }),
    readOnlineCheckout({ attemptId: s.checkout.attemptId, token: s.checkout.token })]);
  expect(webhook).toBe("succeeded");
  // A concurrent observer can finish before settlement commits; the next poll
  // sees confirmation without issuing another capture.
  expect(["pending_payment", "confirmed"]).toContain(poll.status);
  expect(await readOnlineCheckout({ attemptId: s.checkout.attemptId, token: s.checkout.token }))
    .toMatchObject({ status: "confirmed", paymentStatus: "succeeded" });
  expect(stripeAdapter.capturePayment).toHaveBeenCalledOnce();
  expect(stripeAdapter.cancelPayment).not.toHaveBeenCalled();
  // Every capture request concerns this attempt (stable court-capture-<attempt> idempotency key).
  expect(new Set(vi.mocked(stripeAdapter.capturePayment).mock.calls.map(([call]) => call.id))).toEqual(new Set([s.attempt.id]));
  expect(await captureReceipts(s.attempt.id)).toHaveLength(1);
  expect(await findAdjustment(database.manager, s.adjustmentId)).toMatchObject({ status: "applied" });
  expect(await state(f)).toMatchObject({ booking: { total_amount_minor: 7500 }, reservation: { ends_at_minute: 690 }, refunds: [] });
  expect(await emails(f.id)).toHaveLength(sent + 1);
  // A delayed payment_intent.succeeded webhook is a no-op.
  expect(await processOnlinePaymentEvent({ attemptId: s.attempt.id, provider: "stripe", providerPaymentId: s.attempt.providerPaymentId,
    eventId: randomUUID(), outcome: "succeeded", amountMinor: 2500, currency: "RON" })).toBe("succeeded");
  expect(await emails(f.id)).toHaveLength(sent + 1);
  expect(await database.query("SELECT id FROM public.booking_revisions WHERE adjustment_id=$1", [s.adjustmentId])).toHaveLength(1);
});

test.each(["cutoff", "dismissed", "amount"])("a surcharge authorization rejected by %s is cancelled at Stripe without collecting money", async reason => {
  const outcomes = authorizedSurcharge();
  const f = await seed(600, true), s = await surcharge(f), before = await state(f);
  // Only the immutable cutoff passes; the target holds themselves are still valid.
  if (reason === "cutoff") await database.transaction(m => setAdjustmentExpiryFixture(m, s.adjustmentId, new Date(Date.now() - 1000).toISOString()));
  if (reason === "dismissed") await database.transaction(m => revokeCheckoutCapability(m, s.attempt.id));
  outcomes.set(s.attempt.providerPaymentId, "authorized");
  if (reason === "amount") vi.mocked(stripeAdapter.readPayment).mockResolvedValue({ status: "authorized", amountMinor: 2400,
    currency: "RON", providerCaptureId: null, live: false });
  expect(await resolveAuthorizedCheckoutPayment({ attemptId: s.attempt.id, providerPaymentId: s.attempt.providerPaymentId })).toBe("cancelled");
  expect(stripeAdapter.capturePayment).not.toHaveBeenCalled();
  expect(outcomes.get(s.attempt.providerPaymentId)).toBe("cancelled");
  expect(await captureReceipts(s.attempt.id)).toEqual([]);
  expect((await findAdjustment(database.manager, s.adjustmentId))?.status).not.toBe("applied");
  expect((await surchargeHolds(s.adjustmentId)).map(hold => hold.status)).toEqual(["released"]);
  // The original booking, occupancy and money are untouched.
  expect(await state(f)).toEqual(before);
  expect(await bookingFinancials(database.manager, f.id)).toMatchObject({ captured: 5000, refunded: 0 });
});

test("a surcharge whose capture fails at Stripe preserves the original booking", async () => {
  const outcomes = authorizedSurcharge(async providerPaymentId => { outcomes.set(providerPaymentId, "cancelled"); });
  const f = await seed(600, true), s = await surcharge(f), before = await state(f);
  outcomes.set(s.attempt.providerPaymentId, "authorized");
  expect(await resolveAuthorizedCheckoutPayment({ attemptId: s.attempt.id, providerPaymentId: s.attempt.providerPaymentId })).toBe("cancelled");
  expect(await findAdjustment(database.manager, s.adjustmentId)).toMatchObject({ status: "cancelled" });
  expect(await captureReceipts(s.attempt.id)).toEqual([]);
  expect(await state(f)).toEqual(before);
  expect(await readOnlineCheckout({ attemptId: s.checkout.attemptId, token: s.checkout.token }))
    .toMatchObject({ status: "cancelled", paymentStatus: "cancelled" });
  expect(await bookingFinancials(database.manager, f.id)).toMatchObject({ captured: 5000, refunded: 0, netPaid: 5000 });
});

test.each([true, false])("accepted surcharge capture (extra hold: %s) survives concurrent expiry, dismissal and supersession after grace", async extraHold => {
  const gate = deferred(), started = deferred();
  const outcomes = authorizedSurcharge(async () => { started.resolve(); await gate.promise; });
  const f = await seed(600, true), s = await surcharge(f, extraHold), original = await state(f);
  outcomes.set(s.attempt.providerPaymentId, "authorized");
  const resolving = resolveAuthorizedCheckoutPayment({ attemptId: s.attempt.id, providerPaymentId: s.attempt.providerPaymentId });
  await started.promise;
  expect((await findAdjustment(database.manager, s.adjustmentId))?.captureAcceptedAt).toBeInstanceOf(Date);
  expect(await surchargeHolds(s.adjustmentId)).toEqual(extraHold ? [{ status: "held", accepted: true }] : []);
  // Advance the fixture's cutoff while keeping its durable acceptance before it.
  await database.transaction(m => setAdjustmentExpiryFixture(m, s.adjustmentId, new Date(Date.now() - 121_000).toISOString()));
  await database.query(`UPDATE public.court_reservations r SET hold_expires_at=a.expires_at+interval '120 seconds'
    FROM public.booking_adjustments a WHERE a.id=$1 AND r.adjustment_id=a.id`, [s.adjustmentId]);
  const acceptedAt = (await findAdjustment(database.manager, s.adjustmentId))!.captureAcceptedAt;
  const replacement = await edit(f, { courtId, startMinute: 600, endMinute: extraHold ? 690 : 660,
    expectedTotal: 7500, requestId: randomUUID() });
  const [, , superseded, cancelled, decline] = await Promise.all([
    readAdjustmentStatus(database.manager, s.adjustmentId), dismissAdjustment(s.adjustmentId), save(replacement), cancel(f),
    processOnlinePaymentEvent({ attemptId: s.attempt.id, provider: "stripe", providerPaymentId: s.attempt.providerPaymentId,
      eventId: randomUUID(), outcome: "retryable_failed", amountMinor: 2500, currency: "RON" }),
    // An out-of-order processing signal must not change the acceptance hold marker.
    (await import("@/lib/payments/hold-expiry")).extendLiveAdjustmentHold(s.attempt.id, s.attempt.providerPaymentId),
  ]);
  expect(superseded).toMatchObject({ ok: false, message: expect.stringContaining("still processing") });
  expect(cancelled).toMatchObject({ outcome: "change_pending" });
  expect(decline).toBe("pending");
  expect(await listBookingsWithLivePayment(database.manager, [f.id])).toEqual(new Set([f.id]));
  expect(stripeAdapter.dismissPayment).not.toHaveBeenCalled();
  expect(await surchargeHolds(s.adjustmentId)).toEqual(extraHold ? [{ status: "held", accepted: true }] : []);
  expect(await findAdjustment(database.manager, s.adjustmentId)).toMatchObject({ status: "pending", captureAcceptedAt: acceptedAt });
  expect(await state(f)).toEqual(original);
  // Stripe cannot cancel while processing; recovery preserves the held court.
  vi.mocked(stripeAdapter.cancelPayment).mockResolvedValueOnce("processing");
  expect(await resolveAuthorizedCheckoutPayment({ attemptId: s.attempt.id, providerPaymentId: s.attempt.providerPaymentId })).toBe("processing");
  expect(stripeAdapter.capturePayment).toHaveBeenCalledOnce();
  const occupancy = await reservations.listPublicDayOccupancy(database.manager, locationId, [courtId], date);
  expect(occupancy).toHaveLength(extraHold ? 2 : 1);
  expect(await reservations.listCustomerEditOccupancy(database.manager, locationId, date, f.reservationId)).toHaveLength(extraHold ? 1 : 0);
  gate.resolve();
  expect(await resolving).toBe("succeeded");
  expect(await findAdjustment(database.manager, s.adjustmentId)).toMatchObject({ status: "applied", captureAcceptedAt: acceptedAt });
  expect(await state(f)).toMatchObject({ booking: { total_amount_minor: 7500 }, reservation: { ends_at_minute: extraHold ? 690 : 660 }, refunds: [] });
  expect(await captureReceipts(s.attempt.id)).toHaveLength(1);
  expect(await database.query("SELECT id FROM public.booking_revisions WHERE adjustment_id=$1", [s.adjustmentId])).toHaveLength(1);
  // The acceptance record is write-once even after completion.
  await expect(database.query("UPDATE public.booking_adjustments SET capture_accepted_at=NULL WHERE id=$1", [s.adjustmentId]))
    .rejects.toThrow("Capture acceptance is immutable");
});

test.each([true, false])("accepted surcharge authorization (extra hold: %s) is cancelled after an interrupted dispatch past grace", async extraHold => {
  const outcomes = authorizedSurcharge(), f = await seed(600, true), s = await surcharge(f, extraHold), original = await state(f);
  // Simulate a process stopping after acceptance committed, before the provider call.
  const { acceptAdjustmentCapture } = await import("@/lib/db/repositories/booking-adjustments.repository");
  await inTransaction(async manager => {
    await lockLocationsForAcceptance(manager, f, s.attempt.id);
    expect(await acceptAdjustmentCapture(manager, s.adjustmentId)).toBe(true);
  });
  await database.transaction(m => setAdjustmentExpiryFixture(m, s.adjustmentId, new Date(Date.now() - 121_000).toISOString()));
  outcomes.set(s.attempt.providerPaymentId, "authorized");
  expect(await resolveAuthorizedCheckoutPayment({ attemptId: s.attempt.id, providerPaymentId: s.attempt.providerPaymentId })).toBe("cancelled");
  expect(stripeAdapter.capturePayment).not.toHaveBeenCalled();
  expect(await captureReceipts(s.attempt.id)).toEqual([]);
  expect(await state(f)).toEqual(original);
  expect(stripeAdapter.cancelPayment).toHaveBeenCalledOnce();
  await expirePaymentHolds({ courtId });
  expect(await findAdjustment(database.manager, s.adjustmentId)).toMatchObject({ status: "expired" });
  expect((await surchargeHolds(s.adjustmentId)).every(hold => hold.status === "released")).toBe(true);
  expect((await adjustmentAttempt(database.manager, s.adjustmentId))?.status).toBe("cancelled");
});

async function lockLocationsForAcceptance(manager: EntityManager, f: Fixture, attemptId: string) {
  await clubs.lockLocations(manager, [locationId]);
  await bookings.findBookingForUpdate(manager, f.id);
  await reservations.findReservationForUpdate(manager, f.reservationId);
  await payments.lockSettlementAttempt(manager, attemptId);
}

test("the same refund reversal delivered repeatedly keeps one reversal notice and the financial history", async () => {
  simulatedStripe();
  const f = await seed(600, false, true);
  await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.reservationId]);
  await expirePaymentHolds({ courtId });
  // A late capture is fully refunded automatically (no refund-backed change waits on it).
  expect(await processOnlinePaymentEvent(paymentEvent(f), { strict: true })).toBe("expired");
  const [refund] = z.array(z.object({ id: z.uuid(), status: z.string() })).parse((await state(f)).refunds);
  expect(refund.status).toBe("succeeded");
  vi.mocked(stripeAdapter.refundPayment).mockImplementation(async p => ({ providerRefundId: p.providerRefundId ?? `re_${p.id}`,
    status: "failed", failureReason: "expired_or_canceled_card" }));
  // Stripe redelivers refund.failed / refund.updated; an Admin also checks it.
  for (let delivery = 0; delivery < 3; delivery++)
    expect(await refundProcessing.processBookingRefund(refund.id, { strict: true, providerChanged: true })).toBe("failed");
  expect(await refundProcessing.processBookingRefund(refund.id, { actorId, retryRejected: true, strict: true })).toBe("failed");
  expect(await refundProcessing.processBookingRefund(refund.id)).toBe("failed");
  expect((await database.query("SELECT event_key FROM public.booking_notification_deliveries WHERE event_key LIKE $1 ORDER BY event_key",
    [`refund:${refund.id}:%`])).map((row: { event_key: string }) => row.event_key))
    .toEqual([`refund:${refund.id}:late_payment`, `refund:${refund.id}:reversed`]);
  expect((await emails(f.id)).map(email => email.subject)).toEqual(["Payment received after checkout ended", "Refund requires attention"]);
  const executions = await refundExecutions.listRefundExecutions(database.manager, refund.id);
  expect(executions).toHaveLength(1);
  expect(executions[0]).toMatchObject({ terminalResult: "succeeded", lastError: "provider_refund_reversed" });
  expect((await state(f)).refunds).toMatchObject([{ status: "failed" }]);
});

// Signed-webhook processing never acknowledges unfinished financial work.
test("refund webhook: a failed booking update after the refund commit propagates, and redelivery completes it once", async () => {
  simulatedStripe();
  const f = await seed(600, true), request = await cancel(f);
  if (request.outcome !== "cancellation_pending") throw new Error("Missing pending cancellation");
  vi.mocked(stripeAdapter.refundPayment).mockRejectedValueOnce(new Error("timeout"));
  expect(await refundProcessing.processBookingRefund(request.refundIds[0])).toBe("pending_retry");
  const failure = vi.spyOn(reservations, "updateCustomerReservationCancellation").mockRejectedValueOnce(new Error("simulated database failure"));
  await expect(refundProcessing.processBookingRefund(request.refundIds[0], { strict: true, providerChanged: true }))
    .rejects.toBeInstanceOf(refundProcessing.RefundProcessingError);
  failure.mockRestore();
  expect(await state(f)).toMatchObject({ booking: { status: "confirmed" }, refunds: [expect.objectContaining({ status: "succeeded" })] });
  expect(await refundProcessing.processBookingRefund(request.refundIds[0], { strict: true, providerChanged: true })).toBe("succeeded");
  expect(await state(f)).toMatchObject({ booking: { status: "cancelled" }, reservation: { status: "cancelled" } });
  expect(await refundExecutions.listRefundExecutions(database.manager, request.refundIds[0])).toHaveLength(1);
  expect(await emails(f.id)).toHaveLength(1);
});

test("refund webhook: Stripe unreachable during the check propagates instead of acknowledging", async () => {
  simulatedStripe();
  const f = await seed(600, true), request = await cancel(f);
  if (request.outcome !== "cancellation_pending") throw new Error("Missing pending cancellation");
  vi.mocked(stripeAdapter.refundPayment).mockRejectedValueOnce(new Error("timeout")).mockRejectedValueOnce(new Error("still down"));
  expect(await refundProcessing.processBookingRefund(request.refundIds[0])).toBe("pending_retry");
  await expect(refundProcessing.processBookingRefund(request.refundIds[0], { strict: true })).rejects.toThrow("Stripe did not confirm the refund.");
  expect(await refundProcessing.processBookingRefund(request.refundIds[0], { strict: true })).toBe("succeeded");
  const keys = vi.mocked(stripeAdapter.refundPayment).mock.calls.map(([call]) => call.idempotencyKey);
  expect(new Set(keys).size).toBe(1);
});

test("payment webhook redelivery re-drives an unfinished late-capture refund even though its receipt is a replay", async () => {
  simulatedStripe();
  const f = await seed(600, false, true);
  await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.reservationId]);
  await expirePaymentHolds({ courtId });
  vi.mocked(stripeAdapter.refundPayment).mockRejectedValue(new Error("Stripe unavailable"));
  const event = paymentEvent(f);
  await expect(processOnlinePaymentEvent(event, { strict: true })).rejects.toThrow();
  expect((await state(f)).refunds).toMatchObject([{ status: "pending_retry", reason: "late_capture_compensation" }]);
  vi.mocked(stripeAdapter.refundPayment).mockImplementation(async p => ({ providerRefundId: `re_${p.id}`, status: "succeeded" }));
  expect(await processOnlinePaymentEvent(event, { strict: true })).toBe("expired");
  expect(await processOnlinePaymentEvent(event, { strict: true })).toBe("expired");
  expect((await state(f)).refunds).toMatchObject([{ status: "succeeded", amount_minor: 5000 }]);
  expect(await database.query("SELECT id FROM public.payment_capture_receipts WHERE payment_attempt_id=$1", [f.attemptId])).toHaveLength(1);
  expect(await emails(f.id)).toMatchObject([{ subject: "Payment received after checkout ended" }]);
});

test("refund success followed by Stripe refund.failed is recorded as the current exception without a replacement refund", async () => {
  simulatedStripe();
  const f = await seed(600, true), request = await cancel(f);
  if (request.outcome !== "cancellation_pending") throw new Error("Missing pending cancellation");
  expect(await refundProcessing.processBookingRefund(request.refundIds[0])).toBe("succeeded");
  const [success] = await refundExecutions.listRefundExecutions(database.manager, request.refundIds[0]);
  expect(await bookingFinancials(database.manager, f.id)).toMatchObject({ refunded: 5000, netPaid: 0 });
  // refund.updated while still succeeded changes nothing.
  expect(await refundProcessing.processBookingRefund(request.refundIds[0], { strict: true, providerChanged: true })).toBe("succeeded");
  vi.mocked(stripeAdapter.refundPayment).mockImplementation(async p => ({ providerRefundId: p.providerRefundId ?? `re_${p.id}`,
    status: "failed", failureReason: "expired_or_canceled_card" }));
  for (let delivery = 0; delivery < 2; delivery++)
    expect(await refundProcessing.processBookingRefund(request.refundIds[0], { strict: true, providerChanged: true })).toBe("failed");
  expect(await refundProcessing.processBookingRefund(request.refundIds[0], { actorId, retryRejected: true, strict: true })).toBe("failed");
  const executions = await refundExecutions.listRefundExecutions(database.manager, request.refundIds[0]);
  expect(executions).toHaveLength(1);
  expect(executions[0]).toMatchObject({ id: success.id, terminalResult: "succeeded", terminalEvidence: success.terminalEvidence,
    providerRefundId: success.providerRefundId, lastError: "provider_refund_reversed" });
  expect(vi.mocked(stripeAdapter.refundPayment).mock.calls.filter(([call]) => call.operation !== "recover")).toHaveLength(1);
  expect(await bookingFinancials(database.manager, f.id)).toMatchObject({ refunded: 0, netPaid: 5000 });
  expect((await state(f)).refunds).toMatchObject([{ status: "failed" }]);
  expect((await historyFor(f)).find(row => row.refund?.id === request.refundIds[0])?.refund).toMatchObject({ status: "failed", last_error: "provider_refund_reversed" });
  expect(await emails(f.id)).toMatchObject([{ subject: "Booking cancelled" }, { subject: "Refund requires attention" }]);
  expect(await database.query("SELECT requires_acknowledgement FROM public.booking_notification_deliveries WHERE event_key=$1",
    [`refund:${request.refundIds[0]}:reversed`])).toEqual([{ requires_acknowledgement: true }]);
});

test("an unresolved refund of a pending cancellation notifies the customer once and keeps the obligation", async () => {
  simulatedStripe();
  const f = await seed(600, true), before = await state(f), request = await cancel(f);
  if (request.outcome !== "cancellation_pending") throw new Error("Missing pending cancellation");
  const { RefundProviderError } = await import("@/lib/payments/providers/types");
  vi.mocked(stripeAdapter.refundPayment).mockRejectedValue(new RefundProviderError({ kind: "not_found", operation: "discover", providerRefundId: null }));
  for (let check = 0; check < 2; check++) expect(await refundProcessing.processBookingRefund(request.refundIds[0])).toBe("pending_retry");
  const after = await state(f);
  expect(after.booking).toEqual(before.booking); expect(after.reservation).toEqual(before.reservation);
  expect(after.refunds).toMatchObject([{ status: "pending_retry", amount_minor: 5000 }]);
  expect(await database.query("SELECT status FROM public.booking_adjustments WHERE id=$1", [request.adjustmentId])).toEqual([{ status: "pending" }]);
  expect(await emails(f.id)).toMatchObject([{ subject: "Refund requires attention" }]);
  expect(await database.query("SELECT requires_acknowledgement,acknowledged_at FROM public.booking_notification_deliveries WHERE booking_id=$1", [f.id]))
    .toEqual([{ requires_acknowledgement: true, acknowledged_at: null }]);
});

async function interruptedBooking(f: Fixture, pastGrace = true) {
  await inTransaction(async manager => {
    await lockLocationsForAcceptance(manager, f, f.attemptId);
    expect(await reservations.extendCheckoutHoldForCapture(manager,
      { reservationId: f.reservationId, attemptId: f.attemptId, graceSeconds: 120 })).toBe(true);
  });
  if (pastGrace) {
    await database.transaction(m => setPaymentAttemptExpiryFixture(m, f.attemptId, new Date(Date.now() - 121_000).toISOString()));
    await database.query(`UPDATE public.court_reservations r SET hold_expires_at=p.expires_at+interval '120 seconds'
      FROM public.payment_attempts p WHERE r.id=$1 AND p.id=$2`, [f.reservationId, f.attemptId]);
  }
}
const paymentAttention = (bookingId: string) => readFinancialHistory(database.manager, { page: 1, status: "all",
  provider: "all", method: "all", attention: true, search: "", sort: "date", direction: "desc",
  bookingId, attentionRefundStatuses: ["failed"] });

test.each(["authorized", "pending", "succeeded", "unreachable", "cancel-race", "processing"] as const)(
  "interrupted capture recovery: Stripe %s uses evidence and protects occupancy until terminal", async outcome => {
    const f = await seed(600, false, true), stripe = authorizedStripe(f);
    await interruptedBooking(f);
    expect((await paymentAttention(f.id)).rows).toMatchObject([{ payment_check_required: true }]);
    if (outcome === "unreachable") vi.mocked(stripeAdapter.readPayment).mockRejectedValue(new Error("Stripe temporarily unavailable"));
    else if (outcome !== "authorized" && outcome !== "cancel-race") vi.mocked(stripeAdapter.readPayment).mockResolvedValue({
      status: outcome, amountMinor: 5000, currency: "RON", providerCaptureId: outcome === "succeeded" ? stripe.intent : null });
    if (outcome === "processing") vi.mocked(stripeAdapter.cancelPayment).mockResolvedValue("processing");
    if (outcome === "cancel-race") vi.mocked(stripeAdapter.cancelPayment).mockImplementation(async () => {
      // Capture wins at Stripe before cancellation; its late success remains legitimate.
      vi.mocked(stripeAdapter.readPayment).mockResolvedValue({ status: "succeeded", amountMinor: 5000,
        currency: "RON", providerCaptureId: stripe.intent });
      return "succeeded";
    });
    if (outcome === "unreachable") await expect(checkOnlinePayment(f.attemptId)).rejects.toThrow("temporarily unavailable");
    else expect(await checkOnlinePayment(f.attemptId)).toBe(outcome === "succeeded" || outcome === "cancel-race" ? "succeeded"
      : outcome === "processing" ? "processing" : "cancelled");
    const unresolved = outcome === "unreachable" || outcome === "processing";
    expect(await state(f)).toMatchObject({ reservation: { status: unresolved ? "held"
      : outcome === "succeeded" || outcome === "cancel-race" ? "active" : "released" }, refunds: [] });
    expect(await reservations.listPublicDayOccupancy(database.manager, locationId, [courtId], date)).toHaveLength(
      unresolved || outcome === "succeeded" || outcome === "cancel-race" ? 1 : 0);
    expect((await paymentAttention(f.id)).total).toBe(unresolved ? 1 : 0);
    expect(stripeAdapter.capturePayment).not.toHaveBeenCalled();
    if (outcome === "succeeded" || outcome === "cancel-race") expect(await captureReceipts(f.attemptId)).toHaveLength(1);
  });

test("interrupted capture recovery during grace observes without capturing or cancelling", async () => {
  const f = await seed(600, false, true); authorizedStripe(f);
  await interruptedBooking(f, false);
  expect(await checkOnlinePayment(f.attemptId)).toBe("processing");
  expect(stripeAdapter.cancelPayment).not.toHaveBeenCalled();
  expect(stripeAdapter.capturePayment).not.toHaveBeenCalled();
  expect(await state(f)).toMatchObject({ reservation: { status: "held" } });
});

test.each([false, true])("expired checkout cleanup cancels its active Stripe intent (locally expired: %s)", async expired => {
  const outcomes = simulatedStripe(), f = await seed(600, false, true);
  await database.transaction(m => setPaymentAttemptExpiryFixture(m, f.attemptId, new Date(Date.now() - 121_000).toISOString()));
  await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '121 seconds' WHERE id=$1", [f.reservationId]);
  if (expired) await expirePaymentHolds({ courtId });
  const token = randomBytes(32).toString("hex");
  await database.query("UPDATE public.payment_attempts SET checkout_token_hash=$2 WHERE id=$1",
    [f.attemptId, createHash("sha256").update(token).digest("hex")]);
  expect(await readOnlineCheckout({ attemptId: f.attemptId, token })).toMatchObject({
    status: "expired", paymentStatus: "cancelled", paymentUncertain: false,
  });
  expect(outcomes.get(`pi-${f.attemptId}`)).toBe("cancelled");
  expect(await state(f)).toMatchObject({ booking: { status: "expired" }, reservation: { status: "released" } });
  expect((await payments.findCheckoutAttempt(database.manager, f.attemptId))?.status).toBe("cancelled");
  expect((await paymentAttention(f.id)).total).toBe(0);
});

test("old client secret authorization after local expiry never captures or reclaims the court", async () => {
  const f = await seed(600, false, true), stripe = authorizedStripe(f);
  await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.reservationId]);
  await expirePaymentHolds({ courtId });
  // The old client secret can authorize remotely despite the local expired row.
  expect(await resolveAuthorizedCheckoutPayment({ attemptId: f.attemptId, providerPaymentId: stripe.intent })).toBe("cancelled");
  expect(stripeAdapter.capturePayment).not.toHaveBeenCalled();
  expect(await state(f)).toMatchObject({ booking: { status: "expired" }, reservation: { status: "released" }, refunds: [] });
  expect(stripe.status()).toBe("cancelled");
});

test("expired surcharge polling cancels its unused intent and releases only its extra occupancy", async () => {
  const outcomes = authorizedSurcharge(), f = await seed(600, true), s = await surcharge(f);
  await expireAdjustmentFixture(s.adjustmentId);
  expect(await readOnlineCheckout({ attemptId: s.attempt.id, token: s.checkout.token }))
    .toMatchObject({ status: "expired", paymentStatus: "expired", paymentUncertain: false });
  expect(outcomes.get(s.attempt.providerPaymentId)).toBe("cancelled");
  expect((await adjustmentAttempt(database.manager, s.adjustmentId))?.status).toBe("cancelled");
  expect(await surchargeHolds(s.adjustmentId)).toMatchObject([{ status: "released" }]);
  expect(await state(f)).toMatchObject({ booking: { status: "confirmed", total_amount_minor: 5000 },
    reservation: { status: "active" }, refunds: [] });
  expect(stripeAdapter.capturePayment).not.toHaveBeenCalled();
});
