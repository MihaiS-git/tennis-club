const sent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notifications/booking-email", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/notifications/booking-email")>(), sendBookingNotification: sent,
}));
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { QueryFailedError, type DataSource, type EntityManager } from "typeorm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { getDataSource } from "@/lib/db/data-source";
import { expirePaymentHolds } from "@/lib/payments/hold-expiry";
import { inTransaction } from "@/lib/db/transaction";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as accounts from "@/lib/db/repositories/accounts.repository";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import { createDirectReservationCommand } from "@/lib/reservations/commands";
import { runBookingReschedule } from "@/lib/bookings/reschedule";
import { readCustomerBookingEditContext } from "@/lib/bookings/commands";
import { processOnlinePaymentEvent } from "@/lib/payments/service";
import { createCustomerBooking } from "@/lib/bookings/service";
import { commitCustomerCheckout } from "@/lib/bookings/checkout";
import { startOnlineCheckout, readOnlineCheckout } from "@/lib/payments/checkout";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";

let database: DataSource, service: SupabaseClient, guest: SupabaseClient, member: SupabaseClient;
let userId: string, previousProvider: string | null;
const locationId = randomUUID(), courtId = randomUUID(), ruleSetId = randomUUID();
const date = "2099-10-15", now = new Date("2099-10-14T12:00:00Z");
const input = { paymentMethod: "pay_at_club", courtId, date, startMinute: 600, endMinute: 660,
  customerName: "  Guest Name  ", customerEmail: "  Guest@Example.test  ", customerPhone: "  +40 123  ",
  expectedTotalAmountMinor: 5000, expectedCurrency: "RON" };
const { createPayment } = vi.hoisted(() => ({ createPayment: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => guest }));
vi.mock("@/lib/payments/providers/stripe/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/providers/stripe/client")>("@/lib/payments/providers/stripe/client");
  return { ...actual, stripeClient: () => ({ paymentIntents: { create: createPayment } }) };
});

beforeAll(async () => {
  const url = process.env.DATABASE_URL!;
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url).hostname);
  vi.stubEnv("DATABASE_URL", url); vi.stubEnv("DATABASE_POOL_MAX", "8");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_Fixture"); vi.stubEnv("STRIPE_PUBLISHABLE_KEY", "pk_test_Fixture");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_Fixture");
  database = await getDataSource(); service = localFixtureClient();
  previousProvider = await payments.findSelectedPaymentProvider(database.manager);
  const reader = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  guest = reader(); member = reader();
  const email = `checkout-${randomUUID()}@example.test`, password = "checkout-race-password-123";
  const user = await service.auth.admin.createUser({ email, password, email_confirm: true });
  expect(user.error).toBeNull(); if (!user.data.user) throw new Error("Missing checkout actor");
  userId = user.data.user.id;
  expect((await member.auth.signInWithPassword({ email, password })).error).toBeNull();
  await database.query(`INSERT INTO public.locations(id,name,slug,timezone,currency,is_public,allow_pay_at_club)
    VALUES($1,'Checkout fixture',$2,'UTC','RON',true,true)`, [locationId, `checkout-${locationId}`]);
  await database.query(`INSERT INTO public.courts(id,location_id,name,slug,surface,environment)
    VALUES($1,$2,'Court','court','clay','outdoor')`, [courtId, locationId]);
  await database.query("INSERT INTO public.pricing_rule_sets(id,location_id) VALUES($1,$2)", [ruleSetId, locationId]);
});

