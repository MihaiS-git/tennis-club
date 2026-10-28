import "server-only";

import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { getDataSource } from "@/lib/db/data-source";
import { inReadSnapshot } from "@/lib/db/transaction";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { countAdminBookings, findAdminBookingDetails, findAdminBookingsPage, listAdminBookingCoaches } from "@/lib/db/repositories/bookings.repository";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { listBookingAdjustments, listBookingsWithLivePayment, listBookingsWithPendingChange } from "@/lib/db/repositories/booking-adjustments.repository";
import { listBookingRevisions } from "@/lib/db/repositories/booking-revisions.repository";
import { loadAdminTransactionContext } from "@/lib/db/repositories/payments.repository";
import { localStartInstant } from "@/lib/courts/local-time";
import { toAdminPaymentTransaction } from "@/lib/payments/admin";
import { attentionRefundStatuses, unconfirmedRefundMinutes } from "@/lib/payments/domain";
import { readFinancialHistory, summarizeBookingFacts } from "@/lib/payments/financial-history";
import { reportedOutstanding } from "@/lib/payments/financials";
import { ADMIN_BOOKINGS_PAGE_SIZE, parseAdminBookingQuery, type AdminBookingQuery } from "./admin-query";
import { adminCancellationAvailability, buildBookingHistory, summarizeBookingFinancials } from "./admin-history";
import { expirePaymentHolds } from "@/lib/payments/hold-expiry";

export type AdminBookingDetails = NonNullable<Awaited<ReturnType<typeof findAdminBookingDetails>>>;

