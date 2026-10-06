import "server-only";
import { cancelBookingCommand } from "@/lib/bookings/cancellation-service";
import { paymentFactSchema } from "@/lib/bookings/persistence";
import { successfulRefundPayment } from "@/lib/payments/providers/stripe/refund-policy";
import { finishBookingCancellation, type BookingCancellationResult } from "@/lib/payments/refunds";

import { z } from "zod";
import { cancellationNoticeMinutesSchema } from "@/lib/bookings/cancellation-policy";
import { createClient } from "@/lib/supabase/server";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { logger } from "@/lib/logger";
import { openingIntervalSchema } from "@/lib/admin/opening-hours-validation";
import { localMinute, localToday } from "@/lib/courts/calendar";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { locationCurrencies } from "@/lib/admin/locations-validation";
import type { LocationCurrency } from "@/lib/pricing/money";
import { isStructurallyReady, publicationToday } from "@/lib/locations/publication";
import { requireAdminReservationRole, requireReservationRole } from "./authorization";
import { buildReservationDay, fitsOpeningHours, reservationEditSchema, reservationInputSchema, type Occupancy } from "./domain";
import { loadReservationEditDayForLocation } from "./edit-availability";

type Client = Awaited<ReturnType<typeof createClient>>;
const locationSchema = z.object({ id: z.uuid(), name: z.string(), timezone: z.string(), is_active: z.boolean(), archived_at: z.string().nullable() });
const courtSchema = z.object({ id: z.uuid(), name: z.string(), location_id: z.uuid(), is_active: z.boolean() });
const occupancySchema = z.object({ court_id: z.uuid(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int() });
const adminOccupancyRowSchema = occupancySchema.extend({ kind: z.enum(["reservation", "booking"]), id: z.uuid(),
  booking_date: z.iso.date(), reason: z.string().nullable(), created_by_user_id: z.uuid().nullable(),
  creator_name: z.string().nullable(), customer_name: z.string().nullable(), customer_email: z.string().nullable(),
  customer_phone: z.string().nullable(), cancellation_notice_minutes: cancellationNoticeMinutesSchema.nullable(), total_amount_minor: z.number().int().nullable(), currency: z.enum(locationCurrencies).nullable(), payment_facts: z.array(paymentFactSchema) });
const adminEditTargetSchema = z.object({
  id: z.uuid(), court_id: z.uuid(), booking_date: z.iso.date(),
  starts_at_minute: z.number().int(), ends_at_minute: z.number().int(), reason: z.string().nullable(),
  status: z.literal("active"), updated_at: z.iso.datetime({ offset: true }),
  court: z.object({ location_id: z.uuid(), is_active: z.literal(true),
    location: z.object({ timezone: z.string(), is_active: z.literal(true), archived_at: z.null() }) }),
});
export type AdminReservation = Pick<z.infer<typeof adminOccupancyRowSchema>,
  "id" | "court_id" | "booking_date" | "starts_at_minute" | "ends_at_minute" | "reason" | "created_by_user_id" | "creator_name"> & { kind: "reservation" };
export type AdminBooking = Pick<z.infer<typeof adminOccupancyRowSchema>,
  "id" | "court_id" | "booking_date" | "starts_at_minute" | "ends_at_minute"> & {
    kind: "booking"; stripe_refund_available?: boolean; customer_name: string; customer_email: string; customer_phone: string;
    cancellation_notice_minutes: number; total_amount_minor: number; currency: LocationCurrency;
  };
export type AdminOperationalOccupancy = AdminReservation | AdminBooking;
export type InternalLocation = Pick<z.infer<typeof locationSchema>, "id" | "name" | "timezone"> & { courts: { id: string; name: string }[] };
export type ReservationResult = { ok: true } | { ok: false; message: string };
type ReservationInput = z.infer<typeof reservationInputSchema>;

export async function listInternalLocations(supabase?: Client): Promise<InternalLocation[]> {
  const client = supabase ?? await createClient();
  await requireReservationRole(client);
  const { data, error } = await client.from("locations")
    .select("id, name, slug, timezone, currency, is_active, is_public, archived_at, location_opening_hours(id), courts(id, name, environment, is_active, location_pricing_rules(court_state, ends_on))")
    .eq("is_active", true).is("archived_at", null).eq("courts.is_active", true)
    .order("display_order").order("name").order("name", { referencedTable: "courts" });
  const locations = z.array(z.object({
    id: z.uuid(), name: z.string(), slug: z.string(), timezone: z.string(), currency: z.string(),
    is_active: z.boolean(), is_public: z.boolean(), archived_at: z.string().nullable(),
    location_opening_hours: z.array(z.object({ id: z.uuid() })),
    courts: z.array(z.object({ id: z.uuid(), name: z.string(), environment: z.enum(["indoor", "outdoor"]),
      is_active: z.boolean(), location_pricing_rules: z.array(z.object({
        court_state: z.enum(["indoor", "outdoor", "covered"]), ends_on: z.iso.date().nullable(),
      })) })),
  })).safeParse(data);
  if (error || !locations.success) {
    logger.error({ event: "reservations.locations_read_failed", locationCode: error?.code }, "Failed to load internal locations");
    throw new Error("Unable to load reservation locations.");
  }
  return locations.data.filter((location) => isStructurallyReady(location, publicationToday(location.timezone)))
    .map((location) => ({ id: location.id, name: location.name, timezone: location.timezone,
      courts: location.courts.map(({ id, name }) => ({ id, name })) }));
}

const internalOccupancySelectSchema = occupancySchema.extend({
  status: z.enum(["active", "held"]), hold_expires_at: z.iso.datetime({ offset: true }).nullable(),
  court: z.object({ is_active: z.literal(true),
    location: z.object({ is_active: z.literal(true), archived_at: z.null() }) }),
});

// Called only after requireReservationRole and, for editing, target ownership.
// Neither booking/payment status nor
// publication affects occupancy: the physical row's persisted deadline decides.
export async function readInternalOccupancy(scope: { courtIds: string[] } | { locationId: string },
  date: string, now: Date, excludeReservationId?: string): Promise<Occupancy[]> {
  if ("courtIds" in scope && scope.courtIds.length === 0) return [];
  const reader = createBookingWriter();
  const nowInstant = now.getTime();
  const batchSize = 1000;
  const occupancy: Occupancy[] = [];
  for (let offset = 0; ; offset += batchSize) {
    const query = reader.from("court_reservations").select(`
      court_id, starts_at_minute, ends_at_minute, status, hold_expires_at,
      court:courts!inner(is_active, location:locations!inner(is_active, archived_at))
    `).eq("booking_date", date).in("status", ["active", "held"])
      .eq("court.is_active", true).eq("court.location.is_active", true).is("court.location.archived_at", null)
      .order("court_id").order("starts_at_minute").order("id").range(offset, offset + batchSize - 1);
    if ("courtIds" in scope) query.in("court_id", scope.courtIds);
    else query.eq("court.location_id", scope.locationId);
    if (excludeReservationId) query.neq("id", excludeReservationId);
    const result = await query;
    const parsed = z.array(internalOccupancySelectSchema).safeParse(result.data);
    if (result.error || !parsed.success) {
      logger.error({ event: "reservations.day_read_failed", occupancyCode: result.error?.code }, "Failed to load reservation day");
      throw new Error("Unable to load court availability.");
    }
    for (const row of parsed.data) {
      const expiry = row.hold_expires_at === null ? NaN : Date.parse(row.hold_expires_at);
      // Date.parse truncates PostgreSQL microseconds. A fractional remainder
      // after the shared millisecond instant still represents a live hold.
      const submillisecond = row.hold_expires_at?.match(/\.(\d+)/)?.[1].slice(3) ?? "";
      if (row.status === "active" || expiry > nowInstant
        || (expiry === nowInstant && /[1-9]/.test(submillisecond))) {
        occupancy.push({ court_id: row.court_id, starts_at_minute: row.starts_at_minute, ends_at_minute: row.ends_at_minute });
      }
    }
    if (parsed.data.length < batchSize) break;
  }
  return occupancy;
}

export async function getReservationDay(location: InternalLocation, date: string, now: Date, supabase?: Client) {
  const client = supabase ?? await createClient();
  const actor = await requireReservationRole(client);
  const [hoursResult, occupancy] = await Promise.all([
    client.from("location_opening_hours").select("id, location_id, weekday, opens_at_minute, closes_at_minute, created_at, updated_at")
      .eq("location_id", location.id).eq("weekday", mondayWeekday(date)),
    readInternalOccupancy({ courtIds: location.courts.map((court) => court.id) }, date, now),
  ]);
  const hours = z.array(openingIntervalSchema).safeParse(hoursResult.data);
  if (hoursResult.error || !hours.success) {
    logger.error({ event: "reservations.day_read_failed", hoursCode: hoursResult.error?.code }, "Failed to load reservation day");
    throw new Error("Unable to load court availability.");
  }
  const adminOccupancy: AdminOperationalOccupancy[] = [];
  if (actor.roles.includes("admin")) {
    const result = await client.rpc("list_admin_operational_occupancy", { p_court_ids: location.courts.map((court) => court.id), p_date: date });
    const parsed = z.array(adminOccupancyRowSchema).safeParse(result.data);
    if (result.error || !parsed.success) {
      logger.error({ event: "reservations.admin_read_failed", code: result.error?.code }, "Failed to load admin reservation details");
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
    courts: location.courts, hours: hours.data, reservations: occupancy }), occupancy, adminOccupancy };
}

