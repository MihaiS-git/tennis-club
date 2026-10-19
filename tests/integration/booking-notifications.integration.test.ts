import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { DataSource } from "typeorm";
import { afterAll, afterEach, assert, beforeAll, expect, test, vi } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { deliverPendingBookingNotifications, enqueueBookingNotification, maxAutomaticDeliveryAttempts as maxAttempts } from "@/lib/notifications/booking-delivery";
import type { BookingEmailEvent } from "@/lib/notifications/booking-email";
import { acknowledgeOwnFinancialNotice, listOwnFinancialNotices, listOwnNotifications, markOwnNotificationRead, manageOwnNotifications, readOwnNotification, readOwnUnreadNotifications } from "@/lib/notifications/financial-notices";
import { adminNotificationsPageSize, deleteAdminNotifications, listAdminUndeliveredNotifications, retryAdminNotification } from "@/lib/notifications/admin-notifications";
import { claimDueBookingNotification } from "@/lib/db/repositories/booking-notifications.repository";
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
  await database.query("DELETE FROM public.customer_notifications WHERE booking_id = ANY($1::uuid[])", [bookingIds]);
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
  const reservationId = randomUUID(), id = randomUUID(), start = 360 + (bookingIds.length % 18) * 60;
  assert.strictEqual((await service.from("court_reservations").insert({ id: reservationId, court_id: courtId,
    booking_date: `2099-10-${15 + Math.floor(bookingIds.length / 18)}`, starts_at_minute: start, ends_at_minute: start + 60 })).error, null);
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

const setState = (id: string, sql: string) => database.query(`UPDATE public.booking_notification_deliveries SET ${sql} WHERE id=$1`, [id]);
const exists = async (id: string) => (await database.query("SELECT 1 FROM public.booking_notification_deliveries WHERE id=$1", [id])).length === 1;
const stop = "attempts=8,last_error='unavailable',next_attempt_at='infinity'";

