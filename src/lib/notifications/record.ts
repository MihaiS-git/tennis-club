import "server-only";

import { readClubSettings } from "@/lib/db/repositories/club-settings.repository";
import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import { findNotificationAccounts, insertEmailDelivery, insertUserMessages } from "@/lib/db/repositories/notifications.repository";
import { resolveNotificationChannels } from "./policy";
import type { NotificationPurpose } from "./types";

export type NotificationRecord = {
  eventKey: string;
  purpose: NotificationPurpose;
  recipientEmail: string;
  kind: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  href?: string | null;
  occurredAt: Date;
};

// The caller owns the transaction. A stable eventKey plus each database unique key
// makes replay safe after a domain operation is retried.
export async function recordNotification(manager: EntityManager, notification: NotificationRecord) {
  const accounts = await findNotificationAccounts(manager, notification.recipientEmail);
  const channels = resolveNotificationChannels(notification.recipientEmail, accounts, notification.purpose);
  await insertUserMessages(manager, channels.userIds.map((userId) => ({ id: randomUUID(), userId, eventKey: notification.eventKey,
    kind: notification.kind, subject: notification.subject, bodyText: notification.bodyText,
    href: notification.href ?? null, createdAt: notification.occurredAt })));
  if (channels.email && (await readClubSettings(manager, "pessimistic_read")).emailsEnabled) {
    await insertEmailDelivery(manager, { id: randomUUID(), eventKey: notification.eventKey,
      recipientEmail: notification.recipientEmail.trim(), subject: notification.subject,
      bodyText: notification.bodyText, bodyHtml: notification.bodyHtml, status: "pending", attempts: 0,
      nextAttemptAt: notification.occurredAt, lockedUntil: null, providerMessageId: null,
      lastError: null, createdAt: notification.occurredAt, updatedAt: notification.occurredAt });
  }
}
