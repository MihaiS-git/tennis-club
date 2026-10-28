import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { ClubContact } from "@/lib/club/schema";
import type { PublicVisitorLocation } from "@/lib/courts/public";

const schemaWeekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// schema.org description of each published location, built only from stored data.
export function locationsStructuredData(locations: readonly PublicVisitorLocation[], contact: ClubContact) {
  return {
    "@context": "https://schema.org",
    "@graph": locations.map((location) => ({
      "@type": "SportsActivityLocation",
      name: location.name,
      address: {
        "@type": "PostalAddress",
        ...(location.address_line1 && { streetAddress: [location.address_line1, location.address_line2].filter(Boolean).join(", ") }),
        ...(location.city && { addressLocality: location.city }),
        ...(location.postal_code && { postalCode: location.postal_code }),
        ...(location.country_code && { addressCountry: location.country_code }),
      },
      ...(contact.contactPhone && { telephone: contact.contactPhone }),
      ...(contact.contactEmail && { email: contact.contactEmail }),
      openingHoursSpecification: location.weekOpeningHours.flatMap((day) => day.intervals.map((interval) => ({
        "@type": "OpeningHoursSpecification",
        dayOfWeek: `https://schema.org/${schemaWeekdays[day.weekday]}`,
        opens: minuteToTime(interval.opens_at_minute),
        // schema.org expresses closing at midnight as the last minute of the day.
        closes: interval.closes_at_minute === 1440 ? "23:59" : minuteToTime(interval.closes_at_minute),
      }))),
    })),
  };
}

// Serialized for an inline JSON-LD script; "<" is escaped so data cannot close the tag.
export function jsonLd(data: unknown) {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