test("Admins permanently dismiss stopped emails of every type; active and retrying rows are protected", async () => {
  const member = await account(), admin = await account();
  assert.strictEqual((await service.from("user_roles").insert({ user_id: admin.id, role_code: "admin" })).error, null);
  try {
    const owned = await booking(member.id);
    const [stopped, rejected, retrying, queued, sending, financial] = [
      await enqueue(owned, "confirmed"), await enqueue(owned, "customer_rescheduled"), await enqueue(owned, "confirmed"),
      await enqueue(owned, "confirmed"), await enqueue(owned, "confirmed"), await enqueue(owned, "refund_incomplete")];
    await setState(stopped, stop);
    await setState(rejected, "attempts=1,last_error='rejected',next_attempt_at='infinity'");
    await setState(retrying, "attempts=1,last_error='unavailable',next_attempt_at=clock_timestamp()+interval '1 hour'");
    await setState(sending, `${stop},lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes'`);
    await setState(financial, stop);
    const listed = (await listAdminUndeliveredNotifications({ q: owned }, admin.client)).rows;
    expect(Object.fromEntries(listed.map((item) => [item.id, [item.state, item.deletable]]))).toEqual({
      [stopped]: ["stopped", true], [rejected]: ["stopped", true], [retrying]: ["retrying", false],
      [queued]: ["queued", false], [sending]: ["sending", false], [financial]: ["stopped", true] });
    const bookingBefore = await database.query("SELECT to_jsonb(b) AS booking FROM public.bookings b WHERE b.id=$1", [owned]);

    // Only an active Admin may delete, and the input is validated before any database work.
    await expect(deleteAdminNotifications({ ids: [stopped] }, member.client)).rejects.toThrow();
    for (const ids of [[], ["not-a-uuid"], [stopped, stopped], Array.from({ length: adminNotificationsPageSize + 1 }, () => randomUUID())])
      expect(await deleteAdminNotifications({ ids }, admin.client)).toEqual({ ok: false, message: "Choose valid notifications to delete." });

    // Individual deletion.
    expect(await deleteAdminNotifications({ ids: [stopped] }, admin.client)).toEqual({ ok: true, deleted: [stopped], skipped: 0 });
    expect(await exists(stopped)).toBe(true);
    expect(await database.query("SELECT dismissed_at IS NOT NULL AS dismissed FROM public.booking_notification_deliveries WHERE id=$1",
      [stopped])).toEqual([{ dismissed: true }]);
    expect(await retryAdminNotification({ id: stopped }, admin.client)).toEqual({ ok: false, message: "This notification no longer exists." });
    expect(await database.transaction(manager => claimDueBookingNotification(manager, randomUUID(), stopped))).toBeUndefined();
    // Bulk deletion skips every protected row, including ones selected by a stale page.
    const bulk = await deleteAdminNotifications({ ids: [rejected, retrying, queued, sending, financial, randomUUID()] }, admin.client);
    expect(bulk).toEqual({ ok: true, deleted: [rejected, financial], skipped: 4 });
    for (const id of [retrying, queued, sending]) expect(await exists(id)).toBe(true);
    // The financial row is only dismissed: hidden from Admins, never sent again, still unacknowledged.
    expect(await database.query("SELECT dismissed_at IS NOT NULL AS dismissed,acknowledged_at FROM public.booking_notification_deliveries WHERE id=$1",
      [financial])).toEqual([{ dismissed: true, acknowledged_at: null }]);
    expect((await listAdminUndeliveredNotifications({ q: owned }, admin.client)).rows.map((item) => item.id)).not.toContain(financial);
    expect(await database.transaction((manager) => claimDueBookingNotification(manager, randomUUID(), financial))).toBeUndefined();
    expect(await retryAdminNotification({ id: financial }, admin.client)).toEqual({ ok: false, message: "This notification no longer exists." });
    expect(await deleteAdminNotifications({ ids: [financial] }, admin.client)).toEqual({ ok: true, deleted: [], skipped: 1 });
    // Booking records and the customer's financial notice are untouched, and the customer can still acknowledge it.
    expect(await database.query("SELECT to_jsonb(b) AS booking FROM public.bookings b WHERE b.id=$1", [owned])).toEqual(bookingBefore);
    expect((await listOwnFinancialNotices(member.client)).map((notice) => notice.id)).toContain(financial);
    expect(await acknowledgeOwnFinancialNotice(financial, member.client)).toEqual({ ok: true });
    expect(await database.query("SELECT acknowledged_at IS NOT NULL AS acknowledged FROM public.customer_notifications WHERE id=$1",
      [financial])).toEqual([{ acknowledged: true }]);
  } finally {
    await service.from("user_roles").delete().eq("user_id", admin.id).eq("role_code", "admin");
  }
});

test("a manual retry that claims a selected row first prevents its deletion; a deleted row cannot be claimed", async () => {
  const admin = await account();
  assert.strictEqual((await service.from("user_roles").insert({ user_id: admin.id, role_code: "admin" })).error, null);
  try {
    const guest = await booking(null);
    const claimed = await enqueue(guest, "confirmed"), deleted = await enqueue(guest, "confirmed");
    await setState(claimed, stop); await setState(deleted, stop);
    // The Admin selected both rows; a retry then claims one before the deletion runs.
    const claim = await database.transaction((manager) => claimDueBookingNotification(manager, randomUUID(), claimed));
    expect(claim?.id).toBe(claimed);
    expect(await deleteAdminNotifications({ ids: [claimed, deleted] }, admin.client)).toEqual({ ok: true, deleted: [deleted], skipped: 1 });
    expect(await exists(claimed)).toBe(true);
    // Deleted rows are gone for every later delivery.
    expect(await database.transaction((manager) => claimDueBookingNotification(manager, randomUUID(), deleted))).toBeUndefined();
    // A deletion waiting on a row lock re-checks the lease once the claim commits.
    await setState(claimed, "lease_token=NULL,lease_until=NULL");
    const runner = database.createQueryRunner();
    await runner.connect(); await runner.startTransaction();
    try {
      await runner.query("UPDATE public.booking_notification_deliveries SET lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1", [claimed]);
      const pending = deleteAdminNotifications({ ids: [claimed] }, admin.client);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await runner.commitTransaction();
      expect(await pending).toEqual({ ok: true, deleted: [], skipped: 1 });
    } finally { if (runner.isTransactionActive) await runner.rollbackTransaction(); await runner.release(); }
    expect(await exists(claimed)).toBe(true);
  } finally {
    await service.from("user_roles").delete().eq("user_id", admin.id).eq("role_code", "admin");
  }
});

