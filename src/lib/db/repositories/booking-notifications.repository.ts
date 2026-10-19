import "server-only";

import type { EntityManager } from "typeorm";
import { z } from "zod";
import { inboxPageSize, type InboxQuery } from "@/lib/notifications/inbox-query";

const messageSchema = z.object({ to: z.email(), subject: z.string(), text: z.string() });
type NotificationMessage = z.infer<typeof messageSchema>;

// Written inside the caller's state-change transaction; an event key is sent once.
export async function insertBookingNotification(manager: EntityManager, input: {
  key: string; message: NotificationMessage; bookingId: string; requiresAcknowledgement: boolean; eventKind: string; occurredAt?: Date | string;
}) {
  await manager.query(`WITH delivery AS (
    INSERT INTO public.booking_notification_deliveries (event_key,message,booking_id,requires_acknowledgement,created_at)
    VALUES ($1,$2::jsonb,$3,$4,COALESCE($6::timestamptz,clock_timestamp())) ON CONFLICT (event_key) DO NOTHING RETURNING *)
    INSERT INTO public.customer_notifications
      (id,event_key,account_user_id,booking_id,event_kind,subject,text,created_at,requires_acknowledgement)
    SELECT d.id,d.event_key,b.account_user_id,b.id,$5,d.message->>'subject',d.message->>'text',d.created_at,d.requires_acknowledgement
    FROM delivery d JOIN public.bookings b ON b.id=d.booking_id WHERE b.account_user_id IS NOT NULL
    ON CONFLICT (event_key) DO NOTHING`,
  [input.key, JSON.stringify(input.message), input.bookingId, input.requiresAcknowledgement, input.eventKind,input.occurredAt ?? null]);
}

// A short lease keeps concurrent deliveries from sending one row twice. With an
// id (explicit Admin retry) the backoff is ignored, never a live lease. A row an
// Admin dismissed is never sent again.
// A claimable row carries provider evidence only when Brevo reported its last
// submission as failed. Its next submission gets a new key, so Brevo does not
// deduplicate it into the failed message, and events of the old message no longer match.
export async function claimDueBookingNotification(manager: EntityManager, token: string, id?: string) {
  const rows: unknown = await manager.query(`WITH candidate AS (
    SELECT id FROM public.booking_notification_deliveries WHERE delivered_at IS NULL AND dismissed_at IS NULL
      AND ($2::uuid IS NULL AND next_attempt_at <= clock_timestamp() OR id=$2::uuid)
      AND (lease_until IS NULL OR lease_until <= clock_timestamp())
    ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1),
    claimed AS (UPDATE public.booking_notification_deliveries d SET lease_token=$1, lease_until=clock_timestamp()+interval '5 minutes',
      attempts=attempts+1,
      submission_key=CASE WHEN d.provider_message_id IS NOT NULL OR d.provider_status IS NOT NULL THEN gen_random_uuid() ELSE d.submission_key END,
      provider_message_id=NULL,provider_status=NULL,provider_event=NULL,provider_reason=NULL,provider_event_at=NULL
      FROM candidate c WHERE d.id=c.id RETURNING d.id,d.message,d.attempts,COALESCE(d.submission_key,d.id) AS submission_key)
    SELECT id,message,attempts,submission_key FROM claimed`, [token, id ?? null]);
  return z.array(z.object({ id: z.uuid(), attempts: z.number().int(), message: messageSchema, submission_key: z.uuid() })).parse(rows)[0];
}

