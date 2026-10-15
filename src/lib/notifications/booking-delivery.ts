import "server-only";

import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import { z } from "zod";
import { inTransaction } from "@/lib/db/transaction";
import { renderBookingEmail, type BookingEmailEvent } from "./booking-email";
import { deliverMail } from "@/lib/mail/brevo";
import { logger } from "@/lib/logger";

// A focused booking-email outbox. The caller owns the financial transaction.
export async function enqueueBookingNotification(manager: EntityManager, key: string, event: BookingEmailEvent) {
  if (!manager.queryRunner?.isTransactionActive) throw new Error("Booking notification requires the state-change transaction");
  await manager.query(`INSERT INTO public.booking_notification_deliveries (event_key,message)
    VALUES ($1,$2::jsonb) ON CONFLICT (event_key) DO NOTHING`, [key, JSON.stringify(renderBookingEmail(event))]);
}

const deliverySchema = z.object({ id: z.uuid(), attempts: z.number().int(), message: z.object({
  to: z.email(), subject: z.string(), text: z.string(),
}) });

export async function deliverPendingBookingNotifications(deadline: number) {
  let checked = 0;
  let failed = 0;
  while (checked < 25 && Date.now() < deadline) {
    const token = randomUUID();
    const item = await inTransaction(async manager => {
      const rows: unknown = await manager.query(`WITH candidate AS (
        SELECT id FROM public.booking_notification_deliveries WHERE delivered_at IS NULL
          AND next_attempt_at <= clock_timestamp() AND (lease_until IS NULL OR lease_until <= clock_timestamp())
        ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1),
        claimed AS (UPDATE public.booking_notification_deliveries d SET lease_token=$1, lease_until=clock_timestamp()+interval '5 minutes',
          attempts=attempts+1 FROM candidate c WHERE d.id=c.id RETURNING d.id,d.message,d.attempts)
        SELECT id,message,attempts FROM claimed`, [token]);
      return z.array(deliverySchema).parse(rows)[0];
    });
    if (!item) break;
    checked++;
    // Stable provider key limits duplicates within Brevo's retention window.
    // Ambiguous outcomes are retried: durable at-least-once submission, not exactly-once email.
    const accepted = await deliverMail(item.message, item.id);
    if (!accepted) failed++;
    await inTransaction(async manager => {
      await manager.query(`UPDATE public.booking_notification_deliveries SET
        delivered_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,
        last_error=CASE WHEN $3 THEN NULL ELSE 'delivery_unconfirmed' END,
        next_attempt_at=clock_timestamp()+($4 * interval '1 second'), lease_token=NULL,lease_until=NULL
        WHERE id=$1 AND lease_token=$2`, [item.id, token, accepted, Math.min(3600, 60 * 2 ** Math.min(item.attempts, 6))]);
    });
    if (!accepted) logger.warn({ event: "booking_email.delivery_deferred", deliveryId: item.id }, "Durable notification will retry");
  }
  return { checked, failed };
}
