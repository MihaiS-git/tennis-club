import type { EntityManager } from "typeorm";
import { expect, test } from "vitest";
import { loadAdminTransactionContext } from "@/lib/db/repositories/payments.repository";

// A transaction-bound manager owns one PostgreSQL connection; overlapping queries on it
// trigger pg's concurrent-query deprecation and must never be issued.
test("financial context reads run one at a time on the supplied manager", async () => {
  let inFlight = 0, maxInFlight = 0;
  const order: string[] = [];
  const read = (name: string, rows: unknown[]) => async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); order.push(name);
    await new Promise(resolve => setTimeout(resolve, 1));
    inFlight--; return rows;
  };
  const builder = (name: string, rows: unknown[]) => {
    const chain = { innerJoin: () => chain, where: () => chain, orderBy: () => chain, addOrderBy: () => chain, getMany: read(name, rows) };
    return chain;
  };
  const refund = { id: "refund-1", bookingId: "booking-1" };
  const repositories: Record<string, { findBy?: () => Promise<unknown[]>; createQueryBuilder?: () => unknown }> = {
    BookingRevisionEntity: { findBy: read("revisions", [{ id: "revision-1" }]) },
    BookingAdjustmentEntity: { findBy: read("adjustments", [{ id: "adjustment-1" }]) },
    PaymentAttemptEntity: { findBy: read("payments", [{ id: "attempt-1" }]) },
    PaymentRefundEntity: { findBy: read("refunds", [refund]) },
    PaymentCaptureReceiptEntity: { createQueryBuilder: () => builder("captures", [{ id: "capture-1" }]) },
    RefundExecutionEntity: { createQueryBuilder: () => builder("executions", [{ refundId: "refund-1", providerRefundId: "re_1" }]) },
  };
  const manager = { getRepository: (entity: { name: string }) => repositories[entity.name] } as unknown as EntityManager;

  const result = await loadAdminTransactionContext(manager, { bookingIds: ["booking-1"], revisionIds: ["revision-1"],
    adjustmentIds: ["adjustment-1"] });
  expect(maxInFlight).toBe(1);
  expect(order).toEqual(["revisions", "adjustments", "payments", "refunds", "captures", "executions"]);
  expect(result).toEqual({ revisions: [{ id: "revision-1" }], adjustments: [{ id: "adjustment-1" }], payments: [{ id: "attempt-1" }],
    captures: [{ id: "capture-1" }], executions: [{ refundId: "refund-1", providerRefundId: "re_1" }],
    refunds: [{ ...refund, providerRefundId: "re_1" }] });
});
