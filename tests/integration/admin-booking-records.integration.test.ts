import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, vi } from "vitest";

// Spies around the real repositories: a test can act between the snapshot's first
// read and its later reads, and count how often each read path runs.
const hooks = vi.hoisted(() => ({ beforeRevisions: null as null | (() => Promise<void>) }));
vi.mock("@/lib/db/repositories/booking-revisions.repository", async (original) => {
  const actual = await original<typeof import("@/lib/db/repositories/booking-revisions.repository")>();
  return { ...actual, listBookingRevisions: vi.fn(async (...args: Parameters<typeof actual.listBookingRevisions>) => {
    await hooks.beforeRevisions?.();
    return actual.listBookingRevisions(...args);
  }) };
});
vi.mock("@/lib/db/repositories/payments.repository", async (original) => {
  const actual = await original<typeof import("@/lib/db/repositories/payments.repository")>();
  return { ...actual, loadAdminTransactionContext: vi.fn(actual.loadAdminTransactionContext),
    listAdminTransactionProjection: vi.fn(actual.listAdminTransactionProjection) };
});

import { inTransaction } from "@/lib/db/transaction";
import { listAdminTransactionProjection, loadAdminTransactionContext } from "@/lib/db/repositories/payments.repository";
import { getAdminBookingRecords } from "@/lib/bookings/admin-details";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { ensureIntegrationAdminAnchor } from "./admin-anchor";
import { appendBookingContractFixture, cleanupBookingFixtures, insertBookingFixture } from "./checkout-fixtures";