test("Admin search, filters, sorting and pagination are applied in the database before paging", async () => {
  const admin = await account();
  assert.strictEqual((await service.from("user_roles").insert({ user_id: admin.id, role_code: "admin" })).error, null);
  try {
    const first = await booking(null), second = await booking(null);
    const confirmed = await enqueue(first, "confirmed"), cancelled = await enqueue(first, "customer_cancelled"),
      other = await enqueue(second, "confirmed");
    await setState(confirmed, "attempts=3,last_error='unavailable',next_attempt_at=clock_timestamp()+interval '2 hours',created_at='2099-01-10T12:00:00Z'");
    await setState(cancelled, `${stop},created_at='2099-01-11T22:30:00Z'`);
    await setState(other, "attempts=1,last_error='unavailable',next_attempt_at=clock_timestamp()+interval '1 hour',created_at='2099-01-12T12:00:00Z'");
    const ids = async (params: Record<string, string>) => (await listAdminUndeliveredNotifications(params, admin.client)).rows
      .map((item) => item.id).filter((id) => [confirmed, cancelled, other].includes(id));
    // Search: booking ID (full or partial), subject and recipient; LIKE wildcards are literal.
    expect(await ids({ q: first })).toEqual([cancelled, confirmed]);
    expect(await ids({ q: first.slice(0, 13).toUpperCase() })).toEqual([cancelled, confirmed]);
    expect((await ids({ q: "Booking cancelled" }))).toEqual([cancelled]);
    expect(await ids({ q: "notice@example.test" })).toEqual([other, cancelled, confirmed]);
    expect(await ids({ q: "%" })).toEqual([]);
    // Filters combine: status, type (by its fixed subject) and the creation date in the club timezone.
    expect(await ids({ status: "stopped", q: first })).toEqual([cancelled]);
    expect(await ids({ status: "retrying", type: "confirmed" })).toEqual([other, confirmed]);
    expect(await ids({ type: "customer_cancelled", status: "retrying" })).toEqual([]);
    // 22:30 UTC on 11 January is 00:30 on 12 January in Europe/Bucharest.
    expect(await ids({ from: "2099-01-12", to: "2099-01-12" })).toEqual([other, cancelled]);
    expect(await ids({ from: "2099-01-10", to: "2099-01-11" })).toEqual([confirmed]);
    // Sorting: created (default newest), attempts, next retry (stopped rows last) and status,
    // within this test's dates so other rows on the shared stack do not page them out.
    const range = { from: "2099-01-10", to: "2099-01-12" };
    expect(await ids({ sort: "created", dir: "asc", ...range })).toEqual([confirmed, cancelled, other]);
    expect(await ids({ sort: "attempts", dir: "desc", ...range })).toEqual([cancelled, confirmed, other]);
    expect(await ids({ sort: "next_retry", dir: "asc", ...range })).toEqual([other, confirmed, cancelled]);
    expect(await ids({ sort: "status", dir: "asc", ...range })).toEqual([other, confirmed, cancelled]);
    // Filtered totals drive pagination; an empty result is a valid first page.
    const filtered = await listAdminUndeliveredNotifications({ q: first, page: "4" }, admin.client);
    expect({ total: filtered.total, page: filtered.page, totalPages: filtered.totalPages }).toEqual({ total: 2, page: 1, totalPages: 1 });
    expect(await listAdminUndeliveredNotifications({ q: randomUUID() }, admin.client)).toMatchObject({ rows: [], total: 0, page: 1, totalPages: 1 });
  } finally {
    await service.from("user_roles").delete().eq("user_id", admin.id).eq("role_code", "admin");
  }
});


