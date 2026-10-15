import type { CourtDay } from "./calendar";
import type { PublicCourt, PublicLocation } from "./public";

export const surfaceLabels: Record<PublicCourt["surface"], string> = {
  clay: "Clay", hard: "Hard", grass: "Grass", carpet: "Carpet",
};

const countryNames = new Intl.DisplayNames(["en"], { type: "region" });

// Configured address lines of a public location; absent optional fields are omitted.
export function locationAddressLines(location: Pick<PublicLocation, "address_line1" | "address_line2" | "city" | "postal_code" | "country_code">): string[] {
  return [
    location.address_line1,
    location.address_line2,
    [location.city, location.postal_code].filter(Boolean).join(", "),
    location.country_code ? countryNames.of(location.country_code) ?? location.country_code : null,
  ].filter((line): line is string => Boolean(line));
}

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// Club-wide figures derived from the public locations projection, in its order.
export function summarizeClubCourts(locations: readonly Pick<PublicLocation, "courts">[]) {
  const surfaces = new Map<PublicCourt["surface"], number>();
  for (const court of locations.flatMap((location) => location.courts)) {
    surfaces.set(court.surface, (surfaces.get(court.surface) ?? 0) + 1);
  }
  return {
    locationCount: locations.length,
    courtCount: locations.reduce((total, location) => total + location.courts.length, 0),
    surfaces: [...surfaces].map(([surface, count]) => ({ surface, count })),
  };
}

// Compact preview of a booking calendar day: starting times backed by two
// consecutive available half-hour cells, i.e. the 60-minute booking minimum.
export function hourlyStartPreview(day: { times: readonly number[]; courts: readonly CourtDay[] },
  limits = { courts: 4, starts: 3 }) {
  const courts = day.courts.map(({ court, cells }) => ({
    court,
    starts: day.times.filter((minute, index) => cells[index] === "available"
      && cells[index + 1] === "available" && day.times[index + 1] === minute + 30),
  }));
  const orderedCourts = [
    ...courts.filter(({ starts }) => starts.length > 0),
    ...courts.filter(({ starts }) => starts.length === 0),
  ];
  return {
    closed: day.courts.every((court) => court.cells.every((cell) => cell === "closed")),
    available: courts.some((court) => court.starts.length > 0),
    courts: orderedCourts.slice(0, limits.courts).map(({ court, starts }) => ({ court, starts: starts.slice(0, limits.starts) })),
  };
}
