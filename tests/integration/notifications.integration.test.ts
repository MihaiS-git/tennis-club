import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { createCustomerBooking } from "@/lib/bookings/service";
import { recordBookingTransition, recordBookingFinancialException } from "@/lib/notifications/events";
import { recordNotification } from "@/lib/notifications/record";
import { claimEmailDeliveries, completeEmailAttempt, insertEmailDelivery, insertUserMessage, findMessageDelivery, findDeliveryBooking, failExpiredFinalClaims } from "@/lib/db/repositories/notifications.repository";
import { deleteOwnMessage, listOwnMessages, openOwnMessage, readOwnMessage, unreadOwnMessage, unreadOwnMessageCount,
  updateOwnMessages } from "@/lib/notifications/inbox";
import { processClaim, recordEmailFailureAlerts } from "@/lib/notifications/delivery";
import { parseInboxQuery } from "@/lib/notifications/inbox-query";
import { findRevision } from "@/lib/db/repositories/booking-revisions.repository";
import { configureCheckoutPolicyFixture } from "./opening-hours-fixtures";
import { cleanupBookingFixtures, insertCheckoutFixture } from "./checkout-fixtures";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";

// Explicit opt-in fixture; production and fresh migrations start disabled.
let previousSettings: unknown;
beforeEach(async () => {
  const source = await getDataSource();
  [previousSettings] = await source.query("SELECT official_email, sender_name, emails_enabled FROM public.club_settings WHERE id=true");
  await source.query("UPDATE public.club_settings SET official_email='club@example.test', sender_name='Test Club', emails_enabled=true WHERE id=true");
});
afterEach(async () => {
  if (previousSettings) await (await getDataSource()).query(`UPDATE public.club_settings SET
    official_email=$1::jsonb->>'official_email', sender_name=$1::jsonb->>'sender_name',
    emails_enabled=($1::jsonb->>'emails_enabled')::boolean WHERE id=true`, [JSON.stringify(previousSettings)]);
});

async function account(role?: "admin" | "coach") {
  const service = localFixtureClient();
  const email = `notification-${randomUUID()}@example.test`;
  const created = await service.auth.admin.createUser({ email, password: "Notification-test-123", email_confirm: true });
  expect(created.error).toBeNull();
  const id = created.data.user!.id;
  if (role) expect((await service.from("user_roles").insert({ user_id: id, role_code: role })).error).toBeNull();
  return { id, email };
}

async function bookingFixture(email: string, method: "online" | "pay_at_club") {
  const service = localFixtureClient();
  const locationId = randomUUID(), courtId = randomUUID();
  expect((await service.from("locations").insert({ id: locationId, name: "Notification fixture",
    slug: `notification-${locationId}`, timezone: "UTC", currency: "RON", is_public: true,
    allow_pay_at_club: true })).error).toBeNull();
  expect((await service.from("courts").insert({ id: courtId, location_id: locationId,
    name: "Court", slug: "court", environment: "outdoor", surface: "clay" })).error).toBeNull();
  await configureCheckoutPolicyFixture(service, locationId, courtId);
  const cleanup = async (bookingIds: string[]) => {
    await cleanupBookingFixtures({ bookingIds });
    expect((await service.from("court_reservations").delete().eq("court_id", courtId)).error).toBeNull();
    expect((await service.from("location_pricing_rules").delete().eq("location_id", locationId)).error).toBeNull();
    expect((await service.from("pricing_rule_sets").delete().eq("location_id", locationId)).error).toBeNull();
    expect((await service.from("location_opening_hours").delete().eq("location_id", locationId)).error).toBeNull();
    expect((await service.from("opening_hours_schedules").delete().eq("location_id", locationId)).error).toBeNull();
    expect((await service.from("courts").delete().eq("id", courtId)).error).toBeNull();
    expect((await service.from("locations").delete().eq("id", locationId)).error).toBeNull();
  };
  if (method === "pay_at_club") {
    const guest = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } });
    const result = await createCustomerBooking({ paymentMethod: method, courtId, date: "2099-10-15",
      startMinute: 600, endMinute: 660, customerName: "Notification customer", customerEmail: email,
      customerPhone: "123", expectedTotalAmountMinor: 5000, expectedCurrency: "RON" },
    guest, new Date("2099-10-14T12:00:00Z"));
    expect(result.ok).toBe(true);
    const rows: { id: string; current_revision_id: string }[] = await (await getDataSource()).query(
      "SELECT id,current_revision_id FROM public.bookings WHERE reservation_id IN (SELECT id FROM public.court_reservations WHERE court_id=$1)", [courtId]);
    return { bookingId: rows[0].id, revisionId: rows[0].current_revision_id, attemptId: null, cleanup };
  }
  const held = await insertCheckoutFixture({ courtId, bookingDate: "2099-10-15",
    startMinute: 600, endMinute: 660, accountUserId: null,
    customerName: "Notification customer", customerEmail: email, customerPhone: "123",
    totalAmountMinor: 5000, currency: "RON", paymentMethod: "online", provider: "stripe", holdSeconds: 600 });
  const bookingId = held.booking_id;
  const rows: { current_revision_id: string }[] = await (await getDataSource()).query(
    "SELECT current_revision_id FROM public.bookings WHERE id=$1", [bookingId]);
  return { bookingId, revisionId: rows[0].current_revision_id, attemptId: held.payment_attempt_id, cleanup };
}

