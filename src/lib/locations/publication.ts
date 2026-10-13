import { z } from "zod";
import { mondayWeekday, pricingHasFutureOccurrence } from "@/lib/pricing/resolution";
import { locationCurrencies, isIanaTimezone } from "@/lib/admin/locations-validation";
import { localToday } from "@/lib/courts/calendar";

export const publicationHoursSchema = z.object({
  id: z.uuid(), weekday: z.number().int().min(0).max(6),
  starts_on: z.iso.date(), ends_on: z.iso.date().nullable(),
  opens_at_minute: z.number().int().min(0).max(1439), closes_at_minute: z.number().int().min(1).max(1440),
}).refine((hour) => hour.opens_at_minute < hour.closes_at_minute)
  .refine((hour) => hour.ends_on === null || hour.starts_on <= hour.ends_on);
export const publicationPricingSchema = z.object({
  court_state: z.enum(["indoor", "outdoor", "covered"]), weekday: z.number().int().min(0).max(6),
  starts_on: z.iso.date().nullable(), ends_on: z.iso.date().nullable(),
  starts_at_minute: z.number().int().min(0).max(1439), ends_at_minute: z.number().int().min(1).max(1440),
}).refine((rule) => rule.starts_at_minute < rule.ends_at_minute)
  .refine((rule) => rule.starts_on === null || rule.ends_on === null || rule.starts_on <= rule.ends_on);

export type PublicationConfiguration = {
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  is_active: boolean;
  is_public: boolean;
  archived_at: string | null;
  location_opening_hours: z.infer<typeof publicationHoursSchema>[];
  courts: { id: string; environment: "indoor" | "outdoor"; location_pricing_rules: z.infer<typeof publicationPricingSchema>[] }[];
};

export function publicationReadiness(location: PublicationConfiguration, today: string): string[] {
  const missing: string[] = [];
  if (!location.name.trim() || !location.slug.trim() || !isIanaTimezone(location.timezone)
    || !locationCurrencies.some((currency) => currency === location.currency)) missing.push("valid location details");
  const relevantHours = location.location_opening_hours.filter((h) => (!h.ends_on || h.ends_on >= today) && pricingHasFutureOccurrence({ weekday: h.weekday, starts_on: h.starts_on, ends_on: h.ends_on }, today));
  if (relevantHours.length === 0) missing.push("opening hours");
  if (location.courts.length === 0) missing.push("an active court");
  if (location.courts.some((court) => {
    const prices = court.location_pricing_rules.filter((rule) => rule.court_state === court.environment
      && (!rule.ends_on || rule.ends_on >= today));
    if (!prices.length) return true;
    return relevantHours.some((hour) => {
      const dayPrices = prices.filter((rule) => rule.weekday === hour.weekday);
      const firstDate = hour.starts_on > today ? hour.starts_on : today;
      const dates = [...new Set([firstDate, ...dayPrices.map((r) => r.starts_on).filter((d): d is string => d !== null && d > firstDate)])];
      return !dates.some((first) => {
        const date = new Date(`${first}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() + (hour.weekday - mondayWeekday(first) + 7) % 7);
        const occurrence = date.toISOString().slice(0, 10);
        if (hour.ends_on && occurrence > hour.ends_on) return false;
        const rules = dayPrices.filter((r) => (!r.starts_on || r.starts_on <= occurrence)
          && (!r.ends_on || occurrence <= r.ends_on));
        let covered = hour.opens_at_minute;
        for (const rule of rules.sort((a,b) => a.starts_at_minute - b.starts_at_minute)) {
          if (rule.starts_at_minute > covered) break;
          covered = Math.max(covered, rule.ends_at_minute);
        }
        return covered >= hour.closes_at_minute;
      });
    });
  })) missing.push("pricing for every active court");
  return missing;
}

export function isPubliclyEligible(location: PublicationConfiguration, today: string): boolean {
  return location.is_public && isStructurallyReady(location, today);
}

export function isStructurallyReady(location: PublicationConfiguration, today: string): boolean {
  return location.is_active && location.archived_at === null && publicationReadiness(location, today).length === 0;
}

export function publicationToday(timezone: string, now = new Date()): string {
  return localToday(isIanaTimezone(timezone) ? timezone : "UTC", now);
}

export function publicationError(missing: string[]): string {
  return `This location cannot be published yet. Configure ${missing.join(", ")}.`;
}