// lastError null records acceptance; otherwise the exact delivery failure kind.
// retrySeconds null stops automatic retries (permanent or exhausted); the row
// stays undelivered and only an explicit Admin retry submits it again.
// A Brevo event for this submission may arrive before its API answer is
// recorded; that provider evidence is authoritative and kept, only the lease ends.
export async function recordBookingNotificationDelivery(manager: EntityManager, input: {
  id: string; token: string; lastError: string | null; retrySeconds: number | null; messageId?: string | null;
}) {
  await manager.query(`UPDATE public.booking_notification_deliveries SET
    delivered_at=CASE WHEN provider_status IS NOT NULL THEN delivered_at WHEN $3::text IS NULL THEN clock_timestamp() ELSE NULL END,
    last_error=CASE WHEN provider_status IS NOT NULL THEN last_error ELSE $3::text END,
    next_attempt_at=CASE WHEN provider_status IS NOT NULL THEN next_attempt_at WHEN $4::integer IS NULL THEN 'infinity'::timestamptz
      ELSE clock_timestamp()+($4::integer * interval '1 second') END,
    provider_message_id=COALESCE(provider_message_id,$5::text),
    lease_token=NULL,lease_until=NULL
    WHERE id=$1 AND lease_token=$2`, [input.id, input.token, input.lastError, input.retrySeconds, input.messageId ?? null]);
}

// The delivery a Brevo event belongs to: the current submission's recorded
// message id or, before that id is recorded, the current submission key echoed
// through X-Mailin-custom. Earlier submissions and dismissed rows match neither and are unknown.
export async function lockDeliveryForProviderEvent(manager: EntityManager, input: { messageId: string; submissionKey: string | null }) {
  const rows: unknown = await manager.query(`SELECT id,provider_status,
      CASE WHEN provider_event_at IS NULL THEN NULL ELSE round(extract(epoch FROM provider_event_at)*1000)::float8 END AS provider_event_at
    FROM public.booking_notification_deliveries
    WHERE (provider_message_id=$1 OR $2::uuid IS NOT NULL AND provider_message_id IS NULL
      AND (submission_key=$2::uuid OR submission_key IS NULL AND id=$2::uuid)) AND dismissed_at IS NULL
    ORDER BY provider_message_id IS NULL LIMIT 1 FOR UPDATE`, [input.messageId, input.submissionKey]);
  return z.array(z.object({ id: z.uuid(), provider_status: z.enum(["deferred", "delivered", "failed"]).nullable(),
    provider_event_at: z.number().nullable() })).max(1).parse(rows)[0] ?? null;
}

// Persists a provider outcome the delivery service decided to apply. A failure
// makes the row undelivered and stopped (only an explicit retry resends it);
// any other event proves Brevo accepted the message.
export async function recordProviderDeliveryEvent(manager: EntityManager, input: {
  id: string; messageId: string; status: "deferred" | "delivered" | "failed"; event: string; reason: string | null; occurredAt: number;
}) {
  await manager.query(`UPDATE public.booking_notification_deliveries SET
    provider_message_id=COALESCE(provider_message_id,$2),provider_status=$3,provider_event=$4,provider_reason=$5,
    provider_event_at=to_timestamp($6::float8/1000),
    delivered_at=CASE WHEN $3='failed' THEN NULL ELSE COALESCE(delivered_at,clock_timestamp()) END,
    last_error=CASE WHEN $3='failed' THEN $4 END,
    next_attempt_at=CASE WHEN $3='failed' THEN 'infinity'::timestamptz ELSE next_attempt_at END
    WHERE id=$1`, [input.id, input.messageId, input.status, input.event, input.reason, input.occurredAt]);
}

const deliveryStateSchema = z.object({ id: z.uuid(), booking_id: z.uuid().nullable(), recipient: z.string(), subject: z.string(),
  attempts: z.number().int(), last_error: z.string().nullable(), important: z.boolean(),
  failure_reason: z.string().nullable(), failed_at: z.iso.datetime({ offset: true }).nullable(),
  created_at: z.iso.datetime({ offset: true }), next_attempt_at: z.iso.datetime({ offset: true }).nullable() });
const iso = (column: string) => `CASE WHEN isfinite(${column}) THEN replace((${column} AT TIME ZONE 'UTC')::text,' ','T') || '+00:00' END`;

// Unacknowledged financial exceptions sort before every ordinary message, so no
// number of ordinary failed emails can push one off the first page or list.
const priority = "(requires_acknowledgement AND acknowledged_at IS NULL)";

