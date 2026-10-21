import "server-only";

import { z } from "zod";
import { requireActiveCoach } from "@/lib/coaching/authorization";
import { localStartInstant } from "@/lib/courts/local-time";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { findAdminBookingDetails } from "@/lib/db/repositories/bookings.repository";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { readBookingFilterLocations, readBookingListPage } from "./admin-details";
import { parseCoachBookingQuery, type AdminBookingQuery } from "./admin-query";

type Client = Awaited<ReturnType<typeof createClient>>;

// The Coach List: the same server-side List query, scoped by the query itself to the
// Coach's own lessons and own staff reservations. Prices, payments and customer
// account IDs are dropped here so they never reach the browser.
export async function listCoachBookings(input: AdminBookingQuery, supabase?: Client) {
  const actor = await requireActiveCoach(supabase ?? await createClient());
  const result = await readBookingListPage(parseCoachBookingQuery({ ...input, page: String(input.page) }), actor.userId);
  return { ...result, rows: result.rows.map((row) => {
    if (row.kind === "reservation") return row;
    return { kind: row.kind, id: row.id, status: row.status, created_at: row.created_at, booking_date: row.booking_date,
      starts_at_minute: row.starts_at_minute, ends_at_minute: row.ends_at_minute, location_id: row.location_id,
      location_name: row.location_name, location_timezone: row.location_timezone, court_id: row.court_id, court_name: row.court_name,
      customer_name: row.customer_name, customer_email: row.customer_email, includes_coaching: row.includes_coaching,
      coach_name: row.coach_name, coaching_program_name: row.coaching_program_name };
  }) };
}
export type CoachBookingListItem = Awaited<ReturnType<typeof listCoachBookings>>["rows"][number];

export async function listCoachBookingFilterOptions(supabase?: Client) {
  await requireActiveCoach(supabase ?? await createClient());
  return readBookingFilterLocations();
}

// One of the Coach's own lessons, with the schedule and the customer contact the Coach
// Calendar already shows. Another Coach's lesson, a court booking and checkout state
// (payment pending, failed, expired) are indistinguishable from a missing booking.
export async function getCoachLesson(input: unknown, supabase?: Client) {
  const actor = await requireActiveCoach(supabase ?? await createClient());
  const id = z.uuid().safeParse(input);
  if (!id.success) return null;
  let booking: Awaited<ReturnType<typeof findAdminBookingDetails>>;
  try {
    booking = await findAdminBookingDetails((await getDataSource()).manager, id.data);
  } catch (error: unknown) {
    logger.error({ event: "coach.lesson_details_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load lesson details");
    throw new Error("Unable to load lesson details. Try again.");
  }
  if (!booking || booking.coach_user_id !== actor.userId || (booking.status !== "confirmed" && booking.status !== "cancelled")) return null;
  return { id: booking.id, status: booking.status, booking_date: booking.booking_date,
    starts_at_minute: booking.starts_at_minute, ends_at_minute: booking.ends_at_minute,
    location_name: booking.location_name, location_timezone: booking.location_timezone, court_name: booking.court_name,
    coach_name: booking.coach_name, coaching_program_name: booking.coaching_program_name,
    customer_name: booking.customer_name, customer_email: booking.customer_email, customer_phone: booking.customer_phone,
    created_at: booking.created_at };
}

// One of the Coach's own staff reservations. Actions mirror the existing owner
// commands, which still decide on submit: editable until it ends, and cancellable
// until it ends while its court and location are active.
export async function getCoachDirectReservation(input: unknown, supabase?: Client, now = new Date()) {
  const actor = await requireActiveCoach(supabase ?? await createClient());
  const id = z.uuid().safeParse(input);
  if (!id.success) return null;
  let row: Awaited<ReturnType<typeof reservations.findAdminDirectReservationDetails>>;
  try {
    row = await reservations.findAdminDirectReservationDetails((await getDataSource()).manager, id.data);
  } catch (error: unknown) {
    logger.error({ event: "coach.reservation_details_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load reservation details");
    throw new Error("Unable to load reservation details. Try again.");
  }
  if (!row || row.created_by_user_id !== actor.userId) return null;
  const startsAt = localStartInstant(row.location_timezone, row.booking_date, row.starts_at_minute);
  const endsAt = localStartInstant(row.location_timezone, row.booking_date, row.ends_at_minute);
  const upcoming = row.status === "active" && Date.parse(endsAt) > now.getTime();
  return { reservation: row, startsAt, endsAt, started: Date.parse(startsAt) <= now.getTime(), editable: upcoming,
    cancellable: upcoming && row.court_active && row.location_active && row.archived_at === null };
}
