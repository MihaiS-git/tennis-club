import "server-only";

import { z } from "zod";
import { getDataSource } from "@/lib/db/data-source";
import { createClient } from "@/lib/supabase/server";
import { loadReservationEditDayForLocation, reservationEditLocationSchema } from "@/lib/reservations/edit-availability";
import { openingIntervalSchema } from "@/lib/admin/opening-hours-validation";
import { readCurrentAccount } from "@/lib/auth/account";
import { bookingRescheduleInputSchema, readCustomerBookingEditContext, rescheduleCustomerBookingCommand } from "./commands";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { adjustmentPresentation, readAdjustmentStatus, finishBookingAdjustment } from "@/lib/payments/booking-adjustments";
import type { AdjustmentTarget } from "@/lib/db/entities/booking-adjustment.entity";
import type { OnlineCheckout } from "@/lib/payments/domain";
import type { RefundStatus } from "@/lib/payments/refunds";
import { logger } from "@/lib/logger";

type Client = Awaited<ReturnType<typeof createClient>>;
const bookingEditContextSchema = z.object({
  payment_method: z.enum(["online", "pay_at_club"]),
  pending_adjustment_id: z.uuid().nullable().optional(),
  adjustment_status: z.enum(["pending","applied","cancelled","expired","unsuccessful"]).optional(),
  adjustment_target: z.object({ courtId: z.uuid(), date: z.iso.date(), startMinute: z.number().int(), endMinute: z.number().int() }).optional(),
  adjustment_total_minor: z.number().int().positive().optional(), payment_recovery_required: z.boolean().optional(),
  financial: z.object({ captured: z.number(), refunded: z.number(), refundObligations: z.number(), netPaid: z.number(), outstanding: z.number() }).optional(),
  refunds: z.array(z.object({ id: z.uuid(), amount: z.number(), status: z.enum(["pending", "pending_retry", "succeeded", "failed"]) })),
  location_id: z.uuid(), location_timezone: z.string(), court_id: z.uuid(), booking_date: z.iso.date(),
  starts_at_minute: z.number().int(), ends_at_minute: z.number().int(),
  updated_at: z.iso.datetime({ offset: true }), current_revision_id: z.uuid(),
  total_amount_minor: z.number().int().positive(), currency: z.string(),
  location: reservationEditLocationSchema, hours: z.array(openingIntervalSchema),
  occupancy: z.array(z.object({ court_id: z.uuid(), starts_at_minute: z.number().int(), ends_at_minute: z.number().int() })),
});
export type BookingEditContext = z.infer<typeof bookingEditContextSchema>;
export type BookingRescheduleResult = { ok: true; totalAmountMinor: number;
  adjustmentId?: string; adjustmentStatus?: "pending" | "applied" | "cancelled" | "expired" | "unsuccessful";
  target?: Pick<AdjustmentTarget,"courtId" | "date" | "startMinute" | "endMinute">; paymentRecoveryRequired?: boolean; refundIds?: string[]; refundStatus?: RefundStatus; checkout?: OnlineCheckout; holdExpiresAt?: string; paymentUrl?: string }
  | { ok: false; message: string; reason?: "stale" | "price_changed"; totalAmountMinor?: number };

export async function loadBookingEditDay(id: unknown, date: unknown, client: Client, now = new Date()) {
  const input = z.object({ id: z.uuid(), date: z.iso.date() }).parse({ id, date });
  const account = await readCurrentAccount(client);
  if (account.state !== "active")
    throw new Error("An active authorized account is required to edit a booking.");
  const context = await readCustomerBookingEditContext(input.id, input.date, account.userId);
  if (!context) throw new Error("This booking is no longer available to edit.");
  const booking = bookingEditContextSchema.parse(context);
  const availability = await loadReservationEditDayForLocation({ client, locationId: context.location_id,
    timezone: context.location_timezone, date: input.date, occupancy: context.occupancy, now,
    configuration: { location: booking.location, hours: context.hours } });
  let adjustment: Awaited<ReturnType<typeof adjustmentPresentation>> = null;
  if (booking.pending_adjustment_id) {
    try {
      adjustment = await adjustmentPresentation(booking.pending_adjustment_id);
      const status = await readAdjustmentStatus((await getDataSource()).manager, booking.pending_adjustment_id);
      if (status.status !== "pending_payment") {
        const refreshed = await readCustomerBookingEditContext(input.id,input.date,account.userId);
        if (refreshed?.pending_adjustment_id === booking.pending_adjustment_id) return { ...availability, booking, adjustment };
        booking.pending_adjustment_id = null;
        // Settlement may have just applied an edit or compensation. Refresh the
        // authoritative context after it, rather than returning pre-observation tokens.
        return loadBookingEditDay(id, date, client, now);
      }
    }
    catch { /* The durable operation remains visible and initialization can be retried. */ }
  }
  return { ...availability, booking, adjustment };
}
export async function runBookingReschedule(input: unknown, actorId: string): Promise<BookingRescheduleResult> {
  const parsed = bookingRescheduleInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Check the booking interval." };
  try {
    return await finishBookingAdjustment(await rescheduleCustomerBookingCommand(parsed.data, actorId));
  } catch (error: unknown) {
    const failure = normalizeDatabaseError(error);
    if (failure.sqlState === "23P01" && failure.constraint === "court_reservation_no_overlap")
      return { ok: false, message: "That court is no longer available. The booking has not changed." };
    logger.error({ event: "bookings.reschedule_failed", actorId, bookingId: parsed.data.id, code: failure.sqlState }, "Booking reschedule failed");
    return { ok: false, message: "Unable to reschedule this booking. Try again." };
  }
}
