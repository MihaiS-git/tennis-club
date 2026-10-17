import "server-only";
import { randomUUID } from "node:crypto";
import { buildBookingRevision } from "@/lib/bookings/revision";
import { advanceRevision, findInitialRevision } from "@/lib/db/repositories/booking-revisions.repository";
import { z } from "zod";
import { inTransaction } from "@/lib/db/transaction";
import { getDataSource } from "@/lib/db/data-source";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import { listCheckoutPricing } from "@/lib/db/repositories/pricing.repository";
import { buildCourtDay } from "@/lib/courts/calendar";
import { getCalendarSelection } from "@/lib/courts/interval-selection";
import { localToday, localMinute } from "@/lib/courts/local-time";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { lockLocations } from "@/lib/db/repositories/clubs.repository";
import { hasOccupancyConflict } from "@/lib/reservations/occupancy";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as captures from "@/lib/db/repositories/payment-capture-receipts.repository";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { deliverPendingBookingNotifications, enqueueBookingNotification } from "@/lib/notifications/booking-delivery";
import { bookingNotification, type BookingEmailEvent } from "@/lib/notifications/booking-email";
import { logger } from "@/lib/logger";
import { paymentProviderSchema, paymentTransition } from "./domain";
import type { OnlinePaymentEvent } from "./providers/types";
import { settleAdjustment } from "./settle-adjustment";
import { allocateBookingRefund } from "./financials";
import { processBookingRefund } from "./refunds";
import { onlinePaymentAdapter } from "./providers";

const settlementSchema = z.strictObject({ attemptId: z.uuid(), provider: paymentProviderSchema,
  providerPaymentId: z.string().trim().min(1).max(255),
  outcome: z.enum(["succeeded", "failed", "retryable_failed", "cancelled"]) });
type Settlement = z.infer<typeof settlementSchema>;

function replay(receipt: payments.ProviderReceipt, event: OnlinePaymentEvent) {
  if (receipt.attempt_id !== event.attemptId || receipt.provider_payment_id !== event.providerPaymentId
    || receipt.outcome !== event.outcome || receipt.amount_minor !== event.amountMinor
    || receipt.currency.toUpperCase() !== event.currency.toUpperCase()
    || receipt.provider_capture_id !== (event.outcome === "succeeded" ? event.providerCaptureId ?? null : null))
    throw new Error("Changed payment event evidence.");
  return receipt.settlement_result;
}
// Throw through inTransaction so even an identical insert-race winner never
// commits provisional lifecycle writes from the losing transaction.
class ReceiptRaceReplay extends Error {
  constructor(readonly result: payments.ProviderReceipt["settlement_result"]) { super("Payment event already committed."); }
}

class SettlementParentChanged extends Error {}

