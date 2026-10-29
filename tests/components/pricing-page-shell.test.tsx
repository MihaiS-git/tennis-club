// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

// jsdom renders Client Components, not async RSC children. The real sections
// are exercised independently in pricing-page.test.tsx.
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/app/pricing/pricing-sections", () => ({
  CourtRates: () => null,
  CoachingRates: () => null,
}));
vi.mock("@/lib/courts/public-calendar", () => ({ listPublicLocationsToday: async () => [] }));
vi.mock("@/lib/coaching/public", () => ({ readPublicCoaching: async () => ({ programs: [], coaches: [] }) }));
import PricingPage, { metadata } from "@/app/pricing/page";

afterEach(cleanup);

it("composes the pricing sections with in-page navigation, booking links and metadata", () => {
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
