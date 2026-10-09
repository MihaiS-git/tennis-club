import "server-only";

import type { EntityManager } from "typeorm";
import { z } from "zod";
import { BookingEntity } from "../entities/booking.entity";

export type CheckoutBookingFields = Pick<BookingEntity,
  "id" | "reservationId" | "accountUserId" | "customerName" | "customerEmail" | "customerPhone"
  | "status" | "totalAmountMinor" | "currency" | "cancellationNoticeMinutes" | "paymentMethod"
>;

export async function insertCheckoutBooking(manager: EntityManager, input: CheckoutBookingFields) {
  await manager.createQueryBuilder().insert().into(BookingEntity).values({
    id: input.id, reservationId: input.reservationId, accountUserId: input.accountUserId,
    customerName: input.customerName, customerEmail: input.customerEmail, customerPhone: input.customerPhone,
    status: input.status, totalAmountMinor: input.totalAmountMinor, currency: input.currency,
    cancellationNoticeMinutes: input.cancellationNoticeMinutes, paymentMethod: input.paymentMethod,
  }).updateEntity(false).execute();
}

export async function findBookingCancellationNotice(manager: EntityManager, id: string) {
  return manager.getRepository(BookingEntity).findOne({
    where: { id }, select: { cancellationNoticeMinutes: true },
  });
}

export async function findCheckoutBookingStatus(manager: EntityManager, id: string) {
  return manager.getRepository(BookingEntity).findOne({ where: { id }, select: { status: true } });
}

export async function lockCheckoutBooking(manager: EntityManager, id: string) {
  return manager.getRepository(BookingEntity).createQueryBuilder("booking")
    .select(["booking.id"]).where("booking.id = :id", { id })
    .setLock("pessimistic_write").getOne();
}

// Cast before driver hydration: browser tokens retain PostgreSQL microseconds.
const commandBookingSchema = z.object({
  id: z.uuid(), reservation_id: z.uuid(), account_user_id: z.uuid().nullable(), status: z.string(),
  customer_name: z.string(), customer_email: z.string(), customer_phone: z.string(),
  total_amount_minor: z.number().int(), currency: z.string(), cancellation_notice_minutes: z.number().int(),
  updated_at: z.iso.datetime({ offset: true }), token_matches: z.boolean().nullable(),
});

export async function discoverBookingLocation(manager: EntityManager, id: string) {
  const rows: unknown = await manager.query(
    `SELECT c.location_id FROM public.bookings b
     JOIN public.court_reservations r ON r.id=b.reservation_id
     JOIN public.courts c ON c.id=r.court_id WHERE b.id=$1`, [id]);
  return z.array(z.object({ location_id: z.uuid() })).max(1).parse(rows)[0] ?? null;
}

export async function findBookingForUpdate(manager: EntityManager, id: string, token?: string) {
  const rows: unknown = await manager.query(
    `SELECT id,reservation_id,account_user_id,status,customer_name,customer_email,customer_phone,
     total_amount_minor,currency,cancellation_notice_minutes,
     replace((updated_at AT TIME ZONE 'UTC')::text,' ','T') || '+00:00' AS updated_at,
     updated_at=$2::timestamptz AS token_matches FROM public.bookings WHERE id=$1 FOR UPDATE`, [id, token ?? null]);
  return z.array(commandBookingSchema).max(1).parse(rows)[0] ?? null;
}

export async function updateBookingCancellationStatus(manager: EntityManager, id: string) {
  await manager.query("UPDATE public.bookings SET status='cancelled',updated_at=now() WHERE id=$1", [id]);
}

export async function updateBookingRescheduleTotal(manager: EntityManager, id: string, total: number) {
  // Preserve transaction now(), rather than a monotonic booking token.
  await manager.query("UPDATE public.bookings SET total_amount_minor=$2,updated_at=now() WHERE id=$1", [id, total]);
}


export async function lockSettlementBooking(manager: EntityManager, id: string) {
  const rows: unknown = await manager.query(
    `SELECT id,reservation_id,status,customer_name,customer_email,total_amount_minor,currency
     FROM public.bookings WHERE id=$1 FOR UPDATE`, [id]);
  return z.array(commandBookingSchema.pick({ id:true,reservation_id:true,status:true,customer_name:true,
    customer_email:true,total_amount_minor:true,currency:true })).max(1).parse(rows)[0] ?? null;
}

export async function updateSettlementBookingStatus(manager: EntityManager, id: string, status: string) {
  await manager.query("UPDATE public.bookings SET status=$2,updated_at=now() WHERE id=$1", [id,status]);
}
