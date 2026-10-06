import "server-only";
import { z } from "zod";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { commandFence, readBookingContext } from "@/lib/bookings/persistence";
import { bookingNotification } from "@/lib/notifications/booking-email";
import { logger } from "@/lib/logger";
import { paymentProviderSchema, paymentTransition } from "./domain";
import type { OnlinePaymentEvent } from "./providers/types";

const settlementSchema = z.strictObject({ attemptId: z.uuid(), provider: paymentProviderSchema,
  providerPaymentId: z.string().trim().min(1).max(255),
  outcome: z.enum(["succeeded", "failed", "retryable_failed", "cancelled"]) });
type Settlement = z.infer<typeof settlementSchema>;

async function commitSettlement(value: Settlement, event: OnlinePaymentEvent | null, writer: ReturnType<typeof createBookingWriter>) {
  const attemptRead = await writer.from("payment_attempts").select("booking_id").eq("id", value.attemptId).maybeSingle();
  if (attemptRead.error) throw new Error("Unable to read payment.");
  if (!attemptRead.data) return "unavailable";
  const bookingId = z.object({ booking_id: z.uuid() }).parse(attemptRead.data).booking_id;
  for (let retry = 0; retry < 4; retry++) {
    const context = await readBookingContext(bookingId, writer);
    const attempt = context?.payments.find((p) => p.id === value.attemptId);
    if (!context || !attempt || attempt.method !== "online" || attempt.provider !== value.provider
      || (event ? attempt.provider_payment_id !== value.providerPaymentId
        : attempt.provider_payment_id !== null && attempt.provider_payment_id !== value.providerPaymentId)) return "unavailable";
    const duplicate = event && context.events.find((e) => e.provider === event.provider && e.event_id === event.eventId);
    if (duplicate) {
      if (duplicate.attempt_id !== event.attemptId || duplicate.provider_payment_id !== event.providerPaymentId
        || duplicate.outcome !== event.outcome || duplicate.amount_minor !== event.amountMinor
        || duplicate.currency !== event.currency.toUpperCase()) throw new Error("Changed payment event evidence.");
      return duplicate.settlement_result;
    }
    const mismatch = event && (event.amountMinor !== attempt.amount_minor || event.currency.toUpperCase() !== attempt.currency);
    const decision = mismatch ? { result: "amount_mismatch", targets: null, deadline: null }
      : paymentTransition({ attemptStatus: attempt.status, bookingStatus: context.booking.status,
        reservationStatus: context.reservation.status, reservationExpiry: context.reservation.hold_expires_at,
        attemptExpiry: attempt.expires_at, now: context.now, outcome: value.outcome });
    const b = context.booking, r = context.reservation;
    const notification = decision.targets?.booking === "confirmed" ? bookingNotification("confirmed", "confirmed", {
      booking_id: b.id, customer_name: b.customer_name, location_name: context.location.name, timezone: context.location.timezone,
      court_name: context.court.name, booking_date: r.booking_date, starts_at_minute: r.starts_at_minute,
      ends_at_minute: r.ends_at_minute, total_amount_minor: b.total_amount_minor, currency: b.currency, previous: null,
    }, b.customer_email) : null;
    const reconciliation = event?.outcome === "succeeded" && decision.result !== "succeeded";
    const committed = await writer.rpc("commit_payment_transition", { ...commandFence(context),
      p_attempt_id: value.attemptId, p_deadline: decision.deadline,
      p_targets: decision.targets ? { ...decision.targets, provider_payment_id: value.providerPaymentId } : null,
      p_event: notification, p_result: decision.result,
      p_receipt: event ? { provider: event.provider, event_id: event.eventId, provider_payment_id: event.providerPaymentId,
        outcome: event.outcome, amount_minor: event.amountMinor, currency: event.currency.toUpperCase(), reconciliation_required: reconciliation } : null });
    if (committed.error?.code === "40001") continue;
    if (committed.error) {
      logger.error({ event: "payments.commit_failed", attemptId: value.attemptId, code: committed.error.code }, "Payment persistence failed");
      throw new Error("Unable to update payment lifecycle.");
    }
    if (reconciliation) logger.error({ event: "payments.reconciliation_required", attemptId: value.attemptId,
      eventId: event?.eventId, result: decision.result }, "Successful payment requires reconciliation");
    return z.string().parse(committed.data);
  }
  throw new Error("Payment changed concurrently. Retry processing.");
}
export async function settleOnlinePayment(input: unknown, writer = createBookingWriter()) {
  return commitSettlement(settlementSchema.parse(input), null, writer);
}
export async function processOnlinePaymentEvent(input: OnlinePaymentEvent, writer = createBookingWriter()) {
  const value = settlementSchema.extend({ eventId: z.string().min(1).max(255),
    amountMinor: z.number().int().nonnegative(), currency: z.string().length(3) }).parse(input);
  return commitSettlement(settlementSchema.parse({ attemptId: value.attemptId, provider: value.provider,
    providerPaymentId: value.providerPaymentId, outcome: value.outcome }), value, writer);
}
