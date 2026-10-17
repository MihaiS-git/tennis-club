import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { getDataSource } from "@/lib/db/data-source";
import { deleteStoppedBookingNotifications, findBookingNotificationState, listAdminBookingNotifications } from "@/lib/db/repositories/booking-notifications.repository";
import { inTransaction } from "@/lib/db/transaction";
import { logger } from "@/lib/logger";
import type { MailDeliveryResult } from "@/lib/mail/brevo";
import { createClient } from "@/lib/supabase/server";
import { deliverBookingNotification } from "./booking-delivery";
import { notificationTimezone, notificationTypeSubject, parseAdminNotificationQuery, type NotificationState } from "./admin-notification-query";

type Client = Awaited<ReturnType<typeof createClient>>;

export const adminNotificationsPageSize = 25;
// Bulk deletion acts on one page's selection at most.
const deleteSchema = z.strictObject({ ids: z.array(z.uuid()).min(1).max(adminNotificationsPageSize)
  .refine((ids) => new Set(ids).size === ids.length) });

// Email delivery records only. A row may be deleted once automatic retries have
// stopped and no delivery is sending it. Financial notices (requires_acknowledgement)
// are customer-facing financial records and are never deleted, acknowledged or not.
export function isDeletableNotification(row: { state: NotificationState; important: boolean }) {
  return row.state === "stopped" && !row.important;
}

// Every booking email Brevo has not accepted, including ones never attempted yet,
// searched, filtered, sorted and paginated in the database. Unacknowledged
// financial exceptions always come first.
export async function listAdminUndeliveredNotifications(input: Record<string, string | string[] | undefined> = {}, reader?: Client) {
  await requireActiveAdmin(reader ?? await createClient());
  const manager = (await getDataSource()).manager;
  const query = parseAdminNotificationQuery(input);
  const read = (page: number) => listAdminBookingNotifications(manager, {
    search: query.q, state: query.status === "all" ? null : query.status, subject: notificationTypeSubject(query.type),
    from: query.from ?? null, to: query.to ?? null, timezone: notificationTimezone, sort: query.sort, direction: query.dir,
    limit: adminNotificationsPageSize, offset: (page - 1) * adminNotificationsPageSize,
  });
  let result = await read(query.page);
  const totalPages = Math.max(1, Math.ceil(result.total / adminNotificationsPageSize));
  const page = Math.min(query.page, totalPages);
  // A page beyond the end (rows were delivered or deleted meanwhile) shows the last page.
  if (page !== query.page) result = await read(page);
  return { rows: result.rows.map((row) => ({ ...row, deletable: isDeletableNotification(row) })),
    total: result.total, unacknowledgedExceptions: result.unacknowledged_exceptions, page, totalPages, query: { ...query, page } };
}
export type AdminNotificationRow = Awaited<ReturnType<typeof listAdminUndeliveredNotifications>>["rows"][number];

export type AdminNotificationDeleteResult = { ok: true; deleted: string[]; skipped: number } | { ok: false; message: string };

// Deletes the eligible email delivery records among the selected ids. Eligibility
// is enforced again by the database statement, so records whose state changed
// since selection are skipped and reported, never deleted.
export async function deleteAdminNotifications(input: unknown, reader?: Client): Promise<AdminNotificationDeleteResult> {
  const actor = await requireActiveAdmin(reader ?? await createClient());
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Choose valid notifications to delete." };
  try {
    const deleted = await inTransaction((manager) => deleteStoppedBookingNotifications(manager, parsed.data.ids));
    logger.info({ event: "notifications.admin_delete", actorId: actor.userId, requested: parsed.data.ids.length, deletedIds: deleted },
      "Admin deleted undelivered notifications");
    return { ok: true, deleted, skipped: parsed.data.ids.length - deleted.length };
  } catch {
    logger.error({ event: "notifications.admin_delete_failed", actorId: actor.userId }, "Admin notification deletion failed");
    return { ok: false, message: "Unable to delete notifications. Try again." };
  }
}

export type AdminNotificationRetryResult = { ok: true; result: MailDeliveryResult | "already_delivered" } | { ok: false; message: string };

// An explicit Admin retry: one Brevo submission now, ignoring backoff, with the
// same idempotency key. A row another request is sending is left alone.
export async function retryAdminNotification(input: unknown, reader?: Client): Promise<AdminNotificationRetryResult> {
  const actor = await requireActiveAdmin(reader ?? await createClient());
  const parsed = z.strictObject({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Choose a valid notification." };
  try {
    const result = await deliverBookingNotification(parsed.data.id);
    logger.info({ event: "notifications.admin_retry", actorId: actor.userId, deliveryId: parsed.data.id, result }, "Admin retried notification");
    if (result) return { ok: true, result };
    const state = await findBookingNotificationState((await getDataSource()).manager, parsed.data.id);
    if (state?.delivered) return { ok: true, result: "already_delivered" };
    return { ok: false, message: state ? "This email is being sent right now. Check again in a few minutes." : "This notification no longer exists." };
  } catch {
    logger.error({ event: "notifications.admin_retry_failed", actorId: actor.userId, deliveryId: parsed.data.id }, "Admin notification retry failed");
    return { ok: false, message: "Unable to retry this email. Try again." };
  }
}
