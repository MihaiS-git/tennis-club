import { insertBookingFixture } from "./checkout-fixtures";
import { cleanupBookingFixtures } from "./checkout-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, vi } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { readFinancialHistory } from "@/lib/payments/financial-history";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";
import { ensureIntegrationAdminAnchor } from "./admin-anchor";
import { listAdminPaymentTransactions } from "@/lib/payments/admin";
import { parseAdminPaymentQuery } from "@/lib/payments/admin-query";

test("Admin transaction projection lists every payment and refund, filters before pagination and denies non-Admins", async () => {
  const db = localFixtureClient(), locationId = randomUUID(), courtId = randomUUID(), users: string[] = [];
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const marker = `transaction-${randomUUID()}`;
  const reservationIds = Array.from({ length: 24 }, () => randomUUID());
  const bookingIds = reservationIds.map(() => randomUUID()), attemptIds = bookingIds.map(() => randomUUID());
  const captureReceiptIds = attemptIds.slice(0,22).map(() => randomUUID());
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
    expect((await insertBookingFixture(db, bookingIds.map((id,index) => ({ id, reservation_id: reservationIds[index],
      account_user_id: index === 4 ? users[0] : null,
      customer_name: `${marker} Customer ${index}`, customer_email: `${marker}-${index}@example.test`, customer_phone: "123",
      status: index < 4 ? "cancelled" : index === 22 ? "failed" : "confirmed", total_amount_minor: 9999, currency: "RON", cancellation_notice_minutes: 1440,
      payment_method: index === 23 ? "pay_at_club" : "online" })))).error).toBeNull();
    expect((await db.from("payment_attempts").insert(attemptIds.map((id,index) => ({ id, booking_id: bookingIds[index],
      method: index === 23 ? "pay_at_club" : "online", provider: index === 23 ? null : "stripe",
      provider_payment_id: index === 23 ? null : `original-${id}`, amount_minor: 1000+index, currency: "RON",
      status: index === 23 ? "due" : index === 22 ? "failed" : "succeeded",
      expires_at: index === 23 ? null : "2099-10-15T10:00:00Z", completed_at: index === 23 ? null : "2026-10-06T10:00:00Z",
      created_at: `2026-10-${String(index+1).padStart(2,'0')}T10:00:00Z` })))).error).toBeNull();
    expect((await db.from("payment_capture_receipts").insert(attemptIds.slice(0,22).map((id,index) => ({
      id: captureReceiptIds[index], payment_attempt_id: id, provider: "stripe", provider_payment_id: `original-${id}`,
      provider_capture_id: `capture-${id}`, amount_minor: 1000+index, currency: "RON",
    })))).error).toBeNull();
    // A failed retry remains individually traceable without replacing the original capture.
    expect((await db.from("payment_attempts").insert({ booking_id: bookingIds[0], method: "online", provider: "stripe",
      provider_payment_id: "later-failed-attempt", amount_minor: 8000, currency: "RON", status: "failed",
      expires_at: "2099-10-15T10:00:00Z", completed_at: "2026-10-25T10:00:00Z", created_at: "2026-10-25T10:00:00Z" })).error).toBeNull();
    const contexts = await db.from("bookings").select("id,current_revision_id").in("id", bookingIds);
    expect(contexts.error).toBeNull();
    const contextIds = new Map(contexts.data?.map(row => [row.id, row.current_revision_id]));
    expect((await db.from("payment_refunds").insert([0,1,3].map((index) => ({ booking_id: bookingIds[index], payment_attempt_id: attemptIds[index],
      reason: "booking_cancellation", context_revision_id: contextIds.get(bookingIds[index]),
      provider: "stripe", provider_payment_id: `original-${attemptIds[index]}`, amount_minor: 1000+index, captured_amount_minor: 1000+index, currency: "RON",
      status: index === 0 ? "pending_retry" : index === 1 ? "failed" : "pending", requested_by_user_id: users[0] })))).error).toBeNull();
    expect((await db.from("payment_provider_events").insert({ provider: "stripe", event_id: `event-${marker}`, attempt_id: attemptIds[2],
      capture_receipt_id: captureReceiptIds[2], provider_payment_id: `original-${attemptIds[2]}`,
      outcome: "succeeded", settlement_result: "amount_mismatch",
      reconciliation_required: true, amount_minor: 1, currency: "RON" })).error).toBeNull();
    const first = await listAdminPaymentTransactions(query(),admin), second = await listAdminPaymentTransactions(query({ page: "2" }),admin);
    expect(first.total).toBe(28); expect(first.totalPages).toBe(2); expect(first.rows).toHaveLength(20); expect(second.rows).toHaveLength(8);
    expect(first.rows[0].booking_id).toBe(bookingIds[0]);
    const all = [...first.rows,...second.rows]; expect(new Set(all.map(r => r.transaction_id)).size).toBe(28);
    expect(all.find(r => r.transaction_id === attemptIds[0])).toMatchObject({ amount_minor: 1000, provider_payment_id: `original-${attemptIds[0]}`,
      payment_status: "succeeded", needsAttention: false, refund: null });
    expect(all.find(r => r.booking_id === bookingIds[1] && r.transaction_kind === "refund")).toMatchObject({ needsAttention: true, refund: { status: "failed", amount_minor: 1001 } });
    expect(all.find(r => r.booking_id === bookingIds[2])).toMatchObject({ needsAttention: true, refund: null,
      reconciliation: [{ settlement_result: "amount_mismatch" }] });
    expect(all.find(r => r.booking_id === bookingIds[3] && r.transaction_kind === "refund")).toMatchObject({ needsAttention: false, refund: { status: "pending" } });
    expect(all.find(r => r.booking_id === bookingIds[4])).toMatchObject({ needsAttention: false, refund: null, account_user_id: users[0] });
    // Guest bookings carry no account link, even though the Admin's email shares the marker.
    expect(all.filter(r => r.booking_id !== bookingIds[4]).every(r => r.account_user_id === null)).toBe(true);
    expect(all.find(r => r.booking_id === bookingIds[22])).toMatchObject({ payment_status: "failed", needsAttention: false });
    expect((await listAdminPaymentTransactions(query({ attention: "required" }),admin)).rows.map(row => row.booking_id)).toEqual(expect.arrayContaining([bookingIds[1], bookingIds[2]]));
    expect((await listAdminPaymentTransactions(query({ attention: "required" }),admin)).total).toBe(2);
    expect((await listAdminPaymentTransactions(query({ method: "pay_at_club" }),admin)).total).toBe(1);
    expect((await listAdminPaymentTransactions(query({ provider: "stripe", status: "succeeded" }),admin)).total).toBe(22);
    expect((await listAdminPaymentTransactions(query({ sort: "amount", dir: "asc" }),admin)).rows[0].amount_minor).toBe(1003);
    expect((await listAdminPaymentTransactions(query({ sort: "payment", dir: "asc" }),admin)).rows[0].payment_status).toBe("due");
    for (const search of [bookingIds[0], `original-${attemptIds[0]}`, `${marker}-0@example.test`]) {
      const rows = (await listAdminPaymentTransactions(query({ q: search }),admin)).rows;
      expect(rows).toHaveLength(search.startsWith("original-") ? 2 : 3);
      expect(rows.every(r => r.booking_id === bookingIds[0])).toBe(true);
    }
    expect((await listAdminPaymentTransactions(query({ q: "%" }),admin)).total).toBe(0);
    const last = await listAdminPaymentTransactions(query({ page: "1000" }), admin);
    expect(last).toMatchObject({ page: 2, totalPages: 2 });
    expect(last.rows).toEqual(second.rows);
    const empty = await listAdminPaymentTransactions(query({ q: "%", page: "1000" }), admin);
    expect(empty).toMatchObject({ page: 1, totalPages: 1, total: 0, rows: [] });
    const source = await getDataSource();
    const queries = vi.spyOn(source.logger, "logQuery");
    try {
      const batch = await readFinancialHistory(source.manager, { page: 1, status: "all", provider: "all", method: "all",
        attention: false, search: marker, sort: "date", direction: "desc", bookingId: null, attentionRefundStatuses: ["failed", "pending_retry"] });
      expect(batch.rows).toHaveLength(20);
      // One paginated query plus revision/payment/refund/reference/history batches, independent of row count.
      expect(queries).toHaveBeenCalledTimes(6);
      const historyQueries = queries.mock.calls.filter(([sql]) => sql.includes('FROM "public"."refund_executions"') && !sql.includes("DISTINCT ON"));
      expect(historyQueries).toHaveLength(1);
      const parameters = historyQueries[0][1];
      if (!Array.isArray(parameters)) throw new Error("Missing history query parameters");
      expect(new Set(parameters)).toEqual(new Set(batch.rows.flatMap(row => row.refund ? [row.refund.id] : [])));
    } finally { queries.mockRestore(); }
    expect((await db.from("user_roles").delete().eq("user_id",users[0]).eq("role_code","admin")).error).toBeNull();
    await expect(listAdminPaymentTransactions(query(),admin)).rejects.toThrow();
    const privateRefund = all.find(row => row.refund)?.refund;
    if (!privateRefund) throw new Error("Missing private refund fixture");
    await expect(listAdminPaymentTransactions(query(), admin, undefined, { kind: "refund", id: privateRefund.id })).rejects.toThrow();
    expect((await db.from("user_roles").insert({ user_id: users[0],role_code: "admin" })).error).toBeNull();
    expect((await db.from("users").update({ status: "suspended" }).eq("id",users[0])).error).toBeNull();
    await expect(listAdminPaymentTransactions(query(),admin)).rejects.toThrow();
  } finally {
    await db.from("users").update({ status: "active" }).in("id",users);
    await cleanupBookingFixtures({ bookingIds: bookingIds });
    await db.from("court_reservations").delete().in("id",reservationIds);
    await db.from("courts").delete().eq("id",courtId); await db.from("locations").delete().eq("id",locationId);
    await cleanupAuthFixtures(db,users);
  }
},30000);