async function clearBookings() {
  await database.query("DELETE FROM public.bookings WHERE reservation_id IN (SELECT id FROM public.court_reservations WHERE court_id=$1)", [courtId]);
  await database.query("DELETE FROM public.court_reservations WHERE court_id=$1", [courtId]);
}
beforeEach(async () => {
  await clearBookings(); createPayment.mockReset(); sent.mockReset();
  await database.query("UPDATE public.users SET status='active' WHERE id=$1", [userId]);
  await database.query("UPDATE public.payment_provider_settings SET active_provider='stripe' WHERE id");
  await database.query("UPDATE public.locations SET is_active=true,is_public=true,archived_at=null,allow_pay_at_club=true WHERE id=$1", [locationId]);
  await database.query("UPDATE public.courts SET is_active=true WHERE id=$1", [courtId]);
  await database.query("DELETE FROM public.location_pricing_rules WHERE location_id=$1", [locationId]);
  await database.query("DELETE FROM public.court_coverage_periods WHERE court_id=$1", [courtId]);
  await database.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [locationId]);
  await database.query("INSERT INTO public.location_opening_hours(location_id,weekday,opens_at_minute,closes_at_minute) VALUES($1,3,0,1440)", [locationId]);
  await database.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
    VALUES($1,$2,$3,'outdoor',3,0,1440,5000)`, [locationId, ruleSetId, courtId]);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try {
    if (database?.isInitialized) {
      await clearBookings();
      await database.query("UPDATE public.payment_provider_settings SET active_provider=$1 WHERE id", [previousProvider]);
      await database.query("DELETE FROM public.pricing_rule_sets WHERE id=$1", [ruleSetId]);
      await database.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [locationId]);
      await database.query("DELETE FROM public.court_coverage_periods WHERE court_id=$1", [courtId]);
      await database.query("DELETE FROM public.courts WHERE id=$1", [courtId]);
      await database.query("DELETE FROM public.locations WHERE id=$1", [locationId]);
      await cleanupAuthFixtures(service, [userId]);
    }
  } finally { if (database?.isInitialized) await database.destroy(); vi.unstubAllEnvs(); }
});

async function counts() {
  const rows: unknown = await database.query(`SELECT
    (SELECT count(*)::integer FROM public.court_reservations WHERE court_id=$1) AS reservations,
    (SELECT count(*)::integer FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id WHERE r.court_id=$1) AS bookings,
    (SELECT count(*)::integer FROM public.payment_attempts p JOIN public.bookings b ON b.id=p.booking_id JOIN public.court_reservations r ON r.id=b.reservation_id WHERE r.court_id=$1) AS attempts`, [courtId]);
  return z.array(z.object({ reservations: z.number(), bookings: z.number(), attempts: z.number() })).length(1).parse(rows)[0];
}
async function stored() {
  return database.query(`SELECT b.id,b.account_user_id,b.customer_name,b.customer_email,b.customer_phone,b.status AS booking_status,
    b.total_amount_minor,b.currency,b.payment_method,r.id AS reservation_id,r.status AS reservation_status,r.reason,r.created_by_user_id,
    r.hold_expires_at::text,p.id AS attempt_id,p.status AS attempt_status,p.provider,p.provider_payment_id,p.checkout_token_hash,
    p.expires_at::text,p.completed_at,p.amount_minor FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id
    JOIN public.payment_attempts p ON p.booking_id=b.id WHERE r.court_id=$1 ORDER BY r.starts_at_minute,b.created_at`, [courtId]);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve };
}
async function pid(manager: EntityManager) {
  const rows: unknown = await manager.query("SELECT pg_backend_pid() AS pid");
  return z.array(z.object({ pid: z.number() })).length(1).parse(rows)[0].pid;
}
async function waitForBlock(blocker: number) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows: unknown = await database.query("SELECT pid,query FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [blocker]);
    const blocked = z.array(z.object({ pid: z.number(), query: z.string() })).parse(rows);
    if (blocked.length) return blocked;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected checkout PostgreSQL lock wait was not observed.");
}
async function online() {
  const result = await createCustomerBooking({ ...input, paymentMethod: "online" }, guest, now);
  if (!result.ok || result.status !== "pending_payment") throw new Error(JSON.stringify(result));
  return result;
}

test.each(["pay_at_club", "online"] as const)("concurrent identical %s submissions commit one complete booking, never idempotent success", async (method) => {
  // Hold the winning INSERT while the contender waits on the location mutex.
  // The loser must reject in TypeScript before attempting its own INSERT.
  const acquired = deferred<number>(), release = deferred<void>(); const insert = reservations.insertCustomerReservation;
  const write = vi.spyOn(reservations, "insertCustomerReservation").mockImplementationOnce(async (...args) => {
    await insert(...args); acquired.resolve(await pid(args[0])); await release.promise;
  });
  const first = createCustomerBooking({ ...input, paymentMethod: method }, guest, now);
  const blocker = await acquired.promise;
  const second = createCustomerBooking({ ...input, paymentMethod: method }, guest, now);
  try { expect((await waitForBlock(blocker))[0].query).toContain("locations"); }
  finally { release.resolve(); }
  const results = await Promise.all([first, second]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toEqual({ ok: false, availabilityChanged: true,
    message: "That court is no longer available for the selected time." });
  expect(write).toHaveBeenCalledTimes(1);
  expect(await counts()).toEqual({ reservations: 1, bookings: 1, attempts: 1 });
});

test("Pay at club commits contact/policy snapshots and due payment plus exact confirmation payload", async () => {
  expect(await createCustomerBooking(input, guest, now)).toMatchObject({ ok: true, status: "confirmed", holdExpiresAt: null,
    cancellationPolicy: { noticeMinutes: 1440, cutoff: null } });
  expect(await stored()).toMatchObject([{ account_user_id: null, customer_name: "Guest Name", customer_email: "Guest@Example.test",
    customer_phone: "+40 123", booking_status: "confirmed", reservation_status: "active", reason: null, created_by_user_id: null,
    attempt_status: "due", provider: null, provider_payment_id: null, checkout_token_hash: null, hold_expires_at: null, expires_at: null,
    total_amount_minor: 5000, amount_minor: 5000, currency: "RON" }]);
  const events = sent.mock.calls.map(([event]) => event);
  expect(events).toEqual([{ event_kind: "confirmed", recipient: "Guest@Example.test", payload: {
    booking_id: expect.any(String), customer_name: "Guest Name", location_name: "Checkout fixture", timezone: "UTC", court_name: "Court",
    booking_date: date, starts_at_minute: 600, ends_at_minute: 660, total_amount_minor: 5000, currency: "RON", previous: null,
  } }]);
});

test("online creation shares the full-precision DB deadline and initialization attaches only ID/capability", async () => {
  const created = await online(); const before = await stored();
  expect(before).toMatchObject([{ booking_status: "pending_payment", reservation_status: "held", attempt_status: "pending",
    provider: "stripe", provider_payment_id: null, checkout_token_hash: null, amount_minor: 5000, completed_at: null }]);
  const rows: unknown = await database.query(`SELECT r.hold_expires_at=p.expires_at AS same,
    extract(epoch FROM (r.hold_expires_at - r.created_at)) AS duration
    FROM public.court_reservations r JOIN public.bookings b ON b.reservation_id=r.id JOIN public.payment_attempts p ON p.booking_id=b.id WHERE r.court_id=$1`, [courtId]);
  const clock = z.array(z.object({ same: z.boolean(), duration: z.string() })).parse(rows)[0];
  expect(clock.same).toBe(true); expect(Number(clock.duration)).toBeGreaterThanOrEqual(600); expect(Number(clock.duration)).toBeLessThan(605);
  createPayment.mockImplementation(async () => {
    const transactions: unknown = await database.query("SELECT pid FROM pg_stat_activity WHERE application_name <> 'supabase_admin' AND state='idle in transaction'");
    expect(transactions).toEqual([]);
    return { id: "pi_phase5", client_secret: "pi_phase5_secret" };
  });
  const checkout = await startOnlineCheckout(created.paymentAttemptId);
  expect(checkout).toMatchObject({ attemptId: created.paymentAttemptId, token: expect.stringMatching(/^[a-f0-9]{64}$/),
    presentation: { kind: "stripe", clientSecret: "pi_phase5_secret" } });
  expect(createPayment).toHaveBeenCalledWith({ amount: 5000, currency: "ron", allowed_payment_method_types: ["card"],
    metadata: { payment_attempt_id: created.paymentAttemptId } }, { idempotencyKey: `court-payment-${created.paymentAttemptId}` });
  expect(await counts()).toEqual({ reservations: 1, bookings: 1, attempts: 1 });
  await expect(readOnlineCheckout({ attemptId: checkout.attemptId, token: "0".repeat(64) })).rejects.toThrow();
  expect(await readOnlineCheckout({ attemptId: checkout.attemptId, token: checkout.token })).toMatchObject({ status: "pending_payment", totalAmountMinor: 5000, currency: "RON" });
});

async function changeConfiguration(manager: EntityManager, kind: "hours" | "resource" | "pricing") {
  await clubs.lockConfigurationForWrite(manager); await clubs.lockLocations(manager, [locationId]);
  if (kind === "resource") await manager.query("UPDATE public.courts SET is_active=false WHERE id=$1", [courtId]);
  else if (kind === "pricing") await manager.query("UPDATE public.location_pricing_rules SET price_per_hour_minor=7000 WHERE location_id=$1", [locationId]);
  else {
    await manager.query("UPDATE public.location_pricing_rules SET ends_at_minute=600 WHERE location_id=$1", [locationId]);
    await manager.query("UPDATE public.location_opening_hours SET closes_at_minute=600 WHERE location_id=$1", [locationId]);
  }
}
test.each(["pricing"] as const)("checkout first blocks %s writer and persists coherent old configuration", async (kind) => {
  const acquired = deferred<number>(), release = deferred<void>(); const read = reservations.findCheckoutOccupancy;
  vi.spyOn(reservations, "findCheckoutOccupancy").mockImplementationOnce(async (...args) => {
    const value = await read(...args); acquired.resolve(await pid(args[0])); await release.promise; return value;
  });
  const checkout = createCustomerBooking(input, guest, now); const blocker = await acquired.promise;
  const writer = inTransaction((manager) => changeConfiguration(manager, kind));
  try { expect((await waitForBlock(blocker))[0].query).toContain("pg_advisory_xact_lock"); }
  finally { release.resolve(); }
  expect(await checkout).toMatchObject({ ok: true, totalAmountMinor: 5000 }); await writer;
  expect(await stored()).toMatchObject([{ total_amount_minor: 5000 }]);
});
test.each(["resource", "pricing"] as const)("%s writer first makes checkout use coherent new facts", async (kind) => {
  const writer = database.createQueryRunner(); await writer.connect(); await writer.startTransaction();
  try {
    await changeConfiguration(writer.manager, kind); const blocker = await pid(writer.manager);
    const checkout = createCustomerBooking(input, guest, now);
    await waitForBlock(blocker); await writer.commitTransaction();
    expect(await checkout).toEqual(kind === "pricing" ? { ok: false, reason: "price_changed", totalAmountMinor: 7000, currency: "RON" }
      : kind === "resource" ? { ok: false, message: "That court is not available for booking." }
      : { ok: false, availabilityChanged: true, message: "That court is no longer available for the selected time." });
    expect(await counts()).toEqual({ reservations: 0, bookings: 0, attempts: 0 });
    if (kind === "pricing") {
      expect(await createCustomerBooking({ ...input, expectedTotalAmountMinor: 7000 }, guest, now)).toMatchObject({ ok: true, totalAmountMinor: 7000 });
      expect(await stored()).toMatchObject([{ total_amount_minor: 7000, amount_minor: 7000 }]);
    }
  } finally { if (writer.isTransactionActive) await writer.rollbackTransaction(); await writer.release(); }
});

test("suspension before account fence rejects already-authorized checkout; guest takes no account fence", async () => {
  const reached = deferred<void>(), release = deferred<void>(); const fence = accounts.lockCheckoutAccountStatus;
  vi.spyOn(accounts, "lockCheckoutAccountStatus").mockImplementationOnce(async (...args) => {
    reached.resolve(); await release.promise; return fence(...args);
  });
  const checkout = createCustomerBooking(input, member, now); await reached.promise;
  try { await database.query("UPDATE public.users SET status='suspended' WHERE id=$1", [userId]); } finally { release.resolve(); }
  expect(await checkout).toEqual({ ok: false, message: "Unable to create this booking. Try again." });
  expect(await counts()).toEqual({ reservations: 0, bookings: 0, attempts: 0 });
  vi.mocked(accounts.lockCheckoutAccountStatus).mockClear();
  expect(await createCustomerBooking(input, guest, now)).toMatchObject({ ok: true });
  expect(accounts.lockCheckoutAccountStatus).not.toHaveBeenCalled();
});
test("suspension after account fence waits for checkout and preserves submitted account contact", async () => {
  const acquired = deferred<number>(), release = deferred<void>(); const fence = accounts.lockCheckoutAccountStatus;
  vi.spyOn(accounts, "lockCheckoutAccountStatus").mockImplementationOnce(async (...args) => {
    const value = await fence(...args); acquired.resolve(await pid(args[0])); await release.promise; return value;
  });
  const checkout = createCustomerBooking(input, member, now); const blocker = await acquired.promise;
  const writer = database.query("UPDATE public.users SET status='suspended' WHERE id=$1", [userId]);
  try { await waitForBlock(blocker); } finally { release.resolve(); }
  expect(await checkout).toMatchObject({ ok: true }); await writer;
  expect(await stored()).toMatchObject([{ account_user_id: userId, customer_email: "Guest@Example.test" }]);
});

test("Pay-at-club permission changed before configuration lock is authoritatively rejected", async () => {
  await database.query("UPDATE public.locations SET allow_pay_at_club=false WHERE id=$1", [locationId]);
  expect(await createCustomerBooking(input, guest, now)).toEqual({ ok: false, message: "Pay at club is not available at this location." });
  expect(await counts()).toEqual({ reservations: 0, bookings: 0, attempts: 0 });
});

test("failed replacement rolls back application expiry of the old hold too", async () => {
  const held = await online();
  await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [held.reservationId]);
  const before = await stored(); const insert = bookings.insertCheckoutBooking;
  vi.spyOn(bookings, "insertCheckoutBooking").mockImplementationOnce(async (...args) => { await insert(...args); await args[0].query("SELECT 1/0"); });
  expect(await createCustomerBooking(input, guest, now)).toMatchObject({ ok: false });
  expect(await stored()).toEqual(before); expect(await counts()).toEqual({ reservations: 1, bookings: 1, attempts: 1 });
});

test("provider API failure leaves committed hold pending with no reference, capability or confirmation", async () => {
  createPayment.mockRejectedValue(new Error("private provider response"));
  expect(await commitCustomerCheckout({ ...input, paymentMethod: "online" })).toEqual({ ok: false, availabilityChanged: true,
    message: "Unable to start payment. No booking is confirmed. The temporary hold will expire within 10 minutes." });
  expect(await stored()).toMatchObject([{ reservation_status: "held", booking_status: "pending_payment", attempt_status: "pending",
    provider_payment_id: null, checkout_token_hash: null }]);
  expect(await counts()).toEqual({ reservations: 1, bookings: 1, attempts: 1 });
});
test("provider success and attachment rollback withholds presentation and creates no replacement identity", async () => {
  createPayment.mockResolvedValue({ id: "pi_attachment_failed", client_secret: "secret" });
  const attach = payments.attachCheckoutPayment;
  vi.spyOn(payments, "attachCheckoutPayment").mockImplementationOnce(async (...args) => { await attach(...args); await args[0].query("SELECT 1/0"); return true; });
  expect(await commitCustomerCheckout({ ...input, paymentMethod: "online" })).toMatchObject({ ok: false, availabilityChanged: true });
  expect(await stored()).toMatchObject([{ reservation_status: "held", booking_status: "pending_payment", attempt_status: "pending",
    provider_payment_id: null, checkout_token_hash: null }]);
  expect(await counts()).toEqual({ reservations: 1, bookings: 1, attempts: 1 });
  const rows: unknown = await database.query("SELECT id FROM public.payment_attempts WHERE booking_id IN (SELECT b.id FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id WHERE r.court_id=$1)", [courtId]);
  const attemptId = z.array(z.object({ id: z.uuid() })).length(1).parse(rows)[0].id;
  expect(createPayment).toHaveBeenCalledTimes(1);
  expect(createPayment.mock.calls[0][1]).toEqual({ idempotencyKey: `court-payment-${attemptId}` });
});
test("provider initialization outliving expiry attaches its reference without reclaiming occupancy", async () => {
  const held = await online();
  createPayment.mockImplementation(async () => {
    await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [held.reservationId]);
    await expirePaymentHolds();
    return { id: "pi_after_expiry", client_secret: "secret" };
  });
  await startOnlineCheckout(held.paymentAttemptId);
  expect(await stored()).toMatchObject([{ reservation_status: "released", booking_status: "expired", attempt_status: "expired",
    provider_payment_id: "pi_after_expiry", checkout_token_hash: expect.any(String), hold_expires_at: null }]);
  expect(await counts()).toEqual({ reservations: 1, bookings: 1, attempts: 1 });
});
test("an attachment that committed but lost its acknowledgement is not automatically recovered", async () => {
  createPayment.mockResolvedValue({ id: "pi_unknown_ack", client_secret: "secret" });
  const transaction = await import("@/lib/db/transaction"); const run = transaction.inTransaction;
  vi.spyOn(transaction, "inTransaction").mockImplementationOnce(async (work) => run(work)).mockImplementationOnce(async (work) => {
    await run(work); throw new Error("commit acknowledgement lost");
  });
  const result = await commitCustomerCheckout({ ...input, paymentMethod: "online" });
  expect(result).toMatchObject({ ok: false }); expect(result).not.toHaveProperty("checkout");
  expect(await stored()).toMatchObject([{ provider_payment_id: "pi_unknown_ack", checkout_token_hash: expect.any(String), attempt_status: "pending" }]);
  expect(await counts()).toEqual({ reservations: 1, bookings: 1, attempts: 1 });
});

test.each(["netopia"] as const)("selected provider %s has no online fallback", async (provider) => {
  vi.stubEnv("NETOPIA_API_KEY", "fixture"); vi.stubEnv("NETOPIA_POS_SIGNATURE", "fixture"); vi.stubEnv("NETOPIA_ENVIRONMENT", "sandbox");
  await database.query("UPDATE public.payment_provider_settings SET active_provider=$1 WHERE id", [provider]);
  expect(await createCustomerBooking({ ...input, paymentMethod: "online" }, guest, now)).toEqual({ ok: false,
    message: "Online payment is unavailable. Choose Pay at club if offered, or try again later." });
  expect(await counts()).toEqual({ reservations: 0, bookings: 0, attempts: 0 });
});
test("provider selection waits behind checkout's settings SHARE lock and stored provider remains unchanged", async () => {
  const acquired = deferred<number>(), release = deferred<void>(); const read = payments.findSelectedPaymentProvider;
  vi.spyOn(payments, "findSelectedPaymentProvider").mockImplementationOnce(async (...args) => {
    const value = await read(...args); acquired.resolve(await pid(args[0])); await release.promise; return value;
  });
  const checkout = createCustomerBooking({ ...input, paymentMethod: "online" }, guest, now); const blocker = await acquired.promise;
  const change = database.query("UPDATE public.payment_provider_settings SET active_provider=NULL WHERE id");
  try { expect((await waitForBlock(blocker))[0].query).toContain("payment_provider_settings"); } finally { release.resolve(); }
  expect(await checkout).toMatchObject({ ok: true }); await change;
  expect(await stored()).toMatchObject([{ provider: "stripe" }]);
});
test("attachment locks booking before attempt and an existing capability cannot be replaced", async () => {
  const held = await online(); const blocker = database.createQueryRunner(); await blocker.connect(); await blocker.startTransaction();
  createPayment.mockResolvedValue({ id: "pi_lock_order", client_secret: "secret" });
  const lockBooking = vi.spyOn(bookings, "lockCheckoutBooking"), lockAttempt = vi.spyOn(payments, "lockCheckoutAttempt");
  try {
    await bookings.lockCheckoutBooking(blocker.manager, held.bookingId); lockBooking.mockClear();
    const start = startOnlineCheckout(held.paymentAttemptId);
    expect((await waitForBlock(await pid(blocker.manager)))[0].query).toContain("bookings");
    expect(lockAttempt).not.toHaveBeenCalled();
    await blocker.commitTransaction(); const checkout = await start;
    expect(lockBooking.mock.invocationCallOrder[0]).toBeLessThan(lockAttempt.mock.invocationCallOrder[0]);
    await expect(startOnlineCheckout(held.paymentAttemptId)).rejects.toThrow("Unable to register payment.");
    expect(await readOnlineCheckout({ attemptId: checkout.attemptId, token: checkout.token })).toMatchObject({ status: "pending_payment" });
    expect(createPayment.mock.calls.map((call) => call[1])).toEqual([
      { idempotencyKey: `court-payment-${held.paymentAttemptId}` }, { idempotencyKey: `court-payment-${held.paymentAttemptId}` },
    ]);
  } finally { if (blocker.isTransactionActive) await blocker.rollbackTransaction(); await blocker.release(); }
});
test("checkout retains per-cell adjacent-hours selection and covered mixed-rate rounding", async () => {
  await database.query("DELETE FROM public.location_pricing_rules WHERE location_id=$1", [locationId]);
  await database.query("DELETE FROM public.location_opening_hours WHERE location_id=$1", [locationId]);
  await database.query("INSERT INTO public.location_opening_hours(location_id,weekday,opens_at_minute,closes_at_minute) VALUES($1,3,600,630),($1,3,630,660)", [locationId]);
  await database.query("INSERT INTO public.court_coverage_periods(court_id,starts_on,ends_on) VALUES($1,$2,$2)", [courtId, date]);
  await database.query(`INSERT INTO public.location_pricing_rules(location_id,rule_set_id,court_id,court_state,weekday,starts_at_minute,ends_at_minute,price_per_hour_minor)
    VALUES($1,$2,$3,'outdoor',3,600,630,5000),($1,$2,$3,'covered',3,600,630,5001),($1,$2,$3,'covered',3,630,660,7000)`, [locationId, ruleSetId, courtId]);
  expect(await createCustomerBooking({ ...input, expectedTotalAmountMinor: 6001 }, guest, now)).toMatchObject({ ok: true, totalAmountMinor: 6001 });
  expect(await stored()).toMatchObject([{ total_amount_minor: 6001, amount_minor: 6001 }]);
});

test.each([
  ["23P01", "court_reservation_no_overlap", "conflict"],
  ["40001", undefined, "review"],
])("maps SQLSTATE %s / constraint %s without parsing private messages", async (code, constraint, outcome) => {
  vi.spyOn(reservations, "insertCustomerReservation").mockRejectedValueOnce(new QueryFailedError("private SQL", [],
    Object.assign(new Error("private provider/customer/database details"), { code, constraint })));
  expect(await createCustomerBooking(input, guest, now)).toEqual(outcome === "conflict" ? { ok: false, availabilityChanged: true,
    message: "That court is no longer available for the selected time." }
    : { ok: false, message: outcome === "review" ? "Booking availability changed. Please review your selection and try again."
      : "Unable to create this booking. Try again." });
  expect(await counts()).toEqual({ reservations: 0, bookings: 0, attempts: 0 });
});
test("confirmed policy presentation failure does not report a committed booking as failed", async () => {
  vi.spyOn(bookings, "findBookingCancellationNotice").mockRejectedValueOnce(new Error("private read failure"));
  expect(await createCustomerBooking(input, guest, now)).toMatchObject({ ok: true, status: "confirmed", cancellationPolicy: null });
  expect(await counts()).toEqual({ reservations: 1, bookings: 1, attempts: 1 });
});

// Run real application transactions and observe a database wait on the parent.
// Only the first occupancy read is gated; conflicts must bypass persistence.
async function occupancyRace<T,U>(first:()=>Promise<T>, second:()=>Promise<U>) {
  const acquired=deferred<number>(), release=deferred<void>(), read=reservations.findCheckoutOccupancy;
  vi.spyOn(reservations,"findCheckoutOccupancy").mockImplementationOnce(async (...args)=>{
    const rows=await read(...args); acquired.resolve(await pid(args[0])); await release.promise; return rows;
  });
  const a=first(), blocker=await acquired.promise, b=second();
  try { expect((await waitForBlock(blocker))[0].query).toContain("locations"); }
  finally { release.resolve(); }
  return Promise.all([a,b]);
}
async function direct(startMinute=600) {
  return createDirectReservationCommand({locationId,courtId,date,startMinute,endMinute:startMinute+60,reason:"Training"},userId,now);
}
test.each(["direct"])("%s first rejects a conflicting customer/direct reservation before SQL insertion", async first => {
  await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'coach') ON CONFLICT DO NOTHING",[userId]);
  const customerWrite=vi.spyOn(reservations,"insertCustomerReservation"), directWrite=vi.spyOn(reservations,"insertDirectReservation");
  const customer=()=>createCustomerBooking(input,guest,now);
  const results=await (first==="customer" ? occupancyRace(customer,()=>direct()) : occupancyRace(()=>direct(),customer));
  expect(results[0]).toMatchObject({ok:true}); expect(results[1]).toMatchObject({ok:false,message:expect.stringContaining("no longer available")});
  expect(customerWrite.mock.calls.length+directWrite.mock.calls.length).toBe(1);
});
test("adjacent customer and direct reservations both commit", async () => {
  await database.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'coach') ON CONFLICT DO NOTHING",[userId]);
  const results=await occupancyRace(()=>createCustomerBooking(input,guest,now),()=>direct(660));
  expect(results).toMatchObject([{ok:true},{ok:true}]);
  expect(await database.query("SELECT starts_at_minute,ends_at_minute FROM public.court_reservations WHERE court_id=$1 AND status='active' ORDER BY starts_at_minute",[courtId]))
    .toEqual([{starts_at_minute:600,ends_at_minute:660},{starts_at_minute:660,ends_at_minute:720}]);
});
async function ownerReschedule(bookingId:string) {
  const context=await readCustomerBookingEditContext(bookingId,date,userId,"owner");
  if (!context) throw new Error("Missing booking edit context");
  return {id:bookingId,courtId,date,startMinute:720,endMinute:780,save:true,expectedTotal:5000,priceAcknowledged:true,
    expectedUpdatedAt:context.updated_at,expectedBookingUpdatedAt:context.booking_updated_at};
}
test.each(["creation"])("%s first prevents overlapping reschedule/new checkout before the losing write", async first => {
  const original=await createCustomerBooking(input,member,now); if(!original.ok) throw new Error("Missing original booking");
  const edit=await ownerReschedule(original.bookingId);
  const update=vi.spyOn(reservations,"updateCustomerReservationSchedule"), insert=vi.spyOn(reservations,"insertCustomerReservation");
  const reschedule=()=>runBookingReschedule(edit,member,userId,"owner");
  const create=()=>createCustomerBooking({...input,startMinute:720,endMinute:780},guest,now);
  const results=await (first==="reschedule" ? occupancyRace(reschedule,create) : occupancyRace(create,reschedule));
  expect(results[0]).toMatchObject({ok:true}); expect(results[1]).toMatchObject({ok:false,message:expect.stringContaining("no longer available")});
  expect(update.mock.calls.length+insert.mock.calls.length).toBe(1);
});
async function attachedOnline() {
  const created=await online(); createPayment.mockResolvedValue({id:`pi_${created.paymentAttemptId}`,client_secret:"secret"});
  await startOnlineCheckout(created.paymentAttemptId);
  return created;
}
function successEvent(created:Awaited<ReturnType<typeof online>>) {
  return {provider:"stripe" as const,eventId:randomUUID(),attemptId:created.paymentAttemptId,
    providerPaymentId:`pi_${created.paymentAttemptId}`,outcome:"succeeded" as const,amountMinor:5000,currency:"RON"};
}
async function expireDeadline(created:Awaited<ReturnType<typeof online>>) {
  await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[created.reservationId]);
}
async function waitForDeadline(reservationId:string) {
  const deadline=Date.now()+3000;
  while(Date.now()<deadline) {
    const rows:unknown=await database.query("SELECT clock_timestamp()>=hold_expires_at AS elapsed FROM public.court_reservations WHERE id=$1",[reservationId]);
    if(z.array(z.object({elapsed:z.boolean()})).length(1).parse(rows)[0].elapsed) return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error("Hold deadline did not elapse");
}
test("settlement fenced before expiry commits after expiry while replacement waits and rejects in TypeScript", async () => {
  const created=await attachedOnline();
  await database.query("UPDATE public.court_reservations SET hold_expires_at=clock_timestamp()+interval '300 milliseconds' WHERE id=$1",[created.reservationId]);
  const acquired=deferred<number>(),release=deferred<void>(),write=payments.updateSettlementAttempt;
  vi.spyOn(payments,"updateSettlementAttempt").mockImplementationOnce(async (...args)=>{
    const changed=await write(...args); expect(changed).toBe(true); acquired.resolve(await pid(args[0])); await release.promise; return changed;
  });
  const insert=vi.spyOn(reservations,"insertCustomerReservation");
  const settlement=processOnlinePaymentEvent(successEvent(created)),blocker=await acquired.promise;
  await waitForDeadline(created.reservationId);
  const replacement=createCustomerBooking(input,guest,now);
  try { expect((await waitForBlock(blocker))[0].query).toContain("locations"); } finally {release.resolve();}
  expect(await settlement).toBe("succeeded"); expect(await replacement).toMatchObject({ok:false,availabilityChanged:true});
  expect(insert).not.toHaveBeenCalled(); expect(await stored()).toMatchObject([{booking_status:"confirmed",reservation_status:"active",attempt_status:"succeeded"}]);
});
test("expiry versus real insertion serializes cleanup, then late success is reconciled without reopening occupancy", async () => {
  const created=await attachedOnline();await expireDeadline(created);
  const acquired=deferred<number>(),release=deferred<void>(),write=bookings.updateSettlementBookingStatus;
  vi.spyOn(bookings,"updateSettlementBookingStatus").mockImplementationOnce(async (...args)=>{
    await write(...args); acquired.resolve(await pid(args[0])); await release.promise;
  });
  const expiry=expirePaymentHolds({locationId}),blocker=await acquired.promise,replacement=createCustomerBooking(input,guest,now);
  try { expect((await waitForBlock(blocker))[0].query).toContain("locations"); } finally {release.resolve();}
  expect(await expiry).toBe(1);expect(await replacement).toMatchObject({ok:true});
  expect(await processOnlinePaymentEvent(successEvent(created))).toBe("expired");
  expect(await database.query("SELECT reconciliation_required FROM public.payment_provider_events WHERE attempt_id=$1",[created.paymentAttemptId]))
    .toEqual([{reconciliation_required:true}]);
  expect(await stored()).toMatchObject([{booking_status:"expired",reservation_status:"released"},{booking_status:"confirmed",reservation_status:"active"}]);
});
