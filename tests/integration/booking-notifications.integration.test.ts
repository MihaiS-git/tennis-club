import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { DataSource } from "typeorm";
import { afterAll, afterEach, assert, beforeAll, expect, test, vi } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { deliverPendingBookingNotifications, enqueueBookingNotification, maxAutomaticDeliveryAttempts as maxAttempts } from "@/lib/notifications/booking-delivery";
import type { BookingEmailEvent } from "@/lib/notifications/booking-email";
import { acknowledgeOwnFinancialNotice, listOwnFinancialNotices } from "@/lib/notifications/financial-notices";
import { adminNotificationsPageSize, listAdminUndeliveredNotifications, retryAdminNotification } from "@/lib/notifications/admin-notifications";
import { POST as scheduledDelivery } from "@/app/api/notifications/deliver/route";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { cleanupBookingFixtures, insertBookingFixture } from "./checkout-fixtures";
import { isolateNotificationQueue } from "./booking-notification-fixtures";
import { assertTestEnvironment } from "../local/environment.mjs";

// Post-commit and scheduled (Supabase Cron endpoint) delivery and in-app
// acknowledgement, with no real mail.
const service = localFixtureClient();
const locationId = randomUUID(), courtId = randomUUID();
const userIds: string[] = [], bookingIds: string[] = [];
let database: DataSource;
let restoreQueue: () => Promise<void>;
const submitted: string[] = [];
let brevoStatus = 201;

beforeAll(async () => {
  assertTestEnvironment();
  database = await getDataSource();
  restoreQueue = await isolateNotificationQueue(database.manager);
  assert.strictEqual((await service.from("locations").insert({ id: locationId, name: "Notification fixture",
    slug: `notifications-${locationId}`, timezone: "UTC", currency: "RON" })).error, null);
  assert.strictEqual((await service.from("courts").insert({ id: courtId, location_id: locationId, name: "Court",
    slug: "court", surface: "clay", environment: "outdoor" })).error, null);
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); submitted.length = 0; brevoStatus = 201;
  // Each test observes only its own queued rows.
  await database.query("DELETE FROM public.booking_notification_deliveries WHERE booking_id = ANY($1::uuid[])", [bookingIds]);
});
afterAll(async () => {
  try {
    await cleanupBookingFixtures({ bookingIds });
    await service.from("court_reservations").delete().eq("court_id", courtId);
    await service.from("courts").delete().eq("id", courtId);
    await service.from("locations").delete().eq("id", locationId);
    await cleanupAuthFixtures(service, userIds);
    await restoreQueue?.();
  } finally { await database?.destroy(); }
});

const realFetch = globalThis.fetch;
function brevo() {
  vi.stubEnv("BREVO_API_KEY", "simulated-brevo"); vi.stubEnv("BOOKING_MAIL_FROM", "bookings@example.test");
  // Only Brevo is simulated; local Supabase Auth requests keep the real transport.
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== "https://api.brevo.com/v3/smtp/email") return realFetch(input, init);
    submitted.push(String(init?.body));
    return new Response(null, { status: brevoStatus });
  }));
}
async function account() {
  const email = `notice-${randomUUID()}@example.test`, password = "notice-test-password-123";
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.strictEqual(created.error, null); assert.ok(created.data.user);
  userIds.push(created.data.user.id);
  const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
  return { id: created.data.user.id, client };
}
async function booking(accountUserId: string | null) {
  const reservationId = randomUUID(), id = randomUUID(), start = 360 + bookingIds.length * 60;
  assert.strictEqual((await service.from("court_reservations").insert({ id: reservationId, court_id: courtId,
    booking_date: "2099-10-15", starts_at_minute: start, ends_at_minute: start + 60 })).error, null);
  assert.strictEqual((await insertBookingFixture(service, { id, reservation_id: reservationId, account_user_id: accountUserId,
    payment_method: "pay_at_club", customer_name: "Notice Customer", customer_email: "notice@example.test", customer_phone: "123",
    cancellation_notice_minutes: 120, total_amount_minor: 5000, currency: "RON", status: "confirmed" })).error, null);
  bookingIds.push(id);
  return id;
}
const event = (bookingId: string, kind: BookingEmailEvent["event_kind"]): BookingEmailEvent => ({
  recipient: "notice@example.test", event_kind: kind, payload: { booking_id: bookingId, customer_name: "Notice Customer",
    location_name: "Notification fixture", timezone: "UTC", court_name: "Court", booking_date: "2099-10-15",
    starts_at_minute: 600, ends_at_minute: 660, total_amount_minor: 5000, currency: "RON", previous: null,
    ...(kind === "refund_incomplete" ? { refund_amount_minor: 5000 } : {}) } });
