import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createBookingWriter } from "@/lib/supabase/booking-writer";
import { openingIntervalSchema } from "@/lib/admin/opening-hours-validation";
import { localStartInstant } from "@/lib/courts/local-time";
import { pricingRuleSchema } from "@/lib/pricing/validation";

const instant = z.string();
export const paymentFactSchema = z.object({ id: z.uuid(), booking_id: z.uuid(), method: z.string(), provider: z.string().nullable(),
  provider_payment_id: z.string().nullable(), amount_minor: z.number().int(), currency: z.string(), status: z.string(),
  expires_at: instant.nullable(), created_at: instant });
export const providerEventFactSchema = z.object({ provider: z.string(), event_id: z.string(), attempt_id: z.uuid(),
  provider_payment_id: z.string(), outcome: z.string(), settlement_result: z.string(), reconciliation_required: z.boolean(),
  amount_minor: z.number().int(), currency: z.string(), resolved_at: instant.nullable(), resolved_by_user_id: z.uuid().nullable() });
export const refundFactSchema = z.object({ id: z.uuid(), booking_id: z.uuid(), payment_attempt_id: z.uuid(), provider: z.string(),
  provider_payment_id: z.string(), amount_minor: z.number().int(), currency: z.string(), status: z.string(),
  provider_refund_id: z.string().nullable(), admin_lease_token: z.uuid().nullable(), admin_lease_until: instant.nullable(),
  admin_lease_actor_id: z.uuid().nullable() });
const locationFactSchema = z.object({ id: z.uuid(), name: z.string(), timezone: z.string(), currency: z.string(), is_active: z.boolean(),
  archived_at: instant.nullable(), is_public: z.boolean(), customer_cancellation_notice_minutes: z.number().int(), allow_pay_at_club: z.boolean() });
