import { locationCurrencies, isIanaTimezone } from "@/lib/admin/locations-validation";
import { localToday } from "@/lib/courts/calendar";

export type PublicationConfiguration = {
  name: string;
  slug: string;
  timezone: string;
  currency: string;
  is_active: boolean;
  is_public: boolean;
  archived_at: string | null;
  location_opening_hours: { id: string }[];
  courts: { id: string; environment: "indoor" | "outdoor"; location_pricing_rules: {
    court_state: "indoor" | "outdoor" | "covered"; ends_on: string | null;
  }[] }[];
};

export function publicationReadiness(location: PublicationConfiguration, today: string): string[] {
  const missing: string[] = [];
  if (!location.name.trim() || !location.slug.trim() || !isIanaTimezone(location.timezone)
    || !locationCurrencies.some((currency) => currency === location.currency)) missing.push("valid location details");
  if (location.location_opening_hours.length === 0) missing.push("opening hours");
  if (location.courts.length === 0) missing.push("an active court");
  if (location.courts.some((court) => !court.location_pricing_rules.some((rule) =>
    rule.court_state === court.environment && (!rule.ends_on || rule.ends_on >= today)))) {
    missing.push("pricing for every active court");
  }
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
