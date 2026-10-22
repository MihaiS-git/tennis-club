import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { createCustomerBooking } from "@/lib/bookings/service";
import { recordBookingTransition, recordBookingFinancialException } from "@/lib/notifications/events";
import { recordNotification } from "@/lib/notifications/record";
import { claimEmailDeliveries, completeEmailAttempt, insertEmailDelivery, insertEmailFailureAlerts, insertUserMessage } from "@/lib/db/repositories/notifications.repository";
import { deleteOwnMessage, listOwnMessages, openOwnMessage, readOwnMessage, unreadOwnMessage, unreadOwnMessageCount,
  updateOwnMessages } from "@/lib/notifications/inbox";
import { parseInboxQuery } from "@/lib/notifications/inbox-query";
import { findRevision } from "@/lib/db/repositories/booking-revisions.repository";
import { configureCheckoutPolicyFixture } from "./opening-hours-fixtures";
import { cleanupBookingFixtures, insertCheckoutFixture } from "./checkout-fixtures";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";

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
  const held = await insertCheckoutFixture(service, { p_court_id: courtId, p_booking_date: "2099-10-15",
    p_starts_at_minute: 600, p_ends_at_minute: 660, p_account_user_id: null,
    p_customer_name: "Notification customer", p_customer_email: email, p_customer_phone: "123",
    p_total_amount_minor: 5000, p_currency: "RON", p_payment_method: "online", p_provider: "stripe", p_hold_seconds: 600 });
  expect(held.error).toBeNull();
  const bookingId = held.data[0].booking_id;
  const rows: { current_revision_id: string }[] = await (await getDataSource()).query(
    "SELECT current_revision_id FROM public.bookings WHERE id=$1", [bookingId]);
  return { bookingId, revisionId: rows[0].current_revision_id, attemptId: held.data[0].payment_attempt_id, cleanup };
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

    await source.query("UPDATE public.email_deliveries SET status='pending', attempts=0, next_attempt_at=$2 WHERE id=$1", [id, firstDue]);
    for (const [index, minutes] of [5, 15, 60, 360].entries()) {
      const [retryClaim] = await inTransaction(manager => claimEmailDeliveries(manager, 1));
      expect(retryClaim.id).toBe(id);
      expect(retryClaim.attempts).toBe(index + 1);
      const nextAttemptAt = new Date(Date.now() + minutes * 60_000);
      expect(await completeEmailAttempt(source.manager, { id, attempts: retryClaim.attempts,
        lockedUntil: retryClaim.lockedUntil, status: "pending", nextAttemptAt,
        providerMessageId: null, lastError: "HTTP 503" })).toBe(true);
      const rows: { status: string; attempts: number; next_attempt_at: Date; last_error: string }[] = await source.query(
        "SELECT status, attempts, next_attempt_at, last_error FROM public.email_deliveries WHERE id=$1", [id]);
      expect(rows[0].status).toBe("pending");
      expect(rows[0].attempts).toBe(index + 1);
      expect(rows[0].next_attempt_at).toEqual(nextAttemptAt);
      expect(rows[0].last_error).toBe("HTTP 503");
      await source.query("UPDATE public.email_deliveries SET next_attempt_at=$2 WHERE id=$1", [id, firstDue]);
    }
    const [terminalClaim] = await inTransaction(manager => claimEmailDeliveries(manager, 1));
    expect(terminalClaim.id).toBe(id);
    expect(terminalClaim.attempts).toBe(5);
    expect(await inTransaction(async manager => {
      const completed = await completeEmailAttempt(manager, { id, attempts: terminalClaim.attempts,
        lockedUntil: terminalClaim.lockedUntil, status: "failed", nextAttemptAt: now,
        providerMessageId: null, lastError: "HTTP 503" });
      if (completed) await insertEmailFailureAlerts(manager, id, now);
      return completed;
    })).toBe(true);
    await inTransaction(manager => insertEmailFailureAlerts(manager, id, now));
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
