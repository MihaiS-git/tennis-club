import "server-only";

import { normalizeDatabaseError } from "@/lib/db/errors";
import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { cancellationNoticeMinutesSchema } from "@/lib/bookings/cancellation-policy";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import { createLocalStartInstantResolver, localStartInstant } from "@/lib/courts/local-time";
import { getDataSource } from "@/lib/db/data-source";
import { listOwnerActivityBatch, listSucceededPaymentBookingIds } from "@/lib/db/repositories/court-activity.repository";
import { findOwnedBookingRevision } from "@/lib/db/repositories/bookings.repository";
import { listBookingsWithLivePayment, listBookingsWithPendingChange } from "@/lib/db/repositories/booking-adjustments.repository";
import { courtActivityType, type CustomerBookingHistoryItem } from "./history";
import { minorAmountSchema } from "@/lib/pricing/money";
import { ACTIVITY_PAGE_SIZE, parseActivityQuery, type ActivityQuery, type ActivityScope, type ActivitySearchParams } from "./activity-query";
import type { PersonalCustomerBooking } from "./personal";
import type { PersonalReservation } from "@/lib/reservations/personal";

export type UpcomingCourtActivity = { kind: "booking"; row: PersonalCustomerBooking } | { kind: "reservation"; row: PersonalReservation };
export type UpcomingActivity = Awaited<ReturnType<typeof listOwnUpcomingActivity>>;
export type ActivityOptions = {
  locations: { id: string; name: string }[];
  courts: { id: string; name: string; location_id: string }[];
};
// Completed end instants are materialized only for the returned page. Ordering
// still needs an exact start instant for every candidate, including tie-breaks.
type ActivityRow = (Omit<CustomerBookingHistoryItem, "history_at"> | (PersonalReservation & { kind: "reservation" }))
  & { history_at?: string; starts_at_instant: string; court_id: string; location_id: string };
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
  includes_coaching: z.boolean(),
  coach_name: z.string().nullable(), coaching_program_name: z.string().nullable(),
  cancellation_notice_minutes: cancellationNoticeMinutesSchema,
  total_amount_minor: minorAmountSchema, currency: z.enum(locationCurrencies),
  payment_method: z.enum(["online", "pay_at_club"]),
  reservation: intervalSchema,
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
      case "type": return courtActivityType(row);
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
  const type = !staff && query.type === "reservation" ? "all" : query.type;
  if (!Number.isInteger(query.page) || query.page < 1 || query.page > 1_000_000
    || !Number.isFinite(now.getTime()) || (scope === "upcoming" && (query.status !== "all" || query.sort === "status"))
    || (query.from && query.to && query.from > query.to)) {
    throw new Error("Unable to load your court activity. Try again.");
  }
  const manager = (await getDataSource()).manager;
  const needed = query.page * ACTIVITY_PAGE_SIZE + 1;
  const batchSize = 1000;
  let candidates: ActivityRow[] = [];
  let courtCandidates: ActivityRow[] = [];
  let candidatesNeedSort = false;
  let courtCandidatesNeedSort = false;
  const locations = new Map<string, ActivityOptions["locations"][number]>();
  const courts = new Map<string, ActivityOptions["courts"][number]>();
  const nowInstant = now.getTime();
  const resolveStartInstant = createLocalStartInstantResolver();
  // Conservative date bounds cover every IANA offset, including end minute 1440.
  // Only dates inside these bounds need exact timezone resolution for eligibility.
  const earliestDate = new Date(nowInstant - 2 * 86_400_000).toISOString().slice(0, 10);
  const latestDate = new Date(nowInstant + 86_400_000).toISOString().slice(0, 10);
  const fail = (code?: string): never => {
    logger.error({ event: "activity.list_read_failed", scope, code }, "Failed to load personal court activity");
    throw new Error("Unable to load your court activity. Try again.");
  };
  // Options intentionally span all eligible activity, before URL filters. Read
  // bounded batches and retain only distinct options and the requested top rows,
  // both with and without the court filter until its compatibility is known.
  for (const kind of staff ? ["booking", "reservation"] as const : ["booking"] as const) {
    for (const cancelled of scope === "history" ? [false, true] : [false]) {
      // The cursor belongs to this source/lifecycle stream, before TypeScript
      // eligibility and URL filtering. Public numbered pages are sliced below.
      let afterId: string | null = null;
      for (;;) {
        let data: unknown;
        try {
          data = await listOwnerActivityBatch(manager, { actorId: account.userId, kind, cancelled,
            scope, earliestDate, latestDate, afterId, limit: batchSize });
        } catch (error: unknown) { return fail(normalizeDatabaseError(error).sqlState); }
        const parsed = kind === "booking" ? z.array(bookingSelectSchema).safeParse(data)
          : z.array(reservationSelectSchema).safeParse(data);
        if (!parsed.success) return fail();
        let succeededBookingIds: Set<string>;
        try {
          const onlineBookingIds = parsed.data.flatMap((source) =>
            "reservation" in source && source.payment_method === "online" ? [source.id] : []);
          succeededBookingIds = new Set(await listSucceededPaymentBookingIds(manager, onlineBookingIds));
        } catch (error: unknown) { return fail(normalizeDatabaseError(error).sqlState); }
        let addedCandidates = false;
        let addedCourtCandidates = false;
        for (const source of parsed.data) {
          const interval = "reservation" in source ? source.reservation : source;
          const { court } = interval;
          if (!cancelled && interval.status !== "active") continue;
          if ("reservation" in source) {
            if (source.account_user_id !== account.userId) fail();
            if (source.payment_method === "online" && !succeededBookingIds.has(source.id)) continue;
          } else if (source.created_by_user_id !== account.userId) fail();
          let end: string | undefined;
          if (!cancelled) {
            // Reuse the repository's conservative UTC date bounds. This avoids
            // local-clock comparisons across folds, gaps and skipped dates;
            // the boundary window retains the exact existing DST resolver.
            let ended: boolean;
            if (interval.booking_date <= earliestDate) ended = true;
            else if (interval.booking_date > latestDate) ended = false;
            else {
              end = resolveStartInstant(court.location.timezone, interval.booking_date, interval.ends_at_minute);
              ended = Date.parse(end) <= nowInstant;
            }
            if (scope === "upcoming" ? ended : !ended) continue;
          }
          locations.set(court.location_id, { id: court.location_id, name: court.location.name });
          courts.set(interval.court_id, { id: interval.court_id, name: court.name, location_id: court.location_id });
          const sourceType = courtActivityType("reservation" in source
            ? { kind: "booking", includes_coaching: source.includes_coaching } : { kind: "reservation" });
          if ((type !== "all" && (type === "booking" ? !("reservation" in source) : sourceType !== type))
            || (query.status !== "all" && (source.status === "cancelled" ? "cancelled" : "completed") !== query.status)
            || (query.location && court.location_id !== query.location)
            || (query.from && interval.booking_date < query.from) || (query.to && interval.booking_date > query.to)) continue;
          const common = { id: source.id, court_id: interval.court_id, location_id: court.location_id,
            booking_date: interval.booking_date, starts_at_minute: interval.starts_at_minute, ends_at_minute: interval.ends_at_minute,
            starts_at_instant: resolveStartInstant(court.location.timezone, interval.booking_date, interval.starts_at_minute),
            location_name: court.location.name, location_timezone: court.location.timezone, court_name: court.name };
          let row: ActivityRow;
          if ("reservation" in source) {
            row = { ...common, kind: "booking", status: source.status,
              history_at: source.status === "cancelled" ? source.updated_at : end,
              customer_name: source.customer_name, customer_email: source.customer_email, customer_phone: source.customer_phone,
              includes_coaching: source.includes_coaching,
              coach_name: source.coach_name, coaching_program_name: source.coaching_program_name,
              cancellation_notice_minutes: source.cancellation_notice_minutes,
              total_amount_minor: source.total_amount_minor, currency: source.currency };
          } else {
            row = { ...common, kind: "reservation", status: source.status,
              history_at: source.status === "cancelled" ? source.cancelled_at ?? source.updated_at : end,
              updated_at: source.updated_at, reason: source.reason, created_by_user_id: source.created_by_user_id,
              creator_name: displayName(source.creator), cancelled_at: source.cancelled_at, cancelled_by_name: displayName(source.canceller) };
          }
          candidates.push(row);
          addedCandidates = true;
          if (query.court && row.court_id === query.court) {
            courtCandidates.push(row);
            addedCourtCandidates = true;
          }
        }
        candidatesNeedSort ||= addedCandidates;
        courtCandidatesNeedSort ||= addedCourtCandidates;
        // Ordering is only needed to discard overflow or return the final page.
        // Deep pages can accumulate several batches before reaching their bound.
        if (addedCandidates && candidates.length > needed) {
          candidates.sort((a, b) => compareActivity(a, b, scope, query));
          candidates = candidates.slice(0, needed);
          candidatesNeedSort = false;
        }
        if (addedCourtCandidates && courtCandidates.length > needed) {
          courtCandidates.sort((a, b) => compareActivity(a, b, scope, query));
          courtCandidates = courtCandidates.slice(0, needed);
          courtCandidatesNeedSort = false;
        }
        if (parsed.data.length < batchSize) break;
        afterId = parsed.data[parsed.data.length - 1].id;
      }
    }
  }
  // A direct URL may pair a court with another location (or name an unknown court);
  // ignore that court rather than silently returning an empty list.
  if (query.court && courts.get(query.court)?.location_id === query.location) {
    candidates = courtCandidates;
    candidatesNeedSort = courtCandidatesNeedSort;
  }
  if (candidatesNeedSort) candidates.sort((a, b) => compareActivity(a, b, scope, query));
  const compareOption = (a: { name: string; id: string }, b: { name: string; id: string }) =>
    compareValue(a.name, b.name) || compareValue(a.id, b.id);
  const offset = (query.page - 1) * ACTIVITY_PAGE_SIZE;
  const rows = candidates.slice(offset, offset + ACTIVITY_PAGE_SIZE).map((row) => ({ ...row,
    history_at: row.history_at ?? resolveStartInstant(row.location_timezone, row.booking_date, row.ends_at_minute) }));
  return { rows, hasNext: candidates.length > query.page * ACTIVITY_PAGE_SIZE,
    locations: [...locations.values()].sort(compareOption), courts: [...courts.values()].sort(compareOption) };
}