test("confirmed booking notification shares the revision transaction and deduplicates replays", async () => {
  const customer = await account();
  const coach = await account("coach");
  const fixture = await bookingFixture(customer.email, "pay_at_club");
  const source = await getDataSource();
  const staffKey = `staff-customer:${randomUUID()}`;
  try {
    const revision = await findRevision(source.manager, fixture.revisionId);
    expect(revision?.bookingState).toBe("confirmed");
    const key = `booking.confirmed:${fixture.revisionId}`;
    const messages = () => source.query("SELECT user_id FROM public.user_messages WHERE event_key=$1", [key]);
    const deliveries = () => source.query("SELECT recipient_email FROM public.email_deliveries WHERE event_key=$1", [key]);
    expect(await messages()).toEqual([{ user_id: customer.id }]);
    expect(await deliveries()).toEqual([{ recipient_email: customer.email }]);
    await inTransaction(manager => recordBookingTransition(manager, revision!));
    expect(await messages()).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
    const rolledBackKey = `booking.confirmed:${randomUUID()}`;
    await expect(inTransaction(async manager => {
      await recordBookingTransition(manager, { ...revision!, id: rolledBackKey.slice(18) });
      throw new Error("business rollback");
    })).rejects.toThrow("business rollback");
    expect(await source.query("SELECT id FROM public.user_messages WHERE event_key=$1", [rolledBackKey])).toEqual([]);
    expect(await source.query("SELECT id FROM public.email_deliveries WHERE event_key=$1", [rolledBackKey])).toEqual([]);
    await inTransaction(manager => recordNotification(manager, { eventKey: staffKey, purpose: "customer",
      recipientEmail: coach.email, kind: "booking.confirmed", subject: "Staff fixture",
      bodyText: "Body", bodyHtml: "<p>Body</p>", occurredAt: new Date() }));
    expect(await source.query("SELECT user_id FROM public.user_messages WHERE event_key=$1", [staffKey]))
      .toEqual([{ user_id: coach.id }]);
    expect(await source.query("SELECT id FROM public.email_deliveries WHERE event_key=$1", [staffKey])).toEqual([]);
  } finally {
    await source.query("DELETE FROM public.email_deliveries WHERE event_key=$1", [`booking.confirmed:${fixture.revisionId}`]);
    await fixture.cleanup([fixture.bookingId]);
    await cleanupAuthFixtures(localFixtureClient(), [customer.id, coach.id]);
  }
});

test("financial exception sends one in-app alert per fixture Admin and no Admin email", async () => {
  const admin = await account("admin");
  const customerEmail = `customer-${randomUUID()}@example.test`;
  const fixture = await bookingFixture(customerEmail, "online");
  const source = await getDataSource();
  const key = `notification-exception:${randomUUID()}`;
  try {
    const input = { key, bookingId: fixture.bookingId, revisionId: fixture.revisionId,
      kind: "surcharge_unapplied" as const, paymentAttemptId: fixture.attemptId };
    await inTransaction(manager => recordBookingFinancialException(manager, input));
    await inTransaction(manager => recordBookingFinancialException(manager, input));
    const admins: { id: string; email: string }[] = await source.query(`SELECT DISTINCT u.id,u.email
      FROM public.users u JOIN public.user_roles r ON r.user_id=u.id
      WHERE u.status='active' AND r.role_code='admin' ORDER BY u.id`);
    expect(admins.some(row => row.id === admin.id)).toBe(true);
    expect(await source.query("SELECT user_id FROM public.user_messages WHERE event_key=$1 ORDER BY user_id",
      [`financial.exception:${key}`])).toEqual(admins.map(row => ({ user_id: row.id })));
    expect(await source.query("SELECT recipient_email FROM public.email_deliveries WHERE event_key=$1",
      [`financial.customer:${key}`])).toEqual([{ recipient_email: customerEmail }]);
    expect(admins.some(row => row.email === customerEmail)).toBe(false);
  } finally {
    await source.query("DELETE FROM public.user_messages WHERE event_key=$1", [`financial.exception:${key}`]);
    await source.query("DELETE FROM public.email_deliveries WHERE event_key=$1", [`financial.customer:${key}`]);
    await fixture.cleanup([fixture.bookingId]);
    await cleanupAuthFixtures(localFixtureClient(), [admin.id]);
  }
});

