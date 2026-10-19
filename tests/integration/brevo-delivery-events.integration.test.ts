import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { DataSource } from "typeorm";
import { afterAll, afterEach, assert, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { claimDueBookingNotification, hasAdminNotificationAlerts, recordBookingNotificationDelivery } from "@/lib/db/repositories/booking-notifications.repository";
import { deliverBookingNotification, enqueueBookingNotification } from "@/lib/notifications/booking-delivery";
import type { BookingEmailEvent } from "@/lib/notifications/booking-email";
import { deleteAdminNotifications, listAdminUndeliveredNotifications, retryAdminNotification } from "@/lib/notifications/admin-notifications";
import { acknowledgeOwnFinancialNotice, readNotificationIndicators } from "@/lib/notifications/financial-notices";
import { POST as brevoWebhook } from "@/app/api/notifications/brevo/route";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { cleanupBookingFixtures, insertBookingFixture } from "./checkout-fixtures";
import { assertTestEnvironment } from "../local/environment.mjs";

// Brevo delivery webhooks through the real Route Handler, delivery service and
// PostgreSQL. Only Brevo's HTTP API is simulated.
const service = localFixtureClient();
const locationId = randomUUID(), courtId = randomUUID();
const userIds: string[] = [], bookingIds: string[] = [];
const secret = "brevo-webhook-integration-secret-0123456789";
let database: DataSource;
let admin: Awaited<ReturnType<typeof account>>, member: Awaited<ReturnType<typeof account>>;
// Every Brevo API submission: its request body and the messageId Brevo returned.
const submissions: { body: { subject: string; textContent: string; headers: Record<string, string> }; messageId: string }[] = [];

beforeAll(async () => {
  assertTestEnvironment();
  database = await getDataSource();
  assert.strictEqual((await service.from("locations").insert({ id: locationId, name: "Brevo events fixture",
    slug: `brevo-events-${locationId}`, timezone: "UTC", currency: "RON" })).error, null);
  assert.strictEqual((await service.from("courts").insert({ id: courtId, location_id: locationId, name: "Court",
    slug: "court", surface: "clay", environment: "outdoor" })).error, null);
  admin = await account(); member = await account();
  assert.strictEqual((await service.from("user_roles").insert({ user_id: admin.id, role_code: "admin" })).error, null);
});
beforeEach(() => { brevo(); vi.stubEnv("BREVO_WEBHOOK_SECRET", secret); });
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); submissions.length = 0;
  await database.query("DELETE FROM public.customer_notifications WHERE booking_id = ANY($1::uuid[])", [bookingIds]);
  await database.query("DELETE FROM public.booking_notification_deliveries WHERE booking_id = ANY($1::uuid[])", [bookingIds]);
});
afterAll(async () => {
  try {
    if (admin) await service.from("user_roles").delete().eq("user_id", admin.id).eq("role_code", "admin");
    await cleanupBookingFixtures({ bookingIds });
    await service.from("court_reservations").delete().eq("court_id", courtId);
    await service.from("courts").delete().eq("id", courtId);
    await service.from("locations").delete().eq("id", locationId);
    await cleanupAuthFixtures(service, userIds);
  } finally { await database?.destroy(); }
});

