import "server-only";
import { createDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { findRevision } from "@/lib/db/repositories/booking-revisions.repository";
import { PaymentRefundEntity } from "@/lib/db/entities/payment-refund.entity";
import * as recovery from "@/lib/db/repositories/notification-recovery.repository";
import { logger } from "@/lib/logger";
import { bookingNotification, type BookingEmailEvent } from "./booking-email";
import { enqueueBookingNotification } from "./booking-delivery";
import type { EntityManager } from "typeorm";

// Keep recovery waits bounded and separate from the delivery/application pool.
// Reuse the module's entity constructors; never run migrations or synchronize.
let connection: ReturnType<typeof createDataSource> | undefined;
let initialization: Promise<ReturnType<typeof createDataSource>> | undefined;
async function recoveryDataSource() {
  if (initialization) return initialization;
  if (connection?.isInitialized) return connection;
  const source = createDataSource().setOptions({ poolSize: 1,
    extra: { connectionTimeoutMillis: 500, statement_timeout: 500, lock_timeout: 250, query_timeout: 1000 } });
  connection = source;
  initialization = source.initialize().finally(() => { initialization = undefined; });
  return initialization;
}

const exceptionKinds = {
  cancellation_rejected: "cancellation_failed", modification_rejected: "modification_failed",
  refunded_modification_unapplied: "modification_failed", surcharge_unapplied: "modification_failed",
  late_capture: "late_payment_refund", refund_failed: "refund_incomplete",
  refund_unresolved: "refund_incomplete", refund_reversed: "refund_incomplete",
} as const satisfies Record<recovery.RecoveryExceptionKind, BookingEmailEvent["event_kind"]>;

// Translate committed outcomes; never reevaluate eligibility, refunds or pricing.
async function reconstruct(manager: EntityManager, candidate: recovery.NotificationRecoveryCandidate) {
  const revision = await findRevision(manager, candidate.revision_id);
  if (candidate.source === "exception") {
    const fact = await recovery.findRecoveryException(manager, candidate.key);
    if (!fact) throw new Error("Financial exception missing");
    const refund = fact.refund_id ? await manager.getRepository(PaymentRefundEntity).findOneByOrFail({ id: fact.refund_id }) : null;
    return bookingNotification(exceptionKinds[fact.kind], revision, {
      refundRequested: fact.kind === "surcharge_unapplied",
      ...(refund ? { refund: { amountMinor: refund.amountMinor, currency: refund.currency } } : {}),
    });
  }
  if (revision.kind === "cancelled") return bookingNotification(
    revision.cancellationCause === "admin_cancelled" ? "admin_cancelled" : "customer_cancelled", revision,
    revision.adjustmentId ? { refundStatus: "completed" } : {});
  if (revision.kind === "rescheduled") {
    if (!revision.previousRevisionId) throw new Error("Reschedule predecessor missing");
    const previous = await findRevision(manager, revision.previousRevisionId);
    return bookingNotification("customer_rescheduled", revision, { previous,
      ...(revision.adjustmentId && revision.totalAmountMinor < previous.totalAmountMinor ? { refundStatus: "completed" as const } : {}) });
  }
  // Provider actor scope alone cannot distinguish guest ownership.
  const booking = await manager.query("SELECT account_user_id FROM public.bookings WHERE id=$1", [revision.bookingId]);
  return bookingNotification("confirmed", revision, { guest: booking[0]?.account_user_id === null });
}

export async function recoverBookingNotifications(options: { limit?: number; deadline?: number } = {}) {
  const limit = Math.max(1, Math.min(100, options.limit ?? 100)), deadline = options.deadline ?? Date.now() + 8_000;
  let recovered = 0, failed = 0;
  if (Date.now() >= deadline) return { recovered, failed };
  const source = await recoveryDataSource();
  if (Date.now() >= deadline) return { recovered, failed };
  const candidates = await inTransaction(manager => recovery.listNotificationRecoveryCandidates(manager, limit), source);
  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    try {
      await inTransaction(async manager => {
        const existing = await recovery.lockNotificationProjection(manager, candidate.key);
        const event = await reconstruct(manager, candidate);
        if (!existing) await enqueueBookingNotification(manager, candidate.key, event, candidate.occurred_at);
        await recovery.repairNotificationInbox(manager, candidate.key, event.event_kind);
      }, source);
      recovered++;
    } catch {
      failed++;
      logger.error({ event: "booking_notifications.reconstruction_failed", eventKey: candidate.key },
        "Notification reconstruction failed; committed financial evidence remains available for retry");
    }
  }
  return { recovered, failed };
}
