import Stripe from "stripe";
const { create, list, retrieve } = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), retrieve: vi.fn() }));
vi.mock("@/lib/payments/providers/stripe/client", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/payments/providers/stripe/client")>(),
  stripeClient: () => ({ refunds: { create, list, retrieve } }),
}));
import { processBookingRefund } from "@/lib/payments/refunds";
import { prepareAutomaticRefund, prepareAdminRefund, initiateRefundExecution } from "@/lib/payments/refund-commands";
import * as payments from "@/lib/db/repositories/payments.repository";
import { bookingFinancials } from "@/lib/payments/financials";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";
import { localFixtureClient } from "../auth-fixtures";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { DataSource, EntityManager, QueryRunner } from "typeorm";
import { getDataSource } from "@/lib/db/data-source";
import { PaymentRefundEntity } from "@/lib/db/entities/payment-refund.entity";
import { RefundExecutionEntity } from "@/lib/db/entities/refund-execution.entity";
import * as executions from "@/lib/db/repositories/refund-executions.repository";
import { assertTestEnvironment } from "../../local/environment.mjs";
import { cleanupBookingEvidence, insertBookingRecords } from "../../local/booking-fixtures";

let database: DataSource;
beforeAll(async () => { assertTestEnvironment(); database = await getDataSource(); });
afterAll(async () => { await database?.destroy(); });