async function enqueue(bookingId: string, kind: BookingEmailEvent["event_kind"]) {
  const key = `notification-test:${randomUUID()}`;
  await database.transaction(manager => enqueueBookingNotification(manager, key, event(bookingId, kind)));
  const [row]: { id: string }[] = await database.query("SELECT id FROM public.booking_notification_deliveries WHERE event_key=$1", [key]);
  return row.id;
}
const row = async (id: string) => (await database.query(
  "SELECT attempts,delivered_at IS NOT NULL AS delivered,lease_token,last_error FROM public.booking_notification_deliveries WHERE id=$1", [id]))[0];

test("the outbox rolls back with its transaction and an event key is stored once", async () => {
  const bookingId = await booking(null), key = `notification-test:${randomUUID()}`;
  await expect(database.transaction(async manager => {
    await enqueueBookingNotification(manager, key, event(bookingId, "confirmed"));
    throw new Error("interrupted before commit");
  })).rejects.toThrow("interrupted before commit");
  expect(await database.query("SELECT id FROM public.booking_notification_deliveries WHERE event_key=$1", [key])).toEqual([]);
  await database.transaction(async manager => {
    await enqueueBookingNotification(manager, key, event(bookingId, "confirmed"));
    await enqueueBookingNotification(manager, key, event(bookingId, "confirmed"));
  });
  expect(await database.query("SELECT id FROM public.booking_notification_deliveries WHERE event_key=$1", [key])).toHaveLength(1);
});

test("unconfigured mail is recorded as an undelivered failure, never skipped silently", async () => {
  const id = await enqueue(await booking(null), "confirmed");
  expect(await deliverPendingBookingNotifications()).toMatchObject({ failed: 1 });
  expect(await row(id)).toMatchObject({ attempts: 1, delivered: false, last_error: "not_configured" });
});

test("a temporary Brevo failure keeps the row due with backoff; a later post-commit delivery sends it once", async () => {
  brevo(); brevoStatus = 503;
  const id = await enqueue(await booking(null), "confirmed");
  expect(await deliverPendingBookingNotifications()).toMatchObject({ failed: 1 });
  expect(await row(id)).toMatchObject({ attempts: 1, delivered: false, lease_token: null, last_error: "unavailable" });
  // The delivery id is the stable Brevo idempotency key in every submission.
  const submissions = () => submitted.filter(body => body.includes(id)).length;
  expect(submissions()).toBe(1);
  brevoStatus = 201;
  await deliverPendingBookingNotifications();
  expect(submissions()).toBe(1); // Not due yet: no early resend.
  expect(await row(id)).toMatchObject({ attempts: 1, delivered: false });
  await database.query("UPDATE public.booking_notification_deliveries SET next_attempt_at=clock_timestamp() WHERE id=$1", [id]);
  await deliverPendingBookingNotifications();
  expect(submissions()).toBe(2);
  expect(await row(id)).toMatchObject({ attempts: 2, delivered: true, last_error: null });
});

test("concurrent post-commit deliveries submit each pending notification once", async () => {
  brevo();
  const bookingId = await booking(null);
  const ids = await Promise.all([enqueue(bookingId, "confirmed"), enqueue(bookingId, "customer_cancelled"), enqueue(bookingId, "admin_cancelled")]);
  await Promise.all([deliverPendingBookingNotifications(), deliverPendingBookingNotifications(), deliverPendingBookingNotifications()]);
  expect(submitted).toHaveLength(3);
  for (const id of ids) expect(await row(id)).toMatchObject({ attempts: 1, delivered: true });
  await deliverPendingBookingNotifications();
  expect(submitted).toHaveLength(3);
});