export async function validateDirectReservationTarget(input: ReservationInput, client: Client, now: Date, actorId: string): Promise<ReservationResult> {
  const { locationId, courtId, date, startMinute, endMinute } = input;
  const [locationResult, courtResult, hoursResult] = await Promise.all([
    client.from("locations").select("id, name, timezone, is_active, archived_at").eq("id", locationId).maybeSingle(),
    client.from("courts").select("id, name, location_id, is_active").eq("id", courtId).maybeSingle(),
    client.from("location_opening_hours").select("id, location_id, weekday, opens_at_minute, closes_at_minute, created_at, updated_at")
      .eq("location_id", locationId).eq("weekday", mondayWeekday(date)),
  ]);
  const location = locationSchema.nullable().safeParse(locationResult.data);
  const court = courtSchema.nullable().safeParse(courtResult.data);
  const hours = z.array(openingIntervalSchema).safeParse(hoursResult.data);
  if (locationResult.error || courtResult.error || hoursResult.error || !location.success || !court.success || !hours.success) {
    logger.error({ event: "reservations.validation_read_failed", actorId, locationCode: locationResult.error?.code,
      courtCode: courtResult.error?.code, hoursCode: hoursResult.error?.code }, "Failed to validate reservation resources");
    return { ok: false, message: "Unable to check court availability. Try again." };
  }
  if (!location.data || !location.data.is_active || location.data.archived_at || !court.data || !court.data.is_active || court.data.location_id !== locationId) {
    return { ok: false, message: "That court is not available at the selected location." };
  }
  const today = localToday(location.data.timezone, now);
  if (date < today || (date === today && startMinute < localMinute(location.data.timezone, now))) {
    return { ok: false, message: "Choose a future time at this location." };
  }
  if (!fitsOpeningHours(hours.data, date, startMinute, endMinute)) {
    return { ok: false, message: "Choose an interval within one opening-hours period." };
  }
  return { ok: true };
}

