import "server-only";

import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import { inTransaction } from "@/lib/db/transaction";
import * as notifications from "@/lib/db/repositories/booking-notifications.repository";
import { renderBookingEmail, type BookingEmailEvent } from "./booking-email";
import { deliverMail, type MailDeliveryResult } from "@/lib/mail/brevo";
import { logger } from "@/lib/logger";

// Financial exceptions the customer must see; email is not proof they read it.
const acknowledgedKinds: ReadonlySet<BookingEmailEvent["event_kind"]> = new Set([
  "cancellation_failed", "modification_failed", "refund_incomplete", "late_payment_refund",
]);

// A focused booking-email outbox. The caller owns the financial transaction.
export async function enqueueBookingNotification(manager: EntityManager, key: string, event: BookingEmailEvent) {
  if (!manager.queryRunner?.isTransactionActive) throw new Error("Booking notification requires the state-change transaction");
  await notifications.insertBookingNotification(manager, { key, message: renderBookingEmail(event),
    bookingId: event.payload.booking_id, eventKind: event.event_kind, requiresAcknowledgement: acknowledgedKinds.has(event.event_kind) });
}

// Automatic retry policy. A temporary failure is retried with exponential backoff
// (2, 4, 8, 16, 32 then 60 minutes) up to this many attempts; a permanent Brevo
// rejection is not retried. Either way the row stays undelivered and visible to
// Admins, who can still retry it explicitly.
export const maxAutomaticDeliveryAttempts = 8;
function nextDeliveryRetrySeconds(result: Exclude<MailDeliveryResult, "accepted">, attempts: number) {
  if (result === "rejected" || attempts >= maxAutomaticDeliveryAttempts) return null;
  return Math.min(3600, 60 * 2 ** Math.min(attempts, 6));
}

// Called after commit by the request that changed state (customer, Admin or
// signed webhook), and every five minutes by Supabase Cron through
// POST /api/notifications/deliver; both also drain earlier due rows. Never
// throws: a row that is not accepted stays queued with its exact failure recorded.
// interrupted: the database or delivery loop failed; due rows stay queued.
export async function deliverPendingBookingNotifications(options: { limit?: number; deadline?: number } = {}) {
  const limit = options.limit ?? 10, deadline = options.deadline ?? Date.now() + 8_000;
  let checked = 0;
  let failed = 0;
  let interrupted = false;
  try {
    while (checked < limit && Date.now() < deadline) {
      const result = await deliverOne();
      if (!result) break;
      checked++;
      if (result !== "accepted") failed++;
    }
  } catch {
    interrupted = true;
    logger.error({ event: "booking_email.delivery_interrupted" }, "Booking notification delivery interrupted; pending rows stay queued");
  }
  return { checked, failed, interrupted };
}

// Explicit Admin retry of one undelivered row, ignoring its backoff. null: it was
// already delivered or another request is sending it right now.
export async function deliverBookingNotification(id: string): Promise<MailDeliveryResult | null> {
  return deliverOne(id);
}

async function deliverOne(id?: string): Promise<MailDeliveryResult | null> {
  const token = randomUUID();
  const item = await inTransaction(manager => notifications.claimDueBookingNotification(manager, token, id));
  if (!item) return null;
  // Stable provider key limits duplicates within Brevo's retention window.
  // Ambiguous outcomes are retried: durable at-least-once submission, not exactly-once email.
  const result = await deliverMail(item.message, item.id);
  const retrySeconds = result === "accepted" ? 0 : nextDeliveryRetrySeconds(result, item.attempts);
  await inTransaction(manager => notifications.recordBookingNotificationDelivery(manager, { id: item.id, token,
    lastError: result === "accepted" ? null : result, retrySeconds }));
  if (result !== "accepted") logger.warn({ event: retrySeconds === null ? "booking_email.delivery_stopped" : "booking_email.delivery_deferred",
    deliveryId: item.id, result, attempts: item.attempts },
  retrySeconds === null ? "Booking notification not delivered; automatic retries stopped, visible to Admins"
    : "Booking notification not delivered; it stays queued and is visible to Admins");
  return result;
}