test("Admin booking records show persisted history and verified financial operations for account and guest bookings", async () => {
  const db = localFixtureClient(), users: string[] = [];
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const marker = `records-${randomUUID()}`, locationId = randomUUID(), courtId = randomUUID();
  const reservationIds = [randomUUID(), randomUUID(), randomUUID()], [paid, club, expired] = reservationIds.map(() => randomUUID());
  const [original, extra, failed, abandoned] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const [verified, retrying, rejected] = [randomUUID(), randomUUID(), randomUUID()];
  const adjustmentId = randomUUID();
  try {
    await ensureIntegrationAdminAnchor(db);
    const email = `${marker}@example.test`, password = "booking-records-test-password-123";
    const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
    expect(auth.error).toBeNull(); users.push(auth.data.user!.id);
    expect((await db.from("user_roles").insert({ user_id: users[0], role_code: "admin" })).error).toBeNull();
    expect((await admin.auth.signInWithPassword({ email, password })).error).toBeNull();
    expect((await db.from("locations").insert({ id: locationId, name: "Records club", slug: marker, timezone: "UTC", currency: "RON" })).error).toBeNull();
    expect((await db.from("courts").insert({ id: courtId, location_id: locationId, name: "Court", slug: "court", environment: "outdoor", surface: "clay" })).error).toBeNull();
    expect((await db.from("court_reservations").insert(reservationIds.map((id, index) => ({ id, court_id: courtId,
      booking_date: `2099-12-0${index + 1}`, starts_at_minute: 600, ends_at_minute: 660, status: index === 0 ? "active" : index === 1 ? "cancelled" : "released",
      cancelled_at: index === 1 ? "2026-10-03T10:00:00Z" : null, cancelled_by_user_id: index === 1 ? users[0] : null })))).error).toBeNull();
    expect((await insertBookingFixture(db, [
      { id: paid, reservation_id: reservationIds[0], account_user_id: users[0], customer_name: `${marker} Account`, customer_email: email,
        customer_phone: "1", status: "confirmed", total_amount_minor: 5000, currency: "RON", cancellation_notice_minutes: 1440,
        payment_method: "online", created_at: "2026-10-01T10:00:00Z" },
      { id: club, reservation_id: reservationIds[1], customer_name: `${marker} Guest`, customer_email: `${marker}-guest@example.test`,
        customer_phone: "2", status: "cancelled", total_amount_minor: 4000, currency: "RON", cancellation_notice_minutes: 1440,
        payment_method: "pay_at_club", created_at: "2026-10-02T10:00:00Z" },
      { id: expired, reservation_id: reservationIds[2], customer_name: `${marker} Expired`, customer_email: `${marker}-expired@example.test`,
        customer_phone: "3", status: "expired", total_amount_minor: 4000, currency: "RON", cancellation_notice_minutes: 1440,
        payment_method: "online", created_at: "2026-10-03T10:00:00Z" },
    ])).error).toBeNull();
    // Two recorded changes; the original revision keeps its own historical total.
    await appendBookingContractFixture(paid, { total_amount_minor: 7500, starts_at_minute: 630, ends_at_minute: 690 });
    await appendBookingContractFixture(paid, { total_amount_minor: 5000 });
    await inTransaction(async manager => {
      await manager.query(`INSERT INTO public.booking_adjustments(id,booking_id,base_revision_id,actor_id,scope,request_key,target,original_total,new_total,currency,status,expires_at,created_at)
        VALUES($1,$2,(SELECT id FROM public.booking_revisions WHERE booking_id=$2 AND revision_number=1),$3,'owner',$4,
          '{"courtId":"${courtId}","date":"2099-12-02","startMinute":600,"endMinute":720,"expectedUpdatedAt":"x","courtName":"Court","locationName":"Records club","timezone":"UTC"}',
          5000,10000,'RON','unsuccessful','2026-10-01T11:10:00Z','2026-10-01T11:00:00Z')`, [adjustmentId, paid, users[0], marker]);
    });
    const online = (id: string, amount: number, status: string, at: string) => ({ id, booking_id: paid, method: "online", provider: "stripe",
      provider_payment_id: `pi_${id}`, amount_minor: amount, currency: "RON", status, expires_at: "2099-10-15T10:00:00Z", completed_at: at, created_at: at });
    expect((await db.from("payment_attempts").insert([online(original, 5000, "succeeded", "2026-10-01T10:00:05Z"),
      online(extra, 2500, "succeeded", "2026-10-04T10:00:00Z"), online(failed, 900, "failed", "2026-10-04T09:00:00Z"),
      online(abandoned, 800, "cancelled", "2026-10-04T08:00:00Z"),
      { id: randomUUID(), booking_id: club, method: "pay_at_club", provider: null, provider_payment_id: null, amount_minor: 4000, currency: "RON",
        status: "due", expires_at: null, completed_at: null, created_at: "2026-10-02T10:00:00Z" },
    ])).error).toBeNull();
    expect((await db.from("payment_capture_receipts").insert([original, extra].map((id, index) => ({ payment_attempt_id: id, provider: "stripe",
      provider_payment_id: `pi_${id}`, provider_capture_id: `ch_${id}`, amount_minor: index ? 2500 : 5000, currency: "RON" })))).error).toBeNull();
    const initial = await db.from("booking_revisions").select("id").eq("booking_id", paid).eq("revision_number", 1).single();
    expect(initial.error).toBeNull();
    expect((await db.from("payment_refunds").insert([[verified, 1000, "succeeded", "2026-10-05T10:00:00Z"],
      [retrying, 500, "pending_retry", "2026-10-06T10:00:00Z"], [rejected, 300, "failed", "2026-10-07T10:00:00Z"]].map(([id, amount, status, at]) => ({
      id, booking_id: paid, payment_attempt_id: original, reason: "late_capture_compensation", context_revision_id: initial.data!.id,
      provider: "stripe", provider_payment_id: `pi_${original}`, amount_minor: amount, captured_amount_minor: 5000, currency: "RON",
      status, operation_key: `late-${id}`, requested_by_user_id: users[0], created_at: at })))).error).toBeNull();
    await inTransaction(manager => manager.query(`INSERT INTO public.refund_executions(refund_id,execution_number,provider,provider_payment_id,amount_minor,
      currency,idempotency_key,status,dispatch_initiated_at,provider_refund_id,terminal_result,terminal_evidence,completed_at)
      VALUES($1,1,'stripe',$2,1000,'RON',$3,'succeeded','2026-10-05T10:00:01Z',$4,'succeeded','verified_response','2026-10-05T10:00:02Z')`,
      [verified, `pi_${original}`, randomUUID(), `re_${marker}`]));

    const records = (await getAdminBookingRecords(paid, { supabase: admin }))!;
    expect(records.history.map(event => [event.label, event.status.label])).toEqual([["Booking created", "Confirmed"],
      ["Modification requested", "Failed"], ["Rescheduled", "Confirmed"], ["Price updated", "Confirmed"]]);
    expect(records.history[0].next).toMatchObject({ startMinute: 600, endMinute: 660, total: 5000 });
    expect(records.history[1]).toMatchObject({ previous: { total: 5000 }, next: { endMinute: 720, total: 10000 } });
    expect(records.history[2]).toMatchObject({ previous: { startMinute: 600, total: 5000 }, next: { startMinute: 630, total: 7500 } });
    expect(records.history[3]).toMatchObject({ previous: { total: 7500 }, next: { startMinute: 630, total: 5000 } });
    expect(records.summary).toMatchObject({ currency: "RON", total: 5000, paid: 7500, refunded: 1000, net: 6500,
      pendingPayments: 0, pendingRefunds: 500, failedRefunds: 300, outstanding: 0 });
    // Abandoned requests that never moved money are not payments.
    expect(records.operations).toMatchObject({ page: 1, total: 6, totalPages: 1 });
    expect(records.operations.rows.map(row => [row.transaction_kind, row.transaction_id, row.transaction_status, row.amount_minor])).toEqual([
      ["payment", original, "succeeded", 5000], ["payment", failed, "failed", 900], ["payment", extra, "succeeded", 2500],
      ["refund", verified, "succeeded", 1000], ["refund", retrying, "pending_retry", 500], ["refund", rejected, "failed", 300]]);
    expect(records.operations.rows.find(row => row.transaction_id === verified)?.operation_label).toBe("Late capture compensation");

    const guest = (await getAdminBookingRecords(club, { supabase: admin }))!;
    expect(guest.history.map(event => event.label)).toEqual(["Booking created", "Cancelled"]);
    expect(guest.summary).toMatchObject({ paid: 0, refunded: 0, outstanding: 0, dueAtClub: 0, unrecordedAtClub: 0, activeBooking: false });
    expect(guest.operations.rows.map(row => [row.method, row.transaction_status, row.amount_minor])).toEqual([["pay_at_club", "due", 4000]]);

    const unpaid = (await getAdminBookingRecords(expired, { supabase: admin }))!;
    expect(unpaid.history.map(event => [event.label, event.recorded, event.at])).toEqual([["Booking created", true, "2026-10-03T10:00:00.000Z"],
      ["Checkout expired", false, null]]);
    expect(unpaid.operations).toEqual({ rows: [], page: 1, total: 0, totalPages: 1 });
    expect(unpaid.summary).toMatchObject({ paid: 0, outstanding: 0 });

    // Losing the Admin role denies the records read.
    expect((await db.from("user_roles").delete().eq("user_id", users[0]).eq("role_code", "admin")).error).toBeNull();
    await expect(getAdminBookingRecords(paid, { supabase: admin })).rejects.toThrow();
  } finally {
    await cleanupBookingFixtures({ bookingIds: [paid, club, expired] });
    await db.from("court_reservations").delete().in("id", reservationIds);
    await db.from("courts").delete().eq("id", courtId); await db.from("locations").delete().eq("id", locationId);
    await cleanupAuthFixtures(db, users);
  }
}, 30000);

