import "server-only";

import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import { z } from "zod";
import type { RevisionSnapshot } from "@/lib/bookings/revision";
import { insertUserMessage } from "@/lib/db/repositories/notifications.repository";
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
  if (revision.coachUserId) {
    const eligible: unknown = await manager.query(`SELECT u.id FROM public.users u JOIN public.user_roles r ON r.user_id=u.id
      WHERE u.id=$1 AND u.status='active' AND r.role_code='coach' LIMIT 1`, [revision.coachUserId]);
    if (z.array(z.object({ id: z.uuid() })).parse(eligible).length > 0) {
      const coachContent = { subject: content.subject,
        bodyText: content.bodyText.replace(/^Your coaching lesson (is|was)/, "Your assigned coaching lesson $1") };
      await staffMessage(manager, revision.coachUserId, `coaching.${event}:${revision.id}`, `coaching.${event}`,
        coachContent, `/coach/bookings/lessons/${revision.bookingId}`, revision.recordedAt);
    }
  }
}

const exceptionRow = z.object({ event_key: z.string(), kind: z.string(), booking_id: z.uuid(),
  customer_email: z.string(), currency: z.enum(["EUR", "USD", "GBP", "RON", "CHF"]),
  amount_minor: z.number().nullable(), occurred_at: z.date(),
  location_name: z.string(), court_name: z.string(), booking_date: z.iso.date(),
  starts_at_minute: z.number().int(), ends_at_minute: z.number().int(), timezone: z.string(),
  coaching_program_name: z.string().nullable(), coach_name: z.string().nullable() });

export async function recordBookingFinancialException(manager: EntityManager, input: {
  key: string; bookingId: string; revisionId: string; kind: BookingFinancialExceptionKind;
  adjustmentId?: string | null; paymentAttemptId?: string | null; refundId?: string | null;
}) {
  requireTransaction(manager);
  await persistException(manager, input);
  const rows: unknown = await manager.query(`SELECT e.event_key, e.kind, e.booking_id, e.occurred_at,
      v.customer_email, v.currency, v.location_name, v.court_name, v.booking_date::text AS booking_date,
      v.starts_at_minute, v.ends_at_minute, v.timezone, v.coaching_program_name, v.coach_name,
      COALESCE(f.amount_minor, p.amount_minor,
        nullif(abs(a.new_total-a.original_total), 0)) AS amount_minor
    FROM public.booking_financial_exceptions e
    JOIN public.booking_revisions v ON v.id=e.revision_id
    LEFT JOIN public.payment_refunds f ON f.id=e.refund_id
    LEFT JOIN public.payment_attempts p ON p.id=e.payment_attempt_id
    LEFT JOIN public.booking_adjustments a ON a.id=e.adjustment_id
    WHERE e.event_key=$1`, [input.key]);
  const fact = z.array(exceptionRow).parse(rows)[0];
  if (!fact) throw new Error("Persisted financial exception missing");
  const financial = { kind: fact.kind, amountMinor: fact.amount_minor, currency: fact.currency,
    booking: { locationName: fact.location_name, courtName: fact.court_name, bookingDate: fact.booking_date,
      startMinute: fact.starts_at_minute, endMinute: fact.ends_at_minute, timezone: fact.timezone,
      coachingProgramName: fact.coaching_program_name, coachName: fact.coach_name } };
  const admins: unknown = await manager.query(`SELECT DISTINCT u.id FROM public.users u
    JOIN public.user_roles r ON r.user_id=u.id WHERE u.status='active' AND r.role_code='admin' ORDER BY u.id`);
  for (const admin of z.array(z.object({ id: z.uuid() })).parse(admins)) {
    await staffMessage(manager, admin.id, `financial.exception:${fact.event_key}`, `financial.${fact.kind}`,
      financialContent(financial, "admin"), `/admin/bookings/${fact.booking_id}#financial-history`, fact.occurred_at);
  }
  if (fact.kind !== "refund_unresolved") {
    await recordNotification(manager, { eventKey: `financial.customer:${fact.event_key}`, purpose: "customer",
      recipientEmail: fact.customer_email, kind: `financial.${fact.kind}`, ...financialContent(financial, "customer"),
      href: `/my-activity/history?booking=${fact.booking_id}`, occurredAt: fact.occurred_at });
  }
}

const refundRow = z.object({ id: z.uuid(), booking_id: z.uuid(), reason: z.string(), amount_minor: z.number(),
  currency: z.enum(["EUR", "USD", "GBP", "RON", "CHF"]), customer_email: z.string(),
  location_name: z.string(), court_name: z.string(), booking_date: z.iso.date(),
  starts_at_minute: z.number().int(), ends_at_minute: z.number().int(), timezone: z.string(),
  coaching_program_name: z.string().nullable(), coach_name: z.string().nullable() });

export async function recordSuccessfulRefund(manager: EntityManager, refundId: string, executionId: string, occurredAt: Date) {
  requireTransaction(manager);
  const rows: unknown = await manager.query(`SELECT f.id, f.booking_id, f.reason, f.amount_minor, f.currency, v.customer_email,
      v.location_name, v.court_name, v.booking_date::text AS booking_date, v.starts_at_minute,
      v.ends_at_minute, v.timezone, v.coaching_program_name, v.coach_name
    FROM public.payment_refunds f JOIN public.booking_revisions v ON v.id=f.context_revision_id
    JOIN public.refund_executions x ON x.id=$2 AND x.refund_id=f.id AND x.terminal_result='succeeded'
    WHERE f.id=$1 AND f.status='succeeded'`, [refundId, executionId]);
  const fact = z.array(refundRow).parse(rows)[0];
  if (!fact || fact.reason === "booking_cancellation" || fact.reason === "booking_price_reduction") return;
  const reason = fact.reason === "late_capture_compensation" ? "a payment captured after the booking hold ended"
    : fact.reason === "failed_adjustment_compensation" ? "a booking change that could not be applied"
      : "your booking payment";
  const bodyText = [`A refund of ${formatMoney(fact.amount_minor, fact.currency)} completed for ${reason}.`,
    ...bookingDetails({ locationName: fact.location_name, courtName: fact.court_name, bookingDate: fact.booking_date,
      startMinute: fact.starts_at_minute, endMinute: fact.ends_at_minute, timezone: fact.timezone,
      coachingProgramName: fact.coaching_program_name, coachName: fact.coach_name })].join("\n");
  await recordNotification(manager, { eventKey: `financial.refund:${executionId}`, purpose: "customer",
    recipientEmail: fact.customer_email, kind: "financial.refund_succeeded",
    subject: "Booking refund completed", bodyText, bodyHtml: plainHtml(bodyText),
    href: `/my-activity/history?booking=${fact.booking_id}`, occurredAt });
}
