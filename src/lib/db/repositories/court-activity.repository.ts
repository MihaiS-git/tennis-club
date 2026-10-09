import "server-only";

import type { EntityManager } from "typeorm";
import { z } from "zod";

// One bounded joined stream per source/lifecycle. JSON projection preserves dates
// and PostgreSQL microseconds without driver Date hydration. No public-resource
// predicate applies to personal history, including archived/inactive resources.
export async function listOwnerActivityBatch(manager: EntityManager, input: {
  actorId: string; kind: "booking" | "reservation"; cancelled: boolean;
  scope: "upcoming" | "history"; earliestDate: string; latestDate: string;
  offset: number; limit: number;
}): Promise<unknown> {
  const booking = input.kind === "booking";
  const court = `jsonb_build_object('name',c.name,'location_id',c.location_id,
    'location',jsonb_build_object('name',l.name,'timezone',l.timezone))`;
  const interval = `jsonb_build_object('court_id',r.court_id,'booking_date',r.booking_date,
    'starts_at_minute',r.starts_at_minute,'ends_at_minute',r.ends_at_minute,'status',r.status,'court',${court})`;
  const projection = booking ? `jsonb_build_object('id',b.id,'account_user_id',b.account_user_id,
    'status',b.status,'updated_at',b.updated_at,'customer_name',b.customer_name,'customer_email',b.customer_email,
    'customer_phone',b.customer_phone,'cancellation_notice_minutes',b.cancellation_notice_minutes,
    'total_amount_minor',b.total_amount_minor,'currency',b.currency,'payment_method',b.payment_method,
    'payments',coalesce((SELECT jsonb_agg(jsonb_build_object('status',p.status))
      FROM public.payment_attempts p WHERE p.booking_id=b.id AND p.status='succeeded'),'[]'::jsonb),
    'reservation',${interval})` : `${interval} || jsonb_build_object('id',r.id,'updated_at',r.updated_at,
    'reason',r.reason,'created_by_user_id',r.created_by_user_id,'cancelled_at',r.cancelled_at,
    'creator',CASE WHEN creator.id IS NULL THEN NULL ELSE jsonb_build_object('first_name',creator.first_name,'last_name',creator.last_name) END,
    'canceller',CASE WHEN canceller.id IS NULL THEN NULL ELSE jsonb_build_object('first_name',canceller.first_name,'last_name',canceller.last_name) END)`;
  const rows: unknown = await manager.query(`SELECT ${projection} AS row
    FROM ${booking ? "public.bookings b JOIN public.court_reservations r ON r.id=b.reservation_id" : "public.court_reservations r"}
    JOIN public.courts c ON c.id=r.court_id JOIN public.locations l ON l.id=c.location_id
    ${booking ? "" : "LEFT JOIN public.users creator ON creator.id=r.created_by_user_id LEFT JOIN public.users canceller ON canceller.id=r.cancelled_by_user_id"}
    WHERE ${booking ? "b.account_user_id" : "r.created_by_user_id"}=$1::uuid
      AND ${booking ? "b.status" : "r.status"}=$2
      ${input.cancelled ? "AND $3::date IS NOT NULL" : `AND r.status='active' AND r.booking_date ${input.scope === "upcoming" ? ">=" : "<="} $3::date`}
    ORDER BY ${booking ? "b.id" : "r.id"} LIMIT $4 OFFSET $5`,
    [input.actorId,input.cancelled ? "cancelled" : booking ? "confirmed" : "active",
      input.scope === "upcoming" ? input.earliestDate : input.latestDate,input.limit,input.offset]);
  return z.array(z.object({ row: z.unknown() })).parse(rows).map(({ row }) => row);
}
