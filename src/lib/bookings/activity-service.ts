import "server-only";

import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { cancellationNoticeMinutesSchema } from "@/lib/bookings/cancellation-policy";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { localStartInstant } from "@/lib/courts/local-time";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import type { CourtHistoryItem } from "./history";
import { minorAmountSchema } from "@/lib/pricing/money";
import { ACTIVITY_PAGE_SIZE, parseActivityQuery, type ActivityQuery, type ActivityScope, type ActivitySearchParams } from "./activity-query";
import type { PersonalCustomerBooking } from "./personal";
import type { PersonalReservation } from "@/lib/reservations/personal";

export type UpcomingCourtActivity = { kind: "booking"; row: PersonalCustomerBooking } | { kind: "reservation"; row: PersonalReservation };
export type UpcomingActivity = {
  upcoming: PersonalReservation[]; bookings: PersonalCustomerBooking[];
  ordered?: UpcomingCourtActivity[];
  locations?: ActivityOptions["locations"]; courts?: ActivityOptions["courts"]; hasNext?: boolean;
};
export type ActivityOptions = {
  locations: { id: string; name: string }[];
  courts: { id: string; name: string; location_id: string }[];
};
type ActivityRow = CourtHistoryItem & { starts_at_instant: string; court_id: string; location_id: string };
const intervalSchema = z.object({
  court_id: z.uuid(), booking_date: z.iso.date(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
  status: z.enum(["active", "cancelled", "held", "released"]),
  court: z.object({ name: z.string(), location_id: z.uuid(),
    location: z.object({ name: z.string(), timezone: z.string() }) }),
});
const bookingSelectSchema = z.object({
  id: z.uuid(), account_user_id: z.uuid(), status: z.enum(["confirmed", "cancelled"]),
  updated_at: z.iso.datetime({ offset: true }),
  customer_name: z.string(), customer_email: z.string(), customer_phone: z.string(),
  cancellation_notice_minutes: cancellationNoticeMinutesSchema,
  total_amount_minor: minorAmountSchema, currency: z.enum(locationCurrencies),
  payment_method: z.enum(["online", "pay_at_club"]).nullable(),
  payments: z.array(z.object({ status: z.literal("succeeded") })), reservation: intervalSchema,
});
const nameSchema = z.object({ first_name: z.string().nullable(), last_name: z.string().nullable() }).nullable();
const reservationSelectSchema = intervalSchema.extend({
  id: z.uuid(), status: z.enum(["active", "cancelled"]), updated_at: z.iso.datetime({ offset: true }),
  reason: z.string().nullable(), created_by_user_id: z.uuid(), cancelled_at: z.iso.datetime({ offset: true }).nullable(),
  creator: nameSchema, canceller: nameSchema,
});
function displayName(user: z.infer<typeof nameSchema>) {
  return user ? [user.first_name, user.last_name].filter((part) => part !== null).join(" ") || null : null;
}
function compareValue(a: string | number, b: string | number) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function compareActivity(a: ActivityRow, b: ActivityRow, scope: ActivityScope, query: ActivityQuery) {
  const value = (row: ActivityRow) => {
    switch (query.sort) {
      case "location": return row.location_name.toLowerCase();
      case "court": return row.court_name.toLowerCase();
      case "type": return row.kind;
      case "duration": return row.ends_at_minute - row.starts_at_minute;
      case "status": return row.status === "cancelled" ? "cancelled" : "completed";
      default: return Date.parse(row.starts_at_instant);
    }
  };
  return compareValue(value(a), value(b)) * (query.direction === "asc" ? 1 : -1)
    || compareValue(Date.parse(a.starts_at_instant), Date.parse(b.starts_at_instant)) * (scope === "upcoming" ? 1 : -1)
    || compareValue(a.kind, b.kind) || compareValue(a.id, b.id);
}

export async function listOwnCourtActivity(scope: ActivityScope, query: ActivityQuery,
  client?: Awaited<ReturnType<typeof createClient>>, now = new Date()) {
  const supabase = client ?? await createClient();
  const account = await readCurrentAccount(supabase);
  if (account.state !== "active") throw new Error("An active account is required.");
  const staff = account.roles.some((role) => role === "admin" || role === "coach");
  const type = staff ? query.type : "booking";
  if (!Number.isInteger(query.page) || query.page < 1 || query.page > 1_000_000
    || !Number.isFinite(now.getTime()) || (scope === "upcoming" && (query.status !== "all" || query.sort === "status"))
    || (query.from && query.to && query.from > query.to)) {
    throw new Error("Unable to load your court activity. Try again.");
  }
  const reader = createBookingWriter();
  const needed = query.page * ACTIVITY_PAGE_SIZE + 1;
  const batchSize = 1000;
  let candidates: ActivityRow[] = [];
  const locations = new Map<string, ActivityOptions["locations"][number]>();
  const courts = new Map<string, ActivityOptions["courts"][number]>();
  const nowInstant = now.getTime();
  // Conservative date bounds cover every IANA offset, including end minute 1440.
  // The exact end instant below decides eligibility using the shared location clock.
  const earliestDate = new Date(nowInstant - 2 * 86_400_000).toISOString().slice(0, 10);
  const latestDate = new Date(nowInstant + 86_400_000).toISOString().slice(0, 10);
  const fail = (code?: string): never => {
    logger.error({ event: "activity.list_read_failed", scope, code }, "Failed to load personal court activity");
    throw new Error("Unable to load your court activity. Try again.");
  };
  // Options intentionally span all eligible activity, before URL filters. Read
  // bounded batches and retain only distinct options and the requested top rows.
  for (const kind of staff ? ["booking", "reservation"] as const : ["booking"] as const) {
    for (const cancelled of scope === "history" ? [false, true] : [false]) {
      for (let offset = 0; ; offset += batchSize) {
        const read = kind === "booking"
          ? reader.from("bookings").select(`
              id, account_user_id, status, updated_at, customer_name, customer_email, customer_phone,
              cancellation_notice_minutes, total_amount_minor, currency, payment_method,
              payments:payment_attempts(status),
              reservation:court_reservations!inner(court_id, status, booking_date, starts_at_minute, ends_at_minute,
                court:courts!inner(name, location_id, location:locations!inner(name, timezone)))
            `).eq("account_user_id", account.userId).eq("status", cancelled ? "cancelled" : "confirmed")
            .eq("payments.status", "succeeded")
          : reader.from("court_reservations").select(`
              id, court_id, status, updated_at, booking_date, starts_at_minute, ends_at_minute,
              reason, created_by_user_id, cancelled_at,
              court:courts!inner(name, location_id, location:locations!inner(name, timezone)),
              creator:users!court_reservations_created_by_user_id_fkey(first_name, last_name),
              canceller:users!court_reservations_cancelled_by_user_id_fkey(first_name, last_name)
            `).eq("created_by_user_id", account.userId).eq("status", cancelled ? "cancelled" : "active");
        if (!cancelled) {
          if (kind === "booking") read.eq("reservation.status", "active");
          const dateColumn = kind === "booking" ? "reservation.booking_date" : "booking_date";
          if (scope === "upcoming") read.gte(dateColumn, earliestDate);
          else read.lte(dateColumn, latestDate);
        }
        const result = await read.order("id").range(offset, offset + batchSize - 1);
        const parsed = kind === "booking" ? z.array(bookingSelectSchema).safeParse(result.data)
          : z.array(reservationSelectSchema).safeParse(result.data);
        if (result.error || !parsed.success) return fail(result.error?.code);
        for (const source of parsed.data) {
          const interval = "reservation" in source ? source.reservation : source;
          const { court } = interval;
          const end = localStartInstant(court.location.timezone, interval.booking_date, interval.ends_at_minute);
          if (!cancelled && (interval.status !== "active"
            || (scope === "upcoming" ? Date.parse(end) <= nowInstant : Date.parse(end) > nowInstant))) continue;
          const common = { id: source.id, court_id: interval.court_id, location_id: court.location_id,
            booking_date: interval.booking_date, starts_at_minute: interval.starts_at_minute, ends_at_minute: interval.ends_at_minute,
            starts_at_instant: localStartInstant(court.location.timezone, interval.booking_date, interval.starts_at_minute),
            location_name: court.location.name, location_timezone: court.location.timezone, court_name: court.name };
          let row: ActivityRow;
          if ("reservation" in source) {
            if (source.account_user_id !== account.userId) fail();
            if (source.payment_method === "online" && source.payments.length === 0) continue;
            row = { ...common, kind: "booking", status: source.status,
              history_at: source.status === "cancelled" ? source.updated_at : end,
              customer_name: source.customer_name, customer_email: source.customer_email, customer_phone: source.customer_phone,
              cancellation_notice_minutes: source.cancellation_notice_minutes,
              total_amount_minor: source.total_amount_minor, currency: source.currency };
          } else {
            if (source.created_by_user_id !== account.userId) fail();
            row = { ...common, kind: "reservation", status: source.status,
              history_at: source.status === "cancelled" ? source.cancelled_at ?? source.updated_at : end,
              updated_at: source.updated_at, reason: source.reason, created_by_user_id: source.created_by_user_id,
              creator_name: displayName(source.creator), cancelled_at: source.cancelled_at, cancelled_by_name: displayName(source.canceller) };
          }
          locations.set(row.location_id, { id: row.location_id, name: row.location_name });
          courts.set(row.court_id, { id: row.court_id, name: row.court_name, location_id: row.location_id });
          if ((type !== "all" && row.kind !== type)
            || (query.status !== "all" && (row.status === "cancelled" ? "cancelled" : "completed") !== query.status)
            || (query.location && row.location_id !== query.location) || (query.court && row.court_id !== query.court)
            || (query.from && row.booking_date < query.from) || (query.to && row.booking_date > query.to)) continue;
          candidates.push(row);
        }
        candidates.sort((a, b) => compareActivity(a, b, scope, query));
        candidates = candidates.slice(0, needed);
        if (parsed.data.length < batchSize) break;
      }
    }
  }
  const compareOption = (a: { name: string; id: string }, b: { name: string; id: string }) =>
    compareValue(a.name, b.name) || compareValue(a.id, b.id);
  const offset = (query.page - 1) * ACTIVITY_PAGE_SIZE;
  return { rows: candidates.slice(offset, offset + ACTIVITY_PAGE_SIZE), hasNext: candidates.length > query.page * ACTIVITY_PAGE_SIZE,
    locations: [...locations.values()].sort(compareOption), courts: [...courts.values()].sort(compareOption) };
}

export async function listOwnUpcomingActivity(input: ActivitySearchParams = {}, client?: Awaited<ReturnType<typeof createClient>>) {
  const query = parseActivityQuery(input, "upcoming");
  const result = await listOwnCourtActivity("upcoming", query, client);
  const ordered: UpcomingCourtActivity[] = result.rows.map((row) => row.kind === "booking"
    ? { kind: "booking", row } : { kind: "reservation", row });
  return { ...result, ordered, upcoming: ordered.flatMap((item) => item.kind === "reservation" ? [item.row] : []),
    bookings: ordered.flatMap((item) => item.kind === "booking" ? [item.row] : []) };
}
