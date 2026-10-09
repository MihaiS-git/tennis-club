import "server-only";
import { z } from "zod";
import { inTransaction } from "@/lib/db/transaction";
import { lockLocations } from "@/lib/db/repositories/clubs.repository";
import { hasOccupancyConflict } from "@/lib/reservations/occupancy";
import * as payments from "@/lib/db/repositories/payments.repository";
import * as bookings from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { bookingNotification, sendBookingNotification, type BookingEmailEvent } from "@/lib/notifications/booking-email";
import { logger } from "@/lib/logger";
import { paymentProviderSchema, paymentTransition } from "./domain";
import type { OnlinePaymentEvent } from "./providers/types";

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
  try {
    const committed = await inTransaction(async manager => {
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
      const decide = async () => {
        if (mismatch) return { result: "amount_mismatch", targets: null, deadline: null };
        const transition = paymentTransition({ attemptStatus: attempt.status, bookingStatus: b.status, reservationStatus: r.status,
          reservationExpiry: r.hold_expires_at, attemptExpiry: attempt.expires_at,
          now: await reservations.readReservationClockTime(manager), outcome: value.outcome });
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