// One online booking owned by a fresh Admin, for the snapshot and paging tests.
async function onlineBookingFixture(marker: string) {
  const db = localFixtureClient();
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const ids = { user: "", location: randomUUID(), court: randomUUID(), reservation: randomUUID(), booking: randomUUID() };
  await ensureIntegrationAdminAnchor(db);
  const email = `${marker}@example.test`, password = "booking-records-test-password-123";
  const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
  expect(auth.error).toBeNull(); ids.user = auth.data.user!.id;
  expect((await db.from("user_roles").insert({ user_id: ids.user, role_code: "admin" })).error).toBeNull();
  expect((await admin.auth.signInWithPassword({ email, password })).error).toBeNull();
  expect((await db.from("locations").insert({ id: ids.location, name: "Records club", slug: marker, timezone: "UTC", currency: "RON" })).error).toBeNull();
  expect((await db.from("courts").insert({ id: ids.court, location_id: ids.location, name: "Court", slug: "court", environment: "outdoor", surface: "clay" })).error).toBeNull();
  expect((await db.from("court_reservations").insert({ id: ids.reservation, court_id: ids.court, booking_date: "2099-12-01",
    starts_at_minute: 600, ends_at_minute: 660, status: "active" })).error).toBeNull();
  expect((await insertBookingFixture(db, [{ id: ids.booking, reservation_id: ids.reservation, customer_name: `${marker} Guest`,
    customer_email: `${marker}-guest@example.test`, customer_phone: "1", status: "pending_payment", total_amount_minor: 5000, currency: "RON",
    cancellation_notice_minutes: 1440, payment_method: "online", created_at: "2026-10-01T10:00:00Z" }])).error).toBeNull();
  const cleanup = async () => {
    await cleanupBookingFixtures({ bookingIds: [ids.booking] });
    await db.from("court_reservations").delete().eq("id", ids.reservation);
    await db.from("courts").delete().eq("id", ids.court); await db.from("locations").delete().eq("id", ids.location);
    await cleanupAuthFixtures(db, [ids.user]);
  };
  return { db, admin, ids, cleanup };
}

