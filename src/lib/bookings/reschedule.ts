import "server-only";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { loadReservationEditDayForLocation, reservationEditLocationSchema } from "@/lib/reservations/edit-availability";
import { openingIntervalSchema } from "@/lib/admin/opening-hours-validation";
import { logger } from "@/lib/logger";

type Client = Awaited<ReturnType<typeof createClient>>;
const bookingEditContextSchema = z.object({
  location_id: z.uuid(), location_timezone: z.string(), court_id: z.uuid(), booking_date: z.iso.date(),
  starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
  updated_at: z.iso.datetime({ offset: true }), booking_updated_at: z.iso.datetime({ offset: true }),
  total_amount_minor: z.number().int().positive(), currency: z.string(),
  location: reservationEditLocationSchema, hours: z.array(openingIntervalSchema),
  occupancy: z.array(z.object({ court_id: z.uuid(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int() })),
});
const bookingRescheduleInputSchema = z.strictObject({
  id: z.uuid(), expectedUpdatedAt: z.iso.datetime({ offset: true }),
  expectedBookingUpdatedAt: z.iso.datetime({ offset: true }), courtId: z.uuid(), date: z.iso.date(),
  startMinute: z.number().int().min(0).max(1439), endMinute: z.number().int().min(1).max(1440),
  save: z.boolean(), expectedTotal: z.number().int().positive().nullable(), priceAcknowledged: z.boolean(),
}).refine((v) => v.startMinute % 30 === 0 && v.endMinute % 30 === 0 && v.endMinute - v.startMinute >= 60,
  "Choose at least 60 minutes in 30-minute steps.");
export type BookingEditContext = z.infer<typeof bookingEditContextSchema>;
export type BookingRescheduleResult = { ok: true; totalAmountMinor: number }
  | { ok: false; message: string; reason?: "stale" | "price_changed"; totalAmountMinor?: number };

export async function loadBookingEditDay(id: unknown, date: unknown, client: Client, rpc: "read_admin_booking_edit_availability" | "read_own_booking_edit_availability", now = new Date()) {
  const input = z.object({ id: z.uuid(), date: z.iso.date() }).parse({ id, date });
  const result = await client.rpc(rpc, { p_id: input.id, p_date: input.date });
  const context = bookingEditContextSchema.safeParse(result.data);
  if (result.error || !context.success) {
    logger.error({ event: "bookings.edit_day_read_failed", rpc, bookingId: input.id, code: result.error?.code }, "Failed to load booking edit availability");
    throw new Error("This booking is no longer available to edit.");
  }
  const availability = await loadReservationEditDayForLocation({ client, locationId: context.data.location_id,
    timezone: context.data.location_timezone, date: input.date, occupancy: context.data.occupancy, now, configuration: { location: context.data.location, hours: context.data.hours } });
  return { ...availability, booking: context.data };
}

export async function runBookingReschedule(input: unknown, client: Client, actorId: string, rpc: "reschedule_admin_customer_booking" | "reschedule_own_customer_booking"): Promise<BookingRescheduleResult> {
  const parsed = bookingRescheduleInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Check the booking interval." };
  const edit = parsed.data;
  const result = await client.rpc(rpc, {
    p_id: edit.id, p_expected_updated_at: edit.expectedUpdatedAt,
    p_expected_booking_updated_at: edit.expectedBookingUpdatedAt,
    p_court_id: edit.courtId, p_booking_date: edit.date, p_starts_at_minute: edit.startMinute,
    p_ends_at_minute: edit.endMinute, p_save: edit.save, p_expected_total: edit.expectedTotal,
    p_price_acknowledged: edit.priceAcknowledged,
  });
  if (result.error) {
    if (result.error.code === "23P01") return { ok: false, message: "That court is no longer available. The booking has not changed." };
    logger.error({ event: `bookings.${rpc}_failed`, actorId, bookingId: edit.id,
      code: result.error.code }, "Booking reschedule failed");
    return { ok: false, message: "Unable to reschedule this booking. Try again." };
  }
  const response = z.object({ status: z.enum(["quoted", "updated", "stale", "unavailable", "overlap", "unpriced", "price_changed", "notice_required"]),
    total_amount_minor: z.number().int().positive().optional() }).safeParse(result.data);
  if (!response.success) return { ok: false, message: "Unable to reschedule this booking. Reload its details." };
  const { status, total_amount_minor: total } = response.data;
  if ((status === "updated" || status === "quoted") && total !== undefined) {
    if (status === "updated") logger.info({ event: `bookings.${rpc}_updated`, actorId, bookingId: edit.id }, "Customer booking rescheduled");
    return { ok: true, totalAmountMinor: total };
  }
  if (status === "price_changed") return { ok: false, reason: "price_changed", totalAmountMinor: total,
    message: "The price has changed. Confirm the new total before saving." };
  if (status === "stale") return { ok: false, reason: "stale", message: "This booking has changed since you opened it. Close and reopen its details." };
  return { ok: false, message: status === "notice_required" ? "The rescheduling notice period for this booking has expired." : status === "overlap" ? "That court is no longer available. The booking has not changed."
    : status === "unpriced" ? "No complete pricing is available for this interval. Choose another interval."
    : "This booking or interval is no longer available to reschedule." };
}
