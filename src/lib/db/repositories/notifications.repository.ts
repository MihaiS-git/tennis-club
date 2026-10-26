import "server-only";

import { IsNull, type EntityManager } from "typeorm";
import { z } from "zod";
import { EmailDeliveryEntity } from "../entities/email-delivery.entity";
import { UserMessageEntity } from "../entities/user-message.entity";
import { UserRoleEntity } from "../entities/user-role.entity";
import { UserEntity } from "../entities/user.entity";
import type { BookingContext } from "@/lib/notifications/content";
import { definitiveRejectionPattern } from "@/lib/notifications/delivery-retry";
import type { InboxQuery } from "@/lib/notifications/inbox-query";
import type { NotificationAccount } from "@/lib/notifications/types";

type NewUserMessage = Omit<UserMessageEntity, "readAt" | "deletedAt">;

export async function insertUserMessage(manager: EntityManager, message: NewUserMessage) {
  await manager.getRepository(UserMessageEntity).createQueryBuilder().insert().values({ ...message, readAt: null, deletedAt: null })
    .orIgnore().execute();
}

const userMessageBatchSize = 1000;

// Each row conflicts independently on (user_id, event_key), exactly as single-row inserts do.
export async function insertUserMessages(manager: EntityManager, messages: readonly NewUserMessage[]) {
  for (let offset = 0; offset < messages.length; offset += userMessageBatchSize) {
    await manager.getRepository(UserMessageEntity).createQueryBuilder().insert()
      .values(messages.slice(offset, offset + userMessageBatchSize).map((message) => ({ ...message, readAt: null, deletedAt: null })))
      .orIgnore().execute();
  }
}

export async function insertEmailDelivery(manager: EntityManager, delivery: EmailDeliveryEntity) {
  await manager.getRepository(EmailDeliveryEntity).createQueryBuilder().insert().values(delivery).orIgnore().execute();
}

const accountRows = z.array(z.object({
  user_id: z.uuid(), email: z.string(), auth_email: z.string().nullable(),
  email_confirmed: z.boolean(), active: z.boolean(), role_code: z.string().nullable(),
}));

// Matches either the account or the Auth email; channel policy decides which matches qualify.
export async function findNotificationAccounts(manager: EntityManager, email: string): Promise<NotificationAccount[]> {
  const rows: unknown = await manager.query(`
    SELECT u.id AS user_id, u.email, a.email AS auth_email,
      (a.email_confirmed_at IS NOT NULL) AS email_confirmed, (u.status = 'active') AS active, r.role_code
    FROM public.users u
    JOIN auth.users a ON a.id = u.id
    LEFT JOIN public.user_roles r ON r.user_id = u.id
    WHERE lower(u.email) = lower($1) OR lower(a.email) = lower($1)
    ORDER BY u.id, r.role_code`, [email]);
  const accounts = new Map<string, NotificationAccount>();
  for (const row of accountRows.parse(rows)) {
    const account = accounts.get(row.user_id) ?? { userId: row.user_id, email: row.email,
      authEmail: row.auth_email, emailConfirmed: row.email_confirmed, active: row.active, roles: [] };
    if (row.role_code) account.roles.push(row.role_code);
    accounts.set(row.user_id, account);
  }
  return [...accounts.values()];
}

function activeRoleUsers(manager: EntityManager, roleCode: string) {
  return manager.getRepository(UserEntity).createQueryBuilder("account").select("account.id")
    .innerJoin(UserRoleEntity, "role", "role.userId = account.id")
    .where("account.status = 'active' AND role.roleCode = :roleCode", { roleCode });
}

export function hasActiveUserRole(manager: EntityManager, userId: string, roleCode: string) {
  return activeRoleUsers(manager, roleCode).andWhere("account.id = :userId", { userId }).getExists();
}

export async function listActiveUserIdsWithRole(manager: EntityManager, roleCode: string): Promise<string[]> {
  const users = await activeRoleUsers(manager, roleCode).orderBy("account.id").getMany();
  return users.map((user) => user.id);
}

const currency = z.enum(["EUR", "USD", "GBP", "RON", "CHF"]);
const bookingContextRow = z.object({ location_name: z.string(), court_name: z.string(), booking_date: z.iso.date(),
  starts_at_minute: z.number().int(), ends_at_minute: z.number().int(), timezone: z.string(),
  coaching_program_name: z.string().nullable(), coach_name: z.string().nullable() });

