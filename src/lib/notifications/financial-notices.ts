import "server-only";

import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { acknowledgeBookingNotice, listUnacknowledgedBookingNotices, listCustomerNotifications, manageCustomerNotifications, findCustomerNotification, hasUnreadCustomerNotifications, hasAdminNotificationAlerts } from "@/lib/db/repositories/booking-notifications.repository";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

import { inboxPageSize, parseInboxQuery } from "./inbox-query";

type Client = Awaited<ReturnType<typeof createClient>>;

// Important financial outcomes stay visible to the booking owner until they
// acknowledge them; a delivered email is not proof the customer read it. Other
// booking emails that could not be delivered are shown until they are delivered.
export async function listOwnFinancialNotices(client?: Client) {
  const account = await readCurrentAccount(client ?? await createClient());
  if (account.state !== "active") return [];
  let notices: Awaited<ReturnType<typeof listUnacknowledgedBookingNotices>>;
  try { notices = await listUnacknowledgedBookingNotices((await getDataSource()).manager, account.userId); }
  catch {
    logger.error({ event: "notifications.notice_read_failed", actorId: account.userId }, "Failed to load financial notices");
    return [];
  }
  // The stored text is the email body; drop its greeting in-app.
  return notices.map(({ email_failed: emailFailed, ...notice }) => ({ ...notice, emailFailed,
    text: notice.text.replace(/^Hello [^\n]*\n\n/, "") }));
}

export async function acknowledgeOwnFinancialNotice(id: unknown, client?: Client): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, message: "Choose a valid notice." };
  const account = await readCurrentAccount(client ?? await createClient());
  if (account.state !== "active") return { ok: false, message: "An active account is required." };
  try {
    // Ownership is enforced in the conditional update: another owner's notice is never changed.
    if (!await inTransaction(manager => acknowledgeBookingNotice(manager, { id: parsed.data, accountUserId: account.userId })))
      return { ok: false, message: "This notice is no longer available." };
  } catch {
    logger.error({ event: "notifications.acknowledge_failed", actorId: account.userId }, "Failed to acknowledge financial notice");
    return { ok: false, message: "Unable to save. Try again." };
  }
  return { ok: true };
}

export async function listOwnNotifications(input: Record<string, unknown> = {}, client?: Client) {
  const query = parseInboxQuery(input);
  const account = await readCurrentAccount(client ?? await createClient());
  if (account.state !== "active") return { notices: [], total: 0, totalPages: 1, query };
  const result = await listCustomerNotifications((await getDataSource()).manager, account.userId, query);
  return { ...result, notices: result.notices.map(notice => ({ ...notice, text: notice.text.replace(/^Hello [^\n]*\n\n/, "") })) };
}

export async function manageOwnNotifications(input: unknown, client?: Client): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = z.object({ ids: z.array(z.uuid()).min(1).max(inboxPageSize).refine(ids => new Set(ids).size === ids.length),
    operation: z.enum(["read", "unread", "delete"]) }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Choose valid notifications and an action." };
  const account = await readCurrentAccount(client ?? await createClient());
  if (account.state !== "active") return { ok: false, message: "An active account is required." };
  try {
    const changed = await manageCustomerNotifications((await getDataSource()).manager, { ...parsed.data, accountUserId: account.userId });
    if (!changed.length) return { ok: false, message: "These notifications are no longer available." };
    return { ok: true };
  } catch {
    logger.error({ event: "notifications.inbox_change_failed", actorId: account.userId }, "Failed to update notification inbox");
    return { ok: false, message: "Unable to save. Try again." };
  }
}

export async function markOwnNotificationRead(id: unknown, client?: Client) {
  return manageOwnNotifications({ ids: [id], operation: "read" }, client);
}

export async function readOwnNotification(id: unknown, client?: Client) {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return null;
  const account = await readCurrentAccount(client ?? await createClient());
  if (account.state !== "active") return null;
  return findCustomerNotification((await getDataSource()).manager, account.userId, parsed.data);
}

export async function readOwnUnreadNotifications(client?: Client) {
  const account = await readCurrentAccount(client ?? await createClient());
  if (account.state !== "active") return false;
  return hasUnreadCustomerNotifications((await getDataSource()).manager, account.userId);
}

// Navbar indicators from one authoritative account read. Only an active Admin
// receives the Admin alert field; every other account gets the personal flag alone.
export async function readNotificationIndicators(client?: Client): Promise<{ unread: boolean; adminAlerts?: boolean }> {
  const account = await readCurrentAccount(client ?? await createClient());
  if (account.state !== "active") return { unread: false };
  const { manager } = await getDataSource();
  const unread = await hasUnreadCustomerNotifications(manager, account.userId);
  if (!account.roles.includes("admin")) return { unread };
  return { unread, adminAlerts: await hasAdminNotificationAlerts(manager) };
}
