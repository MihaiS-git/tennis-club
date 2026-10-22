import "server-only";

import { IsNull, type EntityManager } from "typeorm";
import { z } from "zod";
import { EmailDeliveryEntity } from "../entities/email-delivery.entity";
import { UserMessageEntity } from "../entities/user-message.entity";
import type { InboxQuery } from "@/lib/notifications/inbox-query";

export async function insertUserMessage(manager: EntityManager, message: Omit<UserMessageEntity, "readAt" | "deletedAt">) {
  await manager.getRepository(UserMessageEntity).createQueryBuilder().insert().values({ ...message, readAt: null, deletedAt: null })
    .orIgnore().execute();
}

export async function insertEmailDelivery(manager: EntityManager, delivery: EmailDeliveryEntity) {
  await manager.getRepository(EmailDeliveryEntity).createQueryBuilder().insert().values(delivery).orIgnore().execute();
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

export async function claimEmailDeliveries(manager: EntityManager, limit: number, notBefore: Date | null = null): Promise<ClaimedEmail[]> {
  const result: unknown = await manager.query(`WITH due AS (
      SELECT id FROM public.email_deliveries
      WHERE attempts < 5 AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
        AND ((status='pending' AND next_attempt_at <= clock_timestamp())
        OR (status='processing' AND locked_until <= clock_timestamp()))
      ORDER BY next_attempt_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE public.email_deliveries e SET status='processing', attempts=e.attempts+1,
      locked_until=date_trunc('milliseconds', clock_timestamp()+interval '2 minutes'), updated_at=clock_timestamp()
    FROM due WHERE e.id=due.id
    RETURNING e.id, e.recipient_email, e.subject, e.body_text, e.body_html, e.attempts, e.locked_until`, [limit, notBefore]);
  return z.tuple([z.array(claimRow), z.number().int()]).parse(result)[0].map((row) => ({ id: row.id, recipientEmail: row.recipient_email,
    subject: row.subject, bodyText: row.body_text, bodyHtml: row.body_html,
    attempts: row.attempts, lockedUntil: row.locked_until }));
}

export async function failExpiredFinalClaims(manager: EntityManager, limit: number): Promise<string[]> {
  const result: unknown = await manager.query(`WITH expired AS (
      SELECT id FROM public.email_deliveries WHERE status='processing' AND attempts >= 5
        AND locked_until <= clock_timestamp()
      ORDER BY locked_until, id LIMIT $1 FOR UPDATE SKIP LOCKED
    ) UPDATE public.email_deliveries e SET status='failed', locked_until=NULL,
      last_error='Final delivery claim expired; provider outcome unknown', updated_at=clock_timestamp()
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

export async function insertEmailFailureAlerts(manager: EntityManager, deliveryId: string, occurredAt: Date) {
  await manager.query(`INSERT INTO public.user_messages
      (id, user_id, event_key, kind, subject, body_text, href, read_at, created_at)
    SELECT gen_random_uuid(), u.id, $1, 'email.delivery_failed',
      'Booking email delivery failed', 'An outbound booking email could not be delivered. Delivery ID: ' || $2,
      NULL, NULL, $3
    FROM public.users u JOIN public.user_roles r ON r.user_id=u.id
    WHERE u.status='active' AND r.role_code='admin'
    ON CONFLICT (user_id, event_key) DO NOTHING`, [`email.delivery-failed:${deliveryId}`, deliveryId, occurredAt]);
}
