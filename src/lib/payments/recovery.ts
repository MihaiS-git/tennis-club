import "server-only";

import { deliverPendingBookingNotifications } from "@/lib/notifications/booking-delivery";
import { getDataSource } from "@/lib/db/data-source";
import { listDecidableRefundAdjustments, findAdjustment } from "@/lib/db/repositories/booking-adjustments.repository";
import * as payments from "@/lib/db/repositories/payments.repository";
import { refundBackedAdjustment } from "@/lib/bookings/domain";
import { resolveRefundBackedAdjustment } from "@/lib/bookings/commands";
import { logger } from "@/lib/logger";
import { onlinePaymentAdapter } from "./providers";
import { expirePaymentHolds, extendLiveAdjustmentHold } from "./hold-expiry";
import { processOnlinePaymentEvent } from "./service";
import { processBookingRefund } from "./refunds";
import { prepareLateCaptureCompensation } from "./refund-commands";

// Durable recovery for when no customer, Admin or webhook drives a financial
// outcome. Every step reuses the existing locked commands: settlement and its
// receipt dedupe, refund executions with leases and stable idempotency keys, and
// transition-guarded booking changes. Work items are independent; one failure
// never blocks the rest of a run, and the next run retries it. Runs outside any
// request, so no path revalidation: every affected page reads at request time.

const minuteMs = 60_000;
const batch = { payments: 50, events: 25, refunds: 25, refundScan: 200, adjustments: 25 };

// Bounded backoff from when the outcome first became uncertain: about a quarter
// of its age, between one minute and one hour.
export function refundRecoveryDue(candidate: {
  created_at: string; dispatch_initiated_at: string | null; first_uncertain_at: string | null; last_checked_at: string | null;
}, now = Date.now()) {
  if (!candidate.last_checked_at) return true;
  const since = Date.parse(candidate.first_uncertain_at ?? candidate.dispatch_initiated_at ?? candidate.created_at);
  const delay = Math.min(60 * minuteMs, Math.max(minuteMs, (now - since) / 4));
  return now - Date.parse(candidate.last_checked_at) >= delay;
}

type Step = { checked: number; failed: number };
async function each<T>(items: readonly T[], name: string, deadline: number, work: (item: T) => Promise<void>): Promise<Step> {
  const step = { checked: 0, failed: 0 };
  for (const item of items) {
    if (Date.now() > deadline) break;
    step.checked++;
    try { await work(item); }
    catch {
      step.failed++;
      logger.warn({ event: "payments.recovery_item_deferred", step: name }, "Recovery item deferred to the next run");
    }
  }
  return step;
}

// Provider evidence decides an unrecorded payment outcome. Open checkouts are
// only observed (a missing webhook must not cost a timely payment); requests
// that already ended locally are closed at Stripe unless a payment is in flight.
async function reconcilePayment(candidate: Awaited<ReturnType<typeof payments.listPaymentsToReconcile>>[number]) {
  const adapter = await onlinePaymentAdapter(candidate.provider);
  const reference = { id: candidate.id, providerPaymentId: candidate.provider_payment_id };
  const observe = async () => {
    const evidence = await adapter.readPayment(reference);
    if (evidence.status === "succeeded" || evidence.status === "cancelled") {
      await processOnlinePaymentEvent({ attemptId: candidate.id, provider: candidate.provider,
        providerPaymentId: candidate.provider_payment_id, eventId: `checkout-observation-${candidate.id}-${evidence.status}`,
        outcome: evidence.status, amountMinor: evidence.amountMinor, currency: evidence.currency,
        ...(evidence.providerCaptureId ? { providerCaptureId: evidence.providerCaptureId } : {}) });
      return "settled" as const;
    }
    if (evidence.live && candidate.adjustment_id) await extendLiveAdjustmentHold(candidate.id, candidate.provider_payment_id);
    return evidence.live ? "live" as const : "open" as const;
  };
  const observed = await observe();
  if (observed !== "open" || candidate.status === "pending") return;
  // Ended locally but still confirmable at Stripe: cancel it, then record the
  // provider's answer (a racing success is settled and refunded, never applied).
  const dismissed = await adapter.dismissPayment(reference);
  if (dismissed !== "live") await observe();
}

async function recoverRefund(id: string) {
  await processBookingRefund(id);
}

async function compensateLateCapture(event: { provider: string; event_id: string }) {
  if (event.provider !== "stripe") return;
  const refundId = await prepareLateCaptureCompensation(event.event_id);
  if (refundId) await processBookingRefund(refundId);
}

async function decideAdjustment(id: string) {
  const adjustment = await findAdjustment((await getDataSource()).manager, id);
  if (!adjustment || adjustment.status !== "pending" || !refundBackedAdjustment(adjustment)) return;
  await resolveRefundBackedAdjustment(id);
}

export type RecoveryRunSummary = Record<"payments" | "holds" | "lateCaptures" | "refunds" | "changes" | "notifications", Step | number>;

export async function runPaymentRecovery(options: { budgetMs?: number } = {}): Promise<RecoveryRunSummary> {
  const deadline = Date.now() + (options.budgetMs ?? 4 * minuteMs);
  const manager = (await getDataSource()).manager;
  // Drain previously committed email first with its own bounded share of the run,
  // so prolonged financial/provider recovery cannot starve customer notifications.
  const notifications = await deliverPendingBookingNotifications(Math.min(deadline, Date.now() + 30_000));
  // 1. Observe payments before expiry so a timely success with a lost webhook confirms.
  const paymentsStep = await each(await payments.listPaymentsToReconcile(manager, batch.payments), "payments", deadline, reconcilePayment);
  // 2. Release expired checkout and modification holds (existing location-first sweep).
  let holds = 0;
  try { holds = await expirePaymentHolds(); }
  catch { logger.warn({ event: "payments.recovery_hold_expiry_deferred" }, "Hold expiry deferred to the next run"); }
  // 3. Exact captures that arrived after their request ended are returned.
  const lateCaptures = await each(await payments.listUnresolvedCaptureEvents(manager, batch.events), "late_captures", deadline, compensateLateCapture);
  // 4. Unresolved refund obligations: never-dispatched, uncertain, or provider-pending.
  const now = Date.now();
  const due = (await payments.listUnresolvedRefunds(manager, batch.refundScan))
    .filter(candidate => refundRecoveryDue(candidate, now)).slice(0, batch.refunds).map(candidate => candidate.id);
  const refunds = await each(due, "refunds", deadline, recoverRefund);
  // 5. Completed changes and unreported financial exceptions (crash catch-up).
  const changes = await each(await listDecidableRefundAdjustments(manager, batch.adjustments), "changes", deadline, decideAdjustment);
  return { payments: paymentsStep, holds, lateCaptures, refunds, changes, notifications };
}