test("important financial notices stay visible to the booking owner until acknowledged, independent of email", async () => {
  brevo();
  const member = await account(), other = await account();
  const owned = await booking(member.id), guest = await booking(null);
  const important = await enqueue(owned, "refund_incomplete");
  await enqueue(owned, "confirmed");
  await enqueue(guest, "cancellation_failed");
  // Email delivery succeeds, which is not acknowledgement.
  await deliverPendingBookingNotifications();
  expect(await row(important)).toMatchObject({ delivered: true });
  const notices = await listOwnFinancialNotices(member.client);
  expect(notices).toEqual([{ id: important, subject: "Refund requires attention", important: true, emailFailed: false,
    text: expect.stringContaining("could not be completed automatically") }]);
  expect(notices[0].text).not.toMatch(/^Hello/);
  expect(await listOwnFinancialNotices(other.client)).toEqual([]);
  expect(await acknowledgeOwnFinancialNotice(important, other.client)).toEqual({ ok: false, message: "This notice is no longer available." });
  expect(await acknowledgeOwnFinancialNotice("not-a-uuid", member.client)).toEqual({ ok: false, message: "Choose a valid notice." });
  expect(await listOwnFinancialNotices(member.client)).toHaveLength(1);
  expect(await acknowledgeOwnFinancialNotice(important, member.client)).toEqual({ ok: true });
  expect(await listOwnFinancialNotices(member.client)).toEqual([]);
  expect(await acknowledgeOwnFinancialNotice(important, member.client)).toEqual({ ok: false, message: "This notice is no longer available." });
  expect(await database.query("SELECT acknowledged_at IS NOT NULL AS acknowledged FROM public.booking_notification_deliveries WHERE id=$1", [important]))
    .toEqual([{ acknowledged: true }]);
});

test("a failed email stays visible to Admin and the customer; an explicit Admin retry ignores backoff", async () => {
  brevo(); brevoStatus = 503;
  const member = await account(), admin = await account();
  assert.strictEqual((await service.from("user_roles").insert({ user_id: admin.id, role_code: "admin" })).error, null);
  const owned = await booking(member.id);
  const confirmation = await enqueue(owned, "confirmed"), exception = await enqueue(owned, "refund_incomplete");
  await deliverPendingBookingNotifications();
  expect(await row(confirmation)).toMatchObject({ attempts: 1, delivered: false, last_error: "unavailable" });
  // The unacknowledged financial exception is listed before the ordinary email.
  const undelivered = (await listAdminUndeliveredNotifications({}, admin.client)).rows.filter(item => item.booking_id === owned);
  expect(undelivered.map(item => ({ id: item.id, last_error: item.last_error, important: item.important })))
    .toEqual([{ id: exception, last_error: "unavailable", important: true }, { id: confirmation, last_error: "unavailable", important: false }]);
  // The customer is told in-app that the email failed, for both messages.
  const notices = await listOwnFinancialNotices(member.client);
  expect(notices.map(notice => ({ id: notice.id, important: notice.important, emailFailed: notice.emailFailed })))
    .toEqual([{ id: exception, important: true, emailFailed: true }, { id: confirmation, important: false, emailFailed: true }]);
  // Only an active Admin may retry; the retry ignores backoff and reports the exact outcome.
  await expect(retryAdminNotification({ id: confirmation }, member.client)).rejects.toThrow();
  expect(await retryAdminNotification({ id: confirmation }, admin.client)).toEqual({ ok: true, result: "unavailable" });
  expect(await row(confirmation)).toMatchObject({ attempts: 2, delivered: false });
  brevoStatus = 201;
  expect(await retryAdminNotification({ id: confirmation }, admin.client)).toEqual({ ok: true, result: "accepted" });
  expect(await retryAdminNotification({ id: confirmation }, admin.client)).toEqual({ ok: true, result: "already_delivered" });
  expect(await row(confirmation)).toMatchObject({ attempts: 3, delivered: true, last_error: null });
  // Delivered informational messages leave the customer view; the important one waits for OK.
  expect((await listOwnFinancialNotices(member.client)).map(notice => notice.id)).toEqual([exception]);
  expect((await listAdminUndeliveredNotifications({}, admin.client)).rows.map(item => item.id)).not.toContain(confirmation);
  await service.from("user_roles").delete().eq("user_id", admin.id).eq("role_code", "admin");
});

const cronSecret = "notification-cron-test-secret-0123456789abcdef";
const scheduled = (authorization: string | null = `Bearer ${cronSecret}`) => scheduledDelivery(new Request(
  "http://localhost/api/notifications/deliver", { method: "POST", headers: authorization ? { authorization } : {} }));
const due = (ids: string[]) => database.query(
  "UPDATE public.booking_notification_deliveries SET next_attempt_at=clock_timestamp() WHERE id=ANY($1::uuid[])", [ids]);
const schedule = async (id: string) => (await database.query(
  "SELECT isfinite(next_attempt_at) AS automatic FROM public.booking_notification_deliveries WHERE id=$1", [id]))[0].automatic as boolean;

