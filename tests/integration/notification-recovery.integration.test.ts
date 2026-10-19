import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { findRevision } from "@/lib/db/repositories/booking-revisions.repository";
import { recordBookingFinancialException } from "@/lib/db/repositories/booking-financial-exceptions.repository";
import { appendBookingContractFixture, cleanupBookingFixtures, insertCheckoutFixture } from "./checkout-fixtures";
import { localFixtureClient } from "./auth-fixtures";
import { configureCheckoutPolicyFixture } from "./opening-hours-fixtures";
import { recoverBookingNotifications } from "@/lib/notifications/booking-recovery";
import * as emails from "@/lib/notifications/booking-email";
import * as notifications from "@/lib/db/repositories/booking-notifications.repository";
import { processOnlinePaymentEvent } from "@/lib/payments/service";
import { cleanupAuthFixtures } from "./auth-fixtures";
import { isolateNotificationQueue } from "./booking-notification-fixtures";
import * as mail from "@/lib/mail/brevo";
import { enqueueBookingNotification } from "@/lib/notifications/booking-delivery";
import { cancelBookingCommand } from "@/lib/bookings/cancellation-service";
import { finishBookingCancellation } from "@/lib/payments/refunds";
import { rescheduleCustomerBookingCommand, readCustomerBookingEditContext } from "@/lib/bookings/commands";
import { finishBookingAdjustment } from "@/lib/payments/booking-adjustments";
import { prepareRefund, initiateRefundExecution, commitRefundExecution } from "@/lib/payments/refund-commands";
import { resolveRefundBackedAdjustment } from "@/lib/bookings/commands";
import * as evidence from "@/lib/db/repositories/booking-financial-exceptions.repository";
import * as recoveryRepository from "@/lib/db/repositories/notification-recovery.repository";
import { POST } from "@/app/api/notifications/deliver/route";