const courtFactSchema = z.object({ id: z.uuid(), name: z.string(), location_id: z.uuid(), is_active: z.boolean(), environment: z.enum(["indoor", "outdoor"]) });
const bookingContextSchema = z.object({ revision: z.number().int(), now: instant, starts_at_instant: instant,
  location: locationFactSchema, court: courtFactSchema, fingerprint: z.string(),
  booking: z.object({ id: z.uuid(), reservation_id: z.uuid(), account_user_id: z.uuid().nullable(), status: z.string(),
    updated_at: instant, total_amount_minor: z.number().int(), currency: z.string(), cancellation_notice_minutes: z.number().int(),
    customer_name: z.string(), customer_email: z.string(), customer_phone: z.string(), payment_method: z.string().nullable() }),
  reservation: z.object({ id: z.uuid(), court_id: z.uuid(), booking_date: z.string(), starts_at_minute: z.number().int(),
    ends_at_minute: z.number().int(), status: z.string(), hold_expires_at: instant.nullable(), updated_at: instant }),
  payments: z.array(paymentFactSchema), events: z.array(providerEventFactSchema), refund: refundFactSchema.nullable(),
  courts: z.array(courtFactSchema), hours: z.array(openingIntervalSchema),
  coverage: z.array(z.object({ court_id: z.uuid(), starts_on: z.string(), ends_on: z.string() })), pricing: z.array(pricingRuleSchema),
});
export type BookingContext = z.infer<typeof bookingContextSchema>;
export async function readCheckoutContext(courtId: string, date: string, startMinute: number, writer = createBookingWriter()) {
  // Read the revision first: configuration changes during subsequent SELECTs
  // are rejected by the locked revision check in commit_checkout.
  const revisionRead = await writer.from("booking_configuration_revision").select("revision").eq("id", true).single();
  if (revisionRead.error) throw new Error("Unable to read checkout configuration.");
  const { revision } = z.object({ revision: z.number().int() }).parse(revisionRead.data);
  const courtRead = await writer.from("courts").select("id,name,location_id,is_active,environment").eq("id", courtId).maybeSingle();
  if (courtRead.error) throw new Error("Unable to read checkout court.");
  if (!courtRead.data) return null;
  const court = courtFactSchema.parse(courtRead.data);
  const locationRead = await writer.from("locations")
    .select("id,name,timezone,currency,is_active,archived_at,is_public,customer_cancellation_notice_minutes,allow_pay_at_club")
    .eq("id", court.location_id).single();
  if (locationRead.error) throw new Error("Unable to read checkout location.");
  const location = locationFactSchema.parse(locationRead.data);
  return { revision, court, location, starts_at_instant: localStartInstant(location.timezone, date, startMinute) };
}
export function sameDatabaseInstant(a: string, b: string) {
  const fractionalRemainder = (value: string) => (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "").padEnd(6, "0").slice(3);
  return Date.parse(a) === Date.parse(b) && fractionalRemainder(a) === fractionalRemainder(b);
}
export async function readBookingActor(id: string, writer = createBookingWriter()) {
  const userRead = await writer.from("users").select("id,status").eq("id", id).single();
  if (userRead.error) throw new Error("Unable to read booking actor.");
  const user = z.object({ id: z.uuid(), status: z.string() }).parse(userRead.data);
  const rolesRead = await writer.from("user_roles").select("role_code").eq("user_id", user.id).order("role_code");
  if (rolesRead.error) throw new Error("Unable to read booking actor roles.");
  const assignments = z.array(z.object({ role_code: z.enum(["admin", "coach"]) })).parse(rolesRead.data);
  return { ...user, roles: assignments.map((assignment) => assignment.role_code) };
}
export async function readBookingContext(id: string, writer = createBookingWriter()) {
  const revisionRead = await writer.from("booking_configuration_revision").select("revision").eq("id", true).single();
  if (revisionRead.error) throw new Error("Unable to read booking configuration.");
  const { revision } = z.object({ revision: z.number().int() }).parse(revisionRead.data);

  // CSV keeps the scalar jsonb's PostgreSQL text intact. Decode only the
  // single-field record transport escaping; never serialize a JS snapshot.
  // Capture this before SELECTs so a later row change invalidates the command.
  const snapshotRead = await writer.rpc("booking_command_snapshot", { p_id: id }).csv();
  if (snapshotRead.error) throw new Error("Unable to read booking fingerprint.");
  const snapshotRecord = z.string().parse(snapshotRead.data);
  if (snapshotRecord === "pgrst_scalar\n") return null;
  const encodedSnapshot = /^pgrst_scalar\n"([\s\S]*)"$/.exec(snapshotRecord)?.[1];
  if (encodedSnapshot === undefined) throw new Error("Invalid booking fingerprint response.");
  const snapshotText = encodedSnapshot.replace(/""|\\\\/g, (escaped) => escaped === '""' ? '"' : "\\");
  const fingerprint = createHash("md5").update(snapshotText, "utf8").digest("hex");

  const bookingRead = await writer.from("bookings").select("*").eq("id", id).maybeSingle();
  if (bookingRead.error) throw new Error("Unable to read booking.");
  if (!bookingRead.data) return null;
  const booking = bookingContextSchema.shape.booking.parse(bookingRead.data);
  const reservationRead = await writer.from("court_reservations").select("*").eq("id", booking.reservation_id).single();
  if (reservationRead.error) throw new Error("Unable to read booking reservation.");
  const reservation = bookingContextSchema.shape.reservation.parse(reservationRead.data);
  const courtRead = await writer.from("courts").select("id,name,location_id,is_active,environment").eq("id", reservation.court_id).single();
  if (courtRead.error) throw new Error("Unable to read booking court.");
  const court = courtFactSchema.parse(courtRead.data);

  const reads = await Promise.allSettled([
    writer.from("locations")
      .select("id,name,timezone,currency,is_active,archived_at,is_public,customer_cancellation_notice_minutes,allow_pay_at_club")
      .eq("id", court.location_id).single(),
    writer.from("courts").select("id,name,location_id,is_active,environment").eq("location_id", court.location_id).order("id"),
    writer.from("location_opening_hours").select("*").eq("location_id", court.location_id),
    writer.from("location_pricing_rules").select("*").eq("location_id", court.location_id),
    writer.from("payment_attempts").select("*").eq("booking_id", id).order("created_at").order("id"),
    writer.from("payment_refunds").select("*").eq("booking_id", id).maybeSingle(),
  ]);
  const [locationRead, courtsRead, hoursRead, pricingRead, paymentsRead, refundRead] = reads.map((read) => {
    if (read.status === "rejected" || read.value.error) throw new Error("Unable to read booking command context.");
    return read.value;
  });
  const location = locationFactSchema.parse(locationRead.data);
  const courts = z.array(courtFactSchema).parse(courtsRead.data);
  const payments = z.array(paymentFactSchema).parse(paymentsRead.data);
  const relatedReads = await Promise.allSettled([
    courts.length ? writer.from("court_coverage_periods").select("court_id,starts_on,ends_on")
      .in("court_id", courts.map((item) => item.id)) : Promise.resolve({ data: [], error: null }),
    payments.length ? writer.from("payment_provider_events").select("*")
      .in("attempt_id", payments.map((item) => item.id)).order("provider").order("event_id") : Promise.resolve({ data: [], error: null }),
  ]);
  const [coverageRead, eventsRead] = relatedReads.map((read) => {
    if (read.status === "rejected" || read.value.error) throw new Error("Unable to read booking command context.");
    return read.value;
  });
  return bookingContextSchema.parse({ revision, fingerprint, booking, reservation, court, location, courts, payments,
    hours: hoursRead.data, pricing: pricingRead.data, refund: refundRead.data, coverage: coverageRead.data, events: eventsRead.data,
    starts_at_instant: localStartInstant(location.timezone, reservation.booking_date, reservation.starts_at_minute),
    now: new Date().toISOString(),
  });
}
export function commandFence(context: BookingContext) {
  return { p_id: context.booking.id, p_fingerprint: context.fingerprint, p_revision: context.revision };
}
