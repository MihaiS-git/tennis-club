// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { PublicVisitorLocation } from "@/lib/courts/public";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/courts/public", () => ({ listPublicVisitorLocations: load }));
// Async server sections are covered directly below; the page test checks its static composition.
vi.mock("@/app/club/club-locations", async (original) => ({
  ...(await original<typeof import("@/app/club/club-locations")>()),
  ClubBookingTerms: () => <p>Booking terms</p>,
}));

import ClubPage, { metadata } from "@/app/club/page";

const { ClubBookingTerms } = await vi.importActual<typeof import("@/app/club/club-locations")>("@/app/club/club-locations");

const open = (opens: number, closes: number) => [{ opens_at_minute: opens, closes_at_minute: closes }];
const week = (intervals: (weekday: number) => { opens_at_minute: number; closes_at_minute: number }[]) =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, intervals: intervals(weekday) }));

const court = { id: "22222222-2222-4222-8222-222222222222", name: "Court 1", slug: "court-1", surface: "clay", environment: "outdoor", has_lighting: true } as const;
const east: PublicVisitorLocation = { id: "11111111-1111-4111-8111-111111111111", name: "East Club", slug: "east",
  address_line1: "1 Court Road", address_line2: null, city: "Cluj-Napoca", postal_code: "400000", country_code: "RO",
  timezone: "Europe/Bucharest", currency: "RON", allow_pay_at_club: true, courts: [court], todayOpeningHours: open(480, 1320),
  customer_cancellation_notice_minutes: 1440, cancellationNoticeMinutes: 1440, weekOpeningHours: week((day) => (day < 5 ? open(480, 1320) : open(540, 1200))) };
const west: PublicVisitorLocation = { ...east, id: "44444444-4444-4444-8444-444444444444", name: "West Club",
  address_line1: null, city: null, postal_code: null, country_code: null, allow_pay_at_club: false,
  customer_cancellation_notice_minutes: 0, cancellationNoticeMinutes: 0, weekOpeningHours: week((day) => (day === 0 ? [] : open(420, 1380))) };

const render$ = async (component: typeof ClubBookingTerms, locations: PublicVisitorLocation[] | Error) =>
  render(await component({ locations: locations instanceof Error ? Promise.reject(locations) : Promise.resolve(locations) }));

afterEach(cleanup);