test("the scheduled endpoint rejects requests without its dedicated secret and sends nothing", async () => {
  brevo(); vi.stubEnv("NOTIFICATION_CRON_SECRET", cronSecret);
  const id = await enqueue(await booking(null), "confirmed");
  for (const header of [null, "Bearer wrong-secret", cronSecret, `Basic ${cronSecret}`])
    expect((await scheduled(header)).status).toBe(401);
  expect(submitted).toHaveLength(0);
  expect(await row(id)).toMatchObject({ attempts: 0, delivered: false });
  vi.stubEnv("NOTIFICATION_CRON_SECRET", "");
  expect((await scheduled()).status).toBe(503);
  expect(submitted).toHaveLength(0);
});

test("a guest confirmation that Brevo first fails is delivered by Supabase Cron without any other request", async () => {
  brevo(); vi.stubEnv("NOTIFICATION_CRON_SECRET", cronSecret); brevoStatus = 503;
  const id = await enqueue(await booking(null), "confirmed");
  // The booking request's own post-commit delivery fails temporarily.
  await deliverPendingBookingNotifications();
  expect(await row(id)).toMatchObject({ attempts: 1, delivered: false, last_error: "unavailable" });
  expect(await schedule(id)).toBe(true);
  brevoStatus = 201;
  // Not due yet: the next cron run leaves it alone.
  expect(await (await scheduled()).json()).toEqual({ checked: 0, failed: 0 });
  // A later cron run, after the backoff, delivers it. No booking or Admin request happens.
  await due([id]);
  const response = await scheduled();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ checked: 1, failed: 0 });
  expect(await row(id)).toMatchObject({ attempts: 2, delivered: true, last_error: null });
  expect(submitted.filter(body => body.includes(id))).toHaveLength(2);
  // A delivered email is never sent again.
  await due([id]);
  expect(await (await scheduled()).json()).toEqual({ checked: 0, failed: 0 });
  expect(submitted.filter(body => body.includes(id))).toHaveLength(2);
});

test("concurrent scheduled invocations submit each due notification once", async () => {
  vi.stubEnv("NOTIFICATION_CRON_SECRET", cronSecret);
  vi.stubEnv("BREVO_API_KEY", "simulated-brevo"); vi.stubEnv("BOOKING_MAIL_FROM", "bookings@example.test");
  // Slow provider responses keep the invocations overlapping.
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== "https://api.brevo.com/v3/smtp/email") return realFetch(input, init);
    submitted.push(String(init?.body));
    await new Promise(resolve => setTimeout(resolve, 150));
    return new Response(null, { status: 201 });
  }));
  const bookingId = await booking(null);
  const ids = await Promise.all(Array.from({ length: 5 }, (_, index) => enqueue(bookingId, index % 2 ? "confirmed" : "customer_cancelled")));
  const results = await Promise.all([scheduled(), scheduled(), scheduled()]);
  expect(results.map(result => result.status)).toEqual([200, 200, 200]);
  const counts: { checked: number; failed: number }[] = await Promise.all(results.map(result => result.json()));
  expect(counts.reduce((sum, count) => sum + count.checked, 0)).toBe(5);
  expect(submitted).toHaveLength(5);
  for (const id of ids) {
    expect(submitted.filter(body => body.includes(id))).toHaveLength(1);
    expect(await row(id)).toMatchObject({ attempts: 1, delivered: true });
  }
});

test("permanent and exhausted failures stop automatic retries and stay visible to Admins for a manual retry", async () => {
  brevo(); vi.stubEnv("NOTIFICATION_CRON_SECRET", cronSecret);
  const admin = await account();
  assert.strictEqual((await service.from("user_roles").insert({ user_id: admin.id, role_code: "admin" })).error, null);
  try {
    const guest = await booking(null);
    const permanent = await enqueue(guest, "confirmed"), exhausted = await enqueue(guest, "customer_cancelled");
    // The exhausted row has already used all but one automatic attempt.
    await database.query("UPDATE public.booking_notification_deliveries SET attempts=$2 WHERE id=$1", [exhausted, maxAttempts - 1]);
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input) !== "https://api.brevo.com/v3/smtp/email") return realFetch(input, init);
      submitted.push(String(init?.body));
      return new Response(null, { status: String(init?.body).includes(permanent) ? 400 : 503 });
    });
    expect(await (await scheduled()).json()).toEqual({ checked: 2, failed: 2 });
    expect(await row(permanent)).toMatchObject({ attempts: 1, delivered: false, last_error: "rejected" });
    expect(await row(exhausted)).toMatchObject({ attempts: maxAttempts, delivered: false, last_error: "unavailable" });
    expect(await schedule(permanent)).toBe(false);
    expect(await schedule(exhausted)).toBe(false);
    // Later cron runs never pick them up again.
    expect(await (await scheduled()).json()).toEqual({ checked: 0, failed: 0 });
    expect(submitted).toHaveLength(2);
    const listed = (await listAdminUndeliveredNotifications({}, admin.client)).rows.filter(item => [permanent, exhausted].includes(item.id));
    expect(listed.map(item => ({ id: item.id, last_error: item.last_error, next_attempt_at: item.next_attempt_at })).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([{ id: permanent, last_error: "rejected", next_attempt_at: null }, { id: exhausted, last_error: "unavailable", next_attempt_at: null }]
        .sort((a, b) => a.id.localeCompare(b.id)));
    // Manual Admin retry remains available.
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (String(input) !== "https://api.brevo.com/v3/smtp/email") return realFetch(input, init);
      submitted.push(String(init?.body));
      return new Response(null, { status: 201 });
    });
    expect(await retryAdminNotification({ id: permanent }, admin.client)).toEqual({ ok: true, result: "accepted" });
    expect(await row(permanent)).toMatchObject({ attempts: 2, delivered: true });
  } finally {
    await service.from("user_roles").delete().eq("user_id", admin.id).eq("role_code", "admin");
  }
});