const realFetch = globalThis.fetch;
function brevo() {
  vi.stubEnv("BREVO_API_KEY", "simulated-brevo"); vi.stubEnv("BOOKING_MAIL_FROM", "bookings@example.test");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== "https://api.brevo.com/v3/smtp/email") return realFetch(input, init);
    const messageId = `<${randomUUID()}@smtp-relay.mailin.fr>`;
    submissions.push({ body: JSON.parse(String(init?.body)), messageId });
    return Response.json({ messageId }, { status: 201 });
  }));
}
async function account() {
  const email = `brevo-events-${randomUUID()}@example.test`, password = "brevo-events-password-123";
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.strictEqual(created.error, null); assert.ok(created.data.user);
  userIds.push(created.data.user.id);
  const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
  return { id: created.data.user.id, client };
}
async function booking(accountUserId: string | null = null) {
  const reservationId = randomUUID(), id = randomUUID(), start = 360 + (bookingIds.length % 18) * 60;
  assert.strictEqual((await service.from("court_reservations").insert({ id: reservationId, court_id: courtId,
    booking_date: `2099-11-${10 + Math.floor(bookingIds.length / 18)}`, starts_at_minute: start, ends_at_minute: start + 60 })).error, null);
  assert.strictEqual((await insertBookingFixture(service, { id, reservation_id: reservationId, account_user_id: accountUserId,
    payment_method: "pay_at_club", customer_name: "Bounce Customer", customer_email: "bounce@example.test", customer_phone: "123",
    cancellation_notice_minutes: 120, total_amount_minor: 5000, currency: "RON", status: "confirmed" })).error, null);
  bookingIds.push(id);
  return id;
}
async function enqueue(bookingId: string, kind: BookingEmailEvent["event_kind"] = "admin_cancelled") {
  const key = `brevo-events-test:${randomUUID()}`;
  await database.transaction(manager => enqueueBookingNotification(manager, key, { recipient: "bounce@example.test", event_kind: kind,
    payload: { booking_id: bookingId, customer_name: "Bounce Customer", location_name: "Brevo events fixture", timezone: "UTC",
      court_name: "Court", booking_date: "2099-11-10", starts_at_minute: 600, ends_at_minute: 660, total_amount_minor: 5000,
      currency: "RON", previous: null, ...(kind === "refund_incomplete" ? { refund_amount_minor: 5000 } : {}) } }));
  const [created]: { id: string }[] = await database.query("SELECT id FROM public.booking_notification_deliveries WHERE event_key=$1", [key]);
  return created.id;
}
// Enqueue and submit one email; returns the delivery id and Brevo's messageId.
async function sent(bookingId: string, kind?: BookingEmailEvent["event_kind"]) {
  const id = await enqueue(bookingId, kind);
  expect(await deliverBookingNotification(id)).toBe("accepted");
  return { id, messageId: submissions.at(-1)!.messageId };
}

let clock = Date.now();
const event = (name: string, messageId: string, extra: Record<string, unknown> = {}) =>
  ({ event: name, email: "bounce@example.test", id: 1, "message-id": messageId, ts_epoch: clock += 1000, subject: "Booking cancelled", ...extra });
async function webhook(body: unknown, authorization: string | null = `Bearer ${secret}`) {
  const response = await brevoWebhook(new Request("http://localhost/api/notifications/brevo", { method: "POST",
    headers: authorization ? { authorization } : {}, body: JSON.stringify(body) }));
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}
const state = async (id: string) => (await database.query(`SELECT delivered_at IS NOT NULL AS accepted,last_error,provider_message_id,
    provider_status,provider_event,provider_reason,NOT isfinite(next_attempt_at) AS stopped
  FROM public.booking_notification_deliveries WHERE id=$1`, [id]))[0];
const listed = async (bookingId: string) => (await listAdminUndeliveredNotifications({ q: bookingId }, admin.client)).rows;
// The global navbar EXISTS, observed with every other undelivered row hidden in a
// rolled-back transaction, so pre-existing records of the shared stack cannot mask it.
async function alertFor(ids: string[]) {
  const runner = database.createQueryRunner();
  await runner.connect(); await runner.startTransaction();
  try {
    await runner.query(`UPDATE public.booking_notification_deliveries SET delivered_at=clock_timestamp(),
      provider_status=NULL,provider_event=NULL,provider_event_at=NULL WHERE delivered_at IS NULL AND id <> ALL($1::uuid[])`, [ids]);
    return await hasAdminNotificationAlerts(runner.manager);
  } finally { await runner.rollbackTransaction(); await runner.release(); }
}

