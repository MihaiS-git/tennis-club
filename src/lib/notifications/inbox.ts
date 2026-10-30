import "server-only";

import { z } from "zod";
import { profileContext } from "@/lib/profile/profile";
import { getDataSource } from "@/lib/db/data-source";
import { countUnreadUserMessages, countUserMessages, findUserMessage, listUserMessages,
  markUserMessageRead, markUserMessageUnread, updateUserMessages } from "@/lib/db/repositories/notifications.repository";
import { inboxPage, type InboxQuery } from "./inbox-query";

export const messagesPerPage = 25;
export { inboxPage };
export type MessageAccess = { state: "ready"; userId: string } | { state: "unauthenticated" | "unavailable" };

export async function messageAccess(): Promise<MessageAccess> {
  const { account } = await profileContext();
  if (account.state === "unauthenticated") return { state: "unauthenticated" };
  if (account.state === "active" || account.state === "suspended") return { state: "ready", userId: account.userId };
  return { state: "unavailable" };
}

export async function listOwnMessages(userId: string, query: InboxQuery) {
  const { manager } = await getDataSource();
  const [messages, total] = await Promise.all([
    listUserMessages(manager, userId, query, messagesPerPage, (query.page - 1) * messagesPerPage),
    countUserMessages(manager, userId, query),
  ]);
  return { messages, total, page: query.page, hasPrevious: query.page > 1, hasNext: query.page * messagesPerPage < total };
}

export async function unreadOwnMessageCount(userId: string) {
  return countUnreadUserMessages((await getDataSource()).manager, userId);
}

export async function openOwnMessage(userId: string, rawId: unknown) {
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return null;
  const { manager } = await getDataSource();
  return findUserMessage(manager, userId, id.data);
}

export async function readOwnMessage(userId: string, rawId: unknown) {
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return false;
  const { manager } = await getDataSource();
  const message = await findUserMessage(manager, userId, id.data);
  if (!message) return false;
  if (!message.readAt) await markUserMessageRead(manager, userId, id.data, new Date());
  return true;
}

export async function unreadOwnMessage(userId: string, rawId: unknown) {
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return false;
  const { manager } = await getDataSource();
  const message = await findUserMessage(manager, userId, id.data);
  if (!message) return false;
  await markUserMessageUnread(manager, userId, id.data);
  return true;
}

const selectedIds = z.array(z.uuid()).min(1).max(messagesPerPage)
  .refine((ids) => new Set(ids).size === ids.length);

export async function updateOwnMessages(userId: string, rawIds: unknown, operation: "read" | "unread" | "delete") {
  const ids = selectedIds.safeParse(rawIds);
  if (!ids.success) throw new Error("Select up to 25 notifications on this page.");
  return updateUserMessages((await getDataSource()).manager, userId, ids.data, operation);
}

export async function deleteOwnMessage(userId: string, rawId: unknown) {
  const id = z.uuid().safeParse(rawId);
  if (!id.success) throw new Error("Notification unavailable");
  return updateUserMessages((await getDataSource()).manager, userId, [id.data], "delete");
}

// Notification producers emit only these paths. Treat all other stored href values as text,
// including protocol-relative, encoded, or future destinations.
export function safeMessageHref(href: string | null) {
  if (!href || href !== href.trim()) return null;
  const transaction = /^\/admin\/payments\/transactions\/(?:payment|refund|booking)\/([^/]+)$/.exec(href);
  if (transaction && z.uuid().safeParse(transaction[1]).success) return href;
  if (href === "/my-activity/bookings" || href === "/my-activity/history") return href;
  if (/^\/my-activity\/(?:bookings|history)\?booking=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(href)) return href;
  return /^\/(?:admin\/bookings|coach\/bookings\/lessons)\/[0-9a-f-]{36}(?:#financial-history)?$/i.test(href) ? href : null;
}

export function messageCategory(kind: string) {
  if (kind.startsWith("coaching.")) return "Coaching";
  if (kind.startsWith("financial.")) return "Payments";
  if (kind.startsWith("booking.")) return "Bookings";
  return "Club";
}
