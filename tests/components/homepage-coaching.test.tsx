// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
beforeEach(() => vi.clearAllMocks());

// Resolve the homepage's async Server Component children with the server renderer,
// as in the navbar tests, before inspecting the completed HTML.
async function renderHome() {
  const stream = await renderToReadableStream(<Home params={Promise.resolve({})} searchParams={Promise.resolve({})} />);
  await stream.allReady;
  render(<div dangerouslySetInnerHTML={{ __html: await new Response(stream).text() }} />);
  return document;
}

it("links to coaching, states that lessons can be booked online and invents no lesson times", async () => {
  const home = within((await renderHome()).body);
  const coachingLinks = home.getAllByRole("link").filter((link) => link.getAttribute("href") === "/coaching");
  expect(coachingLinks.length).toBeGreaterThan(0);
  const card = home.getByRole("article", { name: "Coaching" });
  expect(card.textContent).toContain("book a lesson online");
  expect(card.textContent).not.toMatch(/can’t be booked|not bookable/i);
  expect(card.textContent).not.toMatch(/\d{1,2}:\d{2}|availability|slot/i);
  expect(within(card).getByRole("link", { name: /Explore coaching/ }).getAttribute("href")).toBe("/coaching");
});

const program = (id: string, name: string) => ({ id, name, description: "", type: "private" as const, durations: [60],
  minParticipants: null, maxParticipants: null, courtRentalIncluded: true, prices: [], participantPrices: [] });
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
  const home = await renderHome();
  expect(readPublicCoaching).toHaveBeenCalledWith([]);
  expect(readPublicCoaching).toHaveBeenCalledTimes(1);
  const section = home.getElementById("coaching")!;
  expect(section.textContent).not.toMatch(/Performance training|Individual coaching/);
  expect(within(section).getByRole("link", { name: /Meet the coaches/ }).getAttribute("href")).toBe("/coaching");
});