// Read-only details, history and financial records for one booking, read in one
// REPEATABLE READ snapshot so a concurrent settlement cannot make the booking,
// its summary and its operations disagree. Booking-scoped facts load once and feed
// both the summary and the requested history page; operations reuse the exact
// Admin Transactions projection, so labels, statuses and links stay consistent.
export async function getAdminBookingRecords(input: unknown, options: { historyPage?: number;
  supabase?: Awaited<ReturnType<typeof createClient>>; now?: Date } = {}) {
  // Authorization reads Supabase Auth, so it completes before the snapshot opens.
  await requireActiveAdmin(options.supabase ?? await createClient());
  const id = z.uuid().safeParse(input);
  if (!id.success) return null;
  const historyPage = z.number().int().positive().catch(1).parse(options.historyPage ?? 1);
  try {
    await expirePaymentHolds();
    return await inReadSnapshot(async manager => {
      const booking = await findAdminBookingDetails(manager, id.data);
      if (!booking) return null;
      // One snapshot connection: reads run in sequence rather than queueing concurrently on it.
      const revisions = await listBookingRevisions(manager, id.data);
      const adjustments = await listBookingAdjustments(manager, id.data);
      // The same pending-change reads My Activity uses to withhold booking actions.
      const pendingChange = (await listBookingsWithPendingChange(manager, [id.data])).get(id.data) ?? null;
      const paymentPending = (await listBookingsWithLivePayment(manager, [id.data])).has(id.data);
      const payments = await loadAdminTransactionContext(manager, { bookingIds: [id.data], revisionIds: [], adjustmentIds: [] });
      const facts = { ...payments, revisions, adjustments };
      const financials = summarizeBookingFacts(facts, id.data);
      const page = await readFinancialHistory(manager, { page: historyPage, status: "all", provider: "all", method: "all",
        attention: false, search: "", sort: "date", direction: "asc", bookingId: id.data,
        attentionRefundStatuses, unconfirmedRefundMinutes }, { facts, financials: new Map([[id.data, financials]]) });
      // A booking without attempts projects only its historical booking row; no money moved.
      const operations = page.rows.some(row => row.transaction_kind === "booking")
        ? { rows: [], page: 1, total: 0, totalPages: 1 }
        : { ...page, rows: page.rows.map(toAdminPaymentTransaction) };
      const now = options.now ?? new Date();
      const ended = Date.parse(localStartInstant(booking.location_timezone, booking.booking_date, booking.ends_at_minute)) <= now.getTime();
      const startsAt = localStartInstant(booking.location_timezone, booking.booking_date, booking.starts_at_minute);
      return {
        booking,
        cancellation: { availability: adminCancellationAvailability({ status: booking.status, startsAt, now, pendingChange, paymentPending }),
          startsAt, // As the command decides: online captures not already owed back are refunded automatically.
          refundAvailable: booking.payment_method === "online" && financials.totals.some(total =>
            total.currency === booking.currency && total.captured - total.refundObligations > 0) },
        history: buildBookingHistory({ status: booking.status, revisions, adjustments }),
        summary: summarizeBookingFinancials({ status: booking.status, total: booking.total_amount_minor, currency: booking.currency,
          paymentMethod: booking.payment_method, ended, financials,
          outstanding: reportedOutstanding(financials.totals, { status: booking.status,
            totalAmountMinor: booking.total_amount_minor, currency: booking.currency }) }),
        operations,
      };
    });
  } catch (error: unknown) {
    logger.error({ event: "admin.booking_records_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load booking records");
    throw new Error("Unable to load booking history. Try again.");
  }
}
export type AdminBookingRecords = NonNullable<Awaited<ReturnType<typeof getAdminBookingRecords>>>;

// Admin-wide, ownership-independent list of authenticated and guest customer bookings.
export async function listAdminBookings(input: AdminBookingQuery, supabase?: Awaited<ReturnType<typeof createClient>>) {
  await requireActiveAdmin(supabase ?? await createClient());
  return readBookingListPage(parseAdminBookingQuery({ ...input, page: String(input.page) }), null);
}

// The one List read for Admins and Coaches. Callers authorize first; a Coach passes
// their own user ID, which the query enforces for every row and the total.
export async function readBookingListPage(query: AdminBookingQuery, staffUserId: string | null) {
  const filters = { coachId: query.coach || null, type: query.type, search: query.q, status: query.status === "all" ? null : query.status,
    locationId: query.location || null, courtId: query.court || null, from: query.from || null, to: query.to || null,
    sort: query.sort, direction: query.dir, staffUserId };
  try {
    // Settle overdue local holds before filtering/counting persisted statuses.
    // No Stripe calls; accepted captures remain protected by the expiry service.
    await expirePaymentHolds();
    const manager = (await getDataSource()).manager;
    const total = await countAdminBookings(manager, filters);
    const totalPages = Math.max(1, Math.ceil(total / ADMIN_BOOKINGS_PAGE_SIZE));
    const page = Math.min(query.page, totalPages);
    const rows = total ? await findAdminBookingsPage(manager, filters, (page - 1) * ADMIN_BOOKINGS_PAGE_SIZE, ADMIN_BOOKINGS_PAGE_SIZE) : [];
    return { rows, page, total, totalPages };
  } catch (error: unknown) {
    logger.error({ event: "admin.bookings_list_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load bookings");
    throw new Error("Unable to load bookings. Try again.");
  }
}
export type AdminBookingListItem = Awaited<ReturnType<typeof listAdminBookings>>["rows"][number];

// Every location (published, unpublished and archived) with its courts, for historical filtering.
export async function listAdminBookingFilterOptions(supabase?: Awaited<ReturnType<typeof createClient>>) {
  await requireActiveAdmin(supabase ?? await createClient());
  return readBookingFilterLocations();
}
// Callers authorize first.
export async function readBookingFilterLocations() {
  try {
    const manager = (await getDataSource()).manager;
    const [current, archived, courts] = await Promise.all([clubs.listAdminLocations(manager, "current"),
      clubs.listAdminLocations(manager, "archived"), clubs.listAdminCourts(manager)]);
    return [...current, ...archived].map((location) => ({ id: location.id, name: location.name,
      archived: location.archivedAt !== null,
      courts: courts.filter((court) => court.locationId === location.id).map((court) => ({ id: court.id, name: court.name })) }));
  } catch (error: unknown) {
    logger.error({ event: "admin.booking_filters_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load booking filters");
    throw new Error("Unable to load bookings. Try again.");
  }
}
export type AdminBookingFilterLocation = Awaited<ReturnType<typeof listAdminBookingFilterOptions>>[number];


export async function listAdminBookingCoachFilterOptions(supabase?: Awaited<ReturnType<typeof createClient>>) {
  await requireActiveAdmin(supabase ?? await createClient());
  try {
    return await listAdminBookingCoaches((await getDataSource()).manager);
  } catch (error: unknown) {
    logger.error({ event: "admin.booking_coach_filters_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load booking coach filters");
    throw new Error("Unable to load bookings. Try again.");
  }
}
export type AdminBookingFilterCoach = Awaited<ReturnType<typeof listAdminBookingCoachFilterOptions>>[number];