// Delivery state, derived from the outbox columns (see notificationStates).
const state = `CASE WHEN lease_until > clock_timestamp() THEN 'sending' WHEN provider_status='failed' THEN 'failed'
  WHEN NOT isfinite(next_attempt_at) THEN 'stopped' WHEN last_error IS NOT NULL THEN 'retrying' ELSE 'queued' END`;
const sortColumns = { created: "created_at", attempts: "attempts", next_retry: "next_attempt_at",
  status: `array_position(ARRAY['queued','sending','retrying','stopped','failed'],${state})` } as const;

export type AdminNotificationFilters = {
  search: string; state: string | null; subject: string | null; from: string | null; to: string | null; timezone: string;
  sort: keyof typeof sortColumns; direction: "asc" | "desc"; limit: number; offset: number;
};

// Brevo's failure report for the current submission (state failed).
const failure = `CASE WHEN provider_status='failed' THEN provider_reason END AS failure_reason,
  CASE WHEN provider_status='failed' THEN ${iso("provider_event_at")} END AS failed_at`;

// Admin visibility: every message not yet accepted by Brevo, or whose delivery Brevo reported as failed, and not
// dismissed by an Admin, filtered, sorted and
// paginated in the database. Unacknowledged exceptions stay first in every order;
// the unique id makes page order stable.
export async function listAdminBookingNotifications(manager: EntityManager, input: AdminNotificationFilters) {
  const pattern = input.search ? `%${input.search.replace(/[\\%_]/g, (match) => `\\${match}`)}%` : "";
  const where = `delivered_at IS NULL AND dismissed_at IS NULL
    AND ($1::text = '' OR message->>'to' ILIKE $1 OR message->>'subject' ILIKE $1 OR booking_id::text ILIKE $1)
    AND ($2::text IS NULL OR ${state} = $2) AND ($3::text IS NULL OR message->>'subject' = $3)
    AND ($4::date IS NULL OR created_at >= ($4::date)::timestamp AT TIME ZONE $6)
    AND ($5::date IS NULL OR created_at < ($5::date + 1)::timestamp AT TIME ZONE $6)`;
  const filters = [pattern, input.state, input.subject, input.from, input.to, input.timezone];
  const direction = input.direction === "asc" ? "ASC" : "DESC";
  const rows: unknown = await manager.query(`SELECT id,booking_id,message->>'to' AS recipient,message->>'subject' AS subject,
      (SELECT u.id FROM public.bookings b JOIN public.users u ON u.id=b.account_user_id
        WHERE b.id=booking_notification_deliveries.booking_id) AS account_user_id,
      attempts,last_error,requires_acknowledgement AS important,${state} AS state,${failure},
      ${iso("created_at")} AS created_at,${iso("next_attempt_at")} AS next_attempt_at
    FROM public.booking_notification_deliveries WHERE ${where}
    ORDER BY ${priority} DESC,${sortColumns[input.sort]} ${direction},created_at DESC,id DESC LIMIT $7 OFFSET $8`,
  [...filters, input.limit, input.offset]);
  const [counts]: unknown[] = await manager.query(`SELECT count(*) FILTER (WHERE ${where})::int AS total,
      count(*) FILTER (WHERE delivered_at IS NULL AND dismissed_at IS NULL AND ${priority})::int AS unacknowledged_exceptions
    FROM public.booking_notification_deliveries`, filters);
  return { rows: z.array(deliveryStateSchema.extend({ account_user_id: z.uuid().nullable(),
    state: z.enum(["queued", "sending", "retrying", "stopped", "failed"]) })).parse(rows),
    ...z.object({ total: z.number().int(), unacknowledged_exceptions: z.number().int() }).parse(counts) };
}

