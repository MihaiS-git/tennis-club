import { cancelBookingCommand } from "@/lib/bookings/cancellation-service";
import { processOnlinePaymentEvent, settleOnlinePayment } from "@/lib/payments/service";
import { insertCheckoutFixture } from "./checkout-fixtures";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, vi } from "vitest";
import { localFixtureClient, cleanupAuthFixtures } from "./auth-fixtures";
import { ensureIntegrationAdminAnchor } from "./admin-anchor";
const { create, list, retrieve } = vi.hoisted(() => ({ create: vi.fn(),list: vi.fn(),retrieve: vi.fn() }));
vi.mock("@/lib/payments/providers/stripe/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments/providers/stripe/client")>("@/lib/payments/providers/stripe/client");
  return { ...actual,stripeClient: () => ({ refunds: { create,list,retrieve } }) };
});
import { retryAdminPaymentRefund, resolveAdminPaymentReconciliation } from "@/lib/payments/admin-reconciliation";

test("Admin retries and late captured-payment refunds are original-payment scoped, durable, idempotent and never reclaim occupancy", async () => {
  const db = localFixtureClient(), locationId = randomUUID(),courtId = randomUUID(),users: string[] = [];
  const admin = createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_PUBLISHABLE_KEY!,{ auth: { persistSession:false,autoRefreshToken:false } });
  const second = createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_PUBLISHABLE_KEY!,{ auth: { persistSession:false,autoRefreshToken:false } });
  const previous = (await db.from("payment_provider_settings").select("active_provider").single()).data!.active_provider;
  const cancelledRows: { booking_id:string; reservation_id:string; payment_attempt_id:string }[] = [];
  const refund = async (bookingId:string) => {
    const result = await db.from("payment_refunds").select("*").eq("booking_id",bookingId).single(); expect(result.error).toBeNull(); return result.data!;
  };
  const occupancy = async (reservationId:string) => (await db.from("court_reservations").select("status,hold_expires_at,court_id,booking_date,starts_at_minute,ends_at_minute").eq("id",reservationId).single()).data;
  const event = async (eventId:string) => (await db.from("payment_provider_events").select("reconciliation_required,resolved_at,resolved_by_user_id").eq("provider","stripe").eq("event_id",eventId).single()).data!;
  async function book(start:number) {
    const result = await insertCheckoutFixture(db, { p_court_id:courtId,p_booking_date:"2099-10-15",p_starts_at_minute:start,p_ends_at_minute:start+60,
      p_account_user_id:null,p_customer_name:"Reconciliation guest",p_customer_email:"refund@example.test",p_customer_phone:"123",
      p_total_amount_minor:5000,p_currency:"RON",p_payment_method:"online",p_provider:"stripe",p_hold_seconds:600 });
    expect(result.error).toBeNull(); const row = result.data[0]; cancelledRows.push(row);
    expect((await db.from("payment_attempts").update({ provider_payment_id:`original-${row.payment_attempt_id}` }).eq("id",row.payment_attempt_id)).error).toBeNull();
    return row;
  }
  async function late(start:number, mismatch = false, expired = false) {
    const row = await book(start);
    if (expired) {
      expect((await db.from("court_reservations").update({ hold_expires_at:"2020-01-01T00:00:00Z" }).eq("id",row.reservation_id)).error).toBeNull();
      expect((await db.rpc("expire_payment_holds",{ p_court_id:courtId })).error).toBeNull();
    } else {
      expect((await settleOnlinePayment({ attemptId:row.payment_attempt_id,provider:"stripe",providerPaymentId:`original-${row.payment_attempt_id}`,outcome:"cancelled" }, db))).toBe("cancelled");
    }
    const eventId = `late-${randomUUID()}`;
    expect((await processOnlinePaymentEvent({ provider:"stripe",eventId:eventId,attemptId:row.payment_attempt_id,
      providerPaymentId:`original-${row.payment_attempt_id}`,outcome:"succeeded",amountMinor:mismatch ? 1 : 5000,currency:"RON" }, db))).toBe(mismatch ? "amount_mismatch" : expired ? "expired" : "cancelled");
    return { ...row,eventId };
  }
  try {
    await ensureIntegrationAdminAnchor(db);
    for (const client of [admin,second]) {
      const email = `reconcile-${randomUUID()}@example.test`,password="reconciliation-test-password-123";
      const auth = await db.auth.admin.createUser({ email,password,email_confirm:true }); expect(auth.error).toBeNull(); users.push(auth.data.user!.id);
      expect((await db.from("user_roles").insert({ user_id:users.at(-1),role_code:"admin" })).error).toBeNull();
      expect((await client.auth.signInWithPassword({ email,password })).error).toBeNull();
    }
    expect((await db.from("payment_provider_settings").update({ active_provider:"stripe" }).eq("id",true)).error).toBeNull();
    expect((await db.from("locations").insert({ id:locationId,name:"Reconciliation test",slug:`reconcile-${locationId}`,timezone:"UTC",currency:"RON",is_public:true })).error).toBeNull();
    expect((await db.from("courts").insert({ id:courtId,location_id:locationId,name:"Court",slug:"court",environment:"outdoor",surface:"clay" })).error).toBeNull();
    list.mockImplementation(() => (async function* () {})());
    create.mockImplementation(async (params) => ({ id:`refund-${params.metadata.payment_refund_id}`,amount:params.amount,currency:"ron",payment_intent:params.payment_intent,status:"succeeded" }));
    const own = await book(600);
    expect((await settleOnlinePayment({ attemptId:own.payment_attempt_id,provider:"stripe",providerPaymentId:`original-${own.payment_attempt_id}`,outcome:"succeeded" }, db))).toBe("succeeded");
    expect(await cancelBookingCommand(own.booking_id,users[0],true,true,db)).toMatchObject({ outcome: "cancelled" });
    const originalRefund = await refund(own.booking_id);
    expect((await db.from("payment_refunds").update({ status:"failed" }).eq("id",originalRefund.id)).error).toBeNull();
    const before = await occupancy(own.reservation_id);
    create.mockRejectedValueOnce(new Error("ambiguous response"));
    const failed = await retryAdminPaymentRefund(originalRefund.id,admin,db);
    expect(failed).toMatchObject({ ok:true,transaction:{ refund:{ id:originalRefund.id,status:"pending_retry" } } });
    expect(await occupancy(own.reservation_id)).toEqual(before);
    const retry = await retryAdminPaymentRefund(originalRefund.id,admin,db);
    expect(retry).toMatchObject({ ok:true,transaction:{ refund:{ id:originalRefund.id,status:"succeeded" } } });
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(create).toHaveBeenLastCalledWith({ payment_intent:`original-${own.payment_attempt_id}`,amount:5000,metadata:{ payment_refund_id:originalRefund.id } },
      { idempotencyKey:`court-payment-refund-${originalRefund.id}` });
    expect(await retryAdminPaymentRefund(originalRefund.id,admin,db)).toMatchObject({ ok:false });
    expect(await occupancy(own.reservation_id)).toEqual(before);

    const lateRow = await late(660,false,true),lateBefore=await occupancy(lateRow.reservation_id);
    const replacement = await book(660); const replacementBefore = await occupancy(replacement.reservation_id);
    const results = await Promise.all([resolveAdminPaymentReconciliation(lateRow.eventId,admin,db),resolveAdminPaymentReconciliation(lateRow.eventId,second,db)]);
    expect(results.some(r => r.ok)).toBe(true);
    const lateRefund = await refund(lateRow.booking_id);
    expect(lateRefund).toMatchObject({ amount_minor:5000,currency:"RON",payment_attempt_id:lateRow.payment_attempt_id,status:"succeeded" });
    expect(await event(lateRow.eventId)).toMatchObject({ reconciliation_required:false,resolved_at:expect.any(String),resolved_by_user_id:expect.any(String) });
    expect(await occupancy(lateRow.reservation_id)).toEqual(lateBefore); expect(await occupancy(replacement.reservation_id)).toEqual(replacementBefore);
    const resolvedBefore = await event(lateRow.eventId);
    expect(await resolveAdminPaymentReconciliation(lateRow.eventId,admin,db)).toMatchObject({ ok:true });
    expect(await event(lateRow.eventId)).toEqual(resolvedBefore);
    expect(create.mock.calls.filter(([params]) => params.metadata.payment_refund_id === lateRefund.id)).toHaveLength(1);
    expect((await db.from("payment_refunds").select("id").eq("booking_id",lateRow.booking_id)).data).toHaveLength(1);

    const incomplete = await late(720);
    create.mockRejectedValueOnce(new Error("network failure"));
    expect(await resolveAdminPaymentReconciliation(incomplete.eventId,admin,db)).toMatchObject({ ok:true,transaction:{ needsAttention:true,refund:{ status:"pending_retry" } } });
    expect((await event(incomplete.eventId)).reconciliation_required).toBe(true);
    const incompleteRefund = await refund(incomplete.booking_id);
    expect(await retryAdminPaymentRefund(incompleteRefund.id,admin,db)).toMatchObject({ ok:true,transaction:{ needsAttention:false,refund:{ status:"succeeded" },reconciliation:[{ reconciliation_required:false }] } });
    expect((await event(incomplete.eventId)).reconciliation_required).toBe(false);

    const terminal = await late(780);
    create.mockImplementationOnce(async (params) => ({ id:`refund-${params.metadata.payment_refund_id}`,amount:params.amount,currency:"ron",payment_intent:params.payment_intent,status:"failed" }));
    expect(await resolveAdminPaymentReconciliation(terminal.eventId,admin,db)).toMatchObject({ ok:true,transaction:{ needsAttention:true,refund:{ status:"failed" } } });
    const terminalRefund = await refund(terminal.booking_id);
    retrieve.mockResolvedValue({ id:terminalRefund.provider_refund_id,amount:5000,currency:"ron",payment_intent:`original-${terminal.payment_attempt_id}`,status:"failed" });
    const createCount = create.mock.calls.length;
    expect(await retryAdminPaymentRefund(terminalRefund.id,admin,db)).toMatchObject({ ok:true,transaction:{ refund:{ status:"failed" } } });
    expect(create.mock.calls.length).toBe(createCount); expect((await event(terminal.eventId)).reconciliation_required).toBe(true);

    // Stored relationship corruption must fail before any Stripe API call.
    expect((await db.from("payment_attempts").update({ amount_minor:6000 }).eq("id",terminal.payment_attempt_id)).error).toBeNull();
    expect(await retryAdminPaymentRefund(terminalRefund.id,admin,db)).toMatchObject({ ok:false });
    expect(create.mock.calls.length).toBe(createCount);
    expect((await db.from("payment_attempts").update({ amount_minor:5000 }).eq("id",terminal.payment_attempt_id)).error).toBeNull();
    const mismatch = await late(840,true);
    expect(await resolveAdminPaymentReconciliation(mismatch.eventId,admin,db)).toMatchObject({ ok:false });
    expect((await db.from("payment_refunds").select("id").eq("booking_id",mismatch.booking_id)).data).toEqual([]);
    expect((await admin.rpc("commit_refund_result",{ p_id: terminal.booking_id, p_fingerprint: "forged", p_revision: 0, p_refund_id:terminalRefund.id,p_token:randomUUID(),p_actor_id:users[0],p_status:"succeeded",p_provider_refund_id:"fake-evidence",p_error:null,p_events:[] })).error?.code).toBe("42501");
    expect((await db.from("user_roles").delete().eq("user_id",users[1]).eq("role_code","admin")).error).toBeNull();
    await expect(retryAdminPaymentRefund(terminalRefund.id,second,db)).rejects.toThrow();
    await expect(resolveAdminPaymentReconciliation(terminal.eventId,second,db)).rejects.toThrow();
    expect((await db.from("users").update({ status:"suspended" }).eq("id",users[0])).error).toBeNull();
    await expect(retryAdminPaymentRefund(terminalRefund.id,admin,db)).rejects.toThrow();
    await expect(resolveAdminPaymentReconciliation(terminal.eventId,admin,db)).rejects.toThrow();
  } finally {
    create.mockReset();list.mockReset();retrieve.mockReset();
    await db.from("users").update({ status:"active" }).in("id",users);
    await db.from("payment_provider_settings").update({ active_provider:previous }).eq("id",true);
    const ids=cancelledRows.map(r => r.booking_id);
    await db.from("booking_email_outbox").delete().in("booking_id",ids); await db.from("bookings").delete().in("id",ids);
    await db.from("court_reservations").delete().eq("court_id",courtId);await db.from("courts").delete().eq("id",courtId);await db.from("locations").delete().eq("id",locationId);
    await cleanupAuthFixtures(db,users);
  }
},30000);