test("important notices stay visible beyond list limits and Admin pages are complete and stable", async () => {
  const member = await account(), admin = await account();
  assert.strictEqual((await service.from("user_roles").insert({ user_id: admin.id, role_code: "admin" })).error, null);
  try {
    const owned = await booking(member.id), guest = await booking(null);
    // The guest's financial exception is the oldest row; 30 newer ordinary emails failed.
    const guestException = await enqueue(guest, "late_payment_refund");
    const ordinary: string[] = [];
    for (let index = 0; index < 30; index++) ordinary.push(await enqueue(owned, "confirmed"));
    const ownException = await enqueue(owned, "refund_incomplete");
    await database.query("UPDATE public.booking_notification_deliveries SET attempts=1,last_error='unavailable' WHERE id=ANY($1::uuid[])",
      [[guestException, ...ordinary, ownException]]);
    // The owner's newest important notice precedes the 20-row limit of older failed emails.
    const notices = await listOwnFinancialNotices(member.client);
    expect(notices).toHaveLength(20);
    expect(notices[0]).toMatchObject({ id: ownException, important: true });
    // Every Admin page holds at most one page of rows; together they list each row once.
    const first = await listAdminUndeliveredNotifications({}, admin.client);
    expect(first.page).toBe(1);
    expect(first.total).toBeGreaterThanOrEqual(32);
    expect(first.unacknowledgedExceptions).toBeGreaterThanOrEqual(2);
    expect(first.totalPages).toBe(Math.ceil(first.total / adminNotificationsPageSize));
    const seen: string[] = [];
    for (let page = 1; page <= first.totalPages; page++) {
      const result = await listAdminUndeliveredNotifications({ page: String(page) }, admin.client);
      expect(result.rows.length).toBeLessThanOrEqual(adminNotificationsPageSize);
      seen.push(...result.rows.map(item => item.id));
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining([guestException, ownException, ...ordinary]));
    // Unacknowledged exceptions come before every ordinary email, whatever their age.
    for (const exception of [guestException, ownException])
      expect(seen.indexOf(exception)).toBeLessThan(Math.min(...ordinary.map(id => seen.indexOf(id))));
    expect(first.rows.map(item => item.id)).toEqual(expect.arrayContaining([guestException, ownException]));
    // Ordinary emails are newest first, and repeated reads return the same order.
    const ours = seen.filter(id => ordinary.includes(id));
    expect(ours).toEqual([...ordinary].reverse());
    expect((await listAdminUndeliveredNotifications({ page: "2" }, admin.client)).rows)
      .toEqual((await listAdminUndeliveredNotifications({ page: "2" }, admin.client)).rows);
    // Invalid and out-of-range pages fall back to valid pages.
    expect((await listAdminUndeliveredNotifications({ page: "abc" }, admin.client)).page).toBe(1);
    expect((await listAdminUndeliveredNotifications({ page: "9999" }, admin.client)).page).toBe(first.totalPages);
    // Acknowledgement keeps its existing behavior and moves the exception into the ordinary order.
    expect(await acknowledgeOwnFinancialNotice(ownException, member.client)).toEqual({ ok: true });
    expect((await listOwnFinancialNotices(member.client)).map(notice => notice.id)).not.toContain(ownException);
    await expect(listAdminUndeliveredNotifications({}, member.client)).rejects.toThrow();
  } finally {
    await service.from("user_roles").delete().eq("user_id", admin.id).eq("role_code", "admin");
  }
});