async function commitSettlement(value: Settlement, event: OnlinePaymentEvent | null, parentAttempt = 0): Promise<string> {
  let notification: BookingEmailEvent | null = null;
  let refundId: string | null = null;
  let adjustmentRefundIds: string[] = [];
  const abandon: { attempt: { id: string; provider: "stripe" | "netopia"; providerPaymentId: string } | null } = { attempt: null };
  try {
    const committed = await inTransaction(async manager => {
      await clubs.lockConfigurationForRead(manager);
      const parent = await payments.discoverSettlementParent(manager, value.attemptId);
      if (!parent) return { result: "unavailable", reconciliation: false };
      // Occupancy mutex precedes every booking/reservation/attempt lock. A hold
      // cannot become active while a replacement is checking expired occupancy.
      const [location] = await lockLocations(manager, [parent.location_id]);
      if (!location) return { result: "unavailable", reconciliation: false };
      const b = await bookings.findBookingForUpdate(manager, parent.booking_id);
      if (!b) return { result: "unavailable", reconciliation: false };
      const r = await reservations.findReservationForUpdate(manager, b.reservation_id);
      const attempt = await payments.lockSettlementAttempt(manager, value.attemptId);
      if (!r || !attempt || attempt.booking_id !== b.id || attempt.method !== "online" || attempt.provider !== value.provider
        || (event ? attempt.provider_payment_id !== value.providerPaymentId
          : attempt.provider_payment_id !== null && attempt.provider_payment_id !== value.providerPaymentId))
        return { result: "unavailable", reconciliation: false };
      if (value.outcome === "succeeded" && !event?.providerCaptureId)
        throw new Error("Successful online settlement requires verified capture evidence.");
      const resourceFacts = await reservations.findReservationResourceFacts(manager, r.court_id);
      if (b.reservation_id !== parent.reservation_id || resourceFacts?.location_id !== parent.location_id)
        throw new SettlementParentChanged();
      const capture = event?.outcome === "succeeded" ? await captures.recordCaptureReceipt(manager, {
        payment_attempt_id: attempt.id, provider: event.provider, provider_payment_id: event.providerPaymentId,
        provider_capture_id: event.providerCaptureId!, amount_minor: event.amountMinor,
        currency: z.enum(["EUR", "USD", "GBP", "RON", "CHF"]).parse(event.currency.toUpperCase()),
      }) : null;
      if (event) {
        const duplicate = await payments.findProviderEventReceipt(manager, event.provider, event.eventId);
        if (duplicate) return { result: replay(duplicate, event), reconciliation: false };
      }
      const mismatch = event && (event.amountMinor !== attempt.amount_minor || event.currency.toUpperCase() !== attempt.currency.toUpperCase());
      if (attempt.adjustment_id) {
        const adjusted = await settleAdjustment(manager, { attempt, event, outcome: value.outcome,
          providerPaymentId: value.providerPaymentId, mismatch: Boolean(mismatch) });
        notification = adjusted.notification;
        if (notification && notification.event_kind !== "customer_rescheduled")
          await enqueueBookingNotification(manager, `payment:${attempt.id}:${notification.event_kind}`, notification);
        adjustmentRefundIds = adjusted.refundIds;
        if (adjusted.abandonProviderPayment && attempt.provider)
          abandon.attempt = { id: attempt.id, provider: attempt.provider, providerPaymentId: value.providerPaymentId };
        const reconciliation = value.outcome === "succeeded" && adjusted.result !== "succeeded";
        if (event && !await payments.insertProviderEventReceipt(manager, {
          provider: event.provider, event_id: event.eventId, attempt_id: attempt.id,
          capture_receipt_id: capture?.id ?? null, provider_capture_id: capture?.provider_capture_id ?? null,
          provider_payment_id: event.providerPaymentId, outcome: event.outcome, amount_minor: event.amountMinor,
          currency: event.currency.toUpperCase(), settlement_result: adjusted.result, reconciliation_required: reconciliation,
        })) {
          const winner = await payments.findProviderEventReceipt(manager, event.provider, event.eventId);
          if (!winner) throw new Error("Unable to read committed payment event");
          throw new ReceiptRaceReplay(replay(winner, event));
        }
        return { result: adjusted.result, reconciliation };
      }
      const decide = async () => {
        if (mismatch) return { result: "amount_mismatch", targets: null, deadline: null };
        const transition = paymentTransition({ attemptStatus: attempt.status, bookingStatus: b.status, reservationStatus: r.status,
          reservationExpiry: r.hold_expires_at, attemptExpiry: attempt.expires_at,
          now: await reservations.readReservationClockTime(manager), outcome: value.outcome });
        if (transition.targets?.reservation === "active") {
          // Pending holds are quotes, not confirmed contracts. Revalidate the
          // playing-date policy under the shared configuration fence before capture settlement.
          const courts = await clubs.listCheckoutLocationCourts(manager, location.id);
          const court = courts.find((c) => c.id === r.court_id);
          const hours = await reservations.listReservationOpeningHours(manager, location.id, r.booking_date);
          const prices = await listCheckoutPricing(manager, r.court_id, mondayWeekday(r.booking_date), r.booking_date);
          const coverage = await clubs.listCheckoutCourtCoverage(manager, r.court_id, r.booking_date);
          const now = new Date(await reservations.readReservationClockTime(manager));
          const day = buildCourtDay({ date: r.booking_date, today: localToday(location.timezone, now), currentMinute: localMinute(location.timezone, now),
            courts: court ? [{ id: court.id, name: court.name, slug: court.slug, surface: court.surface,
              environment: court.environment, has_lighting: court.hasLighting }] : [], hours,
            coverage: coverage.map((c) => ({ id: c.id, court_id: c.courtId, starts_on: c.startsOn, ends_on: c.endsOn,
              created_at: c.createdAt.toISOString(), updated_at: c.updatedAt.toISOString() })),
            pricing: prices.map((p) => ({ id: p.id, rule_set_id: p.ruleSetId, location_id: p.locationId, court_id: p.courtId,
              court_state: p.courtState, weekday: p.weekday, starts_at_minute: p.startsAtMinute, ends_at_minute: p.endsAtMinute,
              starts_on: p.startsOn, ends_on: p.endsOn, price_per_hour_minor: p.pricePerHourMinor,
              created_at: p.createdAt.toISOString(), updated_at: p.updatedAt.toISOString() })), reservations: [] });
          const target = day.courts[0];
          const quote = target && getCalendarSelection({ courtId: r.court_id, times: day.times, cells: target.cells,
            hourlyPrices: target.hourlyPrices }, day.times.indexOf(r.starts_at_minute), day.times.indexOf(r.ends_at_minute - 30) + 1);
          if (!location.isActive || location.archivedAt || !location.isPublic || !quote || quote.endMinute !== r.ends_at_minute
            || quote.priceMinor !== b.total_amount_minor || location.currency !== b.currency
            || location.customerCancellationNoticeMinutes !== b.cancellation_notice_minutes || location.timezone !== b.revision.timezone) {
            // Existing expiry/reconciliation handling refunds a late captured Stripe payment.
            return { result: "expired", targets: { attempt: "expired", booking: "expired", reservation: "released" }, deadline: null };
          }
        }
        if (transition.targets?.reservation === "active" && await hasOccupancyConflict(manager, {
          courtId: r.court_id, date: r.booking_date, startMinute: r.starts_at_minute, endMinute: r.ends_at_minute,
        }, location.id, r.id)) return { result: "unavailable", targets: null, deadline: null };
        return transition;
      };
      let decision = await decide();
      // Re-read after all preceding reads. The UPDATE also fences the exact
      // deadline at the write statement; a crossed boundary is re-evaluated in TS.
      if (decision.targets) {
        decision = await decide();
        if (decision.targets && !await payments.updateSettlementAttempt(manager, attempt.id, {
          status: decision.targets.attempt, providerPaymentId: value.providerPaymentId, deadline: decision.deadline,
        })) {
          decision = await decide();
          if (!decision.targets || decision.deadline !== null) throw new Error("Payment deadline changed unexpectedly.");
          await payments.updateSettlementAttempt(manager, attempt.id, {
            status: decision.targets.attempt, providerPaymentId: value.providerPaymentId, deadline: null,
          });
        }
        if (decision.targets) {
          if (decision.targets.booking === "confirmed") {
            const revision = buildBookingRevision(b.revision, { id: randomUUID(), bookingId: b.id, kind: "confirmed",
              bookingState: "confirmed", operationKey: "confirmation", intentHash: "confirmation", actorUserId: null,
              actorScope: "provider", recordedAt: new Date(await reservations.readReservationClockTime(manager)),
              adjustmentId: null, cancellationCause: null }, b.revision);
            await advanceRevision(manager, { revision, previousId: b.current_revision_id, status: "confirmed" });
            notification = bookingNotification("confirmed", revision, { guest: b.account_user_id === null });
            await enqueueBookingNotification(manager, `revision:${revision.id}`, notification);
          } else {
            await bookings.updateSettlementBookingStatus(manager, b.id,
              z.enum(["confirmed", "cancelled", "pending_payment", "failed", "expired"]).parse(decision.targets.booking));
          }
          await reservations.updateSettlementReservationStatus(manager, r.id, decision.targets.reservation);
        }
      }
      const reconciliation = event?.outcome === "succeeded" && decision.result !== "succeeded";
      if (event) {
        const inserted = await payments.insertProviderEventReceipt(manager, {
          provider: event.provider, event_id: event.eventId, attempt_id: attempt.id,
          capture_receipt_id: capture?.id ?? null, provider_capture_id: capture?.provider_capture_id ?? null,
          provider_payment_id: event.providerPaymentId, outcome: event.outcome, amount_minor: event.amountMinor,
          currency: event.currency.toUpperCase(), settlement_result: z.enum([
            "succeeded", "pending", "failed", "cancelled", "expired", "unavailable", "amount_mismatch",
          ]).parse(decision.result), reconciliation_required: reconciliation,
        });
        if (!inserted) {
          // Separate READ COMMITTED statement sees the committed PK winner.
          const winner = await payments.findProviderEventReceipt(manager, event.provider, event.eventId);
          if (!winner) throw new Error("Unable to read committed payment event.");
          throw new ReceiptRaceReplay(replay(winner, event));
        }
      }
      // A capture whose checkout already ended (expiry, failure or explicit
      // cancellation, including expiry during this settlement) never reclaims
      // occupancy: its full refund obligation commits with the receipt, so a
      // late success is compensated without any later sweep. Normal booking
      // cancellation already allocates its remaining funds atomically.
      const checkoutEnded = b.status === "cancelled" || b.status === "expired" || b.status === "failed"
        || decision.targets?.booking === "expired";
      if (checkoutEnded && (r.status === "held" || r.status === "released")
        && value.outcome === "succeeded" && !mismatch
        && (event || attempt.status === "succeeded" || decision.targets?.attempt === "succeeded")
        && attempt.provider === "stripe") {
        // A known capture may already have been refunded by checkout abandonment.
        // Re-observation processes that obligation without changing its origin.
        const existing = await payments.findAndLockRefundByBooking(manager, b.id, attempt.id);
        refundId = existing?.id ?? null;
        if (!existing) {
          const amountMinor = event?.amountMinor ?? attempt.amount_minor;
          refundId = (await allocateBookingRefund(manager, { bookingId: b.id, actorId: null,
            operationKey: "cancellation", amount: amountMinor, onlyAttemptId: attempt.id,
            reason: "late_capture_compensation", contextRevisionId: (await findInitialRevision(manager, b.id)).id }))[0] ?? null;
          if (refundId) await enqueueBookingNotification(manager, `refund:${refundId}:late_payment`,
            bookingNotification("late_payment_refund", b.revision, { refund: { amountMinor, currency: attempt.currency } }));
        }
      }
      return { result: decision.result, reconciliation };
    });
    if (refundId) await processBookingRefund(refundId);
    for (const id of adjustmentRefundIds) await processBookingRefund(id);
    if (abandon.attempt) {
      // Best effort: a discarded modification's failed intent must not be
      // confirmable later. A late success would still be refunded.
      const abandoned = abandon.attempt;
      try { await (await onlinePaymentAdapter(abandoned.provider)).dismissPayment(abandoned); }
      catch { logger.error({ event: "payments.adjustment_intent_cancel_failed", attemptId: abandoned.id }, "Unable to cancel discarded modification payment"); }
    }
    if (committed.reconciliation) logger.error({ event: "payments.reconciliation_required", attemptId: value.attemptId,
      eventId: event?.eventId, result: committed.result }, "Successful payment requires reconciliation");
    await deliverPendingBookingNotifications();
    return committed.result;
  } catch (error) {
    if (error instanceof SettlementParentChanged && parentAttempt < 2) return commitSettlement(value, event, parentAttempt + 1);
    if (error instanceof ReceiptRaceReplay) return error.result;
    const databaseError = z.object({ code: z.string() }).safeParse(error);
    logger.error({ event: "payments.commit_failed", attemptId: value.attemptId,
      code: databaseError.success ? databaseError.data.code : undefined }, "Payment persistence failed");
    throw error;
  }
}
export async function settleOnlinePayment(input: unknown) {
  return commitSettlement(settlementSchema.parse(input), null);
}
// strict (signed webhook): a compensation refund this settlement owes must be
// processed, or the error reaches Stripe so it redelivers the event. A replayed
// receipt still re-drives that refund, so a redelivery is never a silent no-op.
export async function processOnlinePaymentEvent(input: OnlinePaymentEvent, options: { strict?: boolean } = {}) {
  const value = settlementSchema.extend({ eventId: z.string().min(1).max(255),
    amountMinor: z.number().int().nonnegative(), currency: z.string().length(3),
    providerCaptureId: z.string().trim().min(1).max(255).optional() }).transform(event => ({
      ...event,
      // Each Stripe PaymentIntent has at most one (full) successful capture;
      // normalize both signed webhooks and verified API reads to that identity.
      providerCaptureId: event.outcome === "succeeded" ? event.providerCaptureId ?? event.providerPaymentId : undefined,
    })).parse(input);
  const result = await commitSettlement(settlementSchema.parse({ attemptId: value.attemptId, provider: value.provider,
    providerPaymentId: value.providerPaymentId, outcome: value.outcome }), value);
  if (options.strict) {
    const outstanding = await payments.listOutstandingCompensationRefunds((await getDataSource()).manager, value.attemptId);
    for (const id of outstanding) await processBookingRefund(id, { strict: true });
  }
  return result;
}
