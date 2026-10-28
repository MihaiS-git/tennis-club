import { z } from "zod";
import { cancellationNoticeMinutesSchema } from "@/lib/bookings/cancellation-policy";
import { isCountryCode } from "@/lib/profile/countries";
import { locationCurrencies } from "@/lib/pricing/currency";

export { locationCurrencies };

const timezones = new Set(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []);
export function isIanaTimezone(value: string) {
  try {
    const canonical = new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
    return (value === "UTC" || value.includes("/")) && (canonical === "UTC" || timezones.has(canonical));
  } catch {
    return false;
  }
}

const optionalText = (limit: number) => z.string().trim().max(limit, `Use at most ${limit} characters.`)
  .transform((value) => value || null);

export const locationFieldsSchema = z.strictObject({
  name: z.string().trim().min(1, "Enter a location name.").max(100, "Use at most 100 characters."),
  address_line1: optionalText(200),
  address_line2: optionalText(200),
  city: optionalText(100),
  postal_code: optionalText(20),
  country_code: z.string().trim().toUpperCase().refine((value) => value === "" || isCountryCode(value),
    "Select a supported country.").transform((value) => value || null),
  timezone: z.string().trim().refine(isIanaTimezone, "Enter an IANA timezone, such as Europe/Bucharest."),
  allow_pay_at_club: z.boolean().default(false),
  customer_cancellation_notice_minutes: cancellationNoticeMinutesSchema,
  currency: z.enum(locationCurrencies, "Select a supported currency."),
  is_active: z.boolean(),
  is_public: z.boolean(),
  display_order: z.number().int("Enter a whole number.").min(-2147483648).max(2147483647),
});

export const locationMutationSchema = z.strictObject({
  id: z.uuid().optional(),
  fields: locationFieldsSchema,
});

export const locationArchiveSchema = z.strictObject({ id: z.uuid(), archived: z.boolean() });

// Reasons an existing location's currency cannot change. Court prices carry no
// currency, so every prerequisite must hold before amounts change denomination.
export type CurrencyChangeBlocker =
  | { kind: "unfinished-bookings"; courtBookings: number; coachingBookings: number; reservations: number; checkouts: number }
  | { kind: "financial-operations" | "court-pricing" };

function counted(count: number, noun: string) {
  return count ? `${count} ${noun}${count === 1 ? "" : "s"}` : null;
}

export function currencyChangeBlockerMessage(blocker: CurrencyChangeBlocker) {
  switch (blocker.kind) {
    case "unfinished-bookings": {
      const remaining = [counted(blocker.courtBookings, "court booking"), counted(blocker.coachingBookings, "coaching booking"),
        counted(blocker.reservations, "staff reservation"), counted(blocker.checkouts, "pending checkout")].filter(Boolean).join(", ");
      return `Currency cannot be changed while this location has unfinished bookings (${remaining}). Cancel the remaining bookings or wait until they are completed.`
        + (blocker.checkouts ? " Pending checkouts are confirmed or released when their payment completes or expires." : "");
    }
    case "financial-operations":
      return "Resolve pending payment, refund, or reconciliation operations in Admin → Payments → Transactions before changing the currency.";
    case "court-pricing":
      return "Remove the existing court pricing rules in this location's Pricing tab before changing the currency. Configure new prices afterward.";
  }
}

export type LocationMutationResult =
  | { ok: true; id: string }
  | { ok: false; reason: "invalid-input"; fieldErrors: Record<string, string> }
  | { ok: false; reason: "duplicate-slug" | "not-found" }
  | { ok: false; reason: "not-ready"; message: string }
  | { ok: false; reason: "currency-locked"; blockers: CurrencyChangeBlocker[] };
