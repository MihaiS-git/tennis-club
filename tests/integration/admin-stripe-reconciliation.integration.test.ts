import { expirePaymentHolds } from "@/lib/payments/hold-expiry";
import { processOnlinePaymentEvent, settleOnlinePayment } from "@/lib/payments/service";
import { cleanupBookingFixtures, insertCheckoutFixture } from "./checkout-fixtures";
import { configureCheckoutPolicyFixture } from "./opening-hours-fixtures";
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
import { processBookingRefund } from "@/lib/payments/refunds";
import { prepareRefund } from "@/lib/payments/refund-commands";
import { checkAdminRefundWithProvider, listAdminPaymentTransactions } from "@/lib/payments/admin";
import { parseAdminPaymentQuery } from "@/lib/payments/admin-query";

test("Late-capture compensation preserves payment identity, idempotency and occupancy; Admin can only check refunds with Stripe", async () => {
  const db = localFixtureClient(), locationId = randomUUID(),courtId = randomUUID(),users: string[] = [];
  const admin = createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_PUBLISHABLE_KEY!,{ auth: { persistSession:false,autoRefreshToken:false } });
  const second = createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_PUBLISHABLE_KEY!,{ auth: { persistSession:false,autoRefreshToken:false } });
  const previous = (await db.from("payment_provider_settings").select("active_provider").single()).data!.active_provider;
  const cancelledRows: { booking_id:string; reservation_id:string; payment_attempt_id:string }[] = [];
  const refund = async (bookingId:string) => {
    const result = await db.from("payment_refunds").select("*").eq("booking_id",bookingId).single(); expect(result.error).toBeNull(); const executionResult = await db.from("refund_executions").select("*").eq("refund_id",result.data!.id).order("execution_number",{ascending:false}).limit(1);
    expect(executionResult.error).toBeNull(); const execution=executionResult.data?.[0];
    return { ...result.data!, provider_refund_id: execution?.provider_refund_id ?? null, execution };
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
    expect((await db.from("bookings").select("status").eq("id",row.booking_id).single()).data)
      .toEqual({ status:"expired" });
    expect((await db.from("booking_revisions").select("kind,booking_state").eq("booking_id",row.booking_id)).data)
      .toEqual([{ kind:"created",booking_state:"pending_payment" }]);
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
    await configureCheckoutPolicyFixture(db, locationId, courtId);
    list.mockImplementation(() => (async function* () {})());
    create.mockImplementation(async (params) => ({ id:`refund-${params.metadata.refund_execution_id}`,amount:params.amount,currency:"ron",payment_intent:params.payment_intent,status:"succeeded",metadata:params.metadata }));
    // An accepted request with a lost response is recovered from provider
    // evidence using the original execution, never a new idempotency key.
    create.mockRejectedValueOnce(new Error("ambiguous response"));
    const lateRow = await late(660,false,true);
    const uncertain = await refund(lateRow.booking_id);
    expect(uncertain).toMatchObject({ status:"pending_retry", amount_minor:5000,
      captured_amount_minor:5000, payment_attempt_id:lateRow.payment_attempt_id });
    const before = await occupancy(lateRow.reservation_id);
    const replacement = await book(660), replacementBefore = await occupancy(replacement.reservation_id);
    const acceptedParams = create.mock.calls[0][0];
    const accepted = { id:`refund-${acceptedParams.metadata.refund_execution_id}`,amount:5000,currency:"ron",
      payment_intent:acceptedParams.payment_intent,status:"succeeded",metadata:acceptedParams.metadata };
    list.mockImplementation(() => (async function* () { yield accepted; })());
    retrieve.mockResolvedValue(accepted);
    expect(await processBookingRefund(uncertain.id)).toBe("succeeded");
    expect(await processBookingRefund(uncertain.id)).toBe("succeeded");
    expect(create).toHaveBeenCalledOnce();
    const completed = await refund(lateRow.booking_id);
    expect(completed.execution.id).toBe(uncertain.execution.id);
    expect(completed.execution.idempotency_key).toBe(uncertain.execution.idempotency_key);
    expect(completed.execution.initiated_by_user_id).toBeNull();
    expect(create).toHaveBeenLastCalledWith({ payment_intent:`original-${lateRow.payment_attempt_id}`,amount:5000,
      metadata:{ payment_refund_id:uncertain.id,refund_execution_id:completed.execution.id } },
      { idempotencyKey:completed.execution.idempotency_key });
    expect(await occupancy(lateRow.reservation_id)).toEqual(before);
    expect(await occupancy(replacement.reservation_id)).toEqual(replacementBefore);
    expect(await event(lateRow.eventId)).toMatchObject({ reconciliation_required:false,
      resolved_at:expect.any(String),resolved_by_user_id:null });
    const resolution = await event(lateRow.eventId);
    // A repeated check (refund webhook replay) changes nothing once resolved.
    expect(await processBookingRefund(uncertain.id)).toBe("succeeded");
    expect(await event(lateRow.eventId)).toEqual(resolution);
    expect((await db.from("payment_refunds").select("id").eq("booking_id",lateRow.booking_id)).data).toEqual([{ id:uncertain.id }]);
    expect((await db.from("refund_executions").select("id").eq("refund_id",uncertain.id)).data).toEqual([{ id:completed.execution.id }]);

    const query = parseAdminPaymentQuery({ q:uncertain.id });
    const providerCalls = create.mock.calls.length;
    const page = await listAdminPaymentTransactions(query,admin);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ needsAttention:false, refund:{ id:uncertain.id,status:"succeeded" } });
    expect(page.rows[0].refund).not.toHaveProperty("executions");
    expect(page.rows[0]).not.toHaveProperty("canRetryRefund");
    expect(create.mock.calls.length).toBe(providerCalls);
    expect(await event(lateRow.eventId)).toEqual(resolution);

    // A mismatch is an investigation case, never an automatic full refund.
    const mismatch = await late(840,true,true);
    expect(await event(mismatch.eventId)).toMatchObject({ reconciliation_required:true });
    expect((await db.from("payment_refunds").select("id").eq("booking_id",mismatch.booking_id)).data).toEqual([]);
    expect(create.mock.calls.length).toBe(providerCalls);

    // A definitive failure without retryable evidence cannot create a new
    // generation, even when an Admin checks it with Stripe.
    list.mockImplementation(() => (async function* () {})());
    create.mockImplementationOnce(async params => ({ id:`refund-${params.metadata.refund_execution_id}`,
      amount:params.amount,currency:"ron",payment_intent:params.payment_intent,status:"failed",
      failure_reason:"declined",metadata:params.metadata }));
    const terminal = await late(900,false,true), terminalRefund = await refund(terminal.booking_id);
    expect(terminalRefund.status).toBe("failed");
    expect(await prepareRefund(terminalRefund.id)).toMatchObject({outcome:"terminal",status:"failed"});
    expect(await processBookingRefund(terminalRefund.id)).toBe("failed");
    expect(await checkAdminRefundWithProvider({ refundId:terminalRefund.id },admin)).toEqual({ ok:true,status:"failed" });
    expect(await checkAdminRefundWithProvider({ refundId:"not-a-uuid" },admin)).toEqual({ ok:false,message:"Choose a valid refund." });
    expect(create).toHaveBeenCalledTimes(providerCalls+1);
    expect((await refund(terminal.booking_id)).execution.id).toBe(terminalRefund.execution.id);
    expect((await db.from("refund_executions").select("id").eq("refund_id",terminalRefund.id)).data).toEqual([{id:terminalRefund.execution.id}]);

    // Automatic state transitions have no Admin actor; private inspection
    // still requires an active Admin account.
    expect((await db.from("user_roles").delete().eq("user_id",users[1]).eq("role_code","admin")).error).toBeNull();
    await expect(listAdminPaymentTransactions(query,second)).rejects.toThrow();
    await expect(checkAdminRefundWithProvider({ refundId:terminalRefund.id },second)).rejects.toThrow();
    expect((await db.from("users").update({status:"suspended"}).eq("id",users[0])).error).toBeNull();
    await expect(listAdminPaymentTransactions(query,admin)).rejects.toThrow();
  } finally {
    vi.restoreAllMocks();
    create.mockReset();list.mockReset();retrieve.mockReset();
    expect((await db.from("users").update({ status:"active" }).in("id",users)).error).toBeNull();
    expect((await db.from("payment_provider_settings").update({ active_provider:previous }).eq("id",true)).error).toBeNull();
    const ids=cancelledRows.map(r => r.booking_id);
    await cleanupBookingFixtures({ bookingIds: ids });
    await cleanupBookingFixtures({ courtIds: [courtId] });
    // The checkout policy fixture's pricing and opening hours reference the court and
    // location; remove them first, and fail loudly instead of leaking the location.
    expect((await db.from("court_reservations").delete().eq("court_id",courtId)).error).toBeNull();
    expect((await db.from("pricing_rule_sets").delete().eq("location_id",locationId)).error).toBeNull();
    expect((await db.from("location_opening_hours").delete().eq("location_id",locationId)).error).toBeNull();
    expect((await db.from("courts").delete().eq("id",courtId)).error).toBeNull();
    expect((await db.from("locations").delete().eq("id",locationId)).error).toBeNull();
    await cleanupAuthFixtures(db,users);
  }
},30000);