test.each(["soft_bounce", "hard_bounce", "invalid_email", "blocked", "error"])(
  "API accepted -> %s -> Admin alert with recipient, type, booking, failure type, reason and time", async failure => {
    const bookingId = await booking();
    const { id, messageId } = await sent(bookingId);
    expect(await state(id)).toMatchObject({ accepted: true, provider_message_id: messageId, provider_status: null });
    // Accepted is awaiting confirmation: not an Admin alert, not listed.
    expect(await alertFor([id])).toBe(false);
    expect(await listed(bookingId)).toEqual([]);
    expect(await webhook(event(failure, messageId, { reason: "550 mailbox unavailable" })))
      .toEqual({ status: 200, body: { applied: 1, duplicate: 0, unknown: 0, ignored: 0 } });
    expect(await state(id)).toMatchObject({ accepted: false, last_error: failure, provider_status: "failed", stopped: true });
    const [row] = await listed(bookingId);
    expect(row).toMatchObject({ id, state: "failed", deletable: true, recipient: "bounce@example.test", subject: "Booking cancelled",
      booking_id: bookingId, last_error: failure, failure_reason: "550 mailbox unavailable" });
    expect(Date.parse(row.failed_at!)).toBe(clock);
    expect(await alertFor([id])).toBe(true);
    // Never resent automatically.
    expect(await database.transaction(manager => claimDueBookingNotification(manager, randomUUID()))).not.toMatchObject({ id });
  });

test("API accepted -> deferred -> delivered: no alert at any point", async () => {
  const bookingId = await booking();
  const { id, messageId } = await sent(bookingId);
  expect((await webhook(event("deferred", messageId, { reason: "greylisted" }))).body).toMatchObject({ applied: 1 });
  expect(await state(id)).toMatchObject({ accepted: true, provider_status: "deferred", last_error: null });
  expect(await alertFor([id])).toBe(false);
  expect((await webhook(event("delivered", messageId))).body).toMatchObject({ applied: 1 });
  expect(await state(id)).toMatchObject({ accepted: true, provider_status: "delivered", provider_event: "delivered" });
  expect(await alertFor([id])).toBe(false);
  expect(await listed(bookingId)).toEqual([]);
});

test("duplicate and out-of-order events: redeliveries change nothing and older or deferral events never override", async () => {
  const bookingId = await booking();
  const { id, messageId } = await sent(bookingId);
  const delivered = event("delivered", messageId);
  const olderBounce = event("soft_bounce", messageId, { ts_epoch: delivered.ts_epoch - 500 });
  const laterDeferral = event("deferred", messageId);
  expect((await webhook([delivered, delivered, olderBounce, laterDeferral])).body)
    .toEqual({ applied: 1, duplicate: 3, unknown: 0, ignored: 0 });
  expect(await state(id)).toMatchObject({ accepted: true, provider_status: "delivered" });
  // A failure reported first and then repeated is applied once; Brevo's later successful retry wins.
  const other = await sent(bookingId);
  const bounce = event("soft_bounce", other.messageId);
  expect((await webhook(bounce)).body).toMatchObject({ applied: 1 });
  expect((await webhook(bounce)).body).toMatchObject({ applied: 0, duplicate: 1 });
  expect(await alertFor([other.id])).toBe(true);
  expect((await webhook(event("delivered", other.messageId))).body).toMatchObject({ applied: 1 });
  expect(await state(other.id)).toMatchObject({ accepted: true, provider_status: "delivered", last_error: null });
  expect(await alertFor([id, other.id])).toBe(false);
  // Unknown message ids and engagement events are acknowledged and ignored.
  expect((await webhook([event("hard_bounce", "<unknown@relay>"), event("opened", messageId)])).body)
    .toEqual({ applied: 0, duplicate: 0, unknown: 1, ignored: 1 });
});