it("uses native pictures and matching, mutually exclusive hero preloads", async () => {
  load.mockResolvedValue([]);
  const stream = await renderToReadableStream(<ClubPage />);
  await stream.allReady;
  const html = new DOMParser().parseFromString(await new Response(stream).text(), "text/html");
  const images = [...html.querySelectorAll("main img")];
  expect(images).toHaveLength(4);
  for (const image of images) {
    expect(image.parentElement!.tagName).toBe("PICTURE");
    expect(image.getAttribute("src")).not.toContain("/_next/image");
    expect(image.getAttribute("alt")).toBeTruthy();
    expect(image.getAttribute("width")).toBeTruthy();
    expect(image.getAttribute("height")).toBeTruthy();
    expect(image.getAttribute("decoding")).toBe("async");
  }
  const [hero, story, ...lower] = images;
  expect(hero.getAttribute("loading")).toBe("eager");
  expect(hero.getAttribute("fetchpriority")).toBe("high");
  expect(hero.getAttribute("class")).toContain("object-[18%_center] md:object-[center_35%]");
  for (const image of [story, ...lower]) expect(image.getAttribute("loading")).toBe("lazy");
  for (const image of lower) {
    expect(image.getAttribute("srcset")).toContain("/images/home/");
    expect(image.getAttribute("sizes")).toBeTruthy();
    expect(image.parentElement!.querySelector("source")!.getAttribute("sizes")).toBe(image.getAttribute("sizes"));
  }
  expect(story.getAttribute("srcset")).toContain("/images/club/tennis-courts-public-story-");
  expect(story.getAttribute("sizes")).toContain("100vw");
  expect(story.getAttribute("class")).toContain("object-[22%_center]");
  const sources = [...hero.parentElement!.querySelectorAll("source")];
  expect(sources.map((source) => source.getAttribute("type"))).toEqual(["image/avif", "image/webp", "image/avif", "image/webp", "image/avif"]);
  expect(sources[0].getAttribute("media")).toBe(sources[1].getAttribute("media"));
  expect(sources[4].getAttribute("media")).toBeNull();
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

it("composes the club sections in order with in-page navigation and metadata", async () => {
  load.mockResolvedValue([]);
  render(<ClubPage />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Built slowly, kept with care.");
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "It started with two courts and a borrowed roller.", "Belonging, at your own pace.", "The people who keep it running.",
    "Off the court, too.", "A few rules, kept short.", "Come and see us.",
  ]);
  // Every in-page link resolves to a section on the page.
  const nav = screen.getByRole("navigation", { name: "On this page" });
  for (const link of within(nav).getAllByRole("link")) {
    expect(document.getElementById(link.getAttribute("href")!.slice(1))?.tagName).toBe("SECTION");
  }
  for (const image of screen.getAllByRole("img")) expect(image.getAttribute("alt")).toBeTruthy();
  expect(metadata.title).toBe("The Club | Tennis Club");
  // One shared public read feeds both data-backed sections.
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
});

it("presents membership as illustrative, without purchase controls", () => {
  load.mockResolvedValue([]);
  render(<ClubPage />);
  const membership = document.getElementById("membership")!;
  expect(within(membership).getByText("Illustrative membership")).toBeTruthy();
  expect(membership.textContent).toContain("not sold online");
  expect(within(membership).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
    "Playing", "Family & junior", "Competition", "Social",
  ]);
  expect(within(membership).queryByRole("link")).toBeNull();
  expect(within(membership).queryByRole("button")).toBeNull();
  // The editorial page states no operational price.
  expect(document.body.textContent).not.toMatch(/RON|EUR|€|\bper (hour|month|year)\b/);
});

it("links policy guidance to the authoritative booking surfaces", () => {
  load.mockResolvedValue([]);
  render(<ClubPage />);
  const rules = document.getElementById("rules")!;
  expect(within(rules).getByRole("link", { name: "My bookings" }).getAttribute("href")).toBe("/my-activity/bookings");
  expect(rules.textContent).toContain("To request cancellation, please contact the club before the cancellation deadline.");
  expect(within(rules).getByText("Booking terms")).toBeTruthy();
  // Location details and the map live on the Contact page; the visit anchor still lands here.
  const visit = document.getElementById("visit")!;
  expect(within(visit).getByRole("link", { name: "Contact & directions" }).getAttribute("href")).toBe("/contact");
  expect(within(visit).getByRole("link", { name: /Book a court/ }).getAttribute("href")).toBe("/book");
});

it("shows each location's configured cancellation notice and pay-at-club option", async () => {
  await render$(ClubBookingTerms, [east, west, { ...west, id: "66666666-6666-4666-8666-666666666666", name: "North Club", customer_cancellation_notice_minutes: null, cancellationNoticeMinutes: null }]);
  const [first, second, third] = within(screen.getByRole("list", { name: "Booking terms by location" })).getAllByRole("listitem")
    .filter((item) => item.parentElement?.getAttribute("aria-label") === "Booking terms by location");
  expect(first.textContent).toBe("East ClubCancel with at least 24 hours' noticePay at the club available");
  expect(second.textContent).toBe("West ClubCancel any time before the booking starts");
  // An unknown notice is not invented.
  expect(third.textContent).toBe("North Club");

  cleanup();
  const { container } = await render$(ClubBookingTerms, []);
  expect(container.textContent).toBe("");
  cleanup();
  await render$(ClubBookingTerms, new Error("db"));
  expect(screen.getByText("Location booking terms are currently unavailable.")).toBeTruthy();
});
