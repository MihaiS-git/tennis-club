import "server-only";

import { z } from "zod";
import { cancellationNoticeMinutesSchema } from "@/lib/bookings/cancellation-policy";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { readCurrentAccount } from "@/lib/auth/account";
import { localStartInstant } from "@/lib/courts/local-time";
import { logger } from "@/lib/logger";
import { minorAmountSchema } from "@/lib/pricing/money";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { createClient } from "@/lib/supabase/server";
import type { CourtHistoryItem } from "./history";

export const HISTORY_PAGE_SIZE = 20;

const intervalSchema = z.object({
  booking_date: z.iso.date(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
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
  payments: z.array(z.object({ status: z.string() })),
  reservation: intervalSchema.extend({ status: z.enum(["active", "held", "cancelled", "released"]) }),
});
const nameSchema = z.object({ first_name: z.string().nullable(), last_name: z.string().nullable() }).nullable();
const reservationSelectSchema = intervalSchema.extend({
  id: z.uuid(), court_id: z.uuid(), updated_at: z.iso.datetime({ offset: true }),
  reason: z.string().nullable(), status: z.enum(["active", "cancelled"]), created_by_user_id: z.uuid(),
  cancelled_at: z.iso.datetime({ offset: true }).nullable(), creator: nameSchema, canceller: nameSchema,
});

function displayName(user: z.infer<typeof nameSchema>) {
  return user ? [user.first_name, user.last_name].filter((part) => part !== null).join(" ") || null : null;
}

function compareHistory(a: CourtHistoryItem, b: CourtHistoryItem) {
  // PostgreSQL timestamps retain microseconds that Date.parse truncates.
  const submillisecond = (instant: string) => (instant.match(/\.(\d+)/)?.[1].slice(3) ?? "").padEnd(6, "0");
  const aFraction = submillisecond(a.history_at), bFraction = submillisecond(b.history_at);
  return Date.parse(b.history_at) - Date.parse(a.history_at)
    || (aFraction > bFraction ? -1 : aFraction < bFraction ? 1 : 0)
    || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
    || (a.id > b.id ? -1 : a.id < b.id ? 1 : 0);
}

export async function listOwnCourtHistory(page: number,
  client?: Awaited<ReturnType<typeof createClient>>, now = new Date()) {
  const supabase = client ?? await createClient();
  const account = await readCurrentAccount(supabase);
  if (account.state !== "active") throw new Error("An active account is required.");
  if (!Number.isInteger(page) || page < 1 || page > 1_000_000) throw new Error("Choose a valid history page.");
  const reader = createBookingWriter();
  const needed = page * HISTORY_PAGE_SIZE + 1;
  const batchSize = Math.min(needed, 1000);
  const rows: CourtHistoryItem[] = [];
  const nowInstant = now.getTime();
  // A local date's end (including minute 1440) is strictly before UTC
  // midnight + 48 hours in every supported IANA zone. This is only a
  // conservative read bound; localStartInstant decides actual completion.
  const dateUpperBound = (date: string) => Date.parse(`${date}T00:00:00Z`) + 2 * 86_400_000;
  const latestCandidateDate = new Date(nowInstant + 86_400_000).toISOString().slice(0, 10);

  // Separate cancellation and completion streams so each can stop once it
  // has enough candidates. Local-date order alone cannot order UTC instants
  // across locations, so completed streams also read through the date bound.
  const streams = ["cancelled-bookings", "completed-bookings", ...(account.roles.some((role) => role === "admin" || role === "coach")
    ? ["cancelled-reservations", "cancelled-reservations-without-cancelled-at", "completed-reservations"] as const : [])] as const;
  for (const stream of streams) {
    const bookings = stream === "cancelled-bookings" || stream === "completed-bookings";
    const completed = stream === "completed-bookings" || stream === "completed-reservations";
    let candidates: CourtHistoryItem[] = [];
    for (let offset = 0; ; offset += batchSize) {
      const query = bookings
        ? reader.from("bookings").select(`
            id, account_user_id, status, updated_at, customer_name, customer_email, customer_phone,
            cancellation_notice_minutes, total_amount_minor, currency, payment_method,
            payments:payment_attempts(status),
            reservation:court_reservations!inner(status, booking_date, starts_at_minute, ends_at_minute,
              court:courts!inner(name, location_id, location:locations!inner(name, timezone)))
          `).eq("account_user_id", account.userId).eq("status", completed ? "confirmed" : "cancelled")
        : reader.from("court_reservations").select(`
            id, court_id, updated_at, booking_date, starts_at_minute, ends_at_minute,
            reason, status, created_by_user_id, cancelled_at,
            court:courts!inner(name, location_id, location:locations!inner(name, timezone)),
            creator:users!court_reservations_created_by_user_id_fkey(first_name, last_name),
            canceller:users!court_reservations_cancelled_by_user_id_fkey(first_name, last_name)
          `).eq("created_by_user_id", account.userId).eq("status", completed ? "active" : "cancelled");
      if (completed) {
        if (bookings) query.eq("reservation.status", "active");
        query.lte(bookings ? "reservation.booking_date" : "booking_date", latestCandidateDate)
          .order(bookings ? "reservation(booking_date)" : "booking_date", { ascending: false });
      } else if (bookings) {
        query.order("updated_at", { ascending: false });
      } else if (stream === "cancelled-reservations") {
        query.not("cancelled_at", "is", null).order("cancelled_at", { ascending: false });
      } else {
        query.is("cancelled_at", null).order("updated_at", { ascending: false });
      }
      const result = await query.order("id", { ascending: false }).range(offset, offset + batchSize - 1);
      const parsed = bookings ? z.array(bookingSelectSchema).safeParse(result.data)
        : z.array(reservationSelectSchema).safeParse(result.data);
      if (result.error || !parsed.success) {
        logger.error({ event: "activity.history_read_failed", code: result.error?.code }, "Failed to load personal court history");
        throw new Error("Unable to load your booking history.");
      }
      let lastDate: string | undefined;
      for (const row of parsed.data) {
        const interval = "reservation" in row ? row.reservation : row;
        const { court } = interval;
        lastDate = interval.booking_date;
        const end = completed ? localStartInstant(court.location.timezone, interval.booking_date, interval.ends_at_minute) : row.updated_at;
        if (completed && Date.parse(end) > nowInstant) continue;
        const common = { id: row.id, booking_date: interval.booking_date,
          starts_at_minute: interval.starts_at_minute, ends_at_minute: interval.ends_at_minute,
          location_name: court.location.name, location_timezone: court.location.timezone, court_name: court.name };
        if ("reservation" in row) {
          if (row.account_user_id !== account.userId) throw new Error("Unable to load your booking history.");
          if (row.payment_method === "online" && !row.payments.some((payment) => payment.status === "succeeded")) continue;
          candidates.push({ ...common, kind: "booking", status: row.status,
            history_at: row.status === "cancelled" ? row.updated_at : end,
            customer_name: row.customer_name, customer_email: row.customer_email, customer_phone: row.customer_phone,
            cancellation_notice_minutes: row.cancellation_notice_minutes,
            total_amount_minor: row.total_amount_minor, currency: row.currency });
        } else {
          if (row.created_by_user_id !== account.userId) throw new Error("Unable to load your booking history.");
          candidates.push({ ...common, kind: "reservation", status: row.status,
            history_at: row.status === "cancelled" ? row.cancelled_at ?? row.updated_at : end,
            court_id: row.court_id, location_id: court.location_id, updated_at: row.updated_at, reason: row.reason,
            created_by_user_id: row.created_by_user_id, creator_name: displayName(row.creator),
            cancelled_at: row.cancelled_at, cancelled_by_name: displayName(row.canceller) });
        }
      }
      candidates = candidates.sort(compareHistory).slice(0, needed);
      if (parsed.data.length < batchSize) break;
      if (candidates.length === needed && (!completed || (lastDate
        && dateUpperBound(lastDate) < Date.parse(candidates[needed - 1].history_at)))) break;
    }
    rows.push(...candidates);
  }
  const offset = (page - 1) * HISTORY_PAGE_SIZE;
  const selected = rows.sort(compareHistory).slice(offset, offset + HISTORY_PAGE_SIZE + 1);
  return { rows: selected.slice(0, HISTORY_PAGE_SIZE), hasNext: selected.length > HISTORY_PAGE_SIZE, page };
}