test("failure -> Retry now -> delivered clears the alert; a new failure reactivates it; old attempts cannot override", async () => {
  const bookingId = await booking();
  const first = await sent(bookingId);
  await webhook(event("soft_bounce", first.messageId));
  expect(await alertFor([first.id])).toBe(true);
  // Only active Admins may retry.
  await expect(retryAdminNotification({ id: first.id }, member.client)).rejects.toThrow();
  expect(await retryAdminNotification({ id: first.id }, admin.client)).toEqual({ ok: true, result: "accepted" });
  const second = submissions.at(-1)!;
  // The original content, tracked as a new submission that Brevo cannot deduplicate into the bounced one.
  expect(submissions).toHaveLength(2);
  expect(second.body).toMatchObject({ subject: submissions[0].body.subject, textContent: submissions[0].body.textContent });
  expect(second.body.headers.idempotencyKey).not.toBe(submissions[0].body.headers.idempotencyKey);
  expect(second.body.headers["X-Mailin-custom"]).toBe(`booking-notification:${second.body.headers.idempotencyKey}`);
  expect(await state(first.id)).toMatchObject({ accepted: true, provider_message_id: second.messageId, provider_status: null, last_error: null });
  // Awaiting confirmation is not actionable; a concurrent second retry sends nothing.
  expect(await alertFor([first.id])).toBe(false);
  expect(await listed(bookingId)).toEqual([]);
  expect(await retryAdminNotification({ id: first.id }, admin.client)).toEqual({ ok: true, result: "already_delivered" });
  expect(submissions).toHaveLength(2);
  // Late events of the old attempt are unknown and never override the new one.
  expect((await webhook([event("hard_bounce", first.messageId), event("delivered", first.messageId)])).body).toMatchObject({ unknown: 2 });
  expect((await webhook(event("hard_bounce", first.messageId, { "X-Mailin-custom": submissions[0].body.headers["X-Mailin-custom"] }))).body)
    .toMatchObject({ unknown: 1 });
  expect(await state(first.id)).toMatchObject({ accepted: true, provider_status: null });
  // The retry also bounces: the alert is reactivated.
  await webhook(event("hard_bounce", second.messageId, { reason: "unknown user" }));
  expect(await alertFor([first.id])).toBe(true);
  expect(await listed(bookingId)).toMatchObject([{ id: first.id, state: "failed", last_error: "hard_bounce", failure_reason: "unknown user" }]);
  // A third submission is delivered; the old attempts' late failures cannot reopen it.
  expect(await retryAdminNotification({ id: first.id }, admin.client)).toEqual({ ok: true, result: "accepted" });
  const third = submissions.at(-1)!;
  await webhook(event("delivered", third.messageId));
  await webhook([event("soft_bounce", first.messageId), event("hard_bounce", second.messageId)]);
  expect(await state(first.id)).toMatchObject({ accepted: true, provider_message_id: third.messageId, provider_status: "delivered" });
  expect(await alertFor([first.id])).toBe(false);
});

test("an event that arrives before the acceptance is recorded is correlated by submission key and is not overwritten", async () => {
  const bookingId = await booking();
  const id = await enqueue(bookingId), token = randomUUID();
  const claim = await database.transaction(manager => claimDueBookingNotification(manager, token, id));
  assert.ok(claim);
  const messageId = `<${randomUUID()}@smtp-relay.mailin.fr>`;
  expect((await webhook(event("invalid_email", messageId, { "X-Mailin-custom": `booking-notification:${claim.submission_key}` }))).body)
    .toMatchObject({ applied: 1 });
  await database.transaction(manager => recordBookingNotificationDelivery(manager, { id, token, lastError: null, retrySeconds: 0, messageId }));
  expect(await state(id)).toMatchObject({ accepted: false, last_error: "invalid_email", provider_message_id: messageId, stopped: true });
  expect(await listed(bookingId)).toMatchObject([{ id, state: "failed" }]);
});

