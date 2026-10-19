// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/courts/public", () => ({
  listPublicVisitorLocations: vi.fn(async () => []), listPublicLocationsWithCourts: vi.fn(async () => []),
}));
vi.mock("@/lib/courts/public-calendar", () => ({ listPublicLocationsToday: vi.fn(async () => []) }));
vi.mock("@/lib/coaching/public", () => ({ readPublicCoaching: vi.fn(async () => ({ programs: [], coaches: [] })) }));
// Data-backed sections have their own tests; these check the shared page structure.
vi.mock("@/app/club/club-locations", () => ({ ClubLocations: () => null, ClubBookingTerms: () => null }));
vi.mock("@/app/courts/courts-discovery", () => ({ CourtsDiscovery: () => null }));
vi.mock("@/app/courts/courts-conditions", () => ({ CourtsConditions: () => null }));
vi.mock("@/app/coaching/coaching-sections", () => ({ CoachingPrograms: () => null, CoachingCoaches: () => null, CoachingPrices: () => null }));
vi.mock("@/app/home-coaching", () => ({ HomeCoachingPrograms: () => null, HomeCoachingFallback: () => null }));
vi.mock("@/app/home-court-availability", () => ({ CourtAvailabilityCard: () => null, CourtAvailabilityCardShell: () => null }));
vi.mock("@/app/home-court-summary", () => ({ FacilitiesCourtsFallback: () => null, FacilitiesCourtsSummary: () => null,
  HeroCourtSummary: () => null, heroSummaryClassName: "" }));
vi.mock("@/app/home-locations", () => ({ HomeLocations: () => null, HomeLocationsShell: () => null }));

import ClubPage from "@/app/club/page";
import CoachingPage from "@/app/coaching/page";
import CourtsPage from "@/app/courts/page";
import Home from "@/app/page";

afterEach(cleanup);

const editorialPages = [
  { name: "club", Page: ClubPage, title: "Built slowly, kept with care.", image: "tennis-club-aerial.webp",
    menu: ["Our story", "Membership", "People", "Facilities", "Rules & policies", "Visit"] },
  { name: "courts", Page: CourtsPage, title: "Courts ready to play.", image: "tennis-courts-public.webp",
    menu: ["Locations", "Playing conditions", "Booking"] },
  { name: "coaching", Page: CoachingPage, title: "Better tennis, one lesson at a time.", image: "tennis-coaching-session.webp",
    menu: ["Programs", "Coaches", "Prices", "How it works", "FAQ"] },
];

function hero() {
  const title = screen.getByRole("heading", { level: 1 });
  return { title, section: title.closest("section")! };
}

// The section menu sits directly below the hero, and every link targets a scroll-offset element.
function expectSectionMenu(heroSection: HTMLElement, labels: string[]) {
  const nav = screen.getByRole("navigation", { name: "On this page" });
  expect(heroSection.nextElementSibling).toBe(nav);
  const links = within(nav).getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual(labels);
  for (const link of links) {
    const target = document.getElementById(link.getAttribute("href")!.replace(/^#/, ""));
    expect(target, link.getAttribute("href")!).not.toBeNull();
    expect(target!.className).toContain("scroll-mt-20");
  }
  return nav;
}

it("uses one editorial hero with identical dimensions and type on The Club, Courts and Coaching", () => {
  const heroes = editorialPages.map(({ Page, title, image, menu }) => {
    render(<Page />);
    const { title: heading, section } = hero();
    expect(heading.textContent).toBe(title);
    const img = within(section).getByRole("img");
    expect(img.getAttribute("src")).toContain(image);
    expect(img.getAttribute("alt")).toBeTruthy();
    const nav = expectSectionMenu(section, menu);
    const result = {
      section: section.className, heading: heading.className.replace(/max-w-\[\d+ch\]/, ""),
      content: heading.parentElement!.className, nav: nav.outerHTML.replace(/<li[\s\S]*<\/li>/, ""),
    };
    cleanup();
    return result;
  });
  expect(heroes[0].section).toContain("h-[clamp(540px,86svh,860px)]");
  for (const other of heroes.slice(1)) expect(other).toEqual(heroes[0]);
});

it("keeps the Courts hero call to action and points it at the locations section", () => {
  render(<CourtsPage />);
  expect(within(hero().section).getByRole("link", { name: /Explore locations/ }).getAttribute("href")).toBe("#locations");
  expect(screen.getByRole("link", { name: "Book a court" }).getAttribute("href")).toBe("/book");
});

it("keeps the homepage hero and Play today widget, with the shared section menu below them", () => {
  render(<Home params={Promise.resolve({})} searchParams={Promise.resolve({})} />);
  const { title, section } = hero();
  expect(title.textContent).toBe("Play more tennis.");
  expect(section.className).not.toContain("h-[clamp(540px,86svh,860px)]");
  const playToday = within(section).getByRole("heading", { level: 2, name: "Play today" }).parentElement!;
  expect(within(playToday).getByRole("link", { name: "Find a court" }).getAttribute("href")).toBe("/book");
  expect(within(section).getByRole("link", { name: "Book a court" }).getAttribute("href")).toBe("/book");
  expect(within(section).getByRole("link", { name: /Explore coaching/ }).getAttribute("href")).toBe("/coaching");
  expectSectionMenu(section, ["Today", "The club", "Facilities", "Coaching", "Community", "Locations"]);
});
