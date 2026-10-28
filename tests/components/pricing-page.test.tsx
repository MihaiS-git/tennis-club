// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpeningInterval } from "@/lib/admin/opening-hours-validation";
import type { PublicCoaching, PublicCoachingProgram } from "@/lib/coaching/public";
import type { PublicLocation } from "@/lib/courts/public";
import type { PublicLocationToday } from "@/lib/courts/public-calendar";
import type { PricingRule } from "@/lib/pricing/validation";
import { formatMoney } from "@/lib/pricing/money";

const reads = vi.hoisted(() => ({ locations: vi.fn(), hours: vi.fn(), coverage: vi.fn(), pricing: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/courts/public", () => ({ listPublicLocationsWithCourts: reads.locations }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: {} }) }));
vi.mock("@/lib/db/repositories/clubs.repository", () => ({ listPublicDayOpeningHours: reads.hours, listPublicDayCoverage: reads.coverage }));
vi.mock("@/lib/db/repositories/pricing.repository", () => ({ listPublicDayPricing: reads.pricing }));
vi.mock("@/lib/db/repositories/reservations.repository", () => ({ listPublicDayOccupancy: vi.fn() }));
vi.mock("@/lib/coaching/public", () => ({ readPublicCoaching: async () => ({ programs: [], coaches: [] }) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import PricingPage, { metadata } from "@/app/pricing/page";
import { CoachingRates, CourtRates } from "@/app/pricing/pricing-sections";
import { listPublicLocationsToday } from "@/lib/courts/public-calendar";

const id = "11111111-1111-4111-8111-111111111111";
const courtId = "22222222-2222-4222-8222-222222222222";
const stamp = "2026-10-01T00:00:00Z";
const location: PublicLocation = { id, name: "East Club", slug: "east", address_line1: null, address_line2: null,
  city: null, postal_code: null, country_code: null, timezone: "Europe/Bucharest", currency: "RON", allow_pay_at_club: true,
  customer_cancellation_notice_minutes: null, todayOpeningHours: [],
  courts: [{ id: courtId, name: "Court 1", slug: "court-1", surface: "clay", environment: "outdoor", has_lighting: true }] };
const hours = (start: number, end: number): OpeningInterval => ({ id: crypto.randomUUID(), location_id: id,
  weekday: 3, opens_at_minute: start, closes_at_minute: end, created_at: stamp, updated_at: stamp });
const price = (start: number, end: number, amount: number): PricingRule => ({
  id: crypto.randomUUID(), rule_set_id: crypto.randomUUID(), location_id: id, court_id: courtId, court_state: "outdoor", weekday: 3,
  starts_at_minute: start, ends_at_minute: end, price_per_hour_minor: amount, starts_on: null, ends_on: null, created_at: stamp, updated_at: stamp });
const now = new Date("2026-10-15T09:15:00Z"); // Thursday in Bucharest.

const program = (change: Partial<PublicCoachingProgram>): PublicCoachingProgram => ({
  id: crypto.randomUUID(), name: "Private lesson", description: "", type: "private", durations: [60, 90],
  minParticipants: 1, maxParticipants: 1, courtRentalIncluded: false, prices: [], fromPrices: [], ...change });

const renderAsync = async (node: Promise<React.ReactNode>) => render(<>{await node}</>);

beforeEach(() => {
  vi.resetAllMocks();
  reads.locations.mockResolvedValue([location]);
  reads.hours.mockResolvedValue([hours(480, 600)]);
  reads.coverage.mockResolvedValue([]);
});
afterEach(cleanup);

it("shows a low half-hour band as today's lowest hourly rate, never as the price of a 60-minute booking", async () => {
  // 08:00–08:30 costs 10.00/hour; the rest of the morning 60.00/hour.
  reads.pricing.mockResolvedValue([price(480, 510, 1000), price(510, 600, 6000)]);
  await renderAsync(CourtRates({ locations: listPublicLocationsToday(now) }));
  const entry = within(screen.getByRole("list", { name: "Court hire by location" })).getByRole("listitem");
  expect(entry.textContent).toContain("Lowest hourly rate today");
  expect(entry.textContent).toContain(`From ${formatMoney(1000, "RON")} per hour`);
  // Neither the half-hour slot amount nor a 60-minute total is derived from the minimum.
  for (const amount of [500, 3500, 7000]) expect(entry.textContent).not.toContain(formatMoney(amount, "RON"));
  expect(entry.textContent).not.toMatch(/60 min|per booking|total/i);
  expect(entry.textContent).toContain("Prices in RON · Pay online or at the club");
  expect(within(entry).getByRole("link", { name: /Exact prices at East Club/ }).getAttribute("href")).toBe(`/book?location=${id}`);
});

it("states missing court rates and failed reads instead of inventing prices", async () => {
  await renderAsync(CourtRates({ locations: Promise.resolve([{ ...location, openingHours: [], startingRateMinor: null } satisfies PublicLocationToday]) }));
  expect(screen.getByText("No court rate available for today.")).toBeTruthy();
  expect(screen.queryByText(/per hour/)).toBeNull();
  cleanup();
  await renderAsync(CourtRates({ locations: Promise.reject(new Error("db")) }));
  expect(screen.getByText("Pricing temporarily unavailable.")).toBeTruthy();
  cleanup();
  await renderAsync(CoachingRates({ coaching: Promise.reject(new Error("db")) }));
  expect(screen.getByText("Pricing temporarily unavailable.")).toBeTruthy();
});

it("orders online-bookable programs first and summarizes starting prices per currency without adding court rates", async () => {
  const coaching: PublicCoaching = {
    programs: [
      program({ name: "Private lesson", fromPrices: [{ currency: "EUR", amountMinor: 4000 }, { currency: "RON", amountMinor: 15000 }] }),
      program({ name: "Junior squad", type: "junior", durations: [90], minParticipants: 4, maxParticipants: 8, courtRentalIncluded: true,
        fromPrices: [{ currency: "RON", amountMinor: 6000 }] }),
      program({ name: "Group clinic", type: "group", minParticipants: 3, maxParticipants: 6 }),
      program({ name: "Semi-private", type: "semi_private", minParticipants: 2, maxParticipants: 2 }),
    ],
    coaches: [
      { id: "c1", displayName: "Ana Pop", bio: "", qualifications: "", specialties: [], languages: [], locations: [], programs: [],
        rates: [{ programId: "p", programName: "Private lesson", courtRentalIncluded: false, durationMinutes: 60, participantCount: 1, currency: "RON", amountMinor: 18000 }] },
      { id: "c2", displayName: "Dan Ionescu", bio: "", qualifications: "", specialties: [], languages: [], locations: [], programs: [], rates: [] },
    ],
  };
  await renderAsync(CoachingRates({ coaching: Promise.resolve(coaching) }));
  const programs = within(screen.getByRole("list", { name: "Coaching starting prices" })).getAllByRole("listitem")
    .filter((item) => item.parentElement?.getAttribute("aria-label") === "Coaching starting prices");
  // Sorted by program type, not by name or input order.
  expect(programs.map((item) => within(item).getByRole("heading", { level: 3 }).textContent))
    .toEqual(["Private lesson", "Semi-private", "Group clinic", "Junior squad"]);
  const [privateLesson, semi, , junior] = programs;
  // Currencies stay separate; amounts are never compared or converted.
  expect(within(privateLesson).getByRole("list", { name: "Private lesson starting prices" }).textContent)
    .toBe(`From ${formatMoney(4000, "EUR")}From ${formatMoney(15000, "RON")}`);
  expect(privateLesson.textContent).toContain("60 min · 90 min · 1 player");
  expect(privateLesson.textContent).toContain("Court rental not included · Court hire is charged separately");
  expect(privateLesson.textContent).toContain("Plus court hire");
  expect(privateLesson.textContent).toContain("Booked and paid online");
  expect(privateLesson.textContent).toContain("Per person per lesson");
  expect(junior.textContent).toContain("4–8 players · Court rental included");
  expect(junior.textContent).toContain("Paid at the club");
  expect(junior.textContent).not.toMatch(/not included|Plus court hire/);
  expect(semi.textContent).toContain("Prices not published.");
  // Only coaches whose own prices exist are named, linked to their profiles.
  expect(screen.getByRole("link", { name: "Ana Pop" }).getAttribute("href")).toBe("/coaching/coaches/c1");
  expect(screen.queryByRole("link", { name: "Dan Ionescu" })).toBeNull();
  expect(document.body.textContent).not.toContain(formatMoney(18000, "RON"));
});

it("composes the pricing sections with in-page navigation, booking links and metadata", () => {
  reads.pricing.mockResolvedValue([]);
  render(<PricingPage />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Court and coaching prices.");
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "Hourly rates by location.", "Lessons, priced per person.", "How booking and payment work.",
  ]);
  const nav = screen.getByRole("navigation", { name: "On this page" });
  for (const link of within(nav).getAllByRole("link")) {
    expect(document.getElementById(link.getAttribute("href")!.slice(1))?.tagName).toBe("SECTION");
  }
  expect(screen.getByRole("link", { name: "Book a court" }).getAttribute("href")).toBe("/book");
  expect(screen.getByRole("link", { name: /Book coaching/ }).getAttribute("href")).toBe("/book?mode=coaching");
  expect(metadata.title).toBe("Pricing | Tennis Club");
});