test("failure -> manual dismissal clears the alert; replayed or late events cannot recreate it", async () => {
  const bookingId = await booking(member.id);
  const { id, messageId } = await sent(bookingId);
  const bounce = event("soft_bounce", messageId);
  await webhook(bounce);
  expect(await alertFor([id])).toBe(true);
  const inbox = await database.query("SELECT id,read_at,deleted_at FROM public.customer_notifications WHERE booking_id=$1", [bookingId]);
  expect(inbox).toHaveLength(1);
  await expect(deleteAdminNotifications({ ids: [id] }, member.client)).rejects.toThrow();
  expect(await deleteAdminNotifications({ ids: [id] }, admin.client)).toEqual({ ok: true, deleted: [id], skipped: 0 });
  expect(await alertFor([])).toBe(false);
  expect((await webhook([bounce, event("hard_bounce", messageId), event("delivered", messageId)])).body).toMatchObject({ unknown: 3 });
  expect(await database.query("SELECT dismissed_at IS NOT NULL AS dismissed FROM public.booking_notification_deliveries WHERE booking_id=$1", [bookingId]))
    .toEqual([{ dismissed: true }]);
  // The customer's own in-app notification is independent of email delivery and dismissal.
  expect(await database.query("SELECT id,read_at,deleted_at FROM public.customer_notifications WHERE booking_id=$1", [bookingId])).toEqual(inbox);
});

test("a bounced financial email can be dismissed without resolving the customer's exception", async () => {
  const bookingId = await booking(member.id);
  const exception = await sent(bookingId, "refund_incomplete"), ordinary = await sent(bookingId, "admin_cancelled");
  await webhook([event("hard_bounce", exception.messageId), event("soft_bounce", ordinary.messageId)]);
  const rows = await listed(bookingId);
  expect(rows.map(row => [row.id, row.state, row.important, row.deletable]))
    .toEqual([[exception.id, "failed", true, true], [ordinary.id, "failed", false, true]]);
  expect(await deleteAdminNotifications({ ids: [exception.id, ordinary.id] }, admin.client))
    .toEqual({ ok: true, deleted: expect.arrayContaining([ordinary.id, exception.id]), skipped: 0 });
  expect(await listed(bookingId)).toEqual([]);
  expect(await alertFor([])).toBe(false);
  expect(await database.query("SELECT requires_acknowledgement,acknowledged_at FROM public.booking_notification_deliveries WHERE id=$1",
    [exception.id])).toEqual([{ requires_acknowledgement: true, acknowledged_at: null }]);
  // Late events for the dismissed email are unknown and cannot restore it.
  expect((await webhook(event("delivered", exception.messageId))).body).toMatchObject({ unknown: 1 });
  expect(await listed(bookingId)).toEqual([]);
  // The customer's exception and inbox copy stay unresolved until the customer acknowledges them.
  expect(await database.query(`SELECT acknowledged_at FROM public.customer_notifications WHERE id=$1`, [exception.id]))
    .toEqual([{ acknowledged_at: null }]);
  expect(await acknowledgeOwnFinancialNotice(exception.id, member.client)).toEqual({ ok: true });
});

test("unauthorized webhook requests are rejected and change nothing", async () => {
  const bookingId = await booking();
  const { id, messageId } = await sent(bookingId);
  const before = await state(id);
  for (const authorization of [null, "Bearer wrong-secret", `Basic ${Buffer.from("brevo:wrong").toString("base64")}`])
    expect((await webhook(event("hard_bounce", messageId), authorization)).status).toBe(401);
  vi.stubEnv("BREVO_WEBHOOK_SECRET", "");
  expect((await webhook(event("hard_bounce", messageId), "Bearer ")).status).toBe(503);
  expect(await state(id)).toEqual(before);
  // Basic authentication with the secret as password is accepted.
  vi.stubEnv("BREVO_WEBHOOK_SECRET", secret);
  expect((await webhook(event("delivered", messageId), `Basic ${Buffer.from(`brevo:${secret}`).toString("base64")}`)).status).toBe(200);
});

test("non-Admins receive no operational alert data and cannot list Admin notifications", async () => {
  const bookingId = await booking();
  const { id, messageId } = await sent(bookingId);
  await webhook(event("hard_bounce", messageId));
  expect(await alertFor([id])).toBe(true);
  expect(await readNotificationIndicators(member.client)).toEqual({ unread: false });
  expect(await readNotificationIndicators(admin.client)).toMatchObject({ adminAlerts: true });
  await expect(listAdminUndeliveredNotifications({ q: bookingId }, member.client)).rejects.toThrow();
});
