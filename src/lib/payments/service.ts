import "server-only";
import { z } from "zod";
import { inTransaction } from "@/lib/db/transaction";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import { listCheckoutPricing } from "@/lib/db/repositories/pricing.repository";
import { buildCourtDay } from "@/lib/courts/calendar";
import { getCalendarSelection } from "@/lib/courts/interval-selection";
import { localToday, localMinute } from "@/lib/courts/local-time";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { lockLocations } from "@/lib/db/repositories/clubs.repository";
import { hasOccupancyConflict } from "@/lib/reservations/occupancy";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { bookingNotification, sendBookingNotification, type BookingEmailEvent } from "@/lib/notifications/booking-email";
import { logger } from "@/lib/logger";
import { paymentProviderSchema, paymentTransition } from "./domain";
import type { OnlinePaymentEvent } from "./providers/types";
import { settleAdjustment } from "./booking-adjustments";
import { processBookingRefund } from "./refunds";

const settlementSchema = z.strictObject({ attemptId: z.uuid(), provider: paymentProviderSchema,
  providerPaymentId: z.string().trim().min(1).max(255),
  outcome: z.enum(["succeeded", "failed", "retryable_failed", "cancelled"]) });
type Settlement = z.infer<typeof settlementSchema>;

function replay(receipt: payments.ProviderReceipt, event: OnlinePaymentEvent) {
  if (receipt.attempt_id !== event.attemptId || receipt.provider_payment_id !== event.providerPaymentId
    || receipt.outcome !== event.outcome || receipt.amount_minor !== event.amountMinor
    || receipt.currency.toUpperCase() !== event.currency.toUpperCase()) throw new Error("Changed payment event evidence.");
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
  try {
    const committed = await inTransaction(async manager => {
      await clubs.lockConfigurationForRead(manager);
      const parent = await payments.discoverSettlementParent(manager, value.attemptId);
      if (!parent) return { result: "unavailable", reconciliation: false };
      // Occupancy mutex precedes every booking/reservation/attempt lock. A hold
      // cannot become active while a replacement is checking expired occupancy.
      const [location] = await lockLocations(manager, [parent.location_id]);
      if (!location) return { result: "unavailable", reconciliation: false };
      const b = await bookings.lockSettlementBooking(manager, parent.booking_id);
      if (!b) return { result: "unavailable", reconciliation: false };
      const r = await reservations.findReservationForUpdate(manager, b.reservation_id);
      const attempt = await payments.lockSettlementAttempt(manager, value.attemptId);
      if (!r || !attempt || attempt.booking_id !== b.id || attempt.method !== "online" || attempt.provider !== value.provider
        || (event ? attempt.provider_payment_id !== value.providerPaymentId
          : attempt.provider_payment_id !== null && attempt.provider_payment_id !== value.providerPaymentId))
        return { result: "unavailable", reconciliation: false };
      const resourceFacts = await reservations.findReservationResourceFacts(manager, r.court_id);
      if (b.reservation_id !== parent.reservation_id || resourceFacts?.location_id !== parent.location_id)
        throw new SettlementParentChanged();
      if (event) {
        const duplicate = await payments.findProviderEventReceipt(manager, event.provider, event.eventId);
        if (duplicate) return { result: replay(duplicate, event), reconciliation: false };
      }
      const mismatch = event && (event.amountMinor !== attempt.amount_minor || event.currency.toUpperCase() !== attempt.currency.toUpperCase());
      if (attempt.adjustment_id) {
        const adjusted = await settleAdjustment(manager, { attempt, event, outcome: value.outcome,
          providerPaymentId: value.providerPaymentId, mismatch: Boolean(mismatch) });
        notification = adjusted.notification;
        adjustmentRefundIds = adjusted.refundIds;
        const reconciliation = value.outcome === "succeeded" && adjusted.result !== "succeeded";
        if (event && !await payments.insertProviderEventReceipt(manager, {
          provider: event.provider, event_id: event.eventId, attempt_id: attempt.id,
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
            || location.customerCancellationNoticeMinutes !== b.cancellation_notice_minutes) {
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
      // Display metadata is not settlement authority and acquires no row locks.
      const resource = decision.targets?.booking === "confirmed"
        ? await reservations.findSettlementNotificationResource(manager, r.court_id) : null;
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
          await bookings.updateSettlementBookingStatus(manager, b.id, decision.targets.booking);
          await reservations.updateSettlementReservationStatus(manager, r.id, decision.targets.reservation);
        }
      }
      const reconciliation = event?.outcome === "succeeded" && decision.result !== "succeeded";
      if (event) {
        const inserted = await payments.insertProviderEventReceipt(manager, {
          provider: event.provider, event_id: event.eventId, attempt_id: attempt.id,
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
      // Captures after a capability-authorized checkout cancellation use the
      // same unique refund record and provider idempotency as booking refunds.
      // Checkout cancellation retains a held row until settlement, then releases
      // it. Normal booking cancellation marks the row cancelled; duplicate
      // settlement must preserve its refund state and the Admin's refund choice.
      if (b.status === "cancelled" && (r.status === "held" || r.status === "released")
        && value.outcome === "succeeded" && !mismatch
        && attempt.provider === "stripe") {
        const refund = await payments.findAndLockRefundByBooking(manager, b.id);
        refundId = refund?.id ?? await payments.insertBookingRefundRequest(manager, b.id, null, {
          id: attempt.id, provider: "stripe", provider_payment_id: value.providerPaymentId,
          amount_minor: attempt.amount_minor, currency: attempt.currency,
        });
      }
      if (decision.targets?.booking === "confirmed") {
        if (!resource) throw new Error("Unable to read confirmation resources.");
        notification = bookingNotification("confirmed", {
          booking_id: b.id, customer_name: b.customer_name, location_name: resource.location_name, timezone: resource.timezone,
          court_name: resource.court_name, booking_date: r.booking_date, starts_at_minute: r.starts_at_minute,
          ends_at_minute: r.ends_at_minute, total_amount_minor: b.total_amount_minor, currency: b.currency, previous: null,
        }, b.customer_email);
      }
      return { result: decision.result, reconciliation };
    });
    if (refundId) await processBookingRefund(refundId);
    for (const id of adjustmentRefundIds) await processBookingRefund(id);
    if (notification) await sendBookingNotification(notification);
    if (committed.reconciliation) logger.error({ event: "payments.reconciliation_required", attemptId: value.attemptId,
      eventId: event?.eventId, result: committed.result }, "Successful payment requires reconciliation");
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
export async function processOnlinePaymentEvent(input: OnlinePaymentEvent) {
  const value = settlementSchema.extend({ eventId: z.string().min(1).max(255),
    amountMinor: z.number().int().nonnegative(), currency: z.string().length(3) }).parse(input);
  return commitSettlement(settlementSchema.parse({ attemptId: value.attemptId, provider: value.provider,
    providerPaymentId: value.providerPaymentId, outcome: value.outcome }), value);
}
