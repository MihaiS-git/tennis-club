import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { getDataSource } from "@/lib/db/data-source";
import { findBookingNotificationState, listUndeliveredBookingNotifications } from "@/lib/db/repositories/booking-notifications.repository";
import { logger } from "@/lib/logger";
import type { MailDeliveryResult } from "@/lib/mail/brevo";
import { createClient } from "@/lib/supabase/server";
import { deliverBookingNotification } from "./booking-delivery";

type Client = Awaited<ReturnType<typeof createClient>>;

export const adminNotificationsPageSize = 25;
const pageSchema = z.coerce.number().int().min(1).max(10_000).catch(1);

// Every booking email Brevo has not accepted, including ones never attempted yet,
// one page at a time. Unacknowledged financial exceptions always come first.
export async function listAdminUndeliveredNotifications(input: { page?: unknown } = {}, reader?: Client) {
  await requireActiveAdmin(reader ?? await createClient());
  const manager = (await getDataSource()).manager;
  const requested = pageSchema.parse(input.page ?? 1);
  let result = await listUndeliveredBookingNotifications(manager,
    { limit: adminNotificationsPageSize, offset: (requested - 1) * adminNotificationsPageSize });
  const totalPages = Math.max(1, Math.ceil(result.total / adminNotificationsPageSize));
  const page = Math.min(requested, totalPages);
  // A page beyond the end (rows were delivered meanwhile) shows the last page.
  if (page !== requested) result = await listUndeliveredBookingNotifications(manager,
    { limit: adminNotificationsPageSize, offset: (page - 1) * adminNotificationsPageSize });
  return { rows: result.rows, total: result.total, unacknowledgedExceptions: result.unacknowledged_exceptions, page, totalPages };
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
