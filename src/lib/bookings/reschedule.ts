import "server-only";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { loadReservationEditDayForLocation, reservationEditLocationSchema } from "@/lib/reservations/edit-availability";
import { openingIntervalSchema } from "@/lib/admin/opening-hours-validation";
import { readCurrentAccount } from "@/lib/auth/account";
import { bookingRescheduleInputSchema, readCustomerBookingEditContext, rescheduleCustomerBookingCommand } from "./commands";
import { normalizeDatabaseError } from "@/lib/db/errors";
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
export type BookingEditContext = z.infer<typeof bookingEditContextSchema>;
export type BookingRescheduleResult = { ok: true; totalAmountMinor: number }
  | { ok: false; message: string; reason?: "stale" | "price_changed"; totalAmountMinor?: number };

type Scope = "owner" | "admin";
export async function loadBookingEditDay(id: unknown, date: unknown, client: Client, scope: Scope, now = new Date()) {
  const input = z.object({ id: z.uuid(), date: z.iso.date() }).parse({ id, date });
  const account = await readCurrentAccount(client);
  if (account.state !== "active" || scope === "admin" && !account.roles.includes("admin"))
    throw new Error("An active authorized account is required to edit a booking.");
  const context = await readCustomerBookingEditContext(input.id, input.date, account.userId, scope);
  if (!context) throw new Error("This booking is no longer available to edit.");
  const booking = bookingEditContextSchema.parse(context);
  const availability = await loadReservationEditDayForLocation({ client, locationId: context.location_id,
    timezone: context.location_timezone, date: input.date, occupancy: context.occupancy, now,
    configuration: { location: booking.location, hours: context.hours } });
  return { ...availability, booking };
}
export async function runBookingReschedule(input: unknown, _client: Client, actorId: string, scope: Scope): Promise<BookingRescheduleResult> {
  const parsed = bookingRescheduleInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Check the booking interval." };
  try {
    return await rescheduleCustomerBookingCommand(parsed.data, actorId, scope);
  } catch (error: unknown) {
    const failure = normalizeDatabaseError(error);
    if (failure.sqlState === "23P01" && failure.constraint === "court_reservation_no_overlap")
      return { ok: false, message: "That court is no longer available. The booking has not changed." };
    logger.error({ event: "bookings.reschedule_failed", actorId, bookingId: parsed.data.id, code: failure.sqlState }, "Booking reschedule failed");
    return { ok: false, message: "Unable to reschedule this booking. Try again." };
  }
}
