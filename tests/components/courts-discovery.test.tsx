// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PublicLocationToday } from "@/lib/courts/public-calendar";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/courts/public-calendar", () => ({ listPublicLocationsToday: load }));
import { CourtsConditions } from "@/app/courts/courts-conditions";
import { CourtsDiscovery } from "@/app/courts/courts-discovery";

afterEach(cleanup);
const location: PublicLocationToday = {
  id: "11111111-1111-4111-8111-111111111111", name: "Riverside", slug: "riverside", timezone: "Europe/Bucharest",
  currency: "RON", allow_pay_at_club: false, address_line1: "1 Court Road", address_line2: null, city: "City", postal_code: "12345", country_code: "RO", todayOpeningHours: [],
  courts: [{ id: "22222222-2222-4222-8222-222222222222", name: "Clay One", slug: "clay-one", surface: "clay", environment: "outdoor", has_lighting: true },
    { id: "33333333-3333-4333-8333-333333333333", name: "Hard Two", slug: "hard-two", surface: "hard", environment: "indoor", has_lighting: false }],
  openingHours: [{ opens_at_minute: 480, closes_at_minute: 720 }, { opens_at_minute: 780, closes_at_minute: 1440 }], startingRateMinor: 5017,
};

it("renders ordered locations/courts, attributes, split hours, currencies and location-specific booking links", async () => {
  load.mockResolvedValue([location, { ...location, id: "44444444-4444-4444-8444-444444444444", name: "West", currency: "USD", courts: [location.courts[1]] }]);
  render(await CourtsDiscovery({ locations: load() }));
  expect(screen.getByText("3 courts")).toBeTruthy();
  expect(screen.getByText(/across 2 locations/)).toBeTruthy();
  const articles = screen.getAllByRole("article");
  expect(articles.map((article) => within(article).getByRole("heading", { level: 3 }).textContent)).toEqual(["Riverside", "West"]);
  const first = within(articles[0]);
  expect(first.getAllByRole("heading", { level: 4 }).map((node) => node.textContent)).toEqual(["Clay One", "Hard Two"]);
  for (const text of ["Clay", "Outdoor", "Floodlit", "Hard", "Indoor", "08:00–12:00, 13:00–24:00", "From RON 50.17/hour"])
    expect(first.getByText(text)).toBeTruthy();
  expect(first.getAllByText("Floodlit")).toHaveLength(1);
  // Unlit courts carry the canonical label rather than omitting lighting.
  expect(first.getAllByText("No lighting")).toHaveLength(1);
  expect(screen.getAllByText("01").concat(screen.getAllByText("02"))).toHaveLength(2);
  expect(within(articles[1]).getByText("From US$50.17/hour")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Book at Riverside" }).getAttribute("href")).toBe(`/book?location=${location.id}`);
  expect(screen.getByRole("link", { name: "Book at West" }).getAttribute("href")).toBe("/book?location=44444444-4444-4444-8444-444444444444");
  expect(screen.queryByText(/available slots|courts available/i)).toBeNull();
});

it.each(["EUR", "GBP"] as const)("formats %s rates", async (currency) => {
  load.mockResolvedValue([{ ...location, currency }]);
  render(await CourtsDiscovery({ locations: load() }));
  expect(screen.getByText(currency === "EUR" ? "From €50.17/hour" : "From £50.17/hour")).toBeTruthy();
});

it("shows Closed and the rate fallback while retaining an eligible location", async () => {
  load.mockResolvedValue([{ ...location, courts: [location.courts[0]], openingHours: [], startingRateMinor: null }]);
  render(await CourtsDiscovery({ locations: load() }));
  expect(screen.getByText("Closed")).toBeTruthy();
  expect(screen.getByText("See rates when booking")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Book at Riverside" })).toBeTruthy();
  expect(screen.queryByText(/From .*\/hour/)).toBeNull();
});

it("renders the empty state without booking links or obsolete static rates", async () => {
  load.mockResolvedValue([]);
  render(await CourtsDiscovery({ locations: load() }));
  expect(screen.getByText(/No club locations are currently open for public booking/)).toBeTruthy();
  expect(screen.queryByRole("article")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});

it("describes only the playing conditions the published courts actually have", async () => {
  const courts = location.courts;
  render(await CourtsConditions({ locations: Promise.resolve([location, { ...location, id: "44444444-4444-4444-8444-444444444444", courts: [{ ...courts[0], id: "55555555-5555-4555-8555-555555555555" }] }]) }));
  expect(screen.getAllByRole("heading", { level: 3 }).map((node) => node.textContent)).toEqual(["Clay", "Hard", "Indoor", "Floodlit"]);
  expect(screen.getAllByText("2 courts")).toHaveLength(2);
  expect(screen.getAllByText("1 court")).toHaveLength(2);
  // Only clay is illustrated, with clay photography.
  expect(screen.getAllByRole("img").map((image) => image.getAttribute("src"))).toEqual(["/images/tennis-hero-desktop.webp"]);
  expect(screen.queryByText(/rackets and balls/i)).toBeNull();
});

it("leaves conditions out without courts, and without photography when no illustrated surface is published", async () => {
  expect(await CourtsConditions({ locations: Promise.resolve([]) })).toBeNull();
  expect(await CourtsConditions({ locations: Promise.reject(new Error("db")) })).toBeNull();
  render(await CourtsConditions({ locations: Promise.resolve([{ ...location, courts: [location.courts[1]] }]) }));
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getAllByRole("heading", { level: 3 }).map((node) => node.textContent)).toEqual(["Hard", "Indoor"]);
});