async function fixture(manager: EntityManager) {
  const locationId = randomUUID(), courtId = randomUUID(), reservationId = randomUUID();
  const bookingId = randomUUID(), attemptId = randomUUID(), refundId = randomUUID();
  const providerPaymentId = `pi_${attemptId}`;
  await manager.query("INSERT INTO public.locations(id,name,slug,timezone) VALUES($1,'Execution test',$2,'UTC')", [locationId, `execution-${locationId}`]);
  await manager.query("INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'Court','court','hard','outdoor')", [courtId, locationId]);
  await manager.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute)
    VALUES($1,$2,'2099-10-15',600,660)`, [reservationId, courtId]);
  await insertBookingRecords(manager, { id: bookingId, reservation_id: reservationId, customer_name: "Customer",
    customer_email: "execution@example.test", customer_phone: "123", total_amount_minor: 5000, currency: "RON",
    cancellation_notice_minutes: 1440, payment_method: "online" });
  await manager.query(`INSERT INTO public.payment_attempts(id,booking_id,method,provider,provider_payment_id,amount_minor,currency,status,expires_at,completed_at)
    VALUES($1,$2,'online','stripe',$3,5000,'RON','succeeded',now()+interval '10 minutes',now())`, [attemptId, bookingId, providerPaymentId]);
  await manager.query(`INSERT INTO public.payment_capture_receipts(payment_attempt_id,provider,provider_payment_id,provider_capture_id,amount_minor,currency)
    VALUES($1,'stripe',$2,$2,5000,'RON')`, [attemptId, providerPaymentId]);
  const context: { current_revision_id: string }[] = await manager.query("SELECT current_revision_id FROM public.bookings WHERE id=$1", [bookingId]);
  await manager.getRepository(PaymentRefundEntity).insert({ id: refundId, bookingId, paymentAttemptId: attemptId,
    provider: "stripe", providerPaymentId, amountMinor: 2500, capturedAmountMinor: 5000, currency: "RON", reason: "booking_price_reduction",
    contextRevisionId: context[0].current_revision_id, operationKey: randomUUID() });
  const request = { id: randomUUID(), refundId, provider: "stripe" as const, providerPaymentId, amountMinor: 2500,
    currency: "RON" as const, idempotencyKey: `refund-execution-${randomUUID()}`, initiatedByUserId: null, createdAt: new Date() };
  return { locationId, courtId, reservationId, bookingId, attemptId, refundId, request };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function isolated(work: (runner: QueryRunner, data: Fixture) => Promise<void>) {
  const runner = database.createQueryRunner();
  await runner.startTransaction();
  try { await work(runner, await fixture(runner.manager)); }
  finally { await runner.rollbackTransaction(); await runner.release(); }
}
async function rejects(runner: QueryRunner, work: () => Promise<unknown>, code: string) {
  await runner.query("SAVEPOINT invalid_execution");
  try { await expect(work()).rejects.toMatchObject({ driverError: { code } }); }
  finally { await runner.query("ROLLBACK TO SAVEPOINT invalid_execution"); }
}
async function ready(manager: EntityManager, data: Fixture) {
  const { execution } = await executions.allocateRefundExecution(manager, data.request);
  const identity = { refundId: data.refundId, executionId: execution.id, token: randomUUID() };
  expect(await executions.claimRefundExecution(manager, { ...identity, leaseUntil: new Date(Date.now() + 300_000) })).toBe(true);
  return identity;
}
async function dispatched(manager: EntityManager, data: Fixture) {
  const identity = await ready(manager, data);
  await executions.recordRefundDispatch(manager, { ...identity, initiatedAt: new Date() });
  return identity;
}

test("initial execution copies locked obligation terms and loads ordered history", async () => {
  await isolated(async (runner, data) => {
    const allocated = await executions.allocateRefundExecution(runner.manager, data.request);
    expect(allocated).toMatchObject({ outcome: "created", execution: { ...data.request, executionNumber: 1,
      status: "ready", dispatchInitiatedAt: null, terminalResult: null } });
    const context = await executions.loadRefundExecutionContext(runner.manager, data.refundId);
    expect(context?.refund.id).toBe(data.refundId);
    expect(context?.executions.map(row => row.id)).toEqual([data.request.id]);
    expect((await executions.findUnresolvedRefundExecution(runner.manager, data.refundId))?.id).toBe(data.request.id);
  });
});

test("number and active-execution uniqueness are actual PostgreSQL constraints", async () => {
  await isolated(async (runner, data) => {
    await executions.allocateRefundExecution(runner.manager, data.request);
    const repository = runner.manager.getRepository(RefundExecutionEntity);
    await rejects(runner, () => repository.insert({ ...data.request, id: randomUUID(), idempotencyKey: randomUUID(), executionNumber: 1 }), "23505");
    await rejects(runner, () => repository.insert({ ...data.request, id: randomUUID(), idempotencyKey: randomUUID(), executionNumber: 2 }), "23505");
  });
});

test("provider idempotency keys and refund identities cannot be reused across obligations", async () => {
  await isolated(async (runner, data) => {
    const other = await fixture(runner.manager);
    const identity = await dispatched(runner.manager, data);
    await rejects(runner, () => executions.allocateRefundExecution(runner.manager, { ...other.request, idempotencyKey: data.request.idempotencyKey }), "23505");
    const otherIdentity = await dispatched(runner.manager, other);
    await executions.recordRefundProviderIdentity(runner.manager, { ...identity, providerRefundId: "re_unique", checkedAt: new Date() });
    await rejects(runner, () => executions.recordRefundProviderIdentity(runner.manager, { ...otherIdentity, providerRefundId: "re_unique", checkedAt: new Date() }), "23505");
  });
});

test.each(["id", "refund_id", "execution_number", "provider", "provider_payment_id", "amount_minor", "currency",
  "idempotency_key", "initiated_by_user_id", "created_at"])("request field %s cannot change through SQL", async column => {
  await isolated(async (runner, data) => {
    await executions.allocateRefundExecution(runner.manager, data.request);
    const replacement = column === "execution_number" || column === "amount_minor" ? "2"
      : column === "created_at" ? "created_at + interval '1 second'"
        : ["id", "refund_id", "initiated_by_user_id"].includes(column) ? "gen_random_uuid()" : "'changed'";
    await rejects(runner, () => runner.query(`UPDATE public.refund_executions SET ${column}=${replacement} WHERE id=$1`, [data.request.id]), "23514");
  });
});

test("provider identity and dispatch timestamp attach once and cannot be cleared or replaced", async () => {
  await isolated(async (runner, data) => {
    const identity = await dispatched(runner.manager, data);
    await executions.recordRefundProviderIdentity(runner.manager, { ...identity, providerRefundId: "re_once", checkedAt: new Date() });
    for (const assignment of ["provider_refund_id=NULL", "provider_refund_id='re_other'", "dispatch_initiated_at=NULL",
      "dispatch_initiated_at=dispatch_initiated_at+interval '1 second'"])
      await rejects(runner, () => runner.query(`UPDATE public.refund_executions SET ${assignment} WHERE id=$1`, [identity.executionId]), "23514");
    await expect(executions.recordRefundProviderIdentity(runner.manager, { ...identity, providerRefundId: "re_other", checkedAt: new Date() }))
      .rejects.toBeInstanceOf(executions.RefundExecutionIntegrityError);
  });
});

test("first uncertainty is retained across repeated observations and nonterminal progress", async () => {
  await isolated(async (runner, data) => {
    const identity = await dispatched(runner.manager, data);
    await executions.recordRefundUncertainty(runner.manager, { ...identity, evidence: "creation_timeout", observedAt: new Date() });
    const before = await executions.findUnresolvedRefundExecution(runner.manager, data.refundId);
    await executions.recordRefundUncertainty(runner.manager, { ...identity, evidence: "later_timeout", observedAt: new Date(Date.now() + 1000) });
    await executions.recordRefundProviderIdentity(runner.manager, { ...identity, providerRefundId: "re_recovered", checkedAt: new Date() });
    expect(await executions.findUnresolvedRefundExecution(runner.manager, data.refundId)).toMatchObject({ status: "pending",
      firstUncertaintyEvidence: "creation_timeout", firstUncertainAt: before?.firstUncertainAt });
    for (const assignment of ["first_uncertainty_evidence=NULL", "first_uncertainty_evidence='replacement'",
      "first_uncertain_at=NULL", "first_uncertain_at=first_uncertain_at+interval '1 second'"])
      await rejects(runner, () => runner.query(`UPDATE public.refund_executions SET ${assignment} WHERE id=$1`, [identity.executionId]), "23514");
  });
});

test("repeated evidence preserves PostgreSQL microsecond timestamps", async () => {
  await isolated(async (runner, data) => {
    const identity = await dispatched(runner.manager, data);
    await runner.query(`UPDATE public.refund_executions SET status='uncertain',
      first_uncertain_at='2026-10-13T12:00:00.123456Z',first_uncertainty_evidence='timeout' WHERE id=$1`, [identity.executionId]);
    await executions.recordRefundUncertainty(runner.manager, { ...identity, evidence: "later_timeout", observedAt: new Date() });
    await runner.query(`UPDATE public.refund_executions SET status='succeeded',provider_refund_id='re_precision',terminal_result='succeeded',
      terminal_evidence='verified_response',completed_at='2026-10-13T12:00:01.654321Z' WHERE id=$1`, [identity.executionId]);
    await executions.recordRefundTerminalResult(runner.manager, { ...identity, result: "succeeded", providerRefundId: "re_precision",
      evidence: "repeat_response", completedAt: new Date() });
    expect(await runner.query(`SELECT first_uncertain_at AT TIME ZONE 'UTC' = timestamp '2026-10-13 12:00:00.123456' AS uncertainty,
      completed_at AT TIME ZONE 'UTC' = timestamp '2026-10-13 12:00:01.654321' AS completion,
      terminal_evidence FROM public.refund_executions WHERE id=$1`, [identity.executionId]))
      .toEqual([{ uncertainty: true, completion: true, terminal_evidence: "verified_response" }]);
  });
});

test.each(["succeeded", "failed", "rejected"] as const)("verified terminal %s evidence is consistent and immutable", async result => {
  await isolated(async (runner, data) => {
    const identity = await dispatched(runner.manager, data);
    const evidence = result === "rejected" ? { result, providerRefundId: null } : { result, providerRefundId: `re_${result}` };
    await executions.recordRefundTerminalResult(runner.manager, { ...identity, ...evidence, evidence: "verified_response", completedAt: new Date() });
    const [row] = await executions.listRefundExecutions(runner.manager, data.refundId);
    expect(row).toMatchObject({ status: result, terminalResult: result, terminalEvidence: "verified_response", leaseToken: null });
    expect(await executions.findUnresolvedRefundExecution(runner.manager, data.refundId)).toBeNull();
    for (const assignment of ["status='pending'", "terminal_result=NULL", "terminal_result='other'", "terminal_evidence=NULL",
      "terminal_evidence='other'", "completed_at=NULL", "completed_at=completed_at+interval '1 second'"])
      await rejects(runner, () => runner.query(`UPDATE public.refund_executions SET ${assignment} WHERE id=$1`, [identity.executionId]), "23514");
    expect(await executions.claimRefundExecution(runner.manager, { ...identity, token: randomUUID(), leaseUntil: new Date(Date.now() + 300_000) })).toBe(false);
  });
});

test("DELETE and TRUNCATE are rejected independently of services", async () => {
  await isolated(async (runner, data) => {
    await executions.allocateRefundExecution(runner.manager, data.request);
    await rejects(runner, () => runner.query("DELETE FROM public.refund_executions WHERE id=$1", [data.request.id]), "23514");
    await rejects(runner, () => runner.query("TRUNCATE public.refund_executions"), "23514");
    await rejects(runner, () => runner.query("DELETE FROM public.payment_refunds WHERE id=$1", [data.refundId]), "23503");
  });
});

test("database checks reject fabricated ready/uncertain/terminal states", async () => {
  await isolated(async (runner, data) => {
    await executions.allocateRefundExecution(runner.manager, data.request);
    for (const assignment of ["status='uncertain'", "status='pending'", "status='succeeded'", "provider_refund_id='re_unstarted'",
      "terminal_result='failed'", "lease_token=gen_random_uuid()"])
      await rejects(runner, () => runner.query(`UPDATE public.refund_executions SET ${assignment} WHERE id=$1`, [data.request.id]), "23514");
  });
});

test.each(["failed", "rejected"] as const)("definitive %s execution permits a new request identity", async result => {
  await isolated(async (runner, data) => {
    const identity = await dispatched(runner.manager, data);
    const evidence = result === "rejected" ? { result, providerRefundId: null } : { result, providerRefundId: "re_failed" };
    await executions.recordRefundTerminalResult(runner.manager, { ...identity, ...evidence, evidence: "verified_response", completedAt: new Date() });
    const next = await executions.allocateRefundExecution(runner.manager, { ...data.request, id: randomUUID(), idempotencyKey: randomUUID() });
    expect(next).toMatchObject({ outcome: "created", execution: { executionNumber: 2, status: "ready" } });
    expect((await executions.listRefundExecutions(runner.manager, data.refundId)).map(row => row.status)).toEqual([result, "ready"]);
  });
});

test.each(["ready", "pending", "uncertain", "succeeded"] as const)("%s blocks creation of another provider operation", async status => {
  await isolated(async (runner, data) => {
    const identity = status === "ready" ? await ready(runner.manager, data) : await dispatched(runner.manager, data);
    if (status === "uncertain") await executions.recordRefundUncertainty(runner.manager, { ...identity, evidence: "timeout", observedAt: new Date() });
    if (status === "succeeded") await executions.recordRefundTerminalResult(runner.manager, { ...identity,
      result: "succeeded", providerRefundId: "re_success", evidence: "verified_response", completedAt: new Date() });
    const request = { ...data.request, id: randomUUID(), idempotencyKey: randomUUID() };
    if (status === "succeeded") await expect(executions.allocateRefundExecution(runner.manager, request)).rejects.toBeInstanceOf(executions.RefundExecutionIntegrityError);
    else expect(await executions.allocateRefundExecution(runner.manager, request)).toMatchObject({ outcome: "existing", execution: { id: identity.executionId, status } });
    await rejects(runner, () => runner.manager.getRepository(RefundExecutionEntity).insert({ ...request, executionNumber: 2 }), "23505");
  });
});

test("expired lease takeover reuses execution and stale completion preserves the new worker's operational fields", async () => {
  await isolated(async (runner, data) => {
    const old = await dispatched(runner.manager, data), current = { ...old, token: randomUUID() };
    expect(await executions.claimRefundExecution(runner.manager, { ...current, leaseUntil: new Date(Date.now() + 300_000) })).toBe(false);
    await runner.query("UPDATE public.refund_executions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [old.executionId]);
    expect(await executions.claimRefundExecution(runner.manager, { ...current, leaseUntil: new Date(Date.now() + 300_000) })).toBe(true);
    const checkedAt = new Date();
    await executions.recordRefundExecutionCheck(runner.manager, { ...current, checkedAt, lastError: "lookup_failed", releaseLease: false });
    await expect(executions.recordRefundExecutionCheck(runner.manager, { ...old, checkedAt: new Date(), lastError: "stale", releaseLease: true }))
      .rejects.toBeInstanceOf(executions.RefundExecutionFenceError);
    await expect(executions.recordRefundDispatch(runner.manager, { ...old, initiatedAt: new Date() })).rejects.toBeInstanceOf(executions.RefundExecutionFenceError);
    expect(await executions.recordRefundProviderIdentity(runner.manager, { ...old, providerRefundId: "re_stale", checkedAt: new Date() })).toBe("stale");
    expect(await executions.recordRefundUncertainty(runner.manager, { ...old, evidence: "creation_timeout", observedAt: new Date() })).toBe("stale");
    expect(await executions.recordRefundTerminalResult(runner.manager, { ...old, result: "succeeded", providerRefundId: "re_stale",
      evidence: "verified_response", completedAt: new Date() })).toBe("stale");
    const [row] = await executions.listRefundExecutions(runner.manager, data.refundId);
    expect(row).toMatchObject({ id: old.executionId, executionNumber: 1, leaseToken: current.token,
      lastCheckedAt: checkedAt, lastError: "lookup_failed", providerRefundId: "re_stale", firstUncertaintyEvidence: "creation_timeout",
      terminalResult: "succeeded", status: "succeeded" });
    expect(row.leaseUntil).not.toBeNull();
  });
});

test("lookup failure and empty recovery checks preserve financial meaning", async () => {
  await isolated(async (runner, data) => {
    const identity = await dispatched(runner.manager, data);
    await executions.recordRefundUncertainty(runner.manager, { ...identity, evidence: "timeout", observedAt: new Date() });
    for (const lastError of ["lookup_failed", "not_found"]) {
      await executions.recordRefundExecutionCheck(runner.manager, { ...identity, checkedAt: new Date(), lastError, releaseLease: false });
      const [row] = await executions.listRefundExecutions(runner.manager, data.refundId);
      expect(row).toMatchObject({ status: "uncertain", terminalResult: null, firstUncertaintyEvidence: "timeout", lastError });
    }
  });
});

test.each(["provider", "providerPaymentId", "amountMinor", "currency"] as const)("allocation rejects obligation mismatch in %s", async field => {
  await isolated(async (runner, data) => {
    const request = { ...data.request,
      ...(field === "provider" ? { provider: "netopia" as const } : {}),
      ...(field === "providerPaymentId" ? { providerPaymentId: "pi_other" } : {}),
      ...(field === "amountMinor" ? { amountMinor: 1 } : {}),
      ...(field === "currency" ? { currency: "EUR" as const } : {}) };
    await expect(executions.allocateRefundExecution(runner.manager, request)).rejects.toBeInstanceOf(executions.RefundExecutionIntegrityError);
    expect(await executions.listRefundExecutions(runner.manager, data.refundId)).toEqual([]);
  });
});

test("scoped mutations reject cross-obligation execution identity", async () => {
  await isolated(async (runner, data) => {
    const identity = await dispatched(runner.manager, data), other = await fixture(runner.manager);
    await expect(executions.recordRefundProviderIdentity(runner.manager, { ...identity, refundId: other.refundId,
      providerRefundId: "re_wrong_owner", checkedAt: new Date() })).rejects.toThrow();
    expect((await executions.listRefundExecutions(runner.manager, data.refundId))[0].providerRefundId).toBeNull();
    expect(await executions.listRefundExecutions(runner.manager, other.refundId)).toEqual([]);
    await rejects(runner, () => runner.manager.getRepository(RefundExecutionEntity).insert({
      ...other.request, refundId: randomUUID(), executionNumber: 1,
    }), "23503");
  });
});

test("failed transaction leaves no partial execution or lease", async () => {
  const executionId = randomUUID();
  await expect(database.transaction(async manager => {
    const data = await fixture(manager);
    data.request.id = executionId;
    await ready(manager, data);
    await manager.query("SELECT 1/0");
  })).rejects.toMatchObject({ driverError: { code: "22012" } });
  expect(await database.getRepository(RefundExecutionEntity).findOneBy({ id: executionId })).toBeNull();
});

test("write methods require an explicit caller transaction", async () => {
  await expect(executions.lockRefundObligation(database.manager, randomUUID())).rejects.toBeInstanceOf(executions.RefundExecutionIntegrityError);
});

test.each(["anon", "authenticated"])("browser role %s cannot read or write execution data", async role => {
  await isolated(async (runner, data) => {
    await executions.allocateRefundExecution(runner.manager, data.request);
    await runner.query(`SET LOCAL ROLE ${role}`);
    for (const sql of ["SELECT * FROM public.refund_executions", "INSERT INTO public.refund_executions DEFAULT VALUES",
      "UPDATE public.refund_executions SET last_error='browser'", "DELETE FROM public.refund_executions", "TRUNCATE public.refund_executions"])
      await rejects(runner, () => runner.query(sql), "42501");
    await runner.query("RESET ROLE");
  });
});

test("concurrent allocators and claimers converge on one execution and one lease", async () => {
  const data = await database.transaction(fixture);
  try {
    const attempts = await Promise.all([0, 1].map(() => database.transaction(async manager => {
      const allocated = await executions.allocateRefundExecution(manager, { ...data.request, id: randomUUID(), idempotencyKey: randomUUID() });
      const claimed = await executions.claimRefundExecution(manager, { refundId: data.refundId, executionId: allocated.execution.id,
        token: randomUUID(), leaseUntil: new Date(Date.now() + 300_000) });
      return { ...allocated, claimed };
    })));
    expect(attempts.map(row => row.outcome).sort()).toEqual(["created", "existing"]);
    expect(new Set(attempts.map(row => row.execution.id)).size).toBe(1);
    expect(attempts.filter(row => row.claimed)).toHaveLength(1);
    expect(await executions.listRefundExecutions(database.manager, data.refundId)).toHaveLength(1);
  } finally {
    await database.transaction(async manager => {
      await cleanupBookingEvidence(manager, { bookingIds: [data.bookingId] });
      await manager.query("DELETE FROM public.court_reservations WHERE id=$1", [data.reservationId]);
      await manager.query("DELETE FROM public.courts WHERE id=$1", [data.courtId]);
      await manager.query("DELETE FROM public.locations WHERE id=$1", [data.locationId]);
    });
  }
});


type ProviderRefund = { id: string; amount: number; currency: string; payment_intent: string | undefined;
  status: string; metadata: Stripe.MetadataParam | undefined };
function providerRefund(params: Stripe.RefundCreateParams, status = "succeeded"): ProviderRefund {
  const metadata = params.metadata && typeof params.metadata === "object" ? params.metadata : undefined;
  return { id: `re_${metadata?.refund_execution_id}`, amount: params.amount ?? 0, currency: "ron",
    payment_intent: params.payment_intent, status, metadata };
}
beforeEach(() => {
  vi.restoreAllMocks(); create.mockReset(); list.mockReset(); retrieve.mockReset();
  list.mockImplementation(() => (async function* () {})());
  create.mockImplementation(async (params: Stripe.RefundCreateParams) => providerRefund(params));
});
async function committed(work: (data: Fixture) => Promise<void>) {
  const data = await database.transaction(fixture);
  try { await work(data); }
  finally {
    vi.restoreAllMocks();
    await database.transaction(async manager => {
      await cleanupBookingEvidence(manager, { bookingIds: [data.bookingId] });
      await manager.query("DELETE FROM public.court_reservations WHERE id=$1", [data.reservationId]);
      await manager.query("DELETE FROM public.courts WHERE id=$1", [data.courtId]);
      await manager.query("DELETE FROM public.locations WHERE id=$1", [data.locationId]);
    });
  }
}
async function expireExecutionLease(refundId: string) {
  await database.query("UPDATE public.refund_executions SET lease_until=clock_timestamp()-interval '1 microsecond' WHERE refund_id=$1 AND lease_token IS NOT NULL", [refundId]);
}

test("runtime commits execution identity, lease and dispatch before Stripe receives the exact stored key", async () => {
  await committed(async data => {
    create.mockImplementation(async (params: Stripe.RefundCreateParams, options: Stripe.RequestOptions) => {
      const [execution] = await executions.listRefundExecutions(database.manager, data.refundId);
      expect(execution).toMatchObject({ status: "pending", dispatchInitiatedAt: expect.any(Date), leaseToken: expect.any(String) });
      expect(params.metadata).toEqual({ payment_refund_id: data.refundId, refund_execution_id: execution.id });
      expect(options.idempotencyKey).toBe(execution.idempotencyKey);
      expect(params.amount).toBe(execution.amountMinor); expect(params.payment_intent).toBe(execution.providerPaymentId);
      return providerRefund(params);
    });
    expect(await processBookingRefund(data.refundId)).toBe("succeeded");
    expect(await processBookingRefund(data.refundId)).toBe("succeeded");
    expect(create).toHaveBeenCalledOnce();
    expect(await executions.listRefundExecutions(database.manager, data.refundId)).toHaveLength(1);
  });
});

test("timeout, failed discovery and empty recovery reuse one execution without another creation", async () => {
  await committed(async data => {
    let accepted: ProviderRefund | undefined;
    create.mockImplementationOnce(async (params: Stripe.RefundCreateParams) => {
      accepted=providerRefund(params); throw new Stripe.errors.StripeConnectionError({message:"timeout"});
    });
    expect(await processBookingRefund(data.refundId)).toBe("pending_retry");
    const [first] = await executions.listRefundExecutions(database.manager, data.refundId);
    expect(first).toMatchObject({status:"uncertain",firstUncertaintyEvidence:"uncertain",leaseToken:null});
    list.mockImplementationOnce(()=> (async function*(){throw new Stripe.errors.StripeInvalidRequestError({statusCode:400});})());
    expect(await processBookingRefund(data.refundId)).toBe("pending_retry");
    expect(await processBookingRefund(data.refundId)).toBe("pending_retry");
    expect(create).toHaveBeenCalledOnce();
    list.mockImplementationOnce(()=> (async function*(){if(accepted) yield accepted;})());
    expect(await processBookingRefund(data.refundId)).toBe("succeeded");
    const history=await executions.listRefundExecutions(database.manager,data.refundId);
    expect(history).toHaveLength(1);expect(history[0]).toMatchObject({id:first.id,idempotencyKey:first.idempotencyKey,
      terminalResult:"succeeded",firstUncertaintyEvidence:"uncertain"});
    expect(create).toHaveBeenCalledOnce();
  });
});

test("accepted pending identity survives retrieval failure and is retrieved to verified success", async () => {
  await committed(async data => {
    let accepted: ProviderRefund | undefined;
    create.mockImplementationOnce(async (params: Stripe.RefundCreateParams)=> {accepted=providerRefund(params,"pending");return accepted;});
    expect(await processBookingRefund(data.refundId)).toBe("pending");
    const [pending]=await executions.listRefundExecutions(database.manager,data.refundId);
    expect(pending).toMatchObject({status:"pending",terminalResult:null,providerRefundId:accepted?.id});
    retrieve.mockRejectedValueOnce(new Stripe.errors.StripeInvalidRequestError({statusCode:404}));
    expect(await processBookingRefund(data.refundId)).toBe("pending_retry");
    retrieve.mockResolvedValueOnce({...accepted,status:"succeeded"});
    expect(await processBookingRefund(data.refundId)).toBe("succeeded");
    expect(retrieve).toHaveBeenLastCalledWith(pending.providerRefundId);expect(create).toHaveBeenCalledOnce();
  });
});

test("identity mismatch retains the returned provider ID and cannot authorize another operation", async () => {
  await committed(async data => {
    let accepted: ProviderRefund | undefined;
    create.mockImplementationOnce(async (params: Stripe.RefundCreateParams)=> {accepted=providerRefund(params);return {...accepted,amount:1};});
    expect(await processBookingRefund(data.refundId)).toBe("pending_retry");
    const [execution]=await executions.listRefundExecutions(database.manager,data.refundId);
    expect(execution).toMatchObject({providerRefundId:accepted?.id,status:"uncertain",firstUncertaintyEvidence:"evidence_mismatch"});
    retrieve.mockResolvedValueOnce(accepted);
    expect(await processBookingRefund(data.refundId)).toBe("succeeded");
    expect(create).toHaveBeenCalledOnce();expect(retrieve).toHaveBeenCalledWith(execution.providerRefundId);
  });
});

test.each(["failed","rejected"] as const)("Admin retry after definitive %s creates a distinct execution/key and counts one obligation", async outcome => {
  await committed(async data => {
    const actorId=await ensureIntegrationAdminAnchor(localFixtureClient());
    if(outcome==="failed") create.mockImplementationOnce(async (params:Stripe.RefundCreateParams)=>providerRefund(params,"failed"));
    else create.mockRejectedValueOnce(new Stripe.errors.StripeInvalidRequestError({statusCode:400}));
    expect(await processBookingRefund(data.refundId)).toBe("failed");
    const [first]=await executions.listRefundExecutions(database.manager,data.refundId);
    expect(first.terminalResult).toBe(outcome);
    expect(await processBookingRefund(data.refundId)).toBe("failed"); // no automatic replacement policy
    const prepared=await prepareAdminRefund("retry",data.refundId,actorId);
    if(prepared.outcome!=="ready") throw new Error("Missing Admin execution claim");
    expect(prepared.claim.execution.id).not.toBe(first.id);
    expect(prepared.claim.execution.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(await processBookingRefund(data.refundId,prepared.claim)).toBe("succeeded");
    const history=await executions.listRefundExecutions(database.manager,data.refundId);
    expect(history).toHaveLength(2);expect(history[0]).toEqual(first);
    expect(await bookingFinancials(database.manager,data.bookingId)).toMatchObject({obligated:2500,refunded:2500});
    expect(await prepareAdminRefund("retry",data.refundId,actorId)).toEqual({outcome:"already_refunded"});
    expect(create).toHaveBeenCalledTimes(2);
  });
});

test("a crash between committed dispatch and HTTP leaves one unresolved execution and no creation on takeover", async () => {
  await committed(async data => {
    const prepared=await prepareAutomaticRefund(data.refundId);
    if(prepared.outcome!=="ready") throw new Error("Missing execution claim");
    await initiateRefundExecution(prepared.claim);
    await expireExecutionLease(data.refundId);
    expect(await processBookingRefund(data.refundId)).toBe("pending_retry");
    expect(create).not.toHaveBeenCalled();
    const history=await executions.listRefundExecutions(database.manager,data.refundId);
    expect(history).toHaveLength(1);expect(history[0]).toMatchObject({id:prepared.claim.execution.id,status:"uncertain",firstUncertaintyEvidence:"not_found"});
  });
});

test("provider acceptance followed by result-transaction failure recovers the same execution without creating again", async () => {
  await committed(async data => {
    let accepted:ProviderRefund|undefined;
    create.mockImplementationOnce(async(params:Stripe.RefundCreateParams)=> {accepted=providerRefund(params);return accepted;});
    const original=payments.writeRefundStatus;
    const injected=vi.spyOn(payments,"writeRefundStatus").mockImplementation(async(...args)=> {
      await original(...args);if(args[2]==="succeeded") throw new Error("result transaction failed");
    });
    expect(await processBookingRefund(data.refundId)).toBe("pending_retry");injected.mockRestore();
    const [execution]=await executions.listRefundExecutions(database.manager,data.refundId);
    expect(execution).toMatchObject({status:"pending",providerRefundId:null,terminalResult:null,leaseToken:expect.any(String)});
    await expireExecutionLease(data.refundId);
    list.mockImplementationOnce(()=> (async function*(){if(accepted) yield accepted;})());
    expect(await processBookingRefund(data.refundId)).toBe("succeeded");
    expect(create).toHaveBeenCalledOnce();
    expect(await executions.listRefundExecutions(database.manager,data.refundId)).toHaveLength(1);
  });
});