test("a settlement committed during the read cannot make booking, summary and operations disagree", async () => {
  const fixture = await onlineBookingFixture(`records-snapshot-${randomUUID()}`);
  const attempt = randomUUID();
  try {
    expect((await fixture.db.from("payment_attempts").insert({ id: attempt, booking_id: fixture.ids.booking, method: "online", provider: "stripe",
      provider_payment_id: `pi_${attempt}`, amount_minor: 5000, currency: "RON", status: "pending", expires_at: "2099-10-15T10:00:00Z",
      created_at: "2026-10-01T10:00:05Z" })).error).toBeNull();
    // Verified settlement commits on another connection after the booking row was read.
    let settled = false;
    hooks.beforeRevisions = async () => {
      hooks.beforeRevisions = null;
      await inTransaction(async manager => {
        await manager.query(`UPDATE public.payment_attempts SET status='succeeded',completed_at='2026-10-01T10:01:00Z' WHERE id=$1`, [attempt]);
        await manager.query(`INSERT INTO public.payment_capture_receipts(payment_attempt_id,provider,provider_payment_id,provider_capture_id,amount_minor,currency)
          VALUES($1,'stripe',$2,$3,5000,'RON')`, [attempt, `pi_${attempt}`, `ch_${attempt}`]);
        await manager.query(`UPDATE public.bookings SET status='confirmed' WHERE id=$1`, [fixture.ids.booking]);
      });
      settled = true;
    };
    const during = (await getAdminBookingRecords(fixture.ids.booking, { supabase: fixture.admin }))!;
    expect(settled).toBe(true);
    expect(during.booking.status).toBe("pending_payment");
    expect(during.summary).toMatchObject({ paid: 0, pendingPayments: 5000, outstanding: 5000 });
    expect(during.operations.rows.map(row => [row.transaction_id, row.transaction_status])).toEqual([[attempt, "pending"]]);

    const after = (await getAdminBookingRecords(fixture.ids.booking, { supabase: fixture.admin }))!;
    expect(after.booking.status).toBe("confirmed");
    expect(after.summary).toMatchObject({ paid: 5000, pendingPayments: 0, outstanding: 0 });
    expect(after.operations.rows.map(row => [row.transaction_id, row.transaction_status])).toEqual([[attempt, "succeeded"]]);
  } finally {
    hooks.beforeRevisions = null;
    await fixture.cleanup();
  }
}, 30000);

test("more than 1,000 operations page on the server in recorded order while facts load once per request", async () => {
  const fixture = await onlineBookingFixture(`records-pages-${randomUUID()}`);
  // One captured payment followed by 1,000 failed retries, one second apart.
  const attempts = Array.from({ length: 1001 }, (_, index) => ({ id: randomUUID(), booking_id: fixture.ids.booking, method: "online",
    provider: "stripe", amount_minor: index ? 900 : 5000, currency: "RON", status: index ? "failed" : "succeeded",
    expires_at: "2099-10-15T10:00:00Z", created_at: new Date(Date.parse("2026-10-01T10:00:00Z") + index * 1000).toISOString() }))
    .map(row => ({ ...row, provider_payment_id: `pi_${row.id}`, completed_at: row.created_at }));
  try {
    expect((await fixture.db.from("payment_attempts").insert(attempts)).error).toBeNull();
    expect((await fixture.db.from("payment_capture_receipts").insert({ payment_attempt_id: attempts[0].id, provider: "stripe",
      provider_payment_id: attempts[0].provider_payment_id, provider_capture_id: `ch_${attempts[0].id}`, amount_minor: 5000, currency: "RON" })).error).toBeNull();
    const read = async (historyPage: number) => {
      vi.mocked(loadAdminTransactionContext).mockClear(); vi.mocked(listAdminTransactionProjection).mockClear();
      const records = (await getAdminBookingRecords(fixture.ids.booking, { supabase: fixture.admin, historyPage }))!;
      expect(loadAdminTransactionContext).toHaveBeenCalledOnce();
      expect(listAdminTransactionProjection).toHaveBeenCalledOnce();
      return records;
    };
    const first = await read(1), second = await read(2), last = await read(51), beyond = await read(52);
    expect(first.operations).toMatchObject({ page: 1, total: 1001, totalPages: 51 });
    expect(first.operations.rows.map(row => row.transaction_id)).toEqual(attempts.slice(0, 20).map(row => row.id));
    expect(second.operations.rows.map(row => row.transaction_id)).toEqual(attempts.slice(20, 40).map(row => row.id));
    expect(last.operations.rows.map(row => row.transaction_id)).toEqual([attempts[1000].id]);
    expect(beyond.operations).toMatchObject({ page: 51, totalPages: 51, rows: [expect.objectContaining({ transaction_id: attempts[1000].id })] });
    // The summary covers every operation regardless of the page shown.
    for (const records of [first, second, last])
      expect(records.summary).toMatchObject({ paid: 5000, net: 5000, pendingPayments: 0, outstanding: 0 });
  } finally {
    await fixture.cleanup();
  }
}, 60000);