test("all customer email events persist once before delivery, remain after retry and reading, and exclude guests", async () => {
  brevo();
  const owner = await account(), other = await account();
  const owned = await booking(owner.id), guest = await booking(null);
  const kinds: BookingEmailEvent["event_kind"][] = ["confirmed", "customer_cancelled", "admin_cancelled", "customer_rescheduled",
    "cancellation_failed", "modification_failed", "refund_incomplete", "late_payment_refund"];
  const ids: string[] = [];
  for (const kind of kinds) {
    const key = `inbox-test:${randomUUID()}`;
    await Promise.all([1, 2, 3].map(() => database.transaction(manager => enqueueBookingNotification(manager, key, event(owned, kind)))));
    ids.push((await database.query("SELECT id FROM public.customer_notifications WHERE event_key=$1", [key]))[0].id);
    await enqueue(guest, kind);
  }
  const before = await listOwnNotifications({}, owner.client);
  expect(before.notices).toHaveLength(8);
  expect(await readOwnUnreadNotifications(owner.client)).toBe(true);
  expect(await readOwnUnreadNotifications(other.client)).toBe(false);
  expect((await readOwnNotification(ids[0], owner.client))?.subject).toBe(before.notices.find(n => n.id === ids[0])?.subject);
  expect(await readOwnNotification(ids[0], other.client)).toBeNull();
  expect(await readOwnNotification(randomUUID(), owner.client)).toBeNull();
  expect(before.notices.map(n => n.event_kind).sort()).toEqual([...kinds].sort());
  expect(before.notices.every(n => n.read_at === null && n.booking_id === owned && n.text.includes(owned))).toBe(true);
  expect(before.notices.map(n => n.id)).toEqual([...ids].reverse());
  expect((await listOwnNotifications({}, other.client)).notices).toEqual([]);
  expect((await owner.client.from("customer_notifications").select("id")).error?.code).toBe("42501");
  expect(await database.query("SELECT id FROM public.customer_notifications WHERE booking_id=$1", [guest])).toEqual([]);
  expect(await markOwnNotificationRead(ids[0], other.client)).toMatchObject({ ok: false });
  brevoStatus = 503;
  await deliverPendingBookingNotifications({ limit: 30 });
  expect((await listOwnNotifications({}, owner.client)).notices).toEqual(before.notices);
  await due(ids); brevoStatus = 201;
  await deliverPendingBookingNotifications({ limit: 30 });
  expect((await listOwnNotifications({}, owner.client)).notices).toEqual(before.notices);
  expect(await markOwnNotificationRead(ids[0], owner.client)).toEqual({ ok: true });
  expect(await markOwnNotificationRead(ids[0], owner.client)).toEqual({ ok: true });
  // Financial notices still require explicit OK, never just delivery or generic read.
  expect(await markOwnNotificationRead(ids[6], owner.client)).toEqual({ ok: true });
  expect((await listOwnFinancialNotices(owner.client)).some(n => n.id === ids[6])).toBe(true);
  expect(await acknowledgeOwnFinancialNotice(ids[6], owner.client)).toEqual({ ok: true });
  const after = (await listOwnNotifications({}, owner.client)).notices;
  expect(after).toHaveLength(8);
  expect(after.find(n => n.id === ids[0])?.read_at).toBeTruthy();
  expect(after.find(n => n.id === ids[6])).toMatchObject({ read_at: expect.any(String), acknowledged_at: expect.any(String) });
});

