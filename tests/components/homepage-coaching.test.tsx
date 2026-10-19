// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/courts/public", () => ({ listPublicLocationsWithCourts: vi.fn(async () => []) }));
const { readPublicCoaching } = vi.hoisted(() => ({ readPublicCoaching: vi.fn(async () => ({ programs: [], coaches: [] })) }));
vi.mock("@/lib/coaching/public", () => ({ readPublicCoaching }));
vi.mock("@/app/home-court-availability", () => ({ CourtAvailabilityCard: () => null, CourtAvailabilityCardShell: () => null }));
vi.mock("@/app/home-court-summary", () => ({ FacilitiesCourtsFallback: () => null, FacilitiesCourtsSummary: () => null,
  HeroCourtSummary: () => null, heroSummaryClassName: "" }));
vi.mock("@/app/home-locations", () => ({ HomeLocations: () => null, HomeLocationsShell: () => null }));

import { HomeCoachingPrograms } from "@/app/home-coaching";
import Home from "@/app/page";
import type { PublicCoaching } from "@/lib/coaching/public";

afterEach(cleanup);

it("links to coaching without implying online lesson booking or invented lesson times", () => {
  render(<Home params={Promise.resolve({})} searchParams={Promise.resolve({})} />);
  const coachingLinks = screen.getAllByRole("link").filter((link) => link.getAttribute("href") === "/coaching");
  expect(coachingLinks.length).toBeGreaterThan(0);
  for (const link of coachingLinks) expect(link.textContent).not.toMatch(/book/i);
  const card = screen.getByRole("article", { name: "Coaching" });
  expect(card.textContent).toContain("Lessons can’t be booked online yet.");
  expect(card.textContent).not.toMatch(/\d{1,2}:\d{2}|availability|slot/i);
  expect(within(card).getByRole("link", { name: /Explore coaching/ }).getAttribute("href")).toBe("/coaching");
});

const program = (id: string, name: string) => ({ id, name, description: "", type: "private" as const, durations: [60],
  minParticipants: null, maxParticipants: null, courtRentalIncluded: true, prices: [] });
const show = async (coaching: PublicCoaching | Error) =>
  render(await HomeCoachingPrograms({ coaching: coaching instanceof Error ? Promise.reject(coaching) : Promise.resolve(coaching) }));

it("names only the coaching programs published in the database", async () => {
  await show({ programs: [program("p1", "Private coaching"), program("p2", "Junior coaching")], coaches: [] });
  expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Private coaching", "Junior coaching"]);
  expect(document.body.textContent).not.toMatch(/Performance training|Individual coaching|Group sessions/);
});

it("uses neutral copy when no program is published or coaching cannot be loaded", async () => {
  await show({ programs: [], coaches: [] });
  expect(screen.queryByRole("list")).toBeNull();
  expect(document.body.textContent).toContain("as soon as the club publishes them");
  cleanup();
  await show(new Error("Unable to load coaching."));
  expect(screen.queryByRole("list")).toBeNull();
  expect(document.body.textContent).toContain("listed on the Coaching page");
});

it("reads coaching once, on the same public locations, without hardcoded categories", async () => {
  render(<Home params={Promise.resolve({})} searchParams={Promise.resolve({})} />);
  await vi.waitFor(() => expect(readPublicCoaching).toHaveBeenCalledWith([]));
  expect(readPublicCoaching).toHaveBeenCalledTimes(1);
  const section = document.getElementById("coaching")!;
  expect(section.textContent).not.toMatch(/Performance training|Individual coaching/);
  expect(within(section).getByRole("link", { name: /Meet the coaches/ }).getAttribute("href")).toBe("/coaching");
});