// Admin navbar attention: an undelivered row an Admin must act on, i.e. one whose
// automatic retries have stopped, whose delivery Brevo reported as failed, or an
// unacknowledged financial exception. Rows still queued, sending or retrying
// automatically, accepted rows awaiting confirmation, dismissed rows and delivered history do not count.
export async function hasAdminNotificationAlerts(manager: EntityManager) {
  const rows: unknown = await manager.query(`SELECT EXISTS(SELECT 1 FROM public.booking_notification_deliveries
    WHERE delivered_at IS NULL AND dismissed_at IS NULL AND (${state} IN ('stopped','failed') OR ${priority})) AS alerts`);
  return z.array(z.object({ alerts: z.boolean() })).length(1).parse(rows)[0].alerts;
}

// Removes undelivered rows whose automatic retries have stopped (including
// Brevo-reported failures) with no live lease from Admin email management.
// All types are dismissed permanently: the event key prevents reconstruction
// from resending ordinary emails as well as retaining financial acknowledgments.
// Later Brevo events for dismissed rows match nothing, so they cannot
// restore a row. The conditions are evaluated by the statement itself, so a row
// claimed, retried or delivered after the Admin selected it is left untouched.
export async function deleteStoppedBookingNotifications(manager: EntityManager, ids: readonly string[]) {
  const eligible = `id = ANY($1::uuid[]) AND delivered_at IS NULL AND dismissed_at IS NULL
      AND NOT isfinite(next_attempt_at) AND (lease_until IS NULL OR lease_until <= clock_timestamp())`;
  const rows: unknown = await manager.query(`WITH dismissed AS (
    UPDATE public.booking_notification_deliveries SET dismissed_at=clock_timestamp()
      WHERE ${eligible} RETURNING id) SELECT id FROM dismissed`, [ids]);
  return z.array(z.object({ id: z.uuid() })).parse(rows).map(({ id }) => id);
}

export async function findBookingNotificationState(manager: EntityManager, id: string) {
  const rows: unknown = await manager.query(`SELECT id,booking_id,message->>'to' AS recipient,message->>'subject' AS subject,
      attempts,last_error,requires_acknowledgement AS important,${failure},${iso("created_at")} AS created_at,${iso("next_attempt_at")} AS next_attempt_at,
      delivered_at IS NOT NULL AS delivered
    FROM public.booking_notification_deliveries WHERE id=$1 AND dismissed_at IS NULL`, [id]);
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
  if (!manager.queryRunner?.isTransactionActive) throw new Error("Acknowledgment requires a transaction");
  // Delivery before inbox, shared with repair. The following statements get fresh
  // READ COMMITTED snapshots after waiting for a concurrent repair to commit.
  await manager.query(`SELECT d.id FROM public.booking_notification_deliveries d
    JOIN public.bookings b ON b.id=d.booking_id WHERE d.id=$1 AND b.account_user_id=$2 FOR UPDATE OF d`,
  [input.id, input.accountUserId]);
  const rows: unknown = await manager.query(`WITH changed AS (UPDATE public.booking_notification_deliveries d SET acknowledged_at=clock_timestamp()
    FROM public.bookings b WHERE d.id=$1 AND b.id=d.booking_id AND b.account_user_id=$2
      AND d.requires_acknowledgement AND d.acknowledged_at IS NULL RETURNING d.id)
    SELECT id FROM changed`, [input.id, input.accountUserId]);
  const changed = z.array(z.object({ id: z.uuid() })).parse(rows).length === 1;
  if (!changed) return false;
  await manager.query(`UPDATE public.customer_notifications n
    SET read_at=COALESCE(n.read_at,d.acknowledged_at),acknowledged_at=COALESCE(n.acknowledged_at,d.acknowledged_at)
    FROM public.booking_notification_deliveries d WHERE n.id=$1 AND d.id=n.id
      AND n.account_user_id=$2 AND d.acknowledged_at IS NOT NULL`, [input.id, input.accountUserId]);
  return true;
}

