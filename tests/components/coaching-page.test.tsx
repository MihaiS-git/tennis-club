// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { PublicCoaching } from "@/lib/coaching/public";
import { formatMoney } from "@/lib/pricing/money";

const { readPublicCoaching, listPublicLocationsWithCourts } = vi.hoisted(() => ({ readPublicCoaching: vi.fn(), listPublicLocationsWithCourts: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/coaching/public", () => ({ readPublicCoaching }));
vi.mock("@/lib/courts/public", () => ({ listPublicLocationsWithCourts }));
vi.mock("@/app/coaching/coaching-sections", async (original) => ({
  ...(await original<typeof import("@/app/coaching/coaching-sections")>()),
  CoachingPrograms: () => <p>Programs list</p>, CoachingCoaches: () => <p>Coaches list</p>,
}));

import CoachingPage, { metadata } from "@/app/coaching/page";
import { startingPriceLabel, startingPrices } from "@/app/coaching/coaching-sections";

const { CoachingCoaches, CoachingPrograms } =
  await vi.importActual<typeof import("@/app/coaching/coaching-sections")>("@/app/coaching/coaching-sections");

const program = { id: "a1000000-0000-4000-8000-000000000001", name: "Private lesson", description: "One player, one coach.",
  type: "private" as const, durations: [60, 90], minParticipants: 1, maxParticipants: 1, courtRentalIncluded: true,
  prices: [
    { durationMinutes: 60, participantCount: 1, amountMinor: 12000, currency: "RON" as const },
    { durationMinutes: 60, participantCount: 1, amountMinor: 3000, currency: "EUR" as const },
    { durationMinutes: 90, participantCount: 1, amountMinor: 17000, currency: "RON" as const },
  ],
  // Resolved by the public projection: the only eligible coach charges RON 150 for 60 minutes.
  fromPrices: [{ currency: "EUR" as const, amountMinor: 3000 }, { currency: "RON" as const, amountMinor: 15000 }] };
const group = { ...program, id: "a1000000-0000-4000-8000-000000000002", name: "Group drills", type: "group" as const, description: "",
  durations: [90], minParticipants: 3, maxParticipants: 6, courtRentalIncluded: false,
  fromPrices: [{ currency: "EUR" as const, amountMinor: 1500 }, { currency: "RON" as const, amountMinor: 5000 }],
  prices: [
    { durationMinutes: 90, participantCount: 3, amountMinor: 6000, currency: "RON" as const },
    { durationMinutes: 90, participantCount: 4, amountMinor: 5000, currency: "RON" as const },
    { durationMinutes: 90, participantCount: 3, amountMinor: 1500, currency: "EUR" as const },
  ] };
const junior = { ...group, id: "a1000000-0000-4000-8000-000000000003", name: "Junior squad", type: "junior" as const,
  description: "Ages 8–12.", durations: [60, 90], minParticipants: 4, maxParticipants: 8, prices: [], fromPrices: [] };
const coach = { id: "c1", displayName: "Ana Pop", bio: "Former junior champion.", qualifications: "Level 2 coach",
  specialties: ["Serve", "Footwork"], languages: ["Romanian", "English"],
  locations: [{ id: "b1", name: "East Club" }], programs: [{ id: program.id, name: "Private lesson" }],
  rates: [{ programId: program.id, programName: "Private lesson", courtRentalIncluded: true,
    durationMinutes: 60, participantCount: 1, amountMinor: 15000, currency: "RON" as const }] };
const data: PublicCoaching = { programs: [program, group], coaches: [coach] };
const empty: PublicCoaching = { programs: [], coaches: [] };

const show = async (component: typeof CoachingPrograms, value: PublicCoaching | Error) =>
  render(await component({ coaching: value instanceof Error ? Promise.reject(value) : Promise.resolve(value) }));

afterEach(cleanup);

it("uses native responsive hero sources with mutually exclusive matching head preloads", async () => {
  listPublicLocationsWithCourts.mockResolvedValue([]);
  readPublicCoaching.mockResolvedValue(empty);
  const stream = await renderToReadableStream(<CoachingPage />);
  await stream.allReady;
  const html = new DOMParser().parseFromString(await new Response(stream).text(), "text/html");
  const image = html.querySelector("picture img")!;
  expect(image.getAttribute("src")).not.toContain("/_next/image");
  expect(image.getAttribute("loading")).toBe("eager");
  expect(image.getAttribute("fetchpriority")).toBe("high");
  expect(image.getAttribute("class")).toContain("object-[60%_center] md:object-center");
  expect(image.getAttribute("width")).toBe("1536");
  expect(image.getAttribute("height")).toBe("1024");
  const sources = [...html.querySelectorAll("picture source")];
  expect(sources.map((source) => source.getAttribute("type"))).toEqual(["image/avif", "image/webp", "image/avif", "image/webp", "image/avif"]);
  expect(sources[0].getAttribute("media")).toBe(sources[1].getAttribute("media"));
  expect(sources[0].getAttribute("srcset")).toContain("/images/coaching/tennis-coaching-session-narrow-");
  expect(sources[2].getAttribute("srcset")).toContain("/images/coaching/tennis-coaching-session-portrait-");
  expect(sources[4].getAttribute("media")).toBeNull();
  expect(image.getAttribute("srcset")).toContain(".webp 1536w");
  const preloads = [...html.head.querySelectorAll('link[rel="preload"][as="image"]')];
  expect(preloads).toHaveLength(3);
  const avif = [sources[0], sources[2], sources[4]];
  for (const [index, preload] of preloads.entries()) {
    expect(preload.getAttribute("type")).toBe("image/avif");
    expect(preload.getAttribute("fetchpriority")).toBe("high");
    expect(preload.getAttribute("imagesrcset")).toBe(avif[index].getAttribute("srcset"));
    expect(preload.getAttribute("imagesizes")).toBe(avif[index].getAttribute("sizes"));
  }
  expect(preloads[0].getAttribute("media")).toBe(sources[0].getAttribute("media"));
  expect(preloads[1].getAttribute("media")).toContain(`not (${sources[0].getAttribute("media")})`);
  expect(preloads[2].getAttribute("media")).toContain(`not (${sources[2].getAttribute("media")})`);
});

it("composes the public coaching sections from one shared read", async () => {
  listPublicLocationsWithCourts.mockResolvedValue([]);
  readPublicCoaching.mockResolvedValue(empty);
  render(<CoachingPage />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Better tennis, one lesson at a time.");
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "Find the right way to train.", "The people on the other side of the net.",
    "From first question to first lesson.", "Questions, answered.",
  ]);
  const nav = screen.getByRole("navigation", { name: "On this page" });
  for (const link of within(nav).getAllByRole("link")) {
    expect(document.getElementById(link.getAttribute("href")!.slice(1))?.tagName).toBe("SECTION");
  }
  expect(screen.getByRole("link", { name: "Explore programs" }).getAttribute("href")).toBe("#programs");
  for (const image of screen.getAllByRole("img")) expect(image.getAttribute("alt")).toBeTruthy();
  expect(metadata.title).toBe("Coaching | Tennis Club");
  await vi.waitFor(() => expect(readPublicCoaching).toHaveBeenCalledTimes(1));
  expect(listPublicLocationsWithCourts).toHaveBeenCalledTimes(1);
});

it("links coaching to the shared booking page", () => {
  render(<CoachingPage />);
  expect(screen.getByRole("link", { name: "Book coaching" }).getAttribute("href")).toBe("/book?mode=coaching");
  const faq = document.getElementById("faq")!.textContent;
  expect(faq).toContain("Private and Semi-private lessons use the booking timetable");
  expect(faq).toContain("Group and Junior sessions cannot be booked or paid online");
});

it("leaves the price catalogue to Pricing and coach profiles, and links locations to Contact", () => {
  render(<CoachingPage />);
  expect(document.getElementById("prices")).toBeNull();
  expect(document.getElementById("group-prices")).toBeNull();
  expect(within(document.getElementById("programs")!).getByRole("link", { name: /How lesson prices work/ }).getAttribute("href")).toBe("/pricing#coaching");
  expect(within(document.getElementById("how-it-works")!).getByRole("link", { name: /Find your location/ }).getAttribute("href")).toBe("/contact");
  // One primary call to action in the hero.
  expect(screen.getAllByRole("link").filter((link) => link.className.includes("bg-chalk"))).toHaveLength(1);
  expect(document.querySelector('a[href^="/club#visit"]')).toBeNull();
});

it("shows active programs with durations, group size, court rental and starting prices per currency", async () => {
  await show(CoachingPrograms, { ...data, programs: [program, group, junior] });
  const [first, second, third] = within(screen.getByRole("list", { name: "Coaching programs" })).getAllByRole("listitem");
  expect(first.textContent).toContain("Private lesson");
  expect(first.textContent).toContain("60 min · 90 min");
  expect(first.textContent).toContain("1 player");
  expect(first.textContent).toContain("Court rental included");
  // The page shows the projection's From prices; it never recomputes them from the listed prices.
  expect(first.textContent).toContain(`From ${formatMoney(3000, "EUR")} · ${formatMoney(15000, "RON")} per person per lesson`);
  expect(startingPrices(program)).toEqual([formatMoney(3000, "EUR"), formatMoney(15000, "RON")]);
  expect(startingPriceLabel({ fromPrices: [{ currency: "RON", amountMinor: 9000 }] }))
    .toBe(`From ${formatMoney(9000, "RON")} per person per lesson`);
  expect(startingPriceLabel({ fromPrices: [] })).toBeNull();
  expect(second.textContent).toContain("Court rental not included");
  expect(second.textContent).toContain("3–6 players");
  expect(first.textContent).not.toContain("Paid at the club");
  // Group/Junior programs start from their lowest club lesson price/person and are arranged offline.
  expect(second.textContent).toContain(`From ${formatMoney(1500, "EUR")} · ${formatMoney(5000, "RON")} per person per lesson`);
  expect(second.textContent).toContain("Arranged with the coach or club · Paid at the club");
  expect(third.textContent).toContain("4–8 players");
  expect(third.textContent).toContain("Prices not published.");
});

it("shows public coach profiles without account details or a price list", async () => {
  await show(CoachingCoaches, data);
  const card = within(screen.getByRole("list", { name: "Coaches" })).getAllByRole("listitem")[0];
  expect(within(card).getByRole("heading", { level: 3 }).textContent).toBe("Ana Pop");
  expect(within(card).getByRole("list", { name: "Ana Pop’s specialties" }).textContent).toBe("ServeFootwork");
  for (const text of ["Former junior champion.", "Level 2 coach", "Romanian, English", "East Club"]) {
    expect(card.textContent).toContain(text);
  }
  // Each coach's lesson prices are on their profile.
  expect(card.textContent).not.toContain(formatMoney(15000, "RON"));
  expect(card.textContent).not.toMatch(/@|phone|c1/);
  // Both the name and the profile link lead to the coach's stable public route.
  expect(within(card).getByRole("link", { name: "Ana Pop" }).getAttribute("href")).toBe("/coaching/coaches/c1");
  expect(within(card).getByRole("link", { name: "View Ana Pop’s profile" }).getAttribute("href")).toBe("/coaching/coaches/c1");
});

it("renders empty and unavailable states without invented data", async () => {
  await show(CoachingPrograms, empty);
  expect(screen.getByText(/No coaching programs are published yet/)).toBeTruthy();
  cleanup();
  await show(CoachingCoaches, empty);
  expect(screen.getByText(/Coach profiles have not been published yet/)).toBeTruthy();
  cleanup();
  await show(CoachingCoaches, new Error("db"));
  expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
  expect(document.body.textContent).not.toMatch(/RON|EUR|€/);
});
