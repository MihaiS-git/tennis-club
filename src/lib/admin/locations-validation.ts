import { z } from "zod";
import { isCountryCode } from "@/lib/profile/countries";

export const locationCurrencies = ["EUR", "USD", "GBP", "RON", "CHF"] as const;
const timezones = new Set(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []);
function isIanaTimezone(value: string) {
  try {
    const canonical = new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
    return (value === "UTC" || value.includes("/")) && (canonical === "UTC" || timezones.has(canonical));
  } catch {
    return false;
  }
}

export function generateLocationSlug(name: string) {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
  currency: z.enum(locationCurrencies, "Select a supported currency."),
  is_active: z.boolean(),
  display_order: z.number().int("Enter a whole number.").min(-2147483648).max(2147483647),
});

export const locationMutationSchema = z.strictObject({
  id: z.uuid().optional(),
  fields: locationFieldsSchema,
});

export const locationArchiveSchema = z.strictObject({ id: z.uuid(), archived: z.boolean() });

export type LocationFormValues = z.input<typeof locationFieldsSchema>;
export type LocationMutationResult =
  | { ok: true; id: string }
  | { ok: false; reason: "invalid-input"; fieldErrors: Record<string, string> }
  | { ok: false; reason: "duplicate-slug" | "not-found" };