// Customer history has its own lifetime and never exposes delivery diagnostics.
const customerNoticeSchema = z.object({ id: z.uuid(), booking_id: z.uuid(), event_kind: z.string(), subject: z.string(), text: z.string(),
  important: z.boolean(), created_at: z.iso.datetime({ offset: true }), read_at: z.iso.datetime({ offset: true }).nullable(),
  acknowledged_at: z.iso.datetime({ offset: true }).nullable() });
export async function listCustomerNotifications(manager: EntityManager, accountUserId: string, query: InboxQuery) {
  const pattern = query.q ? `%${query.q.replace(/[\\%_]/g, match => `\\${match}`)}%` : "";
  const where = `account_user_id=$1 AND deleted_at IS NULL
    AND ($2::text='' OR subject ILIKE $2 OR text ILIKE $2)
    AND ($3='all' OR $3='read' AND read_at IS NOT NULL OR $3='unread' AND read_at IS NULL)
    AND ($4='all' OR event_kind=$4)`;
  const filters = [accountUserId, pattern, query.status, query.type];
  const [count]: unknown[] = await manager.query(`SELECT count(*)::int AS total FROM public.customer_notifications WHERE ${where}`, filters);
  const { total } = z.object({ total: z.number().int().nonnegative() }).parse(count);
  const totalPages = Math.max(1, Math.ceil(total / inboxPageSize));
  const page = Math.min(query.page, totalPages);
  const direction = query.sort === "oldest" ? "ASC" : "DESC";
  const rows: unknown = await manager.query(`SELECT id,booking_id,event_kind,subject,text,requires_acknowledgement AS important,
      ${iso("created_at")} AS created_at,${iso("read_at")} AS read_at,${iso("acknowledged_at")} AS acknowledged_at
    FROM public.customer_notifications WHERE ${where}
    ORDER BY created_at ${direction},id ${direction} LIMIT $5 OFFSET $6`, [...filters, inboxPageSize, (page - 1) * inboxPageSize]);
  return { notices: z.array(customerNoticeSchema).parse(rows), total, totalPages, query: { ...query, page } };
}

export async function findCustomerNotification(manager: EntityManager, accountUserId: string, id: string) {
  const rows: unknown = await manager.query(`SELECT id,booking_id,event_kind,subject,text,requires_acknowledgement AS important,
      ${iso("created_at")} AS created_at,${iso("read_at")} AS read_at,${iso("acknowledged_at")} AS acknowledged_at
    FROM public.customer_notifications WHERE id=$1 AND account_user_id=$2 AND deleted_at IS NULL`, [id, accountUserId]);
  return z.array(customerNoticeSchema).max(1).parse(rows)[0] ?? null;
}

export async function hasUnreadCustomerNotifications(manager: EntityManager, accountUserId: string) {
  const rows: unknown = await manager.query(`SELECT EXISTS(SELECT 1 FROM public.customer_notifications
    WHERE account_user_id=$1 AND deleted_at IS NULL AND read_at IS NULL) AS unread`, [accountUserId]);
  return z.array(z.object({ unread: z.boolean() })).length(1).parse(rows)[0].unread;
}

export type InboxOperation = "read" | "unread" | "delete";
export async function manageCustomerNotifications(manager: EntityManager, input: {
  ids: string[]; accountUserId: string; operation: InboxOperation;
}) {
  // Only an inbox column changes. Financial acknowledgement remains an explicit separate command.
  const assignment = input.operation === "delete" ? "deleted_at=clock_timestamp()"
    : input.operation === "unread" ? "read_at=NULL" : "read_at=COALESCE(read_at,clock_timestamp())";
  const rows: unknown = await manager.query(`WITH changed AS (UPDATE public.customer_notifications SET ${assignment}
    WHERE id=ANY($1::uuid[]) AND account_user_id=$2 AND deleted_at IS NULL RETURNING id) SELECT id FROM changed`, [input.ids, input.accountUserId]);
  return z.array(z.object({ id: z.uuid() })).parse(rows).map(row => row.id);
}
