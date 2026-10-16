import "server-only";

import type { EntityManager } from "typeorm";
import { PaymentRefundEntity } from "../entities/payment-refund.entity";
import { RefundExecutionEntity, type RefundExecutionTerminalResult } from "../entities/refund-execution.entity";

export class RefundExecutionIntegrityError extends Error {}
export class RefundExecutionFenceError extends Error {}

type ExecutionIdentity = { refundId: string; executionId: string };
type ClaimedExecution = ExecutionIdentity & { token: string };
type ExecutionRequest = Pick<RefundExecutionEntity,
  "id" | "refundId" | "provider" | "providerPaymentId" | "amountMinor" | "currency" |
  "idempotencyKey" | "initiatedByUserId" | "createdAt">;

function requireTransaction(manager: EntityManager) {
  if (!manager.queryRunner?.isTransactionActive)
    throw new RefundExecutionIntegrityError("Refund execution writes require a caller-owned transaction");
}

export async function loadRefundExecutionContext(manager: EntityManager, refundId: string) {
  const refund = await manager.getRepository(PaymentRefundEntity).findOneBy({ id: refundId });
  return refund ? { refund, executions: await listRefundExecutions(manager, refundId) } : null;
}

export function listRefundExecutions(manager: EntityManager, refundId: string) {
  return manager.getRepository(RefundExecutionEntity).find({ where: { refundId }, order: { executionNumber: "ASC" } });
}

// Caller acquires any earlier aggregate locks first. All execution mutations use
// the obligation FOR UPDATE before its execution; no provider call belongs here.
export async function lockRefundObligation(manager: EntityManager, refundId: string) {
  requireTransaction(manager);
  return manager.getRepository(PaymentRefundEntity).findOneOrFail({
    where: { id: refundId }, lock: { mode: "pessimistic_write" },
  });
}

export async function lockRefundExecution(manager: EntityManager, identity: ExecutionIdentity) {
  await lockRefundObligation(manager, identity.refundId);
  return manager.getRepository(RefundExecutionEntity).findOneOrFail({
    where: { id: identity.executionId, refundId: identity.refundId }, lock: { mode: "pessimistic_write" },
  });
}

export function findUnresolvedRefundExecution(manager: EntityManager, refundId: string) {
  return manager.getRepository(RefundExecutionEntity).createQueryBuilder("execution")
    .where("execution.refund_id = :refundId", { refundId })
    .andWhere("execution.status IN ('ready', 'pending', 'uncertain')").getOne();
}

// Services choose whether allocation is authorized. This method compares the
// request with locked obligation terms and serializes initial/replacement inserts.
export async function allocateRefundExecution(manager: EntityManager, request: ExecutionRequest): Promise<{
  outcome: "created" | "existing"; execution: RefundExecutionEntity;
}> {
  const refund = await lockRefundObligation(manager, request.refundId);
  if (request.provider !== refund.provider || request.providerPaymentId !== refund.providerPaymentId
    || request.amountMinor !== refund.amountMinor || request.currency !== refund.currency)
    throw new RefundExecutionIntegrityError("Execution request does not match the refund obligation");
  const latest = await manager.getRepository(RefundExecutionEntity).findOne({
    where: { refundId: request.refundId }, order: { executionNumber: "DESC" },
  });
  if (latest?.status === "succeeded")
    throw new RefundExecutionIntegrityError("Successful refund execution cannot be replaced");
  if (latest && latest.status !== "failed" && latest.status !== "rejected")
    return { outcome: "existing", execution: latest };
  const executionNumber = (latest?.executionNumber ?? 0) + 1;
  await manager.getRepository(RefundExecutionEntity).insert({ ...request, executionNumber, status: "ready", updatedAt: request.createdAt });
  return { outcome: "created", execution: await manager.getRepository(RefundExecutionEntity).findOneByOrFail({ id: request.id }) };
}

// Lease expiry only permits takeover of this exact row. It never allocates an
// execution or changes financial status. PostgreSQL retains deadline precision.
export async function claimRefundExecution(manager: EntityManager, input: ClaimedExecution & { leaseUntil: Date }) {
  await lockRefundExecution(manager, input);
  const result = await manager.getRepository(RefundExecutionEntity).createQueryBuilder().update()
    .set({ leaseToken: input.token, leaseUntil: input.leaseUntil, updatedAt: () => "now()" })
    .where("id = :id AND refund_id = :refundId", { id: input.executionId, refundId: input.refundId })
    .andWhere("status IN ('ready', 'pending', 'uncertain')")
    .andWhere("(lease_token IS NULL OR lease_until <= clock_timestamp() OR lease_token = :token)", { token: input.token })
    .andWhere(":until::timestamptz > clock_timestamp()", { until: input.leaseUntil }).execute();
  return result.affected === 1;
}

export async function recordRefundDispatch(manager: EntityManager, input: ClaimedExecution & { initiatedAt: Date }) {
  await lockRefundExecution(manager, input);
  const result = await manager.getRepository(RefundExecutionEntity).createQueryBuilder().update()
    .set({ dispatchInitiatedAt: input.initiatedAt, status: "pending", updatedAt: () => "now()" })
    .where("id = :id AND refund_id = :refundId AND lease_token = :token", {
      id: input.executionId, refundId: input.refundId, token: input.token,
    })
    .andWhere("status = 'ready' AND dispatch_initiated_at IS NULL AND lease_until > clock_timestamp()").execute();
  if (result.affected !== 1) throw new RefundExecutionFenceError("Execution dispatch already initiated or lease changed");
}

