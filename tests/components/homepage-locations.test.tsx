// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PublicLocation } from "@/lib/courts/public";

import { HomeLocations } from "@/app/home-locations";

const court = { id: "22222222-2222-4222-8222-222222222222", name: "Court 1", slug: "court-1", surface: "clay", environment: "outdoor", has_lighting: false } as const;
const east: PublicLocation = { id: "11111111-1111-4111-8111-111111111111", name: "East Club", slug: "east",
  address_line1: "1 Court Road", address_line2: null, city: "Cluj-Napoca", postal_code: "400000", country_code: "RO",
  timezone: "Europe/Bucharest", currency: "RON", allow_pay_at_club: false,
  courts: [court, { ...court, id: "33333333-3333-4333-8333-333333333333" }],
  todayOpeningHours: [{ opens_at_minute: 480, closes_at_minute: 720 }, { opens_at_minute: 780, closes_at_minute: 1440 }] };
const west: PublicLocation = { ...east, id: "44444444-4444-4444-8444-444444444444", name: "West Club",
  address_line1: null, city: "Oradea", postal_code: null, country_code: null, courts: [court], todayOpeningHours: [] };

const section = async (locations: PublicLocation[] | Error, selection?: string) => render(await HomeLocations({
  locations: locations instanceof Error ? Promise.reject(locations) : Promise.resolve(locations),
  searchParams: Promise.resolve({ location: selection }),
}));

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

it("lists every public location in order with address, courts, today's hours and links", async () => {
  vi.stubEnv("GOOGLE_MAPS_EMBED_API_KEY", "key");
  await section([east, west]);
  const [first, second] = screen.getAllByRole("listitem");
  expect(first.textContent).toContain("East Club");
  expect(first.textContent).toContain("1 Court Road");
  expect(first.textContent).toContain("Cluj-Napoca, 400000");
  expect(first.textContent).toContain("Romania");
  expect(first.textContent).toContain("2 courts");
  expect(first.textContent).toContain("08:00–12:00, 13:00–24:00");
  expect(within(first).getByRole("link", { name: /Book a court/ }).getAttribute("href")).toBe(`/book?location=${east.id}`);
  expect(within(first).getByRole("link", { name: /Get directions/ }).getAttribute("href"))
    .toBe(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("1 Court Road, Cluj-Napoca, 400000, Romania").replaceAll("%20", "+")}`);
  expect(second.textContent).toContain("1 court");
  expect(second.textContent).toContain("Closed today");
  // Insufficient address: no directions are offered.
  expect(within(second).queryByRole("link", { name: /Get directions/ })).toBeNull();
  expect(within(second).getByRole("link", { name: /Show on map/ }).getAttribute("href")).toBe(`/?location=${west.id}`);
  expect(screen.getByTitle("Map showing East Club").getAttribute("src")).toContain("q=1+Court+Road%2C+Cluj-Napoca");
});

it.each([undefined, "invalid"])("falls back to the first public location for selection %s", async (selection) => {
  vi.stubEnv("GOOGLE_MAPS_EMBED_API_KEY", "key");
  await section([east, west], selection);
  expect(screen.getAllByRole("listitem")[0].getAttribute("aria-current")).toBe("true");
  expect(screen.getByTitle("Map showing East Club")).toBeTruthy();
});

it("shows the selected location's map fallback instead of guessing an insufficient address", async () => {
  vi.stubEnv("GOOGLE_MAPS_EMBED_API_KEY", "key");
  await section([east, west], west.id);
  expect(screen.getAllByRole("listitem")[1].getAttribute("aria-current")).toBe("true");
  expect(screen.queryByTitle(/Map showing/)).toBeNull();
  expect(screen.getByText("A map is not available for West Club.")).toBeTruthy();
});

it("omits selection controls for a single location", async () => {
  await section([east]);
  expect(screen.queryByRole("link", { name: /Show on map/ })).toBeNull();
  expect(screen.getByRole("listitem").getAttribute("aria-current")).toBeNull();
  expect(screen.getByText("Map unavailable.")).toBeTruthy();
});

it("renders empty and failure states", async () => {
  await section([]);
  expect(screen.getByText("No club locations are currently open to the public.")).toBeTruthy();
  cleanup();
  await section(new Error("db"));
  expect(screen.getByText("Location information is currently unavailable.")).toBeTruthy();
});
