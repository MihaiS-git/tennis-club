import "server-only";

import type { EntityManager } from "typeorm";
import { z } from "zod";

const messageSchema = z.object({ to: z.email(), subject: z.string(), text: z.string() });
type NotificationMessage = z.infer<typeof messageSchema>;

// Written inside the caller's state-change transaction; an event key is sent once.
export async function insertBookingNotification(manager: EntityManager, input: {
  key: string; message: NotificationMessage; bookingId: string; requiresAcknowledgement: boolean;
}) {
  await manager.query(`INSERT INTO public.booking_notification_deliveries (event_key,message,booking_id,requires_acknowledgement)
    VALUES ($1,$2::jsonb,$3,$4) ON CONFLICT (event_key) DO NOTHING`,
  [input.key, JSON.stringify(input.message), input.bookingId, input.requiresAcknowledgement]);
}

// A short lease keeps concurrent deliveries from sending one row twice. With an
// id (explicit Admin retry) the backoff is ignored, never a live lease.
export async function claimDueBookingNotification(manager: EntityManager, token: string, id?: string) {
  const rows: unknown = await manager.query(`WITH candidate AS (
    SELECT id FROM public.booking_notification_deliveries WHERE delivered_at IS NULL
      AND ($2::uuid IS NULL AND next_attempt_at <= clock_timestamp() OR id=$2::uuid)
      AND (lease_until IS NULL OR lease_until <= clock_timestamp())
    ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1),
    claimed AS (UPDATE public.booking_notification_deliveries d SET lease_token=$1, lease_until=clock_timestamp()+interval '5 minutes',
      attempts=attempts+1 FROM candidate c WHERE d.id=c.id RETURNING d.id,d.message,d.attempts)
    SELECT id,message,attempts FROM claimed`, [token, id ?? null]);
  return z.array(z.object({ id: z.uuid(), attempts: z.number().int(), message: messageSchema })).parse(rows)[0];
}

// lastError null records acceptance; otherwise the exact delivery failure kind.
// retrySeconds null stops automatic retries (permanent or exhausted); the row
// stays undelivered and only an explicit Admin retry submits it again.
export async function recordBookingNotificationDelivery(manager: EntityManager, input: {
  id: string; token: string; lastError: string | null; retrySeconds: number | null;
}) {
  await manager.query(`UPDATE public.booking_notification_deliveries SET
    delivered_at=CASE WHEN $3::text IS NULL THEN clock_timestamp() ELSE NULL END, last_error=$3::text,
    next_attempt_at=CASE WHEN $4::integer IS NULL THEN 'infinity'::timestamptz ELSE clock_timestamp()+($4::integer * interval '1 second') END,
    lease_token=NULL,lease_until=NULL
    WHERE id=$1 AND lease_token=$2`, [input.id, input.token, input.lastError, input.retrySeconds]);
}

const deliveryStateSchema = z.object({ id: z.uuid(), booking_id: z.uuid().nullable(), recipient: z.string(), subject: z.string(),
  attempts: z.number().int(), last_error: z.string().nullable(), important: z.boolean(),
  created_at: z.iso.datetime({ offset: true }), next_attempt_at: z.iso.datetime({ offset: true }).nullable() });
const iso = (column: string) => `CASE WHEN isfinite(${column}) THEN replace((${column} AT TIME ZONE 'UTC')::text,' ','T') || '+00:00' END`;

// Unacknowledged financial exceptions sort before every ordinary message, so no
// number of ordinary failed emails can push one off the first page or list.
const priority = "(requires_acknowledgement AND acknowledged_at IS NULL)";

// Admin visibility: every message not yet accepted by Brevo, one page at a time.
// Exceptions first, then newest first; the unique id makes page order stable.
export async function listUndeliveredBookingNotifications(manager: EntityManager, input: { limit: number; offset: number }) {
  const rows: unknown = await manager.query(`SELECT id,booking_id,message->>'to' AS recipient,message->>'subject' AS subject,
      attempts,last_error,requires_acknowledgement AS important,${iso("created_at")} AS created_at,${iso("next_attempt_at")} AS next_attempt_at
    FROM public.booking_notification_deliveries WHERE delivered_at IS NULL
    ORDER BY ${priority} DESC,created_at DESC,id DESC LIMIT $1 OFFSET $2`, [input.limit, input.offset]);
  const [counts]: unknown[] = await manager.query(`SELECT count(*)::int AS total,count(*) FILTER (WHERE ${priority})::int AS unacknowledged_exceptions
    FROM public.booking_notification_deliveries WHERE delivered_at IS NULL`);
  return { rows: z.array(deliveryStateSchema).parse(rows),
    ...z.object({ total: z.number().int(), unacknowledged_exceptions: z.number().int() }).parse(counts) };
}

export async function findBookingNotificationState(manager: EntityManager, id: string) {
  const rows: unknown = await manager.query(`SELECT id,booking_id,message->>'to' AS recipient,message->>'subject' AS subject,
      attempts,last_error,requires_acknowledgement AS important,${iso("created_at")} AS created_at,${iso("next_attempt_at")} AS next_attempt_at,
      delivered_at IS NOT NULL AS delivered
    FROM public.booking_notification_deliveries WHERE id=$1`, [id]);
  return z.array(deliveryStateSchema.extend({ delivered: z.boolean() })).max(1).parse(rows)[0] ?? null;
}

// Ownership is the booking's permanent account; guest bookings have no in-app notices.
// Important notices stay until acknowledged. Any other message whose email failed
// is shown until it is delivered (for 30 days), so a failure is never silent.
export async function listUnacknowledgedBookingNotices(manager: EntityManager, accountUserId: string) {
  const rows: unknown = await manager.query(`SELECT d.id,d.message->>'subject' AS subject,d.message->>'text' AS text,
      d.requires_acknowledgement AS important,d.delivered_at IS NULL AND d.last_error IS NOT NULL AS email_failed
    FROM public.booking_notification_deliveries d JOIN public.bookings b ON b.id=d.booking_id
    WHERE b.account_user_id=$1 AND (d.requires_acknowledgement AND d.acknowledged_at IS NULL
      OR NOT d.requires_acknowledgement AND d.delivered_at IS NULL AND d.last_error IS NOT NULL
        AND d.created_at > clock_timestamp()-interval '30 days')
    ORDER BY d.requires_acknowledgement AND d.acknowledged_at IS NULL DESC,d.created_at,d.id LIMIT 20`, [accountUserId]);
  return z.array(z.object({ id: z.uuid(), subject: z.string(), text: z.string(), important: z.boolean(), email_failed: z.boolean() })).parse(rows);
}

export async function acknowledgeBookingNotice(manager: EntityManager, input: { id: string; accountUserId: string }) {
  const rows: unknown = await manager.query(`WITH changed AS (UPDATE public.booking_notification_deliveries d SET acknowledged_at=clock_timestamp()
    FROM public.bookings b WHERE d.id=$1 AND b.id=d.booking_id AND b.account_user_id=$2
      AND d.requires_acknowledgement AND d.acknowledged_at IS NULL RETURNING d.id) SELECT id FROM changed`, [input.id, input.accountUserId]);
  return z.array(z.object({ id: z.uuid() })).parse(rows).length === 1;
}
