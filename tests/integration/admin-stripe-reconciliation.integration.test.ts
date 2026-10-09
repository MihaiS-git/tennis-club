import { expirePaymentHolds } from "@/lib/payments/hold-expiry";
import * as refundPersistence from "@/lib/db/repositories/payments.repository";
import * as accounts from "@/lib/db/repositories/accounts.repository";
import { getDataSource } from "@/lib/db/data-source";
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
      await expirePaymentHolds({ courtId });
    } else {
      expect((await settleOnlinePayment({ attemptId:row.payment_attempt_id,provider:"stripe",providerPaymentId:`original-${row.payment_attempt_id}`,outcome:"cancelled" }))).toBe("cancelled");
    }
    const eventId = `late-${randomUUID()}`;
    expect((await processOnlinePaymentEvent({ provider:"stripe",eventId:eventId,attemptId:row.payment_attempt_id,
      providerPaymentId:`original-${row.payment_attempt_id}`,outcome:"succeeded",amountMinor:mismatch ? 1 : 5000,currency:"RON" }))).toBe(mismatch ? "amount_mismatch" : expired ? "expired" : "cancelled");
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
    expect((await settleOnlinePayment({ attemptId:own.payment_attempt_id,provider:"stripe",providerPaymentId:`original-${own.payment_attempt_id}`,outcome:"succeeded" }))).toBe("succeeded");
    expect(await cancelBookingCommand(own.booking_id,users[0],true,true)).toMatchObject({ outcome: "cancelled" });
    const originalRefund = await refund(own.booking_id);
    expect((await db.from("payment_refunds").update({ status:"failed" }).eq("id",originalRefund.id)).error).toBeNull();
    const before = await occupancy(own.reservation_id);
    create.mockRejectedValueOnce(new Error("ambiguous response"));
    const failed = await retryAdminPaymentRefund(originalRefund.id,admin);
    expect(failed).toMatchObject({ ok:true,transaction:{ refund:{ id:originalRefund.id,status:"pending_retry" } } });
    expect(await occupancy(own.reservation_id)).toEqual(before);
    const retry = await retryAdminPaymentRefund(originalRefund.id,admin);
    expect(retry).toMatchObject({ ok:true,transaction:{ refund:{ id:originalRefund.id,status:"succeeded" } } });
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(create).toHaveBeenLastCalledWith({ payment_intent:`original-${own.payment_attempt_id}`,amount:5000,metadata:{ payment_refund_id:originalRefund.id } },
      { idempotencyKey:`court-payment-refund-${originalRefund.id}` });
    expect(await retryAdminPaymentRefund(originalRefund.id,admin)).toMatchObject({ ok:false });
    expect(await occupancy(own.reservation_id)).toEqual(before);

    const lateRow = await late(660,false,true),lateBefore=await occupancy(lateRow.reservation_id);
    const replacement = await book(660); const replacementBefore = await occupancy(replacement.reservation_id);
    const results = await Promise.all([resolveAdminPaymentReconciliation(lateRow.eventId,admin),resolveAdminPaymentReconciliation(lateRow.eventId,second)]);
    expect(results.some(r => r.ok)).toBe(true);
    const lateRefund = await refund(lateRow.booking_id);
    expect(lateRefund).toMatchObject({ amount_minor:5000,currency:"RON",payment_attempt_id:lateRow.payment_attempt_id,status:"succeeded" });
    expect(await event(lateRow.eventId)).toMatchObject({ reconciliation_required:false,resolved_at:expect.any(String),resolved_by_user_id:expect.any(String) });
    expect(await occupancy(lateRow.reservation_id)).toEqual(lateBefore); expect(await occupancy(replacement.reservation_id)).toEqual(replacementBefore);
    const resolvedBefore = await event(lateRow.eventId);
    expect(await resolveAdminPaymentReconciliation(lateRow.eventId,admin)).toMatchObject({ ok:true });
    expect(await event(lateRow.eventId)).toEqual(resolvedBefore);
    expect(create.mock.calls.filter(([params]) => params.metadata.payment_refund_id === lateRefund.id)).toHaveLength(1);
    expect((await db.from("payment_refunds").select("id").eq("booking_id",lateRow.booking_id)).data).toHaveLength(1);

    const incomplete = await late(720);
    create.mockRejectedValueOnce(new Error("network failure"));
    expect(await resolveAdminPaymentReconciliation(incomplete.eventId,admin)).toMatchObject({ ok:true,transaction:{ needsAttention:true,refund:{ status:"pending_retry" } } });
    expect((await event(incomplete.eventId)).reconciliation_required).toBe(true);
    const incompleteRefund = await refund(incomplete.booking_id);
    expect(await retryAdminPaymentRefund(incompleteRefund.id,admin)).toMatchObject({ ok:true,transaction:{ needsAttention:false,refund:{ status:"succeeded" },reconciliation:[{ reconciliation_required:false }] } });
    expect((await event(incomplete.eventId)).reconciliation_required).toBe(false);
    const resolvedEvidence = await event(incomplete.eventId);
    expect(await processOnlinePaymentEvent({ provider:"stripe",eventId:incomplete.eventId,attemptId:incomplete.payment_attempt_id,
      providerPaymentId:`original-${incomplete.payment_attempt_id}`,outcome:"succeeded",amountMinor:5000,currency:"ron" })).toBe("cancelled");
    expect(await event(incomplete.eventId)).toEqual(resolvedEvidence);

    const terminal = await late(780);
    create.mockImplementationOnce(async (params) => ({ id:`refund-${params.metadata.payment_refund_id}`,amount:params.amount,currency:"ron",payment_intent:params.payment_intent,status:"failed" }));
    expect(await resolveAdminPaymentReconciliation(terminal.eventId,admin)).toMatchObject({ ok:true,transaction:{ needsAttention:true,refund:{ status:"failed" } } });
    const terminalRefund = await refund(terminal.booking_id);
    retrieve.mockResolvedValue({ id:terminalRefund.provider_refund_id,amount:5000,currency:"ron",payment_intent:`original-${terminal.payment_attempt_id}`,status:"failed" });
    const createCount = create.mock.calls.length;
    expect(await retryAdminPaymentRefund(terminalRefund.id,admin)).toMatchObject({ ok:true,transaction:{ refund:{ status:"failed" } } });
    expect(create.mock.calls.length).toBe(createCount); expect((await event(terminal.eventId)).reconciliation_required).toBe(true);

    // Stripe success followed by a local transaction failure must recover the
    // same provider refund from metadata, then retain resolution attribution.
    const recovery = await late(900);
    let accepted: { id:string; amount:number; currency:string; payment_intent:string; status:string; metadata:{ payment_refund_id:string } } | undefined;
    create.mockImplementationOnce(async params => {
      accepted = { id:`refund-${params.metadata.payment_refund_id}`,amount:params.amount,currency:"ron",
        payment_intent:params.payment_intent,status:"succeeded",metadata:params.metadata };
      return accepted;
    });
    const originalResolution=refundPersistence.writeRefundEventResolution;
    const injected=vi.spyOn(refundPersistence,"writeRefundEventResolution").mockImplementationOnce(async (...args)=>{
      await originalResolution(...args); throw new Error("Injected failure after refund/event mutations");
    });
    expect(await resolveAdminPaymentReconciliation(recovery.eventId,admin)).toMatchObject({ok:true,transaction:{refund:{status:"pending"},needsAttention:true}});
    injected.mockRestore();
    const durable=await refund(recovery.booking_id);
    expect(durable).toMatchObject({provider_refund_id:null,admin_lease_token:expect.any(String)});
    expect(await event(recovery.eventId)).toEqual({reconciliation_required:true,resolved_at:null,resolved_by_user_id:null});
    const callsAfterAcceptance=create.mock.calls.length;
    list.mockImplementationOnce(() => (async function* () { if (accepted) yield accepted; })());
    expect((await db.from("payment_refunds").update({admin_lease_until:"2020-01-01T00:00:00.123456Z"}).eq("id",durable.id)).error).toBeNull();
    expect(await resolveAdminPaymentReconciliation(recovery.eventId,second)).toMatchObject({ok:true,transaction:{refund:{id:durable.id,status:"succeeded"},needsAttention:false}});
    expect(create.mock.calls.length).toBe(callsAfterAcceptance);
    const recoveryResolution=await event(recovery.eventId);
    expect(recoveryResolution.resolved_by_user_id).toBe(users[1]);
    expect(await resolveAdminPaymentReconciliation(recovery.eventId,admin)).toMatchObject({ok:true});
    expect(await event(recovery.eventId)).toEqual(recoveryResolution);
    expect(create.mock.calls.length).toBe(callsAfterAcceptance);

    // Authorization verified before entry can change before the locked fence.
    // Neither rejected preparation is allowed to reach Stripe.
    const fenceRow=await late(960);
    for (const change of ["role","status"]) {
      const originalFence=accounts.lockReservationActorFacts;
      const fence=vi.spyOn(accounts,"lockReservationActorFacts").mockImplementationOnce(async (...args)=>{
        const source=await getDataSource();
        if (change==="role") await source.query("DELETE FROM public.user_roles WHERE user_id=$1 AND role_code='admin'",[users[0]]);
        else await source.query("UPDATE public.users SET status='suspended' WHERE id=$1",[users[0]]);
        return originalFence(...args);
      });
      const providerCalls=create.mock.calls.length;
      expect(await resolveAdminPaymentReconciliation(fenceRow.eventId,admin)).toEqual({ok:false,message:"Unable to prepare this refund. Refresh and try again."});
      expect(create.mock.calls.length).toBe(providerCalls);
      fence.mockRestore();
      expect((await db.from("users").update({status:"active"}).eq("id",users[0])).error).toBeNull();
      if (change==="role") expect((await db.from("user_roles").insert({user_id:users[0],role_code:"admin"})).error).toBeNull();
    }

    const beforeCorruptionCalls=create.mock.calls.length;
    // Stored relationship corruption must fail before any Stripe API call.
    expect((await db.from("payment_attempts").update({ amount_minor:6000 }).eq("id",terminal.payment_attempt_id)).error).toBeNull();
    expect(await retryAdminPaymentRefund(terminalRefund.id,admin)).toMatchObject({ ok:false });
    expect(create.mock.calls.length).toBe(beforeCorruptionCalls);
    expect((await db.from("payment_attempts").update({ amount_minor:5000 }).eq("id",terminal.payment_attempt_id)).error).toBeNull();
    const mismatch = await late(840,true);
    expect(await resolveAdminPaymentReconciliation(mismatch.eventId,admin)).toMatchObject({ ok:false });
    expect((await db.from("payment_refunds").select("id").eq("booking_id",mismatch.booking_id)).data).toEqual([]);
    expect((await db.from("user_roles").delete().eq("user_id",users[1]).eq("role_code","admin")).error).toBeNull();
    await expect(retryAdminPaymentRefund(terminalRefund.id,second)).rejects.toThrow();
    await expect(resolveAdminPaymentReconciliation(terminal.eventId,second)).rejects.toThrow();
    expect((await db.from("users").update({ status:"suspended" }).eq("id",users[0])).error).toBeNull();
    await expect(retryAdminPaymentRefund(terminalRefund.id,admin)).rejects.toThrow();
    await expect(resolveAdminPaymentReconciliation(terminal.eventId,admin)).rejects.toThrow();
  } finally {
    vi.restoreAllMocks();
    create.mockReset();list.mockReset();retrieve.mockReset();
    await db.from("users").update({ status:"active" }).in("id",users);
    await db.from("payment_provider_settings").update({ active_provider:previous }).eq("id",true);
    const ids=cancelledRows.map(r => r.booking_id);
    await db.from("bookings").delete().in("id",ids);
    await db.from("court_reservations").delete().eq("court_id",courtId);await db.from("courts").delete().eq("id",courtId);await db.from("locations").delete().eq("id",locationId);
    await cleanupAuthFixtures(db,users);
  }
},30000);
