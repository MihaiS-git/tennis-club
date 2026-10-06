import "server-only";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { commandFence, readBookingActor, readBookingContext } from "./persistence";
import { customerBookingNoticeBypass, customerCancellationEligibility, customerMutationDeadline } from "./self-cancellation";
import { bookingNotification } from "@/lib/notifications/booking-email";
import { successfulRefundPayment } from "@/lib/payments/providers/stripe/refund-policy";

export async function cancelBookingCommand(id: string, actorId: string, admin: boolean,
  refundChoice: boolean | null, writer = createBookingWriter()) {
  for (let retry = 0; retry < 3; retry++) {
    const actor = await readBookingActor(actorId, writer);
    if (actor.status !== "active" || admin && !actor.roles.includes("admin")) throw new Error("Not authorized");
    const staff = customerBookingNoticeBypass(actor.roles);
    const context = await readBookingContext(id, writer);
    const unavailable = { outcome: "unavailable", refund_id: null };
    if (!context || (!admin && context.booking.account_user_id !== actorId)) return unavailable;
    if (context.booking.status === "cancelled") return context.refund
      ? { outcome: "cancelled", refund_id: context.refund.id } : unavailable;
    if (context.booking.status !== "confirmed" || context.reservation.status !== "active") return unavailable;
    if (admin && (!context.location.is_active || context.location.archived_at || !context.court.is_active)) return unavailable;
    const policy = { starts_at_instant: context.starts_at_instant, cancellation_notice_minutes: context.booking.cancellation_notice_minutes };
    const eligibility = customerCancellationEligibility(policy, staff, new Date(context.now));
    if (eligibility !== "eligible") return { outcome: admin ? "unavailable" : eligibility, refund_id: null };
    const payment = successfulRefundPayment(context.payments);
    if (admin && payment && refundChoice === null) return { outcome: "refund_choice_required", refund_id: null };
    const refund = payment && (!admin || refundChoice) ? {
      payment_attempt_id: payment.id, provider: payment.provider, provider_payment_id: payment.provider_payment_id,
      amount_minor: payment.amount_minor, currency: payment.currency,
    } : null;
    const r = context.reservation, b = context.booking;
    const event = bookingNotification(admin ? "admin_cancelled" : "customer_cancelled", "cancelled", {
      booking_id: b.id, customer_name: b.customer_name, location_name: context.location.name, timezone: context.location.timezone,
      court_name: context.court.name, booking_date: r.booking_date, starts_at_minute: r.starts_at_minute,
      ends_at_minute: r.ends_at_minute, total_amount_minor: b.total_amount_minor, currency: b.currency, previous: null,
      ...(refund ? { refund_status: "requested" as const } : {}),
    }, b.customer_email);
    const deadline = customerMutationDeadline(policy, staff);
    const committed = await writer.rpc("commit_booking_cancellation", { ...commandFence(context), p_actor: actorId,
      p_scope: admin ? "admin" : "owner", p_actor_expected: actor, p_deadline: deadline.deadline, p_inclusive: deadline.inclusive,
      p_refund: refund, p_event: event });
    if (committed.error?.code === "40001") continue;
    if (committed.error) throw new Error("Unable to cancel booking.");
    return committed.data;
  }
  return { outcome: "unavailable", refund_id: null };
}
