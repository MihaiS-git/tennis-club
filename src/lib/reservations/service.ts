import "server-only";
import { cancelBookingCommand } from "@/lib/bookings/cancellation-service";
import { paymentFactSchema } from "@/lib/payments/facts";
import { successfulRefundPayment } from "@/lib/payments/providers/stripe/refund-policy";
import { finishBookingCancellation, type BookingCancellationResult } from "@/lib/payments/refunds";

import { z } from "zod";
import { cancellationNoticeMinutesSchema } from "@/lib/bookings/cancellation-policy";
import { createClient } from "@/lib/supabase/server";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import * as reservations from "@/lib/db/repositories/reservations.repository";
import { createDirectReservationCommand, editDirectReservationCommand, cancelDirectReservationCommand } from "./commands";
import { logger } from "@/lib/logger";
import { localMinute, localToday } from "@/lib/courts/calendar";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import type { LocationCurrency } from "@/lib/pricing/money";
import { isStructurallyReady, publicationToday } from "@/lib/locations/publication";
import { requireAdminReservationRole, requireReservationRole } from "./authorization";
import { buildReservationDay, reservationEditSchema, reservationInputSchema, type Occupancy } from "./domain";
import { loadReservationEditDayForLocation } from "./edit-availability";

type Client = Awaited<ReturnType<typeof createClient>>;
const occupancySchema = z.object({ court_id: z.uuid(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int() });
const adminOccupancyRowSchema = occupancySchema.extend({ kind: z.enum(["reservation", "booking"]), id: z.uuid(),
  booking_date: z.iso.date(), reason: z.string().nullable(), created_by_user_id: z.uuid().nullable(),
  creator_name: z.string().nullable(), customer_name: z.string().nullable(), customer_email: z.string().nullable(),
  customer_phone: z.string().nullable(), cancellation_notice_minutes: cancellationNoticeMinutesSchema.nullable(), total_amount_minor: z.number().int().nullable(), currency: z.enum(locationCurrencies).nullable(), payment_facts: z.array(paymentFactSchema) });
export type AdminReservation = Pick<z.infer<typeof adminOccupancyRowSchema>,
  "id" | "court_id" | "booking_date" | "starts_at_minute" | "ends_at_minute" | "reason" | "created_by_user_id" | "creator_name"> & { kind: "reservation" };
export type AdminBooking = Pick<z.infer<typeof adminOccupancyRowSchema>,
  "id" | "court_id" | "booking_date" | "starts_at_minute" | "ends_at_minute"> & {
    kind: "booking"; stripe_refund_available?: boolean; customer_name: string; customer_email: string; customer_phone: string;
    cancellation_notice_minutes: number; total_amount_minor: number; currency: LocationCurrency;
  };
export type AdminOperationalOccupancy = AdminReservation | AdminBooking;
export type InternalLocation = { id: string; name: string; timezone: string; courts: { id: string; name: string }[] };
export type ReservationResult = { ok: true } | { ok: false; message: string };

export async function listInternalLocations(supabase?: Client): Promise<InternalLocation[]> {
  const client = supabase ?? await createClient();
  await requireReservationRole(client);
  try {
    const rows = await reservations.listInternalReservationLocations((await getDataSource()).manager);
    return rows.filter((location) => isStructurallyReady(location, publicationToday(location.timezone)))
      .map((location) => ({ id: location.id, name: location.name, timezone: location.timezone,
        courts: location.courts.map(({ id, name }) => ({ id, name })) }));
  } catch (error: unknown) {
    logger.error({ event: "reservations.locations_read_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load internal locations");
    throw new Error("Unable to load reservation locations.");
  }
}

// Callers authorize staff and, where applicable, target ownership before reading.
export async function readInternalOccupancy(scope: { courtIds: string[] } | { locationId: string },
  date: string, now: Date, excludeReservationId?: string): Promise<Occupancy[]> {
  if ("courtIds" in scope && !scope.courtIds.length) return [];
  try {
    const manager = (await getDataSource()).manager;
    const occupancy: Occupancy[] = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const rows = await reservations.findReservationOccupancy(manager, scope, date, offset, pageSize, excludeReservationId);
      for (const row of rows) {
        const expiry = Date.parse(row.hold_expires_at ?? "");
        const submillisecond = row.hold_expires_at?.match(/\.(\d+)/)?.[1].slice(3) ?? "";
        if (row.status === "active" || expiry > now.getTime()
          || expiry === now.getTime() && /[1-9]/.test(submillisecond)) {
          occupancy.push({ court_id: row.court_id, starts_at_minute: row.starts_at_minute, ends_at_minute: row.ends_at_minute });
        }
      }
      if (rows.length < pageSize) break;
    }
    return occupancy;
  } catch (error: unknown) {
    logger.error({ event: "reservations.day_read_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load reservation day");
    throw new Error("Unable to load court availability.");
  }
}

async function readDayHours(locationId: string, date: string) {
  try {
    return await reservations.listReservationOpeningHours((await getDataSource()).manager, locationId, date);
  } catch (error: unknown) {
    logger.error({ event: "reservations.day_read_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load reservation day");
    throw new Error("Unable to load court availability.");
  }
}

export async function getReservationDay(location: InternalLocation, date: string, now: Date, supabase?: Client) {
  const client = supabase ?? await createClient();
  const actor = await requireReservationRole(client);
  const [hours, occupancy] = await Promise.all([
    readDayHours(location.id, date),
    readInternalOccupancy({ courtIds: location.courts.map((court) => court.id) }, date, now),
  ]);
  const adminOccupancy: AdminOperationalOccupancy[] = [];
  if (actor.roles.includes("admin")) {
    let data: unknown;
    try {
      data = await reservations.listAdminOperationalProjection((await getDataSource()).manager,
        location.courts.map((court) => court.id), date);
    } catch (error: unknown) {
      logger.error({ event: "reservations.admin_read_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load admin reservation details");
      throw new Error("Unable to load reservation details.");
    }
    const parsed = z.array(adminOccupancyRowSchema).safeParse(data);
    if (!parsed.success) {
      logger.error({ event: "reservations.admin_read_failed" }, "Failed to load admin reservation details");
      throw new Error("Unable to load reservation details.");
    }
    for (const row of parsed.data) {
      if (row.kind === "reservation") {
        adminOccupancy.push({ kind: "reservation", id: row.id, court_id: row.court_id, booking_date: row.booking_date,
          starts_at_minute: row.starts_at_minute, ends_at_minute: row.ends_at_minute,
          reason: row.reason, created_by_user_id: row.created_by_user_id, creator_name: row.creator_name });
      } else if (row.customer_name && row.customer_email && row.customer_phone && row.total_amount_minor && row.currency && row.cancellation_notice_minutes !== null) {
        adminOccupancy.push({ kind: "booking", id: row.id, court_id: row.court_id, booking_date: row.booking_date,
          starts_at_minute: row.starts_at_minute, ends_at_minute: row.ends_at_minute,
          customer_name: row.customer_name, customer_email: row.customer_email, customer_phone: row.customer_phone,
          cancellation_notice_minutes: row.cancellation_notice_minutes,
          stripe_refund_available: successfulRefundPayment(row.payment_facts) !== null, total_amount_minor: row.total_amount_minor, currency: row.currency });
      } else {
        logger.error({ event: "reservations.admin_booking_invalid", bookingId: row.id }, "Invalid operational booking snapshot");
        throw new Error("Unable to load booking details.");
      }
    }
  }
  return { ...buildReservationDay({ date, today: localToday(location.timezone, now), currentMinute: localMinute(location.timezone, now),
    courts: location.courts, hours, reservations: occupancy }), occupancy, adminOccupancy };
}

export async function createDirectReservation(input: unknown, supabase?: Client, now = new Date()): Promise<ReservationResult> {
  const client = supabase ?? await createClient();
  const actor = await requireReservationRole(client);
  const parsed = reservationInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the reservation details." };
  try {
    const result = await createDirectReservationCommand(parsed.data, actor.userId, now);
    if (result.ok) logger.info({ event: "reservations.created", actorId: actor.userId, courtId: parsed.data.courtId,
      date: parsed.data.date, startMinute: parsed.data.startMinute, endMinute: parsed.data.endMinute }, "Direct reservation created");
    return result;
  } catch (error: unknown) {
    const failure = normalizeDatabaseError(error);
    if (failure.sqlState === "23P01" && failure.constraint === "court_reservation_no_overlap") return { ok: false,
      message: "That court is no longer available for the selected time. Choose another interval." };
    logger.error({ event: "reservations.insert_failed", actorId: actor.userId, courtId: parsed.data.courtId, code: failure.sqlState }, "Failed to create direct reservation");
    return { ok: false, message: "Unable to reserve this court. Try again." };
  }
}

export async function cancelDirectReservationAsAdmin(input: unknown, supabase?: Client): Promise<ReservationResult> {
  const client = supabase ?? await createClient();
  const actor = await requireAdminReservationRole(client);
  const parsed = z.uuid().safeParse(input);
  if (!parsed.success) return { ok: false, message: "Choose a valid reservation." };
  try {
    const result = await cancelDirectReservationCommand(parsed.data, actor.userId, "admin");
    if (result.ok) logger.info({ event: "reservations.admin_cancelled", actorId: actor.userId, reservationId: parsed.data }, "Admin cancelled direct reservation");
    return result;
  } catch (error: unknown) {
    logger.error({ event: "reservations.admin_cancel_failed", actorId: actor.userId, reservationId: parsed.data,
      code: normalizeDatabaseError(error).sqlState }, "Failed to cancel direct reservation as Admin");
    return { ok: false, message: "Unable to cancel this reservation. Try again." };
  }
}

export async function cancelCustomerBookingAsAdmin(input: unknown, supabase?: Client): Promise<BookingCancellationResult> {
  const client = supabase ?? await createClient();
  const actor = await requireAdminReservationRole(client);
  const parsed = z.union([z.strictObject({ id: z.uuid(), refund: z.boolean().nullable() }),
    z.uuid().transform((id) => ({ id, refund: null }))]).safeParse(input);
  if (!parsed.success) return { ok: false, message: "Choose a valid booking and refund decision." };
  let data: unknown;
  try {
    data = await cancelBookingCommand(parsed.data.id, actor.userId, true, parsed.data.refund);
  } catch {
    logger.error({ event: "bookings.admin_cancel_failed", actorId: actor.userId, bookingId: parsed.data.id }, "Failed to cancel customer booking as Admin");
    return { ok: false, message: "Unable to cancel this booking. Try again." };
  }
  const outcome = await finishBookingCancellation(data, "This booking is no longer available to cancel.");
  if (outcome.ok) logger.info({ event: "bookings.admin_cancelled", actorId: actor.userId,
    bookingId: parsed.data.id, refundStatus: outcome.refundStatus }, "Admin cancelled customer booking");
  return outcome;
}

export async function getAdminReservationEditDay(input: { reservationId: unknown; date: unknown },
  supabase?: Client, now = new Date()) {
  const client = supabase ?? await createClient();
  await requireAdminReservationRole(client);
  const parsed = z.object({ reservationId: z.uuid(), date: z.iso.date() }).safeParse(input);
  if (!parsed.success) throw new Error("Choose a valid date.");
  const context = await readAdminEditContext(parsed.data.reservationId, parsed.data.date, now);
  const availability = await loadReservationEditDayForLocation({ client, locationId: context.location_id,
    timezone: context.location_timezone, date: parsed.data.date, occupancy: context.occupancy, now });
  return { ...availability, reservation: context };
}

// Authorization precedes every private edit-context read.
async function readAdminEditContext(id: string, date: string, now: Date) {
  try {
    const row = await reservations.findReservationEditContext((await getDataSource()).manager, id);
    if (!row) throw new Error("Unavailable reservation");
    const occupancy = await readInternalOccupancy({ locationId: row.location_id }, date, now, id);
    return { location_id: row.location_id, location_timezone: row.location_timezone,
      court_id: row.court_id, booking_date: row.booking_date, starts_at_minute: row.starts_at_minute,
      ends_at_minute: row.ends_at_minute, reason: row.reason, updated_at: row.updated_at, occupancy };
  } catch (error: unknown) {
    logger.error({ event: "reservations.admin_edit_availability_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load Admin edit context");
    throw new Error("This reservation is no longer available to edit.");
  }
}

export type AdminEditResult = { ok: true; reservation: {
  court_id: string; booking_date: string; starts_at_minute: number; ends_at_minute: number; reason: string;
} } | { ok: false; message: string; stale?: boolean; fieldErrors?: Record<string, string> };

export async function editDirectReservationAsAdmin(input: unknown, supabase?: Client, now = new Date()): Promise<AdminEditResult> {
  const client = supabase ?? await createClient();
  const actor = await requireAdminReservationRole(client);
  const parsed = reservationEditSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path.at(-1) ?? "form")] ??= issue.message;
    return { ok: false, message: "Check the reservation details.", fieldErrors };
  }
  try {
    const result = await editDirectReservationCommand(parsed.data, actor.userId, "admin", now);
    if (result.ok) logger.info({ event: "reservations.admin_edited", actorId: actor.userId, reservationId: parsed.data.id }, "Admin edited direct reservation");
    return result;
  } catch (error: unknown) {
    const failure = normalizeDatabaseError(error);
    if (failure.sqlState === "23P01" && failure.constraint === "court_reservation_no_overlap") return { ok: false,
      message: "That court is no longer available for the selected time. The existing reservation has not been changed." };
    logger.error({ event: "reservations.admin_edit_failed", actorId: actor.userId, reservationId: parsed.data.id, code: failure.sqlState }, "Failed to edit direct reservation as Admin");
    return { ok: false, message: "Unable to save this reservation. Refresh the details before trying again." };
  }
}