export async function createDirectReservation(input: unknown, supabase?: Client, now = new Date()): Promise<ReservationResult> {
  const client = supabase ?? await createClient();
  const actor = await requireReservationRole(client);
  const parsed = reservationInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the reservation details." };
  const { courtId, date, startMinute, endMinute, reason } = parsed.data;
  const target = await validateDirectReservationTarget(parsed.data, client, now, actor.userId);
  if (!target.ok) return target;
  const { error } = await client.from("court_reservations").insert({ court_id: courtId, booking_date: date,
    starts_at_minute: startMinute, ends_at_minute: endMinute, reason, created_by_user_id: actor.userId });
  if (error) {
    if (error.code === "23P01") return { ok: false, message: "That court is no longer available for the selected time. Choose another interval." };
    logger.error({ event: "reservations.insert_failed", actorId: actor.userId, courtId, code: error.code }, "Failed to create direct reservation");
    return { ok: false, message: "Unable to reserve this court. Try again." };
  }
  logger.info({ event: "reservations.created", actorId: actor.userId, courtId, date, startMinute, endMinute }, "Direct reservation created");
  return { ok: true };
}

export async function cancelDirectReservationAsAdmin(input: unknown, supabase?: Client): Promise<ReservationResult> {
  const client = supabase ?? await createClient();
  const actor = await requireAdminReservationRole(client);
  const parsed = z.uuid().safeParse(input);
  if (!parsed.success) return { ok: false, message: "Choose a valid reservation." };
  const { data, error } = await client.rpc("cancel_admin_court_reservation", { p_id: parsed.data });
  if (error) {
    logger.error({ event: "reservations.admin_cancel_failed", actorId: actor.userId, reservationId: parsed.data, code: error.code }, "Failed to cancel direct reservation as Admin");
    return { ok: false, message: "Unable to cancel this reservation. Try again." };
  }
  if (!data) return { ok: false, message: "This reservation is no longer available to cancel." };
  logger.info({ event: "reservations.admin_cancelled", actorId: actor.userId, reservationId: parsed.data }, "Admin cancelled direct reservation");
  return { ok: true };
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

// Both callers authorize an active Admin before this privileged read.
async function readAdminEditContext(id: string, date: string, now: Date) {
  const reader = createBookingWriter();
  const result = await reader.from("court_reservations").select(`
    id, court_id, booking_date, starts_at_minute, ends_at_minute, reason, status, updated_at,
    court:courts!inner(location_id, is_active, location:locations!inner(timezone, is_active, archived_at)),
    booking:bookings(reservation_id)
  `).eq("id", id).eq("status", "active").eq("court.is_active", true)
    .eq("court.location.is_active", true).is("court.location.archived_at", null)
    .is("booking", null).maybeSingle();
  const target = adminEditTargetSchema.safeParse(result.data);
  if (result.error || !target.success) {
    logger.error({ event: "reservations.admin_edit_availability_failed", code: result.error?.code }, "Failed to load Admin edit context");
    throw new Error("This reservation is no longer available to edit.");
  }
  const row = target.data;
  let occupancy: Occupancy[];
  try {
    occupancy = await readInternalOccupancy({ locationId: row.court.location_id }, date, now, id);
  } catch {
    throw new Error("This reservation is no longer available to edit.");
  }
  return { location_id: row.court.location_id, location_timezone: row.court.location.timezone,
    court_id: row.court_id, booking_date: row.booking_date,
    starts_at_minute: row.starts_at_minute, ends_at_minute: row.ends_at_minute,
    reason: row.reason, updated_at: row.updated_at, occupancy };
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
  const edit = parsed.data;
  let context: Awaited<ReturnType<typeof readAdminEditContext>>;
  try {
    context = await readAdminEditContext(edit.id, edit.kind === "schedule" ? edit.schedule.date : now.toISOString().slice(0, 10), now);
  } catch { return { ok: false, message: "This reservation is no longer available to edit." }; }
  if (context.updated_at !== edit.expectedUpdatedAt) return { ok: false, stale: true,
    message: "This reservation has changed since you opened it. Refresh and try again." };
  const today = localToday(context.location_timezone, now);
  const currentMinute = localMinute(context.location_timezone, now);
  if (context.booking_date < today || (context.booking_date === today && context.ends_at_minute <= currentMinute))
    return { ok: false, message: "This reservation is no longer available to edit." };
  if (edit.kind === "schedule") {
    if (context.booking_date === today && context.starts_at_minute <= currentMinute)
      return { ok: false, message: "An in-progress reservation can only change its reason." };
    const target = await validateDirectReservationTarget({ ...edit.schedule, locationId: context.location_id }, client, now, actor.userId);
    if (!target.ok) return target;
  }
  const { data, error } = await client.rpc("edit_admin_court_reservation", {
    p_id: edit.id, p_expected_updated_at: edit.expectedUpdatedAt,
    p_reason: edit.kind === "reason" ? edit.reason : edit.schedule.reason,
    p_schedule: edit.kind === "schedule",
    p_court_id: edit.kind === "schedule" ? edit.schedule.courtId : null,
    p_booking_date: edit.kind === "schedule" ? edit.schedule.date : null,
    p_starts_at_minute: edit.kind === "schedule" ? edit.schedule.startMinute : null,
    p_ends_at_minute: edit.kind === "schedule" ? edit.schedule.endMinute : null,
  });
  if (error) {
    if (error.code === "23P01") return { ok: false,
      message: "That court is no longer available for the selected time. The existing reservation has not been changed." };
    logger.error({ event: "reservations.admin_edit_failed", actorId: actor.userId, reservationId: edit.id, code: error.code }, "Failed to edit direct reservation as Admin");
    return { ok: false, message: "Unable to save this reservation. Refresh the details before trying again." };
  }
  if (data === "stale") return { ok: false, stale: true,
    message: "This reservation has changed since you opened it. Refresh and try again." };
  if (data !== "updated") return { ok: false, message: "This reservation is no longer available to edit." };
  logger.info({ event: "reservations.admin_edited", actorId: actor.userId, reservationId: edit.id }, "Admin edited direct reservation");
  return { ok: true, reservation: edit.kind === "schedule"
    ? { court_id: edit.schedule.courtId, booking_date: edit.schedule.date,
      starts_at_minute: edit.schedule.startMinute, ends_at_minute: edit.schedule.endMinute, reason: edit.schedule.reason }
    : { court_id: context.court_id, booking_date: context.booking_date,
      starts_at_minute: context.starts_at_minute, ends_at_minute: context.ends_at_minute, reason: edit.reason } };
}