test("Admin deletion and subsequent event replay retain one original inbox snapshot", async () => {
  const owner = await account(), admin = await account();
  assert.strictEqual((await service.from("user_roles").insert({ user_id: admin.id, role_code: "admin" })).error, null);
  try {
    const owned = await booking(owner.id), key = `inbox-test:${randomUUID()}`;
    await database.transaction(manager => enqueueBookingNotification(manager, key, event(owned, "confirmed")));
    const original = (await listOwnNotifications({}, owner.client)).notices;
    const id = original[0].id;
    await setState(id, stop);
    expect(await deleteAdminNotifications({ ids: [id] }, admin.client)).toMatchObject({ ok: true, deleted: [id] });
    expect((await listOwnNotifications({}, owner.client)).notices).toEqual(original);
    await database.transaction(manager => enqueueBookingNotification(manager, key, event(owned, "confirmed")));
    expect((await listOwnNotifications({}, owner.client)).notices).toEqual(original);
    // A failed domain transaction creates neither copy.
    await expect(database.transaction(async manager => {
      await enqueueBookingNotification(manager, `${key}:rollback`, event(owned, "confirmed"));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await listOwnNotifications({}, owner.client)).notices).toEqual(original);
    expect(await manageOwnNotifications({ ids: [id], operation: "delete" }, owner.client)).toEqual({ ok: true });
    await database.transaction(manager => enqueueBookingNotification(manager, key, event(owned, "confirmed")));
    expect((await listOwnNotifications({}, owner.client)).notices).toEqual([]);
    expect(await database.query("SELECT id FROM public.customer_notifications WHERE event_key=$1", [key])).toEqual([{ id }]);
  } finally {
    await service.from("user_roles").delete().eq("user_id", admin.id).eq("role_code", "admin");
  }
});


test("inbox search, filters, pagination and bulk operations use owner-scoped complete history", async () => {
  const owner = await account(), other = await account();
  const owned = await booking(owner.id);
  const ids: string[] = [];
  for (let i = 0; i < 28; i++) ids.push(await enqueue(owned, i === 0 ? "refund_incomplete" : "confirmed"));
  const newest = await listOwnNotifications({}, owner.client);
  expect(newest.notices).toHaveLength(25);
  expect(newest.total).toBe(28); expect(newest.totalPages).toBe(2);
  expect(newest.notices.map(n => n.id)).toEqual(ids.slice(3).reverse());
  expect((await listOwnNotifications({ page: "2" }, owner.client)).notices.map(n => n.id)).toEqual(ids.slice(0, 3).reverse());
  const oldest = await listOwnNotifications({ sort: "oldest", q: "automatically" }, owner.client);
  expect(oldest.notices.map(n => n.id)).toEqual([ids[0]]); // Message content, beyond first page.
  expect((await listOwnNotifications({ q: "Booking confirmed" }, owner.client)).total).toBe(27);
  expect((await listOwnNotifications({ q: "%" }, owner.client)).total).toBe(0);
  expect((await listOwnNotifications({ type: "refund_incomplete" }, owner.client)).total).toBe(1);
  expect(await manageOwnNotifications({ ids: ids.slice(0, 2), operation: "read" }, other.client)).toMatchObject({ ok: false });
  expect(await manageOwnNotifications({ ids: ids.slice(0, 2), operation: "read" }, owner.client)).toEqual({ ok: true });
  expect((await listOwnNotifications({ status: "read" }, owner.client)).total).toBe(2);
  expect((await listOwnNotifications({ status: "unread" }, owner.client)).total).toBe(26);
  expect(await acknowledgeOwnFinancialNotice(ids[0], owner.client)).toEqual({ ok: true });
  expect(await manageOwnNotifications({ ids: ids.slice(0, 2), operation: "unread" }, owner.client)).toEqual({ ok: true });
  expect((await listOwnNotifications({ status: "read" }, owner.client)).total).toBe(0);
  expect((await listOwnNotifications({ type: "refund_incomplete" }, owner.client)).notices[0].acknowledged_at).toBeTruthy();
  const paymentNotice = await enqueue(owned, "late_payment_refund");
  expect(await manageOwnNotifications({ ids: [paymentNotice, ids[0], ids[1]], operation: "delete" }, owner.client)).toEqual({ ok: true });
  expect((await listOwnNotifications({}, owner.client)).total).toBe(26);
  expect((await listOwnFinancialNotices(owner.client)).some(n => n.id === paymentNotice)).toBe(true);
  expect(await exists(paymentNotice)).toBe(true);
  expect(await readOwnNotification(paymentNotice, owner.client)).toBeNull();
  await manageOwnNotifications({ ids: ids.slice(2, 27), operation: "read" }, owner.client);
  await manageOwnNotifications({ ids: [ids[27]], operation: "read" }, owner.client);
  expect(await readOwnUnreadNotifications(owner.client)).toBe(false);
  await manageOwnNotifications({ ids: [ids[27]], operation: "unread" }, owner.client);
  expect(await readOwnUnreadNotifications(owner.client)).toBe(true);
  await manageOwnNotifications({ ids: [ids[27]], operation: "delete" }, owner.client);
  expect(await readOwnUnreadNotifications(owner.client)).toBe(false);
  expect(await acknowledgeOwnFinancialNotice(paymentNotice, owner.client)).toEqual({ ok: true });
  const [{ acknowledged }]: { acknowledged: boolean }[] = await database.query(
    "SELECT acknowledged_at IS NOT NULL AS acknowledged FROM public.customer_notifications WHERE id=$1", [paymentNotice]);
  expect(acknowledged).toBe(true);
  expect(await manageOwnNotifications({ ids: ids.slice(0, 26), operation: "delete" }, owner.client)).toMatchObject({ ok: false });
});
