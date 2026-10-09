import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "vitest";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { ensureIntegrationAdminAnchor } from "./admin-anchor";
import { listAdminPaymentTransactions } from "@/lib/payments/admin";
import { parseAdminPaymentQuery } from "@/lib/payments/admin-query";

test("Admin transaction projection selects original payments, joins refunds, filters before pagination and denies non-Admins", async () => {
  const db = localFixtureClient(), locationId = randomUUID(), courtId = randomUUID(), users: string[] = [];
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const marker = `transaction-${randomUUID()}`;
  const reservationIds = Array.from({ length: 24 }, () => randomUUID());
  const bookingIds = reservationIds.map(() => randomUUID()), attemptIds = bookingIds.map(() => randomUUID());
  const query = (params: Record<string,string> = {}) => parseAdminPaymentQuery({ q: marker, ...params });
  try {
    await ensureIntegrationAdminAnchor(db);
    const email = `${marker}@example.test`, password = "payments-read-test-password-123";
    const auth = await db.auth.admin.createUser({ email, password, email_confirm: true });
    expect(auth.error).toBeNull(); users.push(auth.data.user!.id);
    expect((await db.from("user_roles").insert({ user_id: users[0], role_code: "admin" })).error).toBeNull();
    expect((await admin.auth.signInWithPassword({ email,password })).error).toBeNull();
    expect((await db.from("locations").insert({ id: locationId, name: "Payment read test", slug: marker, timezone: "UTC", currency: "RON" })).error).toBeNull();
    expect((await db.from("courts").insert({ id: courtId, location_id: locationId, name: "Court", slug: "court", environment: "outdoor", surface: "clay" })).error).toBeNull();
    expect((await db.from("court_reservations").insert(reservationIds.map((id,index) => ({ id, court_id: courtId,
      booking_date: `2099-11-${String(index+1).padStart(2,'0')}`, starts_at_minute: 600, ends_at_minute: 660,
      status: index < 4 ? "cancelled" : index === 22 ? "released" : "active",
      cancelled_at: index < 4 ? "2026-10-06T10:00:00Z" : null, cancelled_by_user_id: index < 4 ? users[0] : null })))).error).toBeNull();
    expect((await db.from("bookings").insert(bookingIds.map((id,index) => ({ id, reservation_id: reservationIds[index],
      customer_name: `${marker} Customer ${index}`, customer_email: `${marker}-${index}@example.test`, customer_phone: "123",
      status: index < 4 ? "cancelled" : index === 22 ? "failed" : "confirmed", total_amount_minor: 9999, currency: "RON", cancellation_notice_minutes: 1440,
      payment_method: index === 23 ? "pay_at_club" : "online" })))).error).toBeNull();
    expect((await db.from("payment_attempts").insert(attemptIds.map((id,index) => ({ id, booking_id: bookingIds[index],
      method: index === 23 ? "pay_at_club" : "online", provider: index === 23 ? null : "stripe",
      provider_payment_id: index === 23 ? null : `original-${id}`, amount_minor: 1000+index, currency: "RON",
      status: index === 23 ? "due" : index === 22 ? "failed" : "succeeded",
      expires_at: index === 23 ? null : "2099-10-15T10:00:00Z", completed_at: index === 23 ? null : "2026-10-06T10:00:00Z",
      created_at: `2026-10-${String(index+1).padStart(2,'0')}T10:00:00Z` })))).error).toBeNull();
    // An additional newer failed attempt must not duplicate or replace original paid money.
    expect((await db.from("payment_attempts").insert({ booking_id: bookingIds[0], method: "online", provider: "stripe",
      provider_payment_id: "later-failed-attempt", amount_minor: 8000, currency: "RON", status: "failed",
      expires_at: "2099-10-15T10:00:00Z", completed_at: "2026-10-25T10:00:00Z", created_at: "2026-10-25T10:00:00Z" })).error).toBeNull();
    expect((await db.from("payment_refunds").insert([0,1,3].map((index) => ({ booking_id: bookingIds[index], payment_attempt_id: attemptIds[index],
      provider: "stripe", provider_payment_id: `original-${attemptIds[index]}`, amount_minor: 1000+index, currency: "RON",
      status: index === 0 ? "pending_retry" : index === 1 ? "failed" : "pending", requested_by_user_id: users[0], last_error: "provider_request_incomplete" })))).error).toBeNull();
    expect((await db.from("payment_provider_events").insert({ provider: "stripe", event_id: `event-${marker}`, attempt_id: attemptIds[2],
      provider_payment_id: `original-${attemptIds[2]}`, outcome: "succeeded", settlement_result: "amount_mismatch",
      reconciliation_required: true, amount_minor: 1, currency: "RON" })).error).toBeNull();
    const first = await listAdminPaymentTransactions(query(),admin), second = await listAdminPaymentTransactions(query({ page: "2" }),admin);
    expect(first.total).toBe(24); expect(first.totalPages).toBe(2); expect(first.rows).toHaveLength(20); expect(second.rows).toHaveLength(4);
    expect(first.rows[0].booking_id).toBe(bookingIds[23]);
    const all = [...first.rows,...second.rows]; expect(new Set(all.map(r => r.booking_id)).size).toBe(24);
    expect(all.find(r => r.booking_id === bookingIds[0])).toMatchObject({ amount_minor: 1000, provider_payment_id: `original-${attemptIds[0]}`,
      payment_status: "succeeded", needsAttention: true, refund: { status: "pending_retry", amount_minor: 1000, requested_by_user_id: users[0] } });
    expect(all.find(r => r.booking_id === bookingIds[1])).toMatchObject({ needsAttention: true, refund: { status: "failed", amount_minor: 1001 } });
    expect(all.find(r => r.booking_id === bookingIds[2])).toMatchObject({ needsAttention: true, refund: null,
      reconciliation: [{ settlement_result: "amount_mismatch" }] });
    expect(all.find(r => r.booking_id === bookingIds[3])).toMatchObject({ needsAttention: false, refund: { status: "pending" } });
    expect(all.find(r => r.booking_id === bookingIds[4])).toMatchObject({ needsAttention: false, refund: null });
    expect(all.find(r => r.booking_id === bookingIds[22])).toMatchObject({ payment_status: "failed", needsAttention: false });
    expect((await listAdminPaymentTransactions(query({ attention: "required" }),admin)).rows).toHaveLength(3);
    expect((await listAdminPaymentTransactions(query({ method: "pay_at_club" }),admin)).total).toBe(1);
    expect((await listAdminPaymentTransactions(query({ provider: "stripe", status: "succeeded" }),admin)).total).toBe(22);
    expect((await listAdminPaymentTransactions(query({ sort: "amount", dir: "asc" }),admin)).rows[0].amount_minor).toBe(1000);
    expect((await listAdminPaymentTransactions(query({ sort: "payment", dir: "asc" }),admin)).rows[0].payment_status).toBe("due");
    for (const search of [bookingIds[0], `original-${attemptIds[0]}`, `${marker}-0@example.test`]) {
      expect((await listAdminPaymentTransactions(query({ q: search }),admin)).rows.map(r => r.booking_id)).toEqual([bookingIds[0]]);
    }
    expect((await listAdminPaymentTransactions(query({ q: "%" }),admin)).total).toBe(0);
    expect((await db.from("user_roles").delete().eq("user_id",users[0]).eq("role_code","admin")).error).toBeNull();
    await expect(listAdminPaymentTransactions(query(),admin)).rejects.toThrow();
    expect((await db.from("user_roles").insert({ user_id: users[0],role_code: "admin" })).error).toBeNull();
    expect((await db.from("users").update({ status: "suspended" }).eq("id",users[0])).error).toBeNull();
    await expect(listAdminPaymentTransactions(query(),admin)).rejects.toThrow();
  } finally {
    await db.from("users").update({ status: "active" }).in("id",users);
    await db.from("bookings").delete().in("id",bookingIds);
    await db.from("court_reservations").delete().in("id",reservationIds);
    await db.from("courts").delete().eq("id",courtId); await db.from("locations").delete().eq("id",locationId);
    await cleanupAuthFixtures(db,users);
  }
},30000);