// Real PostgreSQL projections; provider facts are fixtures, never external calls.
test.each([
  ["single success", ["succeeded"]],
  ["failed then success", ["failed", "succeeded"]],
  ["rejected then success", ["rejected", "succeeded"]],
  ["uncertain", ["uncertain"]],
  ["provider pending", ["pending"]],
] as const)("refund history: %s preserves facts and counts one obligation", async (_name, statuses) => {
  const { insertBookingRecords } = await import("../local/booking-fixtures");
  const { RefundExecutionEntity } = await import("@/lib/db/entities/refund-execution.entity");
  const source = await getDataSource(), runner = source.createQueryRunner();
  await runner.startTransaction();
  try {
    const manager = runner.manager;
    const locationId = randomUUID(), courtId = randomUUID(), reservationId = randomUUID();
    const bookingId = randomUUID(), attemptId = randomUUID(), refundId = randomUUID();
    await manager.query("INSERT INTO public.locations(id,name,slug,timezone) VALUES($1,'Historical Club',$2,'UTC')", [locationId, locationId]);
    await manager.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'Historical Court','court','clay','outdoor')", [courtId, locationId]);
    await manager.query("INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute) VALUES($1,$2,'2099-11-01',600,660)", [reservationId, courtId]);
    await insertBookingRecords(manager, { id: bookingId, reservation_id: reservationId, customer_name: "Historical Customer",
      customer_email: "historical@example.test", customer_phone: "123", total_amount_minor: 5000, currency: "RON",
      cancellation_notice_minutes: 1440, payment_method: "online" });
    await manager.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at,completed_at)
      VALUES($1,$2,'online','stripe',$3,5000,'RON','succeeded',now(),now())`, [attemptId, bookingId, `pi_${attemptId}`]);
    await manager.query(`INSERT INTO public.payment_capture_receipts(payment_attempt_id,provider,provider_payment_id,
      provider_capture_id,amount_minor,currency) VALUES($1,'stripe',$2,$3,5000,'RON')`,
    [attemptId, `pi_${attemptId}`, `capture_${attemptId}`]);
    const successful = statuses.at(-1) === "succeeded";
    await manager.query(`INSERT INTO public.payment_refunds(id,booking_id,payment_attempt_id,provider,provider_payment_id,amount_minor,captured_amount_minor,currency,reason,context_revision_id,status)
      SELECT $1,id,$3,'stripe',$4,2500,5000,'RON','late_capture_compensation',current_revision_id,$5 FROM public.bookings WHERE id=$2`,
    [refundId, bookingId, attemptId, `pi_${attemptId}`, successful ? "succeeded" : "pending_retry"]);
    const ids: string[] = [];
    for (const [index, status] of statuses.entries()) {
      const id = randomUUID(); ids.push(id);
      const terminalResult = status === "succeeded" || status === "failed" || status === "rejected" ? status : null;
      await manager.getRepository(RefundExecutionEntity).insert({ id, refundId, executionNumber: index + 1,
        provider: "stripe", providerPaymentId: `pi_${attemptId}`, amountMinor: 2500, currency: "RON",
        idempotencyKey: `private-key-${id}`, createdAt: new Date(`2026-10-0${2-index}T10:00:00Z`),
        dispatchInitiatedAt: new Date("2026-10-03T10:00:00Z"), status, terminalResult,
        terminalEvidence: terminalResult ? "sensitive provider payload" : null,
        completedAt: terminalResult ? new Date("2026-10-03T11:00:00Z") : null,
        firstUncertainAt: status === "uncertain" ? new Date("2026-10-03T10:05:00Z") : null,
        firstUncertaintyEvidence: status === "uncertain" ? "sensitive uncertainty payload" : null,
        providerRefundId: status === "rejected" || status === "uncertain" ? null : `re_${id}`,
        lastCheckedAt: new Date("2026-10-03T11:00:00Z"), lastError: "raw exception with secret",
      });
    }
    // Current resource changes cannot rewrite contractual financial context.
    await manager.query("UPDATE public.courts SET name='Renamed Court' WHERE id=$1", [courtId]);
    const filters = { page: 1, status: "all", provider: "all", method: "all", attention: false, search: "",
      sort: "date", direction: "desc", bookingId, attentionRefundStatuses: ["failed", "pending_retry"] } as const;
    const list = await readFinancialHistory(manager, filters);
    expect(list.total).toBe(2); // one capture and one obligation, regardless of executions
    const refund = list.rows.find(row => row.transaction_kind === "refund");
    // Execution facts remain in server-side persistence, not the Admin payload.
    const history = await manager.getRepository(RefundExecutionEntity).find({ where: { refundId }, order: { executionNumber: "ASC" } });
    expect(history.map(row => row.id)).toEqual(ids);
    expect(history.map(row => row.status)).toEqual(statuses);
    expect(history.map(row => row.createdAt.toISOString())).toEqual(statuses.map((_, index) => `2026-10-0${2-index}T10:00:00.000Z`));
    expect(history.every(row => row.dispatchInitiatedAt?.toISOString() === "2026-10-03T10:00:00.000Z")).toBe(true);
    expect(history.map(row => row.terminalResult === null)).toEqual(statuses.map(status => ["pending", "uncertain"].includes(status)));
    expect(history.map(row => row.providerRefundId)).toEqual(statuses.map((status, index) =>
      status === "rejected" || status === "uncertain" ? null : `re_${ids[index]}`));
    expect(refund?.refund?.last_error).toBe("processing_error");
    expect(refund?.refund).not.toHaveProperty("executions");
    expect(JSON.stringify(refund)).not.toMatch(/private-key-|sensitive provider payload|sensitive uncertainty payload|raw exception with secret/);
    expect(refund?.context).toMatchObject({ courtName: "Historical Court", locationName: "Historical Club", customerName: "Historical Customer" });
    expect(refund?.refund?.reason).toBe("late_capture_compensation");
    expect(refund?.operation_label).toBe("Late capture compensation");
    expect(refund?.financials.totals).toContainEqual(expect.objectContaining({ currency: "RON", captured: 5000,
      refunded: successful ? 2500 : 0, refundObligations: 2500, netPaid: successful ? 2500 : 5000 }));
    const detail = await readFinancialHistory(manager, { ...filters, transaction: { kind: "refund", id: refundId } });
    expect(detail.rows).toEqual([refund]);
    expect(refund?.refund?.captured_amount_minor).toBe(5000);
    if (_name === "single success") {
      // Simulate a malformed pre-contract row only inside this rolled-back transaction.
      // With the old SQL COALESCE, the history read would fabricate 5000 and succeed.
      await manager.query("SET CONSTRAINTS ALL IMMEDIATE");
      await manager.query("ALTER TABLE public.payment_refunds ALTER COLUMN captured_amount_minor DROP NOT NULL");
      const missingId = randomUUID();
      await manager.query(`INSERT INTO public.payment_refunds(id,booking_id,payment_attempt_id,operation_key,provider,provider_payment_id,
        amount_minor,currency,reason,context_revision_id)
        SELECT $1,id,$3,'missing-snapshot','stripe',$4,1000,'RON','late_capture_compensation',current_revision_id
        FROM public.bookings WHERE id=$2`, [missingId, bookingId, attemptId, `pi_${attemptId}`]);
      await expect(readFinancialHistory(manager, { ...filters, transaction: { kind: "refund", id: missingId } })).rejects.toThrow();
      const { lockRefundForProcessing } = await import("@/lib/db/repositories/payments.repository");
      await expect(lockRefundForProcessing(manager, { id: missingId })).rejects.toThrow();
    }
    const serialized = JSON.stringify(detail);
    for (const secret of ["private-key", "raw exception", "sensitive provider", "sensitive uncertainty", "leaseToken", "idempotencyKey"])
      expect(serialized).not.toContain(secret);
  } finally { await runner.rollbackTransaction(); await runner.release(); }
});