export async function listOwnUpcomingActivity(input: ActivitySearchParams = {}, client?: Awaited<ReturnType<typeof createClient>>) {
  const query = parseActivityQuery(input, "upcoming");
  const result = await listOwnCourtActivity("upcoming", query, client);
  const manager = (await getDataSource()).manager;
  const bookingIds = result.rows.flatMap((row) => row.kind === "booking" ? [row.id] : []);
  const live = await listBookingsWithLivePayment(manager, bookingIds);
  const changes = await listBookingsWithPendingChange(manager, bookingIds);
  const ordered: UpcomingCourtActivity[] = result.rows.map((row) => row.kind === "booking"
    ? { kind: "booking", row: { ...row, payment_pending: live.has(row.id),
      ...(changes.has(row.id) ? { pending_change: changes.get(row.id) } : {}) } } : { kind: "reservation", row });
  return { hasNext: result.hasNext, locations: result.locations, courts: result.courts,
    ordered, upcoming: ordered.flatMap((item) => item.kind === "reservation" ? [item.row] : []),
    bookings: ordered.flatMap((item) => item.kind === "booking" ? [item.row] : []) };
}

// A notification target is resolved independently of list filters and pagination.
// The owner predicate is applied by the database read before any details are returned.
export async function findOwnBookingActivityTarget(rawId: unknown, ownerId: string, now = new Date()) {
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return null;
  const manager = (await getDataSource()).manager;
  const owned = await findOwnedBookingRevision(manager, id.data, ownerId);
  if (!owned || (owned.status !== "confirmed" && owned.status !== "cancelled")) return null;
  const v = owned.revision;
  const common = { id: id.data, booking_date: v.bookingDate, starts_at_minute: v.startMinute,
    ends_at_minute: v.endMinute, starts_at_instant: localStartInstant(v.timezone, v.bookingDate, v.startMinute),
    location_name: v.locationName, location_timezone: v.timezone, court_name: v.courtName,
    customer_name: v.customerName, customer_email: v.customerEmail, customer_phone: v.customerPhone,
    includes_coaching: v.coachUserId != null, coach_name: v.coachName ?? null,
    coaching_program_name: v.coachingProgramName ?? null, cancellation_notice_minutes: v.cancellationNoticeMinutes,
    total_amount_minor: v.totalAmountMinor, currency: v.currency };
  const historyAt = owned.status === "cancelled" ? v.recordedAt.toISOString()
    : localStartInstant(v.timezone, v.bookingDate, v.endMinute);
  if (owned.status === "cancelled" || Date.parse(historyAt) <= now.getTime()) {
    return { scope: "history" as const, booking: { ...common, kind: "booking" as const,
      status: owned.status, history_at: historyAt } };
  }
  const [live, changes] = await Promise.all([
    listBookingsWithLivePayment(manager, [id.data]), listBookingsWithPendingChange(manager, [id.data]),
  ]);
  return { scope: "upcoming" as const, booking: { ...common, payment_pending: live.has(id.data),
    ...(changes.has(id.data) ? { pending_change: changes.get(id.data) } : {}) } };
}