const { refundPayment } = vi.hoisted(() => ({ refundPayment: vi.fn() }));
vi.mock("@/lib/payments/providers", () => ({ onlinePaymentAdapter: async () => ({ refundPayment }) }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/reservations/revalidation", () => ({ revalidateCourtActivity: vi.fn() }));
const locationId = randomUUID(), courtId = randomUUID(), bookingIds: string[] = [];
const userIds: string[] = [];
let nextMinute = 60;
let restoreQueue: () => Promise<void>;
beforeAll(async () => {
  restoreQueue = await isolateNotificationQueue((await getDataSource()).manager);
  const db = localFixtureClient();
  expect((await db.from("locations").insert({ id: locationId, name: "Recovery fixture",
    slug: `recovery-${locationId}`, timezone: "UTC", currency: "RON", is_public: true })).error).toBeNull();
  expect((await db.from("courts").insert({ id: courtId, location_id: locationId, name: "Court",
    slug: "court", environment: "outdoor", surface: "clay" })).error).toBeNull();
  await configureCheckoutPolicyFixture(db, locationId, courtId);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await cleanupBookingFixtures({ bookingIds });
  await localFixtureClient().from("court_reservations").delete().eq("court_id", courtId);
  nextMinute = 60;
});
afterAll(async () => {
  const db = localFixtureClient();
  await cleanupBookingFixtures({ bookingIds });
  await db.from("court_reservations").delete().eq("court_id", courtId);
  await db.from("location_pricing_rules").delete().eq("location_id", locationId);
  await db.from("pricing_rule_sets").delete().eq("location_id", locationId);
  await db.from("location_opening_hours").delete().eq("location_id", locationId);
  await db.from("opening_hours_schedules").delete().eq("location_id", locationId);
  await db.from("courts").delete().eq("id", courtId);
  await db.from("locations").delete().eq("id", locationId);
  await cleanupAuthFixtures(db, userIds);
  await restoreQueue();
});

async function booking(owner: string | null = null, method: "online" | "pay_at_club" = "online", duration = 60) {
  const held = await insertCheckoutFixture(localFixtureClient(), { p_court_id: courtId, p_booking_date: "2099-10-15",
    p_starts_at_minute: nextMinute, p_ends_at_minute: nextMinute + duration, p_account_user_id: owner,
    p_customer_name: "Recovery customer", p_customer_email: "original@example.test", p_customer_phone: "123",
    p_total_amount_minor: 5000 * duration / 60, p_currency: "RON", p_payment_method: method, p_provider: method === "online" ? "stripe" : null, p_hold_seconds: 600 });
  nextMinute += duration;
  expect(held.error).toBeNull();
  const row = held.data[0];
  bookingIds.push(row.booking_id);
  const { manager } = await getDataSource();
  const [identity] = await manager.query("SELECT current_revision_id FROM public.bookings WHERE id=$1", [row.booking_id]);
  return { ...row, revision: await findRevision(manager, identity.current_revision_id) };
}

test("cutover is explicit: legacy revisions stay ineligible and new writer revisions opt in", async () => {
  const held = await booking();
  expect(held.revision.recoveryVersion).toBeNull();
  await appendBookingContractFixture(held.booking_id, { total_amount_minor: 6000 });
  const rows = await (await getDataSource()).query("SELECT recovery_version FROM public.booking_revisions WHERE booking_id=$1 ORDER BY revision_number", [held.booking_id]);
  expect(rows).toEqual([{ recovery_version: null }, { recovery_version: 1 }]);
});

async function confirm(held: Awaited<ReturnType<typeof booking>>) {
  const database = await getDataSource();
  await database.query("UPDATE public.payment_attempts SET provider_payment_id=$2 WHERE id=$1", [held.payment_attempt_id,`pi_${held.payment_attempt_id}`]);
  expect(await processOnlinePaymentEvent({ provider: "stripe", providerPaymentId: `pi_${held.payment_attempt_id}`,
    providerCaptureId: `pi_${held.payment_attempt_id}`, attemptId: held.payment_attempt_id,
    eventId: `evt_${held.payment_attempt_id}`, outcome: "succeeded", amountMinor: held.revision.totalAmountMinor, currency: "RON" })).toBe("succeeded");
  const [row] = await database.query("SELECT current_revision_id FROM public.bookings WHERE id=$1", [held.booking_id]);
  return `revision:${row.current_revision_id}`;
}

test.each(["render", "persistence"])("%s failure cannot undo confirmation; recovery retries the same committed source", async failure => {
  const held = await booking();
  const broken = failure === "render" ? vi.spyOn(emails, "renderBookingEmail").mockImplementation(() => { throw new Error("render unavailable"); })
    : vi.spyOn(notifications, "insertBookingNotification").mockRejectedValue(new Error("projection unavailable"));
  const key = await confirm(held);
  expect(broken).not.toHaveBeenCalled();
  expect((await recoverBookingNotifications()).failed).toBeGreaterThan(0);
  const database = await getDataSource();
  expect(await database.query("SELECT b.status,r.status AS reservation_status FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id WHERE b.id=$1", [held.booking_id]))
    .toEqual([{ status: "confirmed", reservation_status: "active" }]);
  expect(await database.query("SELECT id FROM public.booking_notification_deliveries WHERE event_key=$1", [key])).toEqual([]);
  broken.mockRestore();
  expect((await recoverBookingNotifications()).failed).toBe(0);
  await recoverBookingNotifications();
  expect(await database.query("SELECT event_key FROM public.booking_notification_deliveries WHERE event_key=$1", [key])).toEqual([{ event_key: key }]);
});

test("recovery repairs inbox copies without resetting customer state or resending ordinary/financial dismissals", async () => {
  const db = localFixtureClient();
  const user = await db.auth.admin.createUser({ email: `recovery-${randomUUID()}@example.test`,
    password: "recovery-test-password-123", email_confirm: true });
  expect(user.error).toBeNull();
  const owner = user.data.user!.id;
  userIds.push(owner);
  const held = await booking(owner), key = await confirm(held);
  const exceptionKey = `payment:${held.payment_attempt_id}:modification_failed`;
  await inTransaction(manager => recordBookingFinancialException(manager, { key: exceptionKey,
    bookingId: held.booking_id, revisionId: held.revision.id, kind: "surcharge_unapplied", paymentAttemptId: held.payment_attempt_id }));
  await Promise.all([recoverBookingNotifications(), recoverBookingNotifications()]);
  const database = await getDataSource();
  const rows = await database.query("SELECT id,event_key FROM public.booking_notification_deliveries WHERE event_key=ANY($1::text[]) ORDER BY event_key", [[key,exceptionKey]]);
  expect(rows).toHaveLength(2);
  const ordinaryId = rows.find((row: { event_key: string }) => row.event_key === key).id;
  const financialId = rows.find((row: { event_key: string }) => row.event_key === exceptionKey).id;
  expect(await inTransaction(manager => notifications.acknowledgeBookingNotice(manager, { id: financialId, accountUserId: owner }))).toBe(true);
  await notifications.manageCustomerNotifications(database.manager, { ids: [ordinaryId], accountUserId: owner, operation: "read" });
  const original = await database.query("SELECT * FROM public.customer_notifications WHERE booking_id=$1 ORDER BY id", [held.booking_id]);
  await database.query("UPDATE public.booking_notification_deliveries SET next_attempt_at='infinity' WHERE booking_id=$1", [held.booking_id]);
  expect(await inTransaction(manager => notifications.deleteStoppedBookingNotifications(manager, [ordinaryId,financialId]))).toHaveLength(2);
  await recoverBookingNotifications();
  expect(await database.query("SELECT * FROM public.customer_notifications WHERE booking_id=$1 ORDER BY id", [held.booking_id])).toEqual(original);
  for (const row of rows) expect(await inTransaction(manager => notifications.claimDueBookingNotification(manager, randomUUID(), row.id))).toBeUndefined();
  await database.query("DELETE FROM public.customer_notifications WHERE booking_id=$1", [held.booking_id]);
  await recoverBookingNotifications();
  expect(await database.query("SELECT id,event_key FROM public.customer_notifications WHERE booking_id=$1 ORDER BY event_key", [held.booking_id])).toEqual(rows);
  const [repaired] = await database.query("SELECT acknowledged_at,read_at FROM public.customer_notifications WHERE id=$1", [financialId]);
  const acknowledged = original.find((row: { id: string }) => row.id === financialId);
  expect(repaired).toEqual({ acknowledged_at: acknowledged.acknowledged_at, read_at: acknowledged.acknowledged_at });
  expect(await database.query("SELECT count(*)::int AS total FROM public.booking_notification_deliveries WHERE booking_id=$1 AND dismissed_at IS NOT NULL", [held.booking_id])).toEqual([{ total: 2 }]);
});

test("recovery never reconstructs a legacy missing/deleted email", async () => {
  const held = await booking(null, "pay_at_club");
  expect(held.status).toBe("confirmed");
  const key = `revision:${held.revision.id}`;
  await inTransaction(manager => enqueueBookingNotification(manager, key, emails.bookingNotification("confirmed", held.revision)));
  // Simulate an ordinary guest email physically deleted by the pre-cutover Admin workflow.
  await (await getDataSource()).query("DELETE FROM public.booking_notification_deliveries WHERE event_key=$1", [key]);
  await recoverBookingNotifications();
  expect(await (await getDataSource()).query("SELECT id FROM public.booking_notification_deliveries WHERE booking_id=$1", [held.booking_id])).toEqual([]);
});

test("financial confirmation and failed/successful cancellation refunds never render, project, or deliver queued mail", async () => {
  const db = localFixtureClient();
  const user = await db.auth.admin.createUser({ email: `financial-recovery-${randomUUID()}@example.test`,
    password: "financial-recovery-test-123", email_confirm: true });
  expect(user.error).toBeNull();
  const owner = user.data.user!.id;
  userIds.push(owner);
  const held = await booking(owner);
  // A queued, deliverable row must not be drained as a side effect of finance.
  await inTransaction(manager => enqueueBookingNotification(manager, `fixture:${randomUUID()}`,
    emails.bookingNotification("confirmed", held.revision)));
  const render = vi.spyOn(emails, "renderBookingEmail").mockImplementation(() => { throw new Error("render offline"); });
  const projection = vi.spyOn(notifications, "insertBookingNotification").mockRejectedValue(new Error("projection offline"));
  const delivery = vi.spyOn(mail, "deliverMail").mockRejectedValue(new Error("Brevo offline"));
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
  expect(await database.query("SELECT b.status,r.status AS reservation_status FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id WHERE b.id=$1", [held.booking_id]))
    .toEqual([{ status: "confirmed", reservation_status: "active" }]);
  refundPayment.mockImplementation(async ({ id }: { id: string }) => ({ status: "succeeded", providerRefundId: `re_${id}` }));
  expect(await finishBookingCancellation(await cancelBookingCommand(held.booking_id, owner, false))).toMatchObject({ ok: true, outcome: "cancelled" });
  expect(await database.query("SELECT b.status,r.status AS reservation_status FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id WHERE b.id=$1", [held.booking_id]))
    .toEqual([{ status: "cancelled", reservation_status: "cancelled" }]);
  expect(render).not.toHaveBeenCalled();
  expect(projection).not.toHaveBeenCalled();
  expect(delivery).not.toHaveBeenCalled();
  render.mockRestore(); projection.mockRestore();
  await recoverBookingNotifications();
  expect(delivery).not.toHaveBeenCalled(); // Reconstruction is independent of delivery too.
  const notices = await database.query("SELECT event_kind FROM public.customer_notifications WHERE booking_id=$1 ORDER BY created_at,event_key", [held.booking_id]);
  expect(notices.map((row: { event_kind: string }) => row.event_kind)).toEqual(["confirmed","confirmed","customer_rescheduled","cancellation_failed","customer_cancelled"]);
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
  await recoverBookingNotifications();
  expect(await database.query(`SELECT d.message->>'to' AS recipient,d.created_at=e.occurred_at AS original_time
    FROM public.booking_notification_deliveries d JOIN public.booking_financial_exceptions e USING(event_key)
    WHERE event_key=$1`, [facts.key])).toEqual([{ recipient: "original@example.test", original_time: true }]);
  await expect(inTransaction(manager => recordBookingFinancialException(manager, { ...facts, kind: "late_capture" }))).rejects.toThrow("identity changed");
  await expect(database.query("DELETE FROM public.booking_financial_exceptions WHERE event_key=$1", [facts.key])).rejects.toMatchObject({ code: "23514" });
  await expect(database.query("UPDATE public.booking_financial_exceptions SET revision_id=$2 WHERE event_key=$1", [facts.key,current.current_revision_id])).rejects.toMatchObject({ code: "23514" });
});

async function ownerBooking(duration = 60) {
  const user = await localFixtureClient().auth.admin.createUser({ email: `recovery-${randomUUID()}@example.test`,
    password: "recovery-test-password-123", email_confirm: true });
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

test("a crash after the definitive refund result still reconstructs one rejected cancellation", async () => {
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
  await recoverBookingNotifications();
  expect(await database.query("SELECT event_kind FROM public.customer_notifications WHERE event_key=$1", [key]))
    .toEqual([{ event_kind: "cancellation_failed" }]);
  expect(await resolveRefundBackedAdjustment(result.adjustmentId)).toBe("unsuccessful");
  expect(await resolveRefundBackedAdjustment(result.adjustmentId)).toBe("unsuccessful");
  await Promise.all([recoverBookingNotifications(), recoverBookingNotifications()]);
  expect(await database.query("SELECT count(*)::int AS total FROM public.booking_notification_deliveries WHERE event_key=$1", [key]))
    .toEqual([{ total: 1 }]);
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

test("a rejected price reduction records modification failure without an outstanding refund alert", async () => {
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
    providerRefundId: `re_${randomUUID()}` })).toEqual({ status: "failed", notice: false });
  const database = await getDataSource();
  expect(await database.query("SELECT kind FROM public.booking_financial_exceptions WHERE booking_id=$1", [held.booking_id]))
    .toEqual([{ kind: "modification_rejected" }]);
  await recoverBookingNotifications();
  await resolveRefundBackedAdjustment(result.adjustmentId);
  await recoverBookingNotifications();
  expect(await database.query("SELECT event_kind FROM public.customer_notifications WHERE event_key=$1",
    [`adjustment:${result.adjustmentId}:abandoned`])).toEqual([{ event_kind: "modification_failed" }]);
  expect(await database.query("SELECT status FROM public.bookings WHERE id=$1", [held.booking_id])).toEqual([{ status: "confirmed" }]);
});

test.each(["repair", "acknowledgment"])("concurrent inbox repair and acknowledgment preserve state when %s locks first", async first => {
  const { held, owner } = await ownerBooking();
  const key = `payment:${held.payment_attempt_id}:modification_failed`;
  await inTransaction(manager => recordBookingFinancialException(manager, { key, bookingId: held.booking_id,
    revisionId: held.revision.id, kind: "surcharge_unapplied", paymentAttemptId: held.payment_attempt_id }));
  await recoverBookingNotifications();
  const database = await getDataSource();
  const [delivery] = await database.query("SELECT id FROM public.booking_notification_deliveries WHERE event_key=$1", [key]);
  await database.query("DELETE FROM public.customer_notifications WHERE event_key=$1", [key]);
  const a = database.createQueryRunner(), b = database.createQueryRunner();
  try {
    await a.startTransaction(); await b.startTransaction();
    const [session] = await b.query("SELECT pg_backend_pid() AS pid");
    const repair = (manager: typeof a.manager) => recoveryRepository.repairNotificationInbox(manager, key, "modification_failed");
    const acknowledge = (manager: typeof a.manager) => notifications.acknowledgeBookingNotice(manager, { id: delivery.id, accountUserId: owner });
    await (first === "repair" ? repair(a.manager) : acknowledge(a.manager));
    const waiting = first === "repair" ? acknowledge(b.manager) : repair(b.manager);
    await vi.waitFor(async () => {
      expect((await a.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [session.pid]))[0].wait_event_type).toBe("Lock");
    }, { timeout: 1000, interval: 10 });
    await a.commitTransaction();
    await waiting;
    await b.commitTransaction();
  } finally {
    if (a.isTransactionActive) await a.rollbackTransaction();
    if (b.isTransactionActive) await b.rollbackTransaction();
    await a.release(); await b.release();
  }
  expect(await database.query(`SELECT n.acknowledged_at=d.acknowledged_at AS acknowledged,n.read_at IS NOT NULL AS read
    FROM public.customer_notifications n JOIN public.booking_notification_deliveries d USING(event_key)
    WHERE n.event_key=$1`, [key])).toEqual([{ acknowledged: true, read: true }]);
  await database.query("UPDATE public.customer_notifications SET deleted_at=clock_timestamp() WHERE event_key=$1", [key]);
  const original = await database.query("SELECT * FROM public.customer_notifications WHERE event_key=$1", [key]);
  await recoverBookingNotifications();
  await inTransaction(manager => notifications.acknowledgeBookingNotice(manager, { id: delivery.id, accountUserId: owner }));
  expect(await database.query("SELECT * FROM public.customer_notifications WHERE event_key=$1", [key])).toEqual(original);
});

test("more than 100 persistently failing sources cannot starve newer events and remain retryable", async () => {
  const poison = await booking(), healthy = await booking();
  const keys = Array.from({ length: 105 }, () => `poison:${randomUUID()}`);
  await inTransaction(async manager => {
    for (const key of keys) await recordBookingFinancialException(manager, { key, bookingId: poison.booking_id,
      revisionId: poison.revision.id, kind: "surcharge_unapplied", paymentAttemptId: poison.payment_attempt_id });
  });
  const render = emails.renderBookingEmail;
  const broken = vi.spyOn(emails, "renderBookingEmail").mockImplementation(event => {
    if (event.payload.booking_id === poison.booking_id) throw new Error("persistent render failure");
    return render(event);
  });
  // Traverse the poison batch first, then introduce a newer healthy source.
  expect((await recoverBookingNotifications()).failed).toBe(100);
  const key = `healthy:${randomUUID()}`;
  await inTransaction(manager => recordBookingFinancialException(manager, { key, bookingId: healthy.booking_id,
    revisionId: healthy.revision.id, kind: "surcharge_unapplied", paymentAttemptId: healthy.payment_attempt_id }));
  expect((await recoverBookingNotifications()).recovered).toBe(1);
  const database = await getDataSource();
  expect(await database.query("SELECT event_key FROM public.booking_notification_deliveries WHERE event_key=$1", [key]))
    .toEqual([{ event_key: key }]);
  broken.mockRestore();
  await recoverBookingNotifications(); await recoverBookingNotifications(); await recoverBookingNotifications();
  expect(await database.query("SELECT count(*)::int AS total FROM public.booking_notification_deliveries WHERE event_key=ANY($1::text[])", [keys]))
    .toEqual([{ total: 105 }]);
});

test("a recovery database lock timeout still delivers already queued emails", async () => {
  const held = await booking();
  const key = await confirm(held);
  await recoverBookingNotifications();
  vi.stubEnv("NOTIFICATION_CRON_SECRET", "test-notification-cron-secret-0123456789");
  const delivery = vi.spyOn(mail, "deliverMail").mockResolvedValue({ result: "accepted", messageId: "test-recovery-timeout" });
  const database = await getDataSource();
  const lock = database.createQueryRunner();
  try {
    await lock.startTransaction();
    await lock.query("SELECT singleton FROM public.notification_recovery_cursor WHERE singleton FOR UPDATE");
    const start = Date.now();
    const response = await POST(new Request("http://localhost/api/notifications/deliver", { method: "POST",
      headers: { authorization: `Bearer ${process.env.NOTIFICATION_CRON_SECRET}` } }));
    expect(response.status).toBe(503);
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(delivery).toHaveBeenCalledOnce();
    expect(await lock.query("SELECT delivered_at IS NOT NULL AS delivered FROM public.booking_notification_deliveries WHERE event_key=$1", [key]))
      .toEqual([{ delivered: true }]);
  } finally {
    if (lock.isTransactionActive) await lock.rollbackTransaction();
    await lock.release();
  }
});
