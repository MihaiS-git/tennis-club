import "server-only";

import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import type { RevisionSnapshot } from "@/lib/bookings/revision";
import { findFinancialExceptionNotificationFact, findSucceededRefundNotificationFact, hasActiveUserRole,
  insertUserMessage, insertUserMessages, listActiveUserIdsWithRole } from "@/lib/db/repositories/notifications.repository";
import { recordBookingFinancialException as persistException, type BookingFinancialExceptionKind } from "@/lib/db/repositories/booking-financial-exceptions.repository";
import { formatMoney } from "@/lib/pricing/money";
import { bookingContent, bookingDetails, financialContent, plainHtml } from "./content";
import { recordNotification } from "./record";

function requireTransaction(manager: EntityManager) {
  if (!manager.queryRunner?.isTransactionActive) throw new Error("Notification recording requires a caller-owned transaction");
}

async function staffMessage(manager: EntityManager, userId: string, eventKey: string, kind: string,
  content: { subject: string; bodyText: string }, href: string, occurredAt: Date) {
  await insertUserMessage(manager, { id: randomUUID(), userId, eventKey, kind, ...content, href, createdAt: occurredAt });
}

export async function recordBookingTransition(manager: EntityManager, revision: RevisionSnapshot, refundOutcome?: string) {
  requireTransaction(manager);
  const event = revision.kind === "created" && revision.bookingState === "confirmed" ? "confirmed"
    : revision.kind === "confirmed" || revision.kind === "cancelled" || revision.kind === "rescheduled" ? revision.kind : null;
  if (!event) return;
  const content = bookingContent(revision, event, refundOutcome);
  const href = `/my-activity/${event === "cancelled" ? "history" : "bookings"}?booking=${revision.bookingId}`;
  await recordNotification(manager, { eventKey: `booking.${event}:${revision.id}`, purpose: "customer",
    recipientEmail: revision.customerEmail, kind: `booking.${event}`, ...content, href, occurredAt: revision.recordedAt });
  if (revision.coachUserId && await hasActiveUserRole(manager, revision.coachUserId, "coach")) {
    const coachContent = { subject: content.subject,
      bodyText: content.bodyText.replace(/^Your coaching lesson (is|was)/, "Your assigned coaching lesson $1") };
    await staffMessage(manager, revision.coachUserId, `coaching.${event}:${revision.id}`, `coaching.${event}`,
      coachContent, `/coach/bookings/lessons/${revision.bookingId}`, revision.recordedAt);
  }
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
    subject, bodyText, href: `/admin/bookings/${fact.bookingId}#financial-history`, createdAt: fact.occurredAt })));
  if (fact.kind !== "refund_unresolved") {
    await recordNotification(manager, { eventKey: `financial.customer:${fact.eventKey}`, purpose: "customer",
      recipientEmail: fact.customerEmail, kind: `financial.${fact.kind}`, ...financialContent(financial, "customer"),
      href: `/my-activity/history?booking=${fact.bookingId}`, occurredAt: fact.occurredAt });
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
    href: `/my-activity/history?booking=${fact.bookingId}`, occurredAt });
}
