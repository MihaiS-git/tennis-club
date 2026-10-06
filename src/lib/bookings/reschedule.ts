import "server-only";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { loadReservationEditDayForLocation, reservationEditLocationSchema } from "@/lib/reservations/edit-availability";
import { openingIntervalSchema } from "@/lib/admin/opening-hours-validation";
import { readCurrentAccount } from "@/lib/auth/account";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { readBookingActor, readBookingContext, commandFence, readCheckoutContext, sameDatabaseInstant } from "./persistence";
import { customerBookingNoticeBypass, customerCancellationEligibility, customerMutationDeadline } from "./self-cancellation";
import { getCourtStateForDate } from "@/lib/courts/state";
import { resolvePricingRule } from "@/lib/pricing/resolution";
import { getCalendarSelection } from "@/lib/courts/interval-selection";
import { fitsOpeningHours } from "@/lib/reservations/domain";
import { bookingNotification } from "@/lib/notifications/booking-email";
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

type Scope = "owner" | "admin";
async function editableContext(id: string, client: Client, scope: Scope, writer: ReturnType<typeof createBookingWriter>) {
  const account = await readCurrentAccount(client);
  if (account.state !== "active" || scope === "admin" && !account.roles.includes("admin"))
    throw new Error("An active authorized account is required to edit a booking.");
  const actor = await readBookingActor(account.userId, writer);
  if (actor.status !== "active" || scope === "admin" && !actor.roles.includes("admin")) throw new Error("Not authorized");
  const context = await readBookingContext(id, writer);
  if (!context || scope === "owner" && context.booking.account_user_id !== account.userId
    || context.booking.status !== "confirmed" || context.reservation.status !== "active"
    || !context.court.is_active || !context.location.is_active || context.location.archived_at
    || context.location.currency !== context.booking.currency) throw new Error("This booking is no longer available to edit.");
  const staff = customerBookingNoticeBypass(actor.roles);
  const policy = { starts_at_instant: context.starts_at_instant, cancellation_notice_minutes: context.booking.cancellation_notice_minutes };
  if (customerCancellationEligibility(policy, staff, new Date(context.now)) !== "eligible")
    throw new Error("The rescheduling notice period for this booking has expired.");
  return { context, actor, actorId: account.userId, deadline: customerMutationDeadline(policy, staff) };
}
async function editOccupancy(context: Awaited<ReturnType<typeof readBookingContext>>, date: string, writer: ReturnType<typeof createBookingWriter>) {
  if (!context) throw new Error("Booking unavailable");
  const read = await writer.from("court_reservations").select("court_id,starts_at_minute,ends_at_minute,status,hold_expires_at")
    .in("court_id", context.courts.filter((c) => c.is_active).map((c) => c.id))
    .eq("booking_date", date).neq("id", context.reservation.id).in("status", ["active", "held"]);
  if (read.error) throw new Error("Unable to load occupancy.");
  return z.array(z.object({ court_id: z.uuid(), starts_at_minute: z.number(), ends_at_minute: z.number(),
    status: z.string(), hold_expires_at: z.string().nullable() })).parse(read.data)
    .filter((r) => r.status === "active" || Date.parse(r.hold_expires_at ?? "") > Date.parse(context.now));
}
export async function loadBookingEditDay(id: unknown, date: unknown, client: Client, scope: Scope, now = new Date()) {
  const input = z.object({ id: z.uuid(), date: z.iso.date() }).parse({ id, date });
  const writer = createBookingWriter();
  const { context } = await editableContext(input.id, client, scope, writer);
  const occupancy = await editOccupancy(context, input.date, writer);
  const booking = bookingEditContextSchema.parse({ location_id: context.location.id, location_timezone: context.location.timezone,
    court_id: context.reservation.court_id, booking_date: context.reservation.booking_date,
    starts_at_minute: context.reservation.starts_at_minute, ends_at_minute: context.reservation.ends_at_minute,
    updated_at: context.reservation.updated_at, booking_updated_at: context.booking.updated_at,
    total_amount_minor: context.booking.total_amount_minor, currency: context.booking.currency,
    location: { ...context.location, courts: context.courts.filter((c) => c.is_active) }, hours: context.hours, occupancy });
  const availability = await loadReservationEditDayForLocation({ client, locationId: context.location.id,
    timezone: context.location.timezone, date: input.date, occupancy, now,
    configuration: { location: booking.location, hours: context.hours } });
  return { ...availability, booking };
}
export async function runBookingReschedule(input: unknown, client: Client, actorId: string, scope: Scope): Promise<BookingRescheduleResult> {
  const parsed = bookingRescheduleInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Check the booking interval." };
  const edit = parsed.data, writer = createBookingWriter();
  for (let retry = 0; retry < 3; retry++) {
    const { context, actor, deadline } = await editableContext(edit.id, client, scope, writer);
    const b = context.booking, r = context.reservation;
    if (!sameDatabaseInstant(r.updated_at, edit.expectedUpdatedAt) || !sameDatabaseInstant(b.updated_at, edit.expectedBookingUpdatedAt))
      return { ok: false, reason: "stale", message: "This booking has changed since you opened it. Close and reopen its details." };
    const court = context.courts.find((c) => c.id === edit.courtId && c.is_active);
    if (!court || !fitsOpeningHours(context.hours, edit.date, edit.startMinute, edit.endMinute))
      return { ok: false, message: "This booking or interval is no longer available to reschedule." };
    const target = await readCheckoutContext(court.id, edit.date, edit.startMinute, writer);
    if (!target) return { ok: false, message: "This booking or interval is no longer available to reschedule." };
    if (target.revision !== context.revision) continue;
    if (Date.parse(target.starts_at_instant) <= Date.parse(context.now))
      return { ok: false, message: "This booking or interval is no longer available to reschedule." };
    const occupied = await editOccupancy(context, edit.date, writer);
    if (occupied.some((o) => o.court_id === court.id && o.starts_at_minute < edit.endMinute && edit.startMinute < o.ends_at_minute))
      return { ok: false, message: "That court is no longer available. The booking has not changed." };
    const state = getCourtStateForDate(court.environment, context.coverage.filter((c) => c.court_id === court.id), edit.date);
    const times = Array.from({ length: (edit.endMinute - edit.startMinute) / 30 }, (_, i) => edit.startMinute + i * 30);
    const hourlyPrices = times.map((minute) => {
      const rule = resolvePricingRule(context.pricing, { court_id: court.id, court_state: state, date: edit.date, minute });
      return rule && minute + 30 <= rule.ends_at_minute ? rule.price_per_hour_minor : null;
    });
    const selection = getCalendarSelection({ courtId: court.id, times, cells: times.map(() => "available"), hourlyPrices }, 0, times.length);
    if (!selection || selection.priceMinor > 2147483647)
      return { ok: false, message: "No complete pricing is available for this interval. Choose another interval." };
    const total = selection.priceMinor;
    if (!edit.save) return { ok: true, totalAmountMinor: total };
    if (edit.expectedTotal !== total || total !== b.total_amount_minor && !edit.priceAcknowledged)
      return { ok: false, reason: "price_changed", totalAmountMinor: total, message: "The price has changed. Confirm the new total before saving." };
    const changed = r.court_id !== court.id || r.booking_date !== edit.date || r.starts_at_minute !== edit.startMinute || r.ends_at_minute !== edit.endMinute;
    const event = changed ? bookingNotification(scope === "owner" ? "customer_rescheduled" : "admin_rescheduled", context.fingerprint, {
      booking_id: b.id, customer_name: b.customer_name, location_name: context.location.name, timezone: context.location.timezone,
      court_name: court.name, booking_date: edit.date, starts_at_minute: edit.startMinute, ends_at_minute: edit.endMinute,
      total_amount_minor: total, currency: b.currency, previous: { booking_date: r.booking_date, starts_at_minute: r.starts_at_minute,
        ends_at_minute: r.ends_at_minute, court_name: context.court.name },
    }, b.customer_email) : null;
    const targetFirst = Date.parse(target.starts_at_instant) <= Date.parse(deadline.deadline);
    const result = await writer.rpc("commit_booking_reschedule", { ...commandFence(context), p_actor: actorId, p_actor_expected: actor, p_scope: scope,
      p_deadline: targetFirst ? target.starts_at_instant : deadline.deadline, p_inclusive: targetFirst ? false : deadline.inclusive, p_total: total, p_event: event,
      p_schedule: { court_id: court.id, booking_date: edit.date, starts_at_minute: edit.startMinute, ends_at_minute: edit.endMinute } });
    if (result.error?.code === "40001") continue;
    if (result.error?.code === "23P01") return { ok: false, message: "That court is no longer available. The booking has not changed." };
    if (result.error) {
      logger.error({ event: "bookings.reschedule_failed", actorId, bookingId: edit.id, code: result.error.code }, "Booking reschedule failed");
      return { ok: false, message: "Unable to reschedule this booking. Try again." };
    }
    return { ok: true, totalAmountMinor: total };
  }
  return { ok: false, message: "This booking or interval is no longer available to reschedule." };
}