function verifyProviderIdentity(execution: RefundExecutionEntity, providerRefundId: string) {
  if (execution.providerRefundId && execution.providerRefundId !== providerRefundId)
    throw new RefundExecutionIntegrityError("Conflicting provider refund identity");
  if (execution.terminalResult === "rejected")
    throw new RefundExecutionIntegrityError("Rejected execution cannot acquire a provider refund identity");
}

// Provider facts survive stale worker tokens. The token controls only operational
// updates; established evidence is never cleared or replaced by a later check.
export async function recordRefundProviderIdentity(manager: EntityManager, input: ClaimedExecution & {
  providerRefundId: string; checkedAt: Date;
}) {
  const execution = await lockRefundExecution(manager, input);
  verifyProviderIdentity(execution, input.providerRefundId);
  const current = execution.leaseToken === input.token;
  await manager.getRepository(RefundExecutionEntity).update(execution.id, {
    providerRefundId: execution.providerRefundId ?? input.providerRefundId,
    ...(current ? { lastCheckedAt: input.checkedAt, lastError: null,
      ...(!execution.terminalResult ? { status: "pending" as const } : {}) } : {}),
    updatedAt: () => "now()",
  });
  return current ? "recorded" : "stale";
}

export async function recordRefundUncertainty(manager: EntityManager, input: ClaimedExecution & {
  evidence: string; observedAt: Date;
}) {
  const execution = await lockRefundExecution(manager, input);
  const current = execution.leaseToken === input.token;
  await manager.getRepository(RefundExecutionEntity).update(execution.id, {
    ...(!execution.firstUncertainAt ? {
      firstUncertainAt: input.observedAt, firstUncertaintyEvidence: input.evidence,
    } : {}),
    ...(current && !execution.terminalResult ? {
      status: "uncertain" as const, lastCheckedAt: input.observedAt, lastError: input.evidence,
    } : {}),
    updatedAt: () => "now()",
  });
  return current ? "recorded" : "stale";
}

type TerminalEvidence = { result: "succeeded" | "failed"; providerRefundId: string }
  | { result: "rejected"; providerRefundId: null };

export async function recordRefundTerminalResult(manager: EntityManager, input: ClaimedExecution & TerminalEvidence & {
  evidence: string; completedAt: Date;
}) {
  const execution = await lockRefundExecution(manager, input);
  if (execution.terminalResult && execution.terminalResult !== input.result)
    throw new RefundExecutionIntegrityError("Conflicting terminal refund evidence");
  if (input.providerRefundId) verifyProviderIdentity(execution, input.providerRefundId);
  else if (execution.providerRefundId)
    throw new RefundExecutionIntegrityError("An established provider operation cannot be rejected");
  const current = execution.leaseToken === input.token;
  const terminalResult: RefundExecutionTerminalResult = execution.terminalResult ?? input.result;
  // Terminal status must agree with the verified fact even for a stale observer.
  // That observer cannot clear a newer lease or replace its check/error fields.
  await manager.getRepository(RefundExecutionEntity).update(execution.id, {
    providerRefundId: execution.providerRefundId ?? input.providerRefundId,
    ...(!execution.terminalResult ? {
      terminalResult, terminalEvidence: input.evidence, completedAt: input.completedAt,
    } : {}),
    status: terminalResult,
    ...(current ? { leaseToken: null, leaseUntil: null, lastCheckedAt: input.completedAt,
      lastError: terminalResult === "succeeded" ? null : input.evidence } : {}),
    updatedAt: () => "now()",
  });
  return current ? "recorded" : "stale";
}

// Lookup failures/not-found are operational checks, not terminal financial facts.
// A current token can finish even after expiry until another worker takes over.
export async function recordRefundExecutionCheck(manager: EntityManager, input: ClaimedExecution & {
  checkedAt: Date; lastError: string | null; releaseLease: boolean;
}) {
  await lockRefundExecution(manager, input);
  const result = await manager.getRepository(RefundExecutionEntity).createQueryBuilder().update()
    .set({ lastCheckedAt: input.checkedAt, lastError: input.lastError, updatedAt: () => "now()",
      ...(input.releaseLease ? { leaseToken: null, leaseUntil: null } : {}) })
    .where("id = :id AND refund_id = :refundId AND lease_token = :token", {
      id: input.executionId, refundId: input.refundId, token: input.token,
    }).execute();
  if (result.affected !== 1) throw new RefundExecutionFenceError("Stale refund execution lease");
}

export function ownsRefundExecutionLease(manager: EntityManager, input: ClaimedExecution) {
  return manager.getRepository(RefundExecutionEntity).createQueryBuilder("execution")
    .where("id=:id AND refund_id=:refundId AND lease_token=:token AND lease_until > clock_timestamp()", {
      id: input.executionId, refundId: input.refundId, token: input.token,
    }).getExists();
}

// A terminal execution keeps its write-once evidence; only the writable check
// fields record a later provider reversal of a succeeded refund.
export async function recordRefundReversal(manager: EntityManager, input: ExecutionIdentity & { lastError: string; checkedAt: Date }) {
  await lockRefundExecution(manager, input);
  const result = await manager.getRepository(RefundExecutionEntity).createQueryBuilder().update()
    .set({ lastError: input.lastError, lastCheckedAt: input.checkedAt, updatedAt: () => "now()" })
    .where("id = :id AND refund_id = :refundId AND terminal_result = 'succeeded'", { id: input.executionId, refundId: input.refundId })
    .execute();
  if (result.affected !== 1) throw new RefundExecutionIntegrityError("Only a succeeded refund execution can be reversed");
}
