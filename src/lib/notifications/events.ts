import "server-only";

import { randomUUID } from "node:crypto";
import { findAdjustment } from "@/lib/db/repositories/booking-adjustments.repository";
import type { EntityManager } from "typeorm";
import type { RevisionSnapshot } from "@/lib/bookings/revision";
import type { BookingAdjustmentEntity } from "@/lib/db/entities/booking-adjustment.entity";
import { findFinancialExceptionNotificationFact, findSucceededRefundNotificationFact, hasActiveUserRole,
  insertUserMessage, insertUserMessages, listActiveUserIdsWithRole } from "@/lib/db/repositories/notifications.repository";
import { recordBookingFinancialException as persistException, type BookingFinancialExceptionKind } from "@/lib/db/repositories/booking-financial-exceptions.repository";
import { adminTransactionHref } from "@/lib/payments/admin-query";
import { formatMoney } from "@/lib/pricing/money";
import { bookingContent, bookingDetails, changeRefundRequestedContent, coachLessonContent, coachReassignmentContent, financialContent, plainHtml,
  type PreviousBooking } from "./content";
import { recordNotification } from "./record";

function requireTransaction(manager: EntityManager) {
  if (!manager.queryRunner?.isTransactionActive) throw new Error("Notification recording requires a caller-owned transaction");
}

async function staffMessage(manager: EntityManager, userId: string, eventKey: string, kind: string,
  content: { subject: string; bodyText: string }, href: string, occurredAt: Date) {
  await insertUserMessage(manager, { id: randomUUID(), userId, eventKey, kind, ...content, href, createdAt: occurredAt });
}

// previous: the schedule a reschedule replaced, shown beside the new one when supplied.
// note: the transition's financial outcome (see bookingContent). A completed reassignment
// (previous names another coach) tells the replacement coach of the new assignment and the
// previous coach that the lesson is no longer theirs; otherwise the assigned coach receives
// the lesson's operational details. Coach messages are in-app and never financial.
// Callers record a transition once per applied revision; event keys deduplicate replays.
export async function recordBookingTransition(manager: EntityManager, revision: RevisionSnapshot, note?: string,
  previous?: PreviousBooking) {
  requireTransaction(manager);
  const event = revision.kind === "created" && revision.bookingState === "confirmed" ? "confirmed"
    : revision.kind === "confirmed" || revision.kind === "cancelled" || revision.kind === "rescheduled" ? revision.kind : null;
  if (!event) return;
  const explanation = event === "cancelled" && revision.adjustmentId
    ? (await findAdjustment(manager, revision.adjustmentId))?.target.cancellationExplanation : undefined;
  const cancellationNote = explanation ? `Cancellation explanation: ${explanation}` : undefined;
  const content = bookingContent(revision, event, [note, cancellationNote].filter(Boolean).join("\n") || undefined, previous);
  const href = `/my-activity/${event === "cancelled" ? "history" : "bookings"}?booking=${revision.bookingId}`;
  await recordNotification(manager, { eventKey: `booking.${event}:${revision.id}`, purpose: "customer",
    recipientEmail: revision.customerEmail, kind: `booking.${event}`, ...content, href, occurredAt: revision.recordedAt });
  const previousCoach = event === "rescheduled" && previous?.coachUserId && revision.coachUserId
    && previous.coachUserId.toLowerCase() !== revision.coachUserId.toLowerCase() ? previous.coachUserId : null;
  if (previousCoach && await hasActiveUserRole(manager, previousCoach, "coach"))
    await staffMessage(manager, previousCoach, `coaching.unassigned:${revision.id}`, "coaching.unassigned",
      coachReassignmentContent(previous!, "unassigned"), "/coach/bookings", revision.recordedAt);
  if (!revision.coachUserId || !await hasActiveUserRole(manager, revision.coachUserId, "coach")) return;
  if (previousCoach) {
    await staffMessage(manager, revision.coachUserId, `coaching.assigned:${revision.id}`, "coaching.assigned",
      coachReassignmentContent(revision, "assigned"), `/coach/bookings/lessons/${revision.bookingId}`, revision.recordedAt);
  } else {
    const operationalContent = coachLessonContent(revision, event, previous);
    if (cancellationNote) operationalContent.bodyText += `\n\n${cancellationNote}`;
    await staffMessage(manager, revision.coachUserId, `coaching.${event}:${revision.id}`, `coaching.${event}`,
      operationalContent, `/coach/bookings/lessons/${revision.bookingId}`, revision.recordedAt);
  }
}