// Counts statements sent on the transaction's own connection.
async function countUserMessageInserts<T>(work: (manager: Parameters<Parameters<typeof inTransaction>[0]>[0]) => Promise<T>) {
  let inserts = 0;
  const result = await inTransaction(async manager => {
    const runner = manager.queryRunner!;
    const query = runner.query.bind(runner);
    vi.spyOn(runner, "query").mockImplementation(((sql: string, ...rest: unknown[]) => {
      if (/^\s*INSERT INTO "?public"?\."?user_messages"?/i.test(sql)) inserts++;
      return (query as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof runner.query);
    try { return await work(manager); } finally { vi.mocked(runner.query).mockRestore(); }
  });
  return { result, inserts };
}

test("financial exception batches Admin alerts, keeps multi-role staff in-app only and replays concurrently", async () => {
  const admin = await account("admin");
  const staff = await account("admin");
  expect((await localFixtureClient().from("user_roles").insert({ user_id: staff.id, role_code: "coach" })).error).toBeNull();
  const fixture = await bookingFixture(staff.email, "online");
  const source = await getDataSource();
  const key = `notification-batch:${randomUUID()}`;
  const input = { key, bookingId: fixture.bookingId, revisionId: fixture.revisionId,
    kind: "surcharge_unapplied" as const, paymentAttemptId: fixture.attemptId };
  try {
    const admins: { id: string }[] = await source.query(`SELECT DISTINCT u.id FROM public.users u
      JOIN public.user_roles r ON r.user_id=u.id WHERE u.status='active' AND r.role_code='admin' ORDER BY u.id`);
    expect(admins.length).toBeGreaterThanOrEqual(2);
    // One batched Admin insert plus the single customer-channel insert, independent of Admin count.
    expect((await countUserMessageInserts(manager => recordBookingFinancialException(manager, input))).inserts).toBe(2);
    await Promise.all([
      inTransaction(manager => recordBookingFinancialException(manager, input)),
      inTransaction(manager => recordBookingFinancialException(manager, input)),
    ]);
    expect(await source.query("SELECT user_id FROM public.user_messages WHERE event_key=$1 ORDER BY user_id",
      [`financial.exception:${key}`])).toEqual(admins.map(row => ({ user_id: row.id })));
    expect(await source.query("SELECT user_id FROM public.user_messages WHERE event_key=$1",
      [`financial.customer:${key}`])).toEqual([{ user_id: staff.id }]);
    expect(await source.query("SELECT id FROM public.email_deliveries WHERE event_key = ANY($1)",
      [[`financial.exception:${key}`, `financial.customer:${key}`]])).toEqual([]);
    await expect(inTransaction(async manager => {
      await recordBookingFinancialException(manager, { ...input, key: `${key}:rollback` });
      throw new Error("business rollback");
    })).rejects.toThrow("business rollback");
    expect(await source.query("SELECT id FROM public.user_messages WHERE event_key=$1",
      [`financial.exception:${key}:rollback`])).toEqual([]);
  } finally {
    await source.query("DELETE FROM public.user_messages WHERE event_key = ANY($1)",
      [[`financial.exception:${key}`, `financial.customer:${key}`]]);
    await fixture.cleanup([fixture.bookingId]);
    await cleanupAuthFixtures(localFixtureClient(), [admin.id, staff.id]);
  }
});

test("email failure alerts batch every eligible Admin per delivery and stay idempotent", async () => {
  const admin = await account("admin");
  const multiRole = await account("admin");
  const suspended = await account("admin");
  const coach = await account("coach");
  const member = await account();
  const service = localFixtureClient();
  expect((await service.from("user_roles").insert({ user_id: multiRole.id, role_code: "coach" })).error).toBeNull();
  expect((await service.from("users").update({ status: "suspended" }).eq("id", suspended.id)).error).toBeNull();
  const fixtureIds = [admin.id, multiRole.id, suspended.id, coach.id, member.id];
  const source = await getDataSource();
  const now = new Date();
  const ids = [randomUUID(), randomUUID()];
  const alertKeys = ids.map(id => `email.delivery-failed:${id}`);
  const rollbackId = randomUUID();
  try {
    await inTransaction(async manager => {
      for (const id of [...ids, rollbackId]) await insertEmailDelivery(manager, { id, eventKey: `delivery:${id}`,
        recipientEmail: `delivery-${id}@example.test`, subject: "Delivery test", bodyText: "Body", bodyHtml: "<p>Body</p>",
        status: "failed", attempts: 5, nextAttemptAt: now, lockedUntil: null, providerMessageId: null,
        lastError: "Brevo HTTP 400", createdAt: now, updatedAt: now });
    });
    // Duplicate IDs collapse; every delivery and Admin share one bounded insert.
    expect((await countUserMessageInserts(manager => recordEmailFailureAlerts(manager, [ids[0], ids[1], ids[0]], now))).inserts).toBe(1);
    expect((await countUserMessageInserts(manager => recordEmailFailureAlerts(manager, [], now))).inserts).toBe(0);
    await Promise.all([
      inTransaction(manager => recordEmailFailureAlerts(manager, ids, now)),
      inTransaction(manager => recordEmailFailureAlerts(manager, [ids[1], ids[0]], now)),
    ]);
    const admins: { id: string }[] = await source.query(`SELECT DISTINCT u.id FROM public.users u
      JOIN public.user_roles r ON r.user_id=u.id WHERE u.status='active' AND r.role_code='admin'`);
    const rows: { user_id: string; event_key: string; kind: string; subject: string; body_text: string;
      href: string | null; created_at: Date }[] = await source.query(
      "SELECT user_id, event_key, kind, subject, body_text, href, created_at FROM public.user_messages WHERE event_key = ANY($1)", [alertKeys]);
    expect(rows).toHaveLength(admins.length * ids.length);
    for (const user of [admin, multiRole]) {
      expect(rows.filter(row => row.user_id === user.id).map(row => row.event_key).sort()).toEqual([...alertKeys].sort());
    }
    expect(rows.filter(row => [suspended.id, coach.id, member.id].includes(row.user_id))).toEqual([]);
    expect(new Set(rows.map(row => JSON.stringify([row.kind, row.subject, row.body_text, row.href, row.created_at.getTime()]))))
      .toEqual(new Set([JSON.stringify(["email.delivery_failed", "Booking email delivery failed",
        "An outbound booking email could not be delivered. Open Delivery details to review the failure and retry eligibility.",
        null, now.getTime()])]));
    expect(await source.query("SELECT id FROM public.email_deliveries WHERE event_key = ANY($1)", [alertKeys])).toEqual([]);
    await expect(inTransaction(async manager => {
      await recordEmailFailureAlerts(manager, [rollbackId], now);
      throw new Error("business rollback");
    })).rejects.toThrow("business rollback");
    expect(await source.query("SELECT id FROM public.user_messages WHERE event_key=$1",
      [`email.delivery-failed:${rollbackId}`])).toEqual([]);
  } finally {
    await source.query("DELETE FROM public.user_messages WHERE event_key = ANY($1)", [alertKeys]);
    await source.query("DELETE FROM public.email_deliveries WHERE id = ANY($1)", [[...ids, rollbackId]]);
    await cleanupAuthFixtures(localFixtureClient(), fixtureIds);
  }
});

test("PostgreSQL claims, retry state, terminal alert and stale completion", async () => {
  const admin = await account("admin");
  const source = await getDataSource();
  const id = randomUUID(), concurrentId = randomUUID(), now = new Date();
  const eventKey = `delivery:${id}`;
  const firstDue = new Date("1900-01-01T00:00:00.000Z");
  const original = { id, eventKey, recipientEmail: `delivery-${id}@example.test`, subject: "Delivery test",
    bodyText: "Body", bodyHtml: "<p>Body</p>", status: "pending" as const, attempts: 0,
    nextAttemptAt: firstDue, lockedUntil: null, providerMessageId: null, lastError: null,
    createdAt: now, updatedAt: now };
  try {
    await inTransaction(async manager => {
      await insertEmailDelivery(manager, original);
      await insertEmailDelivery(manager, { ...original, id: concurrentId,
        eventKey: `delivery:${concurrentId}`, recipientEmail: `delivery-${concurrentId}@example.test` });
    });
    // Both fixture rows sort ahead of other due mail; each limited claim can only touch a fixture row.
    const earlier: { id: string }[] = await source.query(`SELECT id FROM public.email_deliveries
      WHERE id NOT IN ($1,$2) AND attempts < 5 AND ((status='pending' AND next_attempt_at <= $3)
        OR (status='processing' AND locked_until <= clock_timestamp() AND next_attempt_at <= $3))
      LIMIT 1`, [id, concurrentId, firstDue]);
    expect(earlier).toEqual([]);
    const [first, second] = await Promise.all([
      inTransaction(manager => claimEmailDeliveries(manager, 1)),
      inTransaction(manager => claimEmailDeliveries(manager, 1)),
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect([...first, ...second].map(row => row.id).sort()).toEqual([id, concurrentId].sort());
    const claim = [...first, ...second].find(row => row.id === id)!;
    const otherClaim = [...first, ...second].find(row => row.id === concurrentId)!;
    expect(await source.query("SELECT status,attempts,locked_until FROM public.email_deliveries WHERE id=$1", [id]))
      .toEqual([{ status: "processing", attempts: 1, locked_until: claim.lockedUntil }]);
    expect(await completeEmailAttempt(source.manager, { id: concurrentId, attempts: otherClaim.attempts,
      lockedUntil: otherClaim.lockedUntil, status: "accepted", nextAttemptAt: now,
      providerMessageId: "brevo-concurrent", lastError: null })).toBe(true);
    expect(await completeEmailAttempt(source.manager, { id, attempts: claim.attempts,
      lockedUntil: claim.lockedUntil, status: "accepted", nextAttemptAt: now,
      providerMessageId: "brevo-first", lastError: null })).toBe(true);
    expect(await completeEmailAttempt(source.manager, { id, attempts: claim.attempts,
      lockedUntil: claim.lockedUntil, status: "failed", nextAttemptAt: now,
      providerMessageId: null, lastError: "stale" })).toBe(false);
    expect(await source.query("SELECT status,provider_message_id FROM public.email_deliveries WHERE id=$1", [id]))
      .toEqual([{ status: "accepted", provider_message_id: "brevo-first" }]);

    await source.query("UPDATE public.email_deliveries SET status='pending', attempts=0, provider_message_id=NULL, next_attempt_at=$2 WHERE id=$1", [id, firstDue]);
    let previousClaim = claim;
    for (const [index, minutes] of [5, 15, 60, 360].entries()) {
      const [retryClaim] = await inTransaction(manager => claimEmailDeliveries(manager, 1));
      expect(retryClaim.id).toBe(id);
      expect(retryClaim.attempts).toBe(index + 1);
      const nextAttemptAt = new Date(Date.now() + minutes * 60_000);
      expect(await completeEmailAttempt(source.manager, { id, attempts: retryClaim.attempts,
        lockedUntil: retryClaim.lockedUntil, status: "pending", nextAttemptAt,
        providerMessageId: null, lastError: "Brevo HTTP 503" })).toBe(true);
      const rows: { status: string; attempts: number; next_attempt_at: Date; last_error: string }[] = await source.query(
        "SELECT status, attempts, next_attempt_at, last_error FROM public.email_deliveries WHERE id=$1", [id]);
      expect(rows[0].status).toBe("pending");
      expect(rows[0].attempts).toBe(index + 1);
      expect(rows[0].next_attempt_at).toEqual(nextAttemptAt);
      expect(rows[0].last_error).toBe("Brevo HTTP 503");
      await source.query("UPDATE public.email_deliveries SET next_attempt_at=$2 WHERE id=$1", [id, firstDue]);
      previousClaim = retryClaim;
    }
    const [terminalClaim] = await inTransaction(manager => claimEmailDeliveries(manager, 1));
    expect(terminalClaim.id).toBe(id);
    expect(terminalClaim.attempts).toBe(5);
    // While the row is processing under the new lease, an earlier attempt or a different lease cannot complete it.
    const stale = { id, status: "accepted" as const, nextAttemptAt: now, providerMessageId: "brevo-stale", lastError: null };
    expect(await completeEmailAttempt(source.manager, { ...stale, attempts: previousClaim.attempts,
      lockedUntil: previousClaim.lockedUntil })).toBe(false);
    expect(await completeEmailAttempt(source.manager, { ...stale, attempts: terminalClaim.attempts,
      lockedUntil: new Date(terminalClaim.lockedUntil.getTime() - 1) })).toBe(false);
    expect(await source.query("SELECT status,attempts,locked_until,provider_message_id FROM public.email_deliveries WHERE id=$1", [id]))
      .toEqual([{ status: "processing", attempts: 5, locked_until: terminalClaim.lockedUntil, provider_message_id: null }]);
    expect(await inTransaction(async manager => {
      const completed = await completeEmailAttempt(manager, { id, attempts: terminalClaim.attempts,
        lockedUntil: terminalClaim.lockedUntil, status: "failed", nextAttemptAt: now,
        providerMessageId: null, lastError: "Brevo HTTP 503" });
      if (completed) await recordEmailFailureAlerts(manager, [id], now);
      return completed;
    })).toBe(true);
    await inTransaction(manager => recordEmailFailureAlerts(manager, [id], now));
    expect(await source.query("SELECT status,attempts FROM public.email_deliveries WHERE id=$1", [id]))
      .toEqual([{ status: "failed", attempts: 5 }]);
    expect(await source.query("SELECT user_id FROM public.user_messages WHERE event_key=$1 AND user_id=$2",
      [`email.delivery-failed:${id}`, admin.id])).toHaveLength(1);
  } finally {
    await source.query("DELETE FROM public.user_messages WHERE event_key=$1", [`email.delivery-failed:${id}`]);
    await source.query("DELETE FROM public.email_deliveries WHERE id IN ($1,$2)", [id, concurrentId]);
    await cleanupAuthFixtures(localFixtureClient(), [admin.id]);
  }
});

test("inbox owner filter, read state and equal-time pagination", async () => {
  const owner = await account(), other = await account();
  const source = await getDataSource();
  const ids = Array.from({ length: 27 }, () => randomUUID()).sort().reverse();
  const otherId = randomUUID(), createdAt = new Date();
  try {
    await inTransaction(async manager => {
      for (const id of ids) await insertUserMessage(manager, { id, userId: owner.id,
        eventKey: `inbox:${id}`, kind: "booking.confirmed", subject: id, bodyText: "Body",
        href: null, createdAt });
      await insertUserMessage(manager, { id: otherId, userId: other.id,
        eventKey: `inbox:${otherId}`, kind: "booking.confirmed", subject: "Other", bodyText: "Body",
        href: null, createdAt });
    });
    expect((await listOwnMessages(owner.id, parseInboxQuery({}))).messages.map(row => row.id)).toEqual(ids.slice(0, 25));
    expect((await listOwnMessages(owner.id, parseInboxQuery({ page: "2" }))).messages.map(row => row.id)).toEqual(ids.slice(25));
    expect((await listOwnMessages(owner.id, parseInboxQuery({ q: "Other" }))).total).toBe(0);
    expect((await listOwnMessages(owner.id, parseInboxQuery({ status: "read" }))).total).toBe(0);
    expect(await openOwnMessage(owner.id, otherId)).toBeNull();
    expect(await unreadOwnMessage(owner.id, otherId)).toBe(false);
    expect(await unreadOwnMessageCount(owner.id)).toBe(27);
    expect((await openOwnMessage(owner.id, ids[0]))?.readAt).toBeNull();
    expect(await readOwnMessage(owner.id, ids[0])).toBe(true);
    expect((await openOwnMessage(owner.id, ids[0]))?.readAt).not.toBeNull();
    expect((await listOwnMessages(owner.id, parseInboxQuery({ status: "read", category: "bookings" }))).messages.map(row => row.id))
      .toEqual([ids[0]]);
    expect(await unreadOwnMessageCount(owner.id)).toBe(26);
    expect(await unreadOwnMessage(owner.id, ids[0])).toBe(true);
    expect(await unreadOwnMessageCount(owner.id)).toBe(27);
    expect(await unreadOwnMessageCount(other.id)).toBe(1);
  } finally {
    await source.query("DELETE FROM public.user_messages WHERE user_id IN ($1,$2)", [owner.id, other.id]);
    await cleanupAuthFixtures(localFixtureClient(), [owner.id, other.id]);
  }
});

test("soft deletion is owner-scoped, hides messages and survives event replay and read-state updates", async () => {
  const owner = await account(), other = await account();
  const source = await getDataSource();
  const ids = [randomUUID(), randomUUID(), randomUUID()], otherId = randomUUID(), deliveryId = randomUUID();
  const createdAt = new Date();
  const message = (id: string, userId: string) => ({ id, userId, eventKey: `soft-delete:${id}`,
    kind: "booking.confirmed", subject: id, bodyText: "Body", href: null, createdAt });
  try {
    await inTransaction(async manager => {
      for (const id of ids) await insertUserMessage(manager, message(id, owner.id));
      await insertUserMessage(manager, message(otherId, other.id));
      await insertEmailDelivery(manager, { id: deliveryId, eventKey: `soft-delete:${ids[0]}`, recipientEmail: owner.email,
        subject: "Body", bodyText: "Body", bodyHtml: "<p>Body</p>", status: "pending", attempts: 0,
        nextAttemptAt: createdAt, lockedUntil: null, providerMessageId: null, lastError: null,
        createdAt, updatedAt: createdAt });
    });
    expect(await updateOwnMessages(owner.id, [ids[0], ids[1], otherId], "read")).toBe(2);
    expect(await unreadOwnMessageCount(owner.id)).toBe(1);
    expect(await unreadOwnMessageCount(other.id)).toBe(1);
    expect(await updateOwnMessages(owner.id, [ids[0], otherId], "unread")).toBe(1);
    expect(await unreadOwnMessageCount(owner.id)).toBe(2);

    expect(await deleteOwnMessage(owner.id, ids[0])).toBe(1);
    expect(await deleteOwnMessage(other.id, ids[1])).toBe(0);
    expect(await updateOwnMessages(owner.id, [ids[1], otherId], "delete")).toBe(1);
    expect(await updateOwnMessages(owner.id, [ids[0], ids[1]], "delete")).toBe(0);
    expect((await listOwnMessages(owner.id, parseInboxQuery({}))).messages.map(row => row.id)).toEqual([ids[2]]);
    expect(await unreadOwnMessageCount(owner.id)).toBe(1);
    expect(await openOwnMessage(owner.id, ids[0])).toBeNull();
    expect(await readOwnMessage(owner.id, ids[0])).toBe(false);
    expect(await unreadOwnMessage(owner.id, ids[1])).toBe(false);
    expect(await updateOwnMessages(owner.id, [ids[0], ids[1]], "unread")).toBe(0);
    expect((await openOwnMessage(other.id, otherId))?.id).toBe(otherId);

    await inTransaction(async manager => {
      for (const id of ids.slice(0, 2)) await insertUserMessage(manager, { ...message(randomUUID(), owner.id), eventKey: `soft-delete:${id}` });
    });
    const stored: { id: string; deleted: boolean }[] = await source.query(
      "SELECT id, deleted_at IS NOT NULL AS deleted FROM public.user_messages WHERE user_id=$1 ORDER BY subject", [owner.id]);
    expect(stored).toEqual(ids.map((id, index) => ({ id, deleted: index < 2 })).sort((a, b) => a.id.localeCompare(b.id)));
    expect((await listOwnMessages(owner.id, parseInboxQuery({}))).total).toBe(1);
    expect(await source.query("SELECT status, attempts FROM public.email_deliveries WHERE id=$1", [deliveryId]))
      .toEqual([{ status: "pending", attempts: 0 }]);
  } finally {
    await source.query("DELETE FROM public.email_deliveries WHERE id=$1", [deliveryId]);
    await source.query("DELETE FROM public.user_messages WHERE user_id IN ($1,$2)", [owner.id, other.id]);
    await cleanupAuthFixtures(localFixtureClient(), [owner.id, other.id]);
  }
});


test("manual and Cron share one claim, preserve booking/payment state and deduplicate failure alerts", async () => {
  const admin = await account("admin");
  const fixture = await bookingFixture(`retry-${randomUUID()}@example.test`, "pay_at_club");
  const source = await getDataSource();
  const eventKey = `booking.confirmed:${fixture.revisionId}`;
  const [delivery]: { id: string }[] = await source.query("SELECT id FROM public.email_deliveries WHERE event_key=$1", [eventKey]);
  const cutoff = new Date("2199-01-01T00:00:00Z");
  const firstDue = new Date("1800-01-01T00:00:00Z");
  const snapshot = async () => source.query(`SELECT to_jsonb(b) AS booking, to_jsonb(r) AS reservation,
      (SELECT jsonb_agg(v ORDER BY v.id) FROM public.booking_revisions v WHERE v.booking_id=b.id) AS revisions,
      (SELECT jsonb_agg(p ORDER BY p.id) FROM public.payment_attempts p WHERE p.booking_id=b.id) AS payments,
      (SELECT jsonb_agg(f ORDER BY f.id) FROM public.payment_refunds f WHERE f.booking_id=b.id) AS refunds
    FROM public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id WHERE b.id=$1`, [fixture.bookingId]);
  try {
    await source.query("UPDATE public.email_deliveries SET status='failed',attempts=1,last_error='Brevo HTTP 401',next_attempt_at=$2,created_at=$3 WHERE id=$1", [delivery.id, firstDue, cutoff]);
    await inTransaction(manager => recordEmailFailureAlerts(manager, [delivery.id], new Date()));
    const [{ id: messageId }]: { id: string }[] = await source.query("SELECT id FROM public.user_messages WHERE event_key=$1 AND user_id=$2", [`email.delivery-failed:${delivery.id}`, admin.id]);
    expect((await findMessageDelivery(source.manager, admin.id, messageId))?.recipientEmail).toContain("retry-");
    expect(await findMessageDelivery(source.manager, randomUUID(), messageId)).toBeNull();
    expect(await findDeliveryBooking(source.manager, eventKey)).toBe(fixture.bookingId);
    const before = await snapshot();
    // A failed row is selectable only by manual retry; pending rejected rows can race Cron.
    await source.query("UPDATE public.email_deliveries SET status='pending' WHERE id=$1", [delivery.id]);
    const [manual, cron] = await Promise.all([
      inTransaction(manager => claimEmailDeliveries(manager, 1, cutoff, delivery.id)),
      inTransaction(manager => claimEmailDeliveries(manager, 1, cutoff)),
    ]);
    const claims = [...manual, ...cron].filter(row => row.id === delivery.id);
    expect(claims).toHaveLength(1);
    expect([...manual, ...cron]).toHaveLength(1);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "unauthorized", message: "Invalid API key" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await processClaim({ apiKey: "mock", sender: "club@example.test", mode: "sandbox" }, claims[0])).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await findMessageDelivery(source.manager, admin.id, messageId))?.lastError).toBe("Brevo HTTP 401: unauthorized: Invalid API key");
    expect(await snapshot()).toEqual(before);
    expect(await source.query("SELECT id FROM public.user_messages WHERE event_key=$1 AND user_id=$2", [`email.delivery-failed:${delivery.id}`, admin.id])).toHaveLength(1);
    // Definitive rejection remains manually claimable, even beyond Cron's attempt budget.
    await source.query("UPDATE public.email_deliveries SET attempts=5 WHERE id=$1", [delivery.id]);
    const [retry] = await inTransaction(manager => claimEmailDeliveries(manager, 1, cutoff, delivery.id));
    expect(retry.attempts).toBe(6);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ messageId: "<sandbox>" }), { status: 201 }));
    expect(await processClaim({ apiKey: "mock", sender: "club@example.test", mode: "sandbox" }, retry)).toBe("sandboxAccepted");
    expect(await inTransaction(manager => claimEmailDeliveries(manager, 1, cutoff, delivery.id))).toEqual([]);
    for (const state of [
      { status: "accepted", provider: "<accepted>", error: null },
      { status: "failed", provider: "<bounced>", error: "hard_bounce" },
      { status: "failed", provider: null, error: "Brevo request outcome unknown" },
      { status: "processing", provider: null, error: "Brevo HTTP 401" },
    ]) {
      await source.query("UPDATE public.email_deliveries SET status=$2,provider_message_id=$3,last_error=$4,attempts=1,locked_until=$5 WHERE id=$1", [delivery.id,state.status,state.provider,state.error,firstDue]);
      expect(await inTransaction(manager => claimEmailDeliveries(manager, 1, cutoff, delivery.id))).toEqual([]);
      expect(await inTransaction(manager => claimEmailDeliveries(manager, 1, cutoff))).toEqual([]);
    }
    // An expired claim has uncertain dispatch evidence, so expiration never authorizes resend.
    expect(await inTransaction(manager => failExpiredFinalClaims(manager, 20))).toContain(delivery.id);
    expect(await inTransaction(manager => claimEmailDeliveries(manager, 1, cutoff, delivery.id))).toEqual([]);
    await source.query("UPDATE public.email_deliveries SET status='failed',last_error='Brevo HTTP 401' WHERE id=$1", [delivery.id]);
    expect(await inTransaction(manager => claimEmailDeliveries(manager, 1, new Date("2200-01-01T00:00:00Z"), delivery.id))).toEqual([]);
    await deleteOwnMessage(admin.id, messageId);
    expect(await findMessageDelivery(source.manager, admin.id, messageId)).toBeNull();
    expect(await source.query("SELECT id FROM public.email_deliveries WHERE id=$1", [delivery.id])).toHaveLength(1);
    expect(await snapshot()).toEqual(before);
  } finally {
    vi.unstubAllGlobals();
    await source.query("DELETE FROM public.user_messages WHERE event_key=$1", [`email.delivery-failed:${delivery.id}`]);
    await source.query("DELETE FROM public.email_deliveries WHERE id=$1", [delivery.id]);
    await fixture.cleanup([fixture.bookingId]);
    await cleanupAuthFixtures(localFixtureClient(), [admin.id]);
  }
});
