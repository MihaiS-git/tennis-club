import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { findRevision } from "@/lib/db/repositories/booking-revisions.repository";
import { recordBookingFinancialException } from "@/lib/db/repositories/booking-financial-exceptions.repository";
import { appendBookingContractFixture, cleanupBookingFixtures, insertCheckoutFixture } from "./checkout-fixtures";
import { localFixtureClient } from "./auth-fixtures";
import { configureCheckoutPolicyFixture } from "./opening-hours-fixtures";
import { processOnlinePaymentEvent } from "@/lib/payments/service";
import { cleanupAuthFixtures } from "./auth-fixtures";
import { cancelBookingCommand } from "@/lib/bookings/cancellation-service";
import { finishBookingCancellation } from "@/lib/payments/refunds";
import { rescheduleCustomerBookingCommand, readCustomerBookingEditContext } from "@/lib/bookings/commands";
import { finishBookingAdjustment } from "@/lib/payments/booking-adjustments";
import { prepareRefund, initiateRefundExecution, commitRefundExecution } from "@/lib/payments/refund-commands";
import { resolveRefundBackedAdjustment } from "@/lib/bookings/commands";
import * as evidence from "@/lib/db/repositories/booking-financial-exceptions.repository";

const { refundPayment } = vi.hoisted(() => ({ refundPayment: vi.fn() }));
vi.mock("@/lib/payments/providers", () => ({ onlinePaymentAdapter: async () => ({ refundPayment }) }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/reservations/revalidation", () => ({ revalidateCourtActivity: vi.fn() }));
const locationId = randomUUID(), courtId = randomUUID(), bookingIds: string[] = [];
const userIds: string[] = [];
let nextMinute = 60;
beforeAll(async () => {
  const db = localFixtureClient();
  expect((await db.from("locations").insert({ id: locationId, name: "Financial exception fixture",
    slug: `financial-exception-${locationId}`, timezone: "UTC", currency: "RON", is_public: true })).error).toBeNull();
  expect((await db.from("courts").insert({ id: courtId, location_id: locationId, name: "Court",
    slug: "court", environment: "outdoor", surface: "clay" })).error).toBeNull();
  await configureCheckoutPolicyFixture(db, locationId, courtId);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await cleanupBookingFixtures({ bookingIds });
  expect((await localFixtureClient().from("court_reservations").delete().eq("court_id", courtId)).error).toBeNull();
  nextMinute = 60;
});
afterAll(async () => {
  const db = localFixtureClient();
  await cleanupBookingFixtures({ bookingIds });
  expect((await db.from("court_reservations").delete().eq("court_id", courtId)).error).toBeNull();
  expect((await db.from("location_pricing_rules").delete().eq("location_id", locationId)).error).toBeNull();
  expect((await db.from("pricing_rule_sets").delete().eq("location_id", locationId)).error).toBeNull();
  expect((await db.from("location_opening_hours").delete().eq("location_id", locationId)).error).toBeNull();
  expect((await db.from("opening_hours_schedules").delete().eq("location_id", locationId)).error).toBeNull();
  expect((await db.from("courts").delete().eq("id", courtId)).error).toBeNull();
  expect((await db.from("locations").delete().eq("id", locationId)).error).toBeNull();
  await cleanupAuthFixtures(db, userIds);
});

async function booking(owner: string | null = null, method: "online" | "pay_at_club" = "online", duration = 60) {
  const row = await insertCheckoutFixture({ courtId, bookingDate: "2099-10-15",
    startMinute: nextMinute, endMinute: nextMinute + duration, accountUserId: owner,
    customerName: "Exception customer", customerEmail: "original@example.test", customerPhone: "123",
    totalAmountMinor: 5000 * duration / 60, currency: "RON", paymentMethod: method, provider: method === "online" ? "stripe" : null, holdSeconds: 600 });
  nextMinute += duration;
  bookingIds.push(row.booking_id);
  const { manager } = await getDataSource();
  const [identity] = await manager.query("SELECT current_revision_id FROM public.bookings WHERE id=$1", [row.booking_id]);
  return { ...row, revision: await findRevision(manager, identity.current_revision_id) };
}

async function confirm(held: Awaited<ReturnType<typeof booking>>) {
  const database = await getDataSource();
  await database.query("UPDATE public.payment_attempts SET provider_payment_id=$2 WHERE id=$1", [held.payment_attempt_id,`pi_${held.payment_attempt_id}`]);
  expect(await processOnlinePaymentEvent({ provider: "stripe", providerPaymentId: `pi_${held.payment_attempt_id}`,
    providerCaptureId: `pi_${held.payment_attempt_id}`, attemptId: held.payment_attempt_id,
    eventId: `evt_${held.payment_attempt_id}`, outcome: "succeeded", amountMinor: held.revision.totalAmountMinor, currency: "RON" })).toBe("succeeded");
}

test("confirmation, rescheduling and failed/successful cancellation refunds settle without side effects", async () => {
  const db = localFixtureClient();
  const user = await db.auth.admin.createUser({ email: `financial-recovery-${randomUUID()}@example.test`,
    password: "financial-recovery-test-123", email_confirm: true });
  expect(user.error).toBeNull();
  const owner = user.data.user!.id;
  userIds.push(owner);
  const held = await booking(owner);
  await confirm(held);
  const context = await readCustomerBookingEditContext(held.booking_id, "2099-10-15", owner);
  if (!context) throw new Error("Missing owner edit context");
  expect(await finishBookingAdjustment(await rescheduleCustomerBookingCommand({ id: held.booking_id,
    expectedUpdatedAt: context.updated_at, expectedRevisionId: context.current_revision_id,
    courtId, date: context.booking_date, startMinute: context.starts_at_minute + 60,
    endMinute: context.ends_at_minute + 60, save: true, expectedTotal: 5000, priceAcknowledged: true }, owner)))
    .toMatchObject({ ok: true, totalAmountMinor: 5000 });
  refundPayment.mockResolvedValueOnce({ status: "failed", providerRefundId: `re_failed_${randomUUID()}`, retryable: false });
  expect(await finishBookingCancellation(await cancelBookingCommand(held.booking_id, owner, false))).toMatchObject({ ok: false });
  const database = await getDataSource();
  expect(await database.query("SELECT kind FROM public.booking_financial_exceptions WHERE booking_id=$1", [held.booking_id]))
    .toEqual([{ kind: "cancellation_rejected" }]);
  expect(await database.query("SELECT b.status,r.status AS reservation_status FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id WHERE b.id=$1", [held.booking_id]))
    .toEqual([{ status: "confirmed", reservation_status: "active" }]);
  refundPayment.mockImplementation(async ({ id }: { id: string }) => ({ status: "succeeded", providerRefundId: `re_${id}` }));
  expect(await finishBookingCancellation(await cancelBookingCommand(held.booking_id, owner, false))).toMatchObject({ ok: true, outcome: "cancelled" });
  expect(await database.query("SELECT b.status,r.status AS reservation_status FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id WHERE b.id=$1", [held.booking_id]))
    .toEqual([{ status: "cancelled", reservation_status: "cancelled" }]);
  expect(await database.query("SELECT status FROM public.payment_refunds WHERE booking_id=$1 ORDER BY created_at,id", [held.booking_id]))
    .toEqual([{ status: "voided" }, { status: "succeeded" }]);
});

test("financial exceptions commit atomically, retain first context, reject changed identity and are immutable", async () => {
  const held = await booking();
  const facts = { key: `payment:${held.payment_attempt_id}:modification_failed`, bookingId: held.booking_id,
    revisionId: held.revision.id, kind: "surcharge_unapplied" as const, paymentAttemptId: held.payment_attempt_id };
  const database = await getDataSource();
  await expect(inTransaction(async manager => {
    await recordBookingFinancialException(manager, facts);
    throw new Error("abort transition");
  })).rejects.toThrow("abort transition");
  expect(await database.query("SELECT * FROM public.booking_financial_exceptions WHERE event_key=$1", [facts.key])).toEqual([]);
  await inTransaction(manager => recordBookingFinancialException(manager, facts));
  const before = await database.query("SELECT * FROM public.booking_financial_exceptions WHERE event_key=$1", [facts.key]);
  await appendBookingContractFixture(held.booking_id, { customer_email: "later@example.test" });
  const [current] = await database.query("SELECT current_revision_id FROM public.bookings WHERE id=$1", [held.booking_id]);
  await inTransaction(manager => recordBookingFinancialException(manager, { ...facts, revisionId: current.current_revision_id }));
  expect(await database.query("SELECT * FROM public.booking_financial_exceptions WHERE event_key=$1", [facts.key])).toEqual(before);
  await expect(inTransaction(manager => recordBookingFinancialException(manager, { ...facts, kind: "late_capture" }))).rejects.toThrow("identity changed");
  await expect(database.query("DELETE FROM public.booking_financial_exceptions WHERE event_key=$1", [facts.key])).rejects.toMatchObject({ code: "23514" });
  await expect(database.query("UPDATE public.booking_financial_exceptions SET revision_id=$2 WHERE event_key=$1", [facts.key,current.current_revision_id])).rejects.toMatchObject({ code: "23514" });
});

async function ownerBooking(duration = 60) {
  const user = await localFixtureClient().auth.admin.createUser({ email: `financial-exception-${randomUUID()}@example.test`,
    password: "financial-exception-test-123", email_confirm: true });
  if (user.error || !user.data.user) throw new Error("Owner fixture failed");
  const owner = user.data.user.id;
  userIds.push(owner);
  const held = await booking(owner, "online", duration);
  await confirm(held);
  return { held, owner };
}

async function cancellationRefund() {
  const { held, owner } = await ownerBooking();
  const result = await cancelBookingCommand(held.booking_id, owner, false);
  if (result.outcome !== "cancellation_pending") throw new Error("Expected pending cancellation");
  const prepared = await prepareRefund(result.refundIds[0], {});
  if (prepared.outcome !== "ready") throw new Error("Expected refund claim");
  await initiateRefundExecution(prepared.claim);
  return { held, result, claim: prepared.claim };
}

test("a crash after the definitive refund result keeps one rejected cancellation that later checks resolve", async () => {
  const { held, result, claim } = await cancellationRefund();
  await commitRefundExecution(claim, { kind: "verified", status: "failed", retryable: false,
    providerRefundId: `re_${randomUUID()}` });
  // Deliberately omit afterRefundOutcome: the process stopped between transactions.
  const database = await getDataSource();
  expect(await database.query("SELECT status FROM public.booking_adjustments WHERE id=$1", [result.adjustmentId]))
    .toEqual([{ status: "pending" }]);
  expect(await database.query("SELECT status FROM public.payment_refunds WHERE id=$1", [claim.refund.id]))
    .toEqual([{ status: "failed" }]);
  const key = `adjustment:${result.adjustmentId}:abandoned`;
  expect(await database.query("SELECT event_key,kind FROM public.booking_financial_exceptions WHERE booking_id=$1", [held.booking_id]))
    .toEqual([{ event_key: key, kind: "cancellation_rejected" }]);
  expect(await resolveRefundBackedAdjustment(result.adjustmentId)).toBe("unsuccessful");
  expect(await resolveRefundBackedAdjustment(result.adjustmentId)).toBe("unsuccessful");
  expect(await database.query("SELECT event_key,kind FROM public.booking_financial_exceptions WHERE booking_id=$1", [held.booking_id]))
    .toEqual([{ event_key: key, kind: "cancellation_rejected" }]);
  expect(await database.query("SELECT status FROM public.bookings WHERE id=$1", [held.booking_id]))
    .toEqual([{ status: "confirmed" }]);
});

test("failure to insert rejection evidence rolls back the definitive refund result", async () => {
  const { result, claim } = await cancellationRefund();
  const database = await getDataSource();
  const before = await database.query("SELECT * FROM public.refund_executions WHERE id=$1", [claim.execution.id]);
  const failure = vi.spyOn(evidence, "recordBookingFinancialException").mockRejectedValue(new Error("evidence unavailable"));
  await expect(commitRefundExecution(claim, { kind: "verified", status: "failed", retryable: false,
    providerRefundId: `re_${randomUUID()}` })).rejects.toThrow("evidence unavailable");
  expect(failure).toHaveBeenCalledOnce();
  expect(await database.query("SELECT * FROM public.refund_executions WHERE id=$1", [claim.execution.id])).toEqual(before);
  expect(await database.query("SELECT status FROM public.payment_refunds WHERE id=$1", [claim.refund.id]))
    .toEqual([{ status: "pending" }]);
  expect(await database.query("SELECT event_key FROM public.booking_financial_exceptions WHERE event_key=$1",
    [`adjustment:${result.adjustmentId}:abandoned`])).toEqual([]);
});

test("a rejected price reduction records modification failure without an outstanding refund", async () => {
  const { held, owner } = await ownerBooking(120);
  const context = await readCustomerBookingEditContext(held.booking_id, "2099-10-15", owner);
  if (!context) throw new Error("Missing edit context");
  const result = await rescheduleCustomerBookingCommand({ id: held.booking_id, expectedUpdatedAt: context.updated_at,
    expectedRevisionId: context.current_revision_id, courtId, date: context.booking_date,
    startMinute: context.starts_at_minute, endMinute: context.starts_at_minute + 60,
    save: true, expectedTotal: 5000, priceAcknowledged: true }, owner);
  if (!result.ok || !result.adjustmentId || !result.refundIds?.length) throw new Error("Expected price reduction");
  const prepared = await prepareRefund(result.refundIds[0], {});
  if (prepared.outcome !== "ready") throw new Error("Expected refund claim");
  await initiateRefundExecution(prepared.claim);
  expect(await commitRefundExecution(prepared.claim, { kind: "verified", status: "failed", retryable: false,
    providerRefundId: `re_${randomUUID()}` })).toEqual({ status: "failed", requiresResolution: false });
  const database = await getDataSource();
  expect(await database.query("SELECT kind FROM public.booking_financial_exceptions WHERE booking_id=$1", [held.booking_id]))
    .toEqual([{ kind: "modification_rejected" }]);
  expect(await resolveRefundBackedAdjustment(result.adjustmentId)).toBe("unsuccessful");
  expect(await database.query("SELECT event_key FROM public.booking_financial_exceptions WHERE booking_id=$1", [held.booking_id]))
    .toEqual([{ event_key: `adjustment:${result.adjustmentId}:abandoned` }]);
  expect(await database.query("SELECT status FROM public.bookings WHERE id=$1", [held.booking_id])).toEqual([{ status: "confirmed" }]);
});

test("a coach conflict when applying a refunded reduction keeps the booking and records the unapplied change", async () => {
  const { held, owner } = await ownerBooking(120);
  const db = localFixtureClient(), database = await getDataSource();
  const otherCourt = randomUUID();
  const coachUser = await db.auth.admin.createUser({ email: `financial-coach-${randomUUID()}@example.test`,
    password: "financial-exception-test-123", email_confirm: true });
  if (coachUser.error || !coachUser.data.user) throw new Error("Coach fixture failed");
  const coach = coachUser.data.user.id;
  userIds.push(coach);
  try {
    const context = await readCustomerBookingEditContext(held.booking_id, "2099-10-15", owner);
    if (!context) throw new Error("Missing edit context");
    const target = { startMinute: context.ends_at_minute, endMinute: context.ends_at_minute + 60 };
    const result = await rescheduleCustomerBookingCommand({ id: held.booking_id, expectedUpdatedAt: context.updated_at,
      expectedRevisionId: context.current_revision_id, courtId, date: context.booking_date, ...target,
      save: true, expectedTotal: 5000, priceAcknowledged: true }, owner);
    if (!result.ok || !result.adjustmentId || !result.refundIds?.length) throw new Error("Expected price reduction");
    // Controlled fixture: the booked row names a coach whom another court already
    // has at the target time, so only court_reservation_coach_no_overlap can fail the move.
    await database.query(`INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages)
      VALUES($1,'Exception Coach','','','{}','{}')`, [coach]);
    await database.query(`INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'Other','other','clay','outdoor')`,
      [otherCourt, locationId]);
    await database.query("UPDATE public.court_reservations SET coach_user_id=$2 WHERE id=$1", [held.reservation_id, coach]);
    await database.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,coach_user_id)
      VALUES($1,$2,'2099-10-15',$3,$4,$5)`, [randomUUID(), otherCourt, target.startMinute, target.endMinute, coach]);
    const before = await database.query("SELECT court_id,starts_at_minute,ends_at_minute,status FROM public.court_reservations WHERE id=$1", [held.reservation_id]);
    const prepared = await prepareRefund(result.refundIds[0], {});
    if (prepared.outcome !== "ready") throw new Error("Expected refund claim");
    await initiateRefundExecution(prepared.claim);
    await commitRefundExecution(prepared.claim, { kind: "verified", status: "succeeded", providerRefundId: `re_${randomUUID()}` });
    expect(await resolveRefundBackedAdjustment(result.adjustmentId)).toBe("unsuccessful");
    // The verified refund and the original booking survive; the exception is recorded once.
    expect(await database.query("SELECT status FROM public.payment_refunds WHERE id=$1", [result.refundIds[0]])).toEqual([{ status: "succeeded" }]);
    expect(await database.query("SELECT court_id,starts_at_minute,ends_at_minute,status FROM public.court_reservations WHERE id=$1", [held.reservation_id])).toEqual(before);
    expect(await database.query("SELECT status FROM public.booking_adjustments WHERE id=$1", [result.adjustmentId])).toEqual([{ status: "unsuccessful" }]);
    expect(await database.query("SELECT event_key,kind FROM public.booking_financial_exceptions WHERE booking_id=$1", [held.booking_id]))
      .toEqual([{ event_key: `adjustment:${result.adjustmentId}:unapplied`, kind: "refunded_modification_unapplied" }]);
    expect(await database.query("SELECT b.status,v.total_amount_minor FROM public.bookings b JOIN public.booking_revisions v ON v.id=b.current_revision_id WHERE b.id=$1",
      [held.booking_id])).toEqual([{ status: "confirmed", total_amount_minor: 10000 }]);
  } finally {
    await database.query("DELETE FROM public.court_reservations WHERE court_id=$1", [otherCourt]);
    await database.query("UPDATE public.court_reservations SET coach_user_id=NULL WHERE id=$1", [held.reservation_id]);
    await database.query("DELETE FROM public.courts WHERE id=$1", [otherCourt]);
    await database.query("DELETE FROM public.coach_profiles WHERE user_id=$1", [coach]);
  }
});