function bookingContext(row: z.infer<typeof bookingContextRow>): BookingContext {
  return { locationName: row.location_name, courtName: row.court_name, bookingDate: row.booking_date,
    startMinute: row.starts_at_minute, endMinute: row.ends_at_minute, timezone: row.timezone,
    coachingProgramName: row.coaching_program_name, coachName: row.coach_name };
}

const exceptionRow = bookingContextRow.extend({ event_key: z.string(), kind: z.string(), booking_id: z.uuid(),
  customer_email: z.string(), currency, amount_minor: z.number().nullable(), occurred_at: z.date() });

export type FinancialExceptionNotificationFact = {
  eventKey: string; kind: string; bookingId: string; customerEmail: string; currency: z.infer<typeof currency>;
  amountMinor: number | null; occurredAt: Date; booking: BookingContext;
};

// Booking context comes from the referenced historical revision, never the current booking.
export async function findFinancialExceptionNotificationFact(manager: EntityManager, eventKey: string):
  Promise<FinancialExceptionNotificationFact | null> {
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
    WHERE e.event_key=$1`, [eventKey]);
  const row = z.array(exceptionRow).parse(rows)[0];
  return row ? { eventKey: row.event_key, kind: row.kind, bookingId: row.booking_id, customerEmail: row.customer_email,
    currency: row.currency, amountMinor: row.amount_minor, occurredAt: row.occurred_at, booking: bookingContext(row) } : null;
}

const refundRow = bookingContextRow.extend({ id: z.uuid(), booking_id: z.uuid(), reason: z.string(),
  amount_minor: z.number(), currency, customer_email: z.string() });

export type SucceededRefundNotificationFact = {
  refundId: string; bookingId: string; reason: string; amountMinor: number; currency: z.infer<typeof currency>;
  customerEmail: string; booking: BookingContext;
};

export async function findSucceededRefundNotificationFact(manager: EntityManager, refundId: string, executionId: string):
  Promise<SucceededRefundNotificationFact | null> {
  const rows: unknown = await manager.query(`SELECT f.id, f.booking_id, f.reason, f.amount_minor, f.currency, v.customer_email,
      v.location_name, v.court_name, v.booking_date::text AS booking_date, v.starts_at_minute,
      v.ends_at_minute, v.timezone, v.coaching_program_name, v.coach_name
    FROM public.payment_refunds f JOIN public.booking_revisions v ON v.id=f.context_revision_id
    JOIN public.refund_executions x ON x.id=$2 AND x.refund_id=f.id AND x.terminal_result='succeeded'
    WHERE f.id=$1 AND f.status='succeeded'`, [refundId, executionId]);
  const row = z.array(refundRow).parse(rows)[0];
  return row ? { refundId: row.id, bookingId: row.booking_id, reason: row.reason, amountMinor: row.amount_minor,
    currency: row.currency, customerEmail: row.customer_email, booking: bookingContext(row) } : null;
}

function filteredMessages(manager: EntityManager, userId: string, query: InboxQuery) {
  const builder = manager.getRepository(UserMessageEntity).createQueryBuilder("message")
    .where("message.userId = :userId AND message.deletedAt IS NULL", { userId });
  if (query.q) builder.andWhere("(strpos(lower(message.subject), lower(:search)) > 0 OR strpos(lower(message.bodyText), lower(:search)) > 0)",
    { search: query.q });
  if (query.status !== "all") builder.andWhere(`message.readAt IS ${query.status === "unread" ? "NULL" : "NOT NULL"}`);
  if (query.category !== "all") {
    const category = query.category;
    if (category === "club") builder.andWhere(`message.kind NOT LIKE 'booking.%' AND message.kind NOT LIKE 'coaching.%'
      AND message.kind NOT LIKE 'financial.%'`);
    else builder.andWhere("message.kind LIKE :kindPrefix",
      { kindPrefix: `${category === "payments" ? "financial" : category === "bookings" ? "booking" : category}.%` });
  }
  return builder;
}

export function listUserMessages(manager: EntityManager, userId: string, query: InboxQuery, limit: number, offset: number) {
  const builder = filteredMessages(manager, userId, query);
  if (query.sort === "subject_asc" || query.sort === "subject_desc") {
    const direction = query.sort === "subject_asc" ? "ASC" : "DESC";
    builder.orderBy("LOWER(message.subject)", direction).addOrderBy("message.id", direction);
  } else {
    const direction = query.sort === "oldest" ? "ASC" : "DESC";
    builder.orderBy("message.createdAt", direction).addOrderBy("message.id", direction);
  }
  return builder.take(limit).skip(offset).getMany();
}

export function countUserMessages(manager: EntityManager, userId: string, query: InboxQuery) {
  return filteredMessages(manager, userId, query).getCount();
}

export function countUnreadUserMessages(manager: EntityManager, userId: string) {
  return manager.getRepository(UserMessageEntity).createQueryBuilder("message")
    .where("message.userId = :userId AND message.readAt IS NULL AND message.deletedAt IS NULL", { userId }).getCount();
}

export function findUserMessage(manager: EntityManager, userId: string, id: string) {
  return manager.getRepository(UserMessageEntity).findOneBy({ userId, id, deletedAt: IsNull() });
}

export async function markUserMessageRead(manager: EntityManager, userId: string, id: string, readAt: Date) {
  await manager.getRepository(UserMessageEntity).createQueryBuilder().update()
    .set({ readAt }).where("id = :id AND user_id = :userId AND read_at IS NULL AND deleted_at IS NULL", { id, userId }).execute();
}

export async function markUserMessageUnread(manager: EntityManager, userId: string, id: string) {
  await manager.getRepository(UserMessageEntity).createQueryBuilder().update()
    .set({ readAt: null }).where("id = :id AND user_id = :userId AND read_at IS NOT NULL AND deleted_at IS NULL", { id, userId }).execute();
}

export async function updateUserMessages(manager: EntityManager, userId: string, ids: string[], operation: "read" | "unread" | "delete") {
  // Read-state changes skip rows already in the target state so original read times are kept.
  const readState = operation === "read" ? " AND read_at IS NULL" : operation === "unread" ? " AND read_at IS NOT NULL" : "";
  const builder = manager.getRepository(UserMessageEntity).createQueryBuilder().update()
    .set(operation === "delete" ? { deletedAt: () => "clock_timestamp()" }
      : { readAt: operation === "read" ? new Date() : null })
    .where(`user_id = :userId AND deleted_at IS NULL AND id IN (:...ids)${readState}`, { userId, ids });
  const result = await builder.execute();
  return result.affected ?? 0;
}

const claimRow = z.object({ id: z.uuid(), recipient_email: z.string(), subject: z.string(),
  body_text: z.string(), body_html: z.string(), attempts: z.number().int(), locked_until: z.date() });

export type ClaimedEmail = {
  id: string; recipientEmail: string; subject: string; bodyText: string; bodyHtml: string;
  attempts: number; lockedUntil: Date;
};

export async function claimEmailDeliveries(manager: EntityManager, limit: number, notBefore: Date | null = null, selectedId: string | null = null): Promise<ClaimedEmail[]> {
  const result: unknown = await manager.query(`WITH due AS (
      SELECT id FROM public.email_deliveries
      WHERE ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
        AND provider_message_id IS NULL AND suppressed_at IS NULL
        AND (last_error IS NULL AND attempts=0 OR (last_error ~ $4 AND last_error !~ '^Brevo HTTP 408(:|$)'))
        AND (($3::uuid IS NULL AND attempts < 5 AND status='pending' AND next_attempt_at <= clock_timestamp())
          OR (id=$3::uuid AND status IN ('failed','pending') AND last_error ~ $4))
      ORDER BY next_attempt_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE public.email_deliveries e SET status='processing', attempts=e.attempts+1,
      locked_until=date_trunc('milliseconds', clock_timestamp()+interval '2 minutes'), updated_at=clock_timestamp()
    FROM due WHERE e.id=due.id
    RETURNING e.id, e.recipient_email, e.subject, e.body_text, e.body_html, e.attempts, e.locked_until`, [limit, notBefore, selectedId, definitiveRejectionPattern]);
  return z.tuple([z.array(claimRow), z.number().int()]).parse(result)[0].map((row) => ({ id: row.id, recipientEmail: row.recipient_email,
    subject: row.subject, bodyText: row.body_text, bodyHtml: row.body_html,
    attempts: row.attempts, lockedUntil: row.locked_until }));
}

export async function failExpiredFinalClaims(manager: EntityManager, limit: number): Promise<string[]> {
  const result: unknown = await manager.query(`WITH expired AS (
      SELECT id FROM public.email_deliveries WHERE status='processing'
        AND locked_until <= clock_timestamp()
      ORDER BY locked_until, id LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE public.email_deliveries e SET status='failed', locked_until=NULL,
      last_error='Delivery claim expired; provider outcome unknown', updated_at=clock_timestamp()
    FROM expired WHERE e.id=expired.id RETURNING e.id`, [limit]);
  return z.tuple([z.array(z.object({ id: z.uuid() })), z.number().int()]).parse(result)[0].map((row) => row.id);
}

export async function completeEmailAttempt(manager: EntityManager, input: {
  id: string; attempts: number; lockedUntil: Date; status: "pending" | "accepted" | "sandbox_accepted" | "failed";
  nextAttemptAt: Date; providerMessageId: string | null; lastError: string | null;
}): Promise<boolean> {
  const result: unknown = await manager.query(`UPDATE public.email_deliveries SET status=$4,
      next_attempt_at=$5, locked_until=NULL, provider_message_id=COALESCE($6, provider_message_id),
      last_error=$7, updated_at=clock_timestamp()
    WHERE id=$1 AND status='processing' AND attempts=$2 AND locked_until=$3
    RETURNING id`, [input.id, input.attempts, input.lockedUntil, input.status,
    input.nextAttemptAt, input.providerMessageId, input.lastError]);
  return z.tuple([z.array(z.object({ id: z.uuid() })), z.number().int()]).parse(result)[0].length === 1;
}

export async function failEmailFromWebhook(manager: EntityManager, input: {
  recipientEmail: string; messageId: string; deliveryId: string | null; reason: string;
}): Promise<string | null> {
  const result: unknown = await manager.query(`UPDATE public.email_deliveries SET status='failed',
      locked_until=NULL, provider_message_id=COALESCE(provider_message_id, $2),
      last_error=$4, updated_at=clock_timestamp()
    WHERE lower(recipient_email)=lower($1) AND status IN ('accepted', 'processing', 'pending')
      AND (trim(both '<>' from provider_message_id)=trim(both '<>' from $2)
        OR (id=$3 AND (provider_message_id IS NULL
          OR trim(both '<>' from provider_message_id)=trim(both '<>' from $2))))
    RETURNING id`, [input.recipientEmail, input.messageId, input.deliveryId, input.reason]);
  return z.tuple([z.array(z.object({ id: z.uuid() })), z.number().int()]).parse(result)[0][0]?.id ?? null;
}

// The persisted event key is the association for both existing and new failure alerts.
// Message text and browser-supplied delivery identifiers are never used.
export async function findMessageDelivery(manager: EntityManager, userId: string, messageId: string, lock = false) {
  const query = manager.getRepository(EmailDeliveryEntity).createQueryBuilder("delivery")
    .innerJoin(UserMessageEntity, "message", "message.event_key = 'email.delivery-failed:' || delivery.id::text")
    .where("message.id=:messageId AND message.user_id=:userId AND message.deleted_at IS NULL AND message.kind='email.delivery_failed'", { messageId, userId });
  if (lock) query.setLock("pessimistic_write", undefined, ["delivery"]);
  return query.getOne();
}

export async function findDeliveryBooking(manager: EntityManager, eventKey: string): Promise<string | null> {
  const rows: unknown = await manager.query(`SELECT booking_id FROM public.booking_revisions
      WHERE $1 IN ('booking.confirmed:' || id::text, 'booking.cancelled:' || id::text, 'booking.rescheduled:' || id::text)
    UNION SELECT booking_id FROM public.booking_financial_exceptions WHERE 'financial.customer:' || event_key=$1
    UNION SELECT f.booking_id FROM public.payment_refunds f JOIN public.refund_executions x ON x.refund_id=f.id
      WHERE 'financial.refund:' || x.id::text=$1 LIMIT 1`, [eventKey]);
  return z.array(z.object({ booking_id: z.uuid() })).parse(rows)[0]?.booking_id ?? null;
}