// A staff change awaiting its price-reduction refund, recorded with the request. The
// completed or rejected outcome is announced by its own transition or financial exception.
export async function recordBookingChangeRefundRequested(manager: EntityManager, current: RevisionSnapshot,
  adjustment: Pick<BookingAdjustmentEntity, "id" | "target" | "newTotal" | "createdAt">, refundMinor: number) {
  requireTransaction(manager);
  const { target } = adjustment;
  const proposed = { ...current, locationName: target.locationName, courtName: target.courtName, timezone: target.timezone,
    bookingDate: target.date, startMinute: target.startMinute, endMinute: target.endMinute, coachName: target.coachName ?? current.coachName };
  await recordNotification(manager, { eventKey: `booking.change_refund_requested:${adjustment.id}`, purpose: "customer",
    recipientEmail: current.customerEmail, kind: "booking.change_refund_requested",
    ...changeRefundRequestedContent(current, proposed, { lesson: current.coachUserId != null, refundMinor,
      newTotalMinor: adjustment.newTotal, currency: current.currency }),
    href: `/my-activity/bookings?booking=${current.bookingId}`, occurredAt: adjustment.createdAt });
}

// A checkout that never became a booking has no booking page or history entry:
// Admins open its payment evidence and customers their booking history.
function customerFinancialHref(fact: { bookingId: string; confirmed: boolean }) {
  return fact.confirmed ? `/my-activity/history?booking=${fact.bookingId}` : "/my-activity/history";
}

function adminFinancialHref(fact: { bookingId: string; confirmed: boolean; paymentAttemptId: string | null; refundId: string | null }) {
  if (fact.confirmed) return `/admin/bookings/${fact.bookingId}#financial-history`;
  return fact.paymentAttemptId ? adminTransactionHref("payment", fact.paymentAttemptId)
    : fact.refundId ? adminTransactionHref("refund", fact.refundId) : adminTransactionHref("booking", fact.bookingId);
}

export async function recordBookingFinancialException(manager: EntityManager, input: {
  key: string; bookingId: string; revisionId: string; kind: BookingFinancialExceptionKind;
  adjustmentId?: string | null; paymentAttemptId?: string | null; refundId?: string | null;
}) {
  requireTransaction(manager);
  await persistException(manager, input);
  const fact = await findFinancialExceptionNotificationFact(manager, input.key);
  if (!fact) throw new Error("Persisted financial exception missing");
  const financial = { kind: fact.kind, amountMinor: fact.amountMinor, currency: fact.currency, booking: fact.booking };
  const { subject, bodyText } = financialContent(financial, "admin");
  await insertUserMessages(manager, (await listActiveUserIdsWithRole(manager, "admin")).map((userId) => ({
    id: randomUUID(), userId, eventKey: `financial.exception:${fact.eventKey}`, kind: `financial.${fact.kind}`,
    subject, bodyText, href: adminFinancialHref(fact), createdAt: fact.occurredAt })));
  if (fact.kind !== "refund_unresolved") {
    await recordNotification(manager, { eventKey: `financial.customer:${fact.eventKey}`, purpose: "customer",
      recipientEmail: fact.customerEmail, kind: `financial.${fact.kind}`, ...financialContent(financial, "customer"),
      href: customerFinancialHref(fact), occurredAt: fact.occurredAt });
  }
}

export async function recordSuccessfulRefund(manager: EntityManager, refundId: string, executionId: string, occurredAt: Date) {
  requireTransaction(manager);
  const fact = await findSucceededRefundNotificationFact(manager, refundId, executionId);
  if (!fact || fact.reason === "booking_cancellation" || fact.reason === "booking_price_reduction") return;
  const reason = fact.reason === "late_capture_compensation" ? "a payment captured after the booking hold ended"
    : fact.reason === "failed_adjustment_compensation" ? "a booking change that could not be applied"
      : "your booking payment";
  const bodyText = [`A refund of ${formatMoney(fact.amountMinor, fact.currency)} completed for ${reason}.`,
    ...bookingDetails(fact.booking)].join("\n");
  await recordNotification(manager, { eventKey: `financial.refund:${executionId}`, purpose: "customer",
    recipientEmail: fact.customerEmail, kind: "financial.refund_succeeded",
    subject: "Booking refund completed", bodyText, bodyHtml: plainHtml(bodyText),
    href: customerFinancialHref(fact), occurredAt });
}
