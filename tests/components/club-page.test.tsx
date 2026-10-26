// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PublicVisitorLocation } from "@/lib/courts/public";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/courts/public", () => ({ listPublicVisitorLocations: load }));
// Async server sections are covered directly below; the page test checks its static composition.
vi.mock("@/app/club/club-locations", async (original) => ({
  ...(await original<typeof import("@/app/club/club-locations")>()),
  ClubLocations: () => <p>Locations list</p>,
  ClubBookingTerms: () => <p>Booking terms</p>,
}));

import ClubPage, { metadata } from "@/app/club/page";
import { groupOpeningHours } from "@/app/club/club-locations";

const { ClubBookingTerms, ClubLocations } = await vi.importActual<typeof import("@/app/club/club-locations")>("@/app/club/club-locations");

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

const render$ = async (component: typeof ClubLocations | typeof ClubBookingTerms, locations: PublicVisitorLocation[] | Error) =>
  render(await component({ locations: locations instanceof Error ? Promise.reject(locations) : Promise.resolve(locations) }));

afterEach(cleanup);

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
  expect(within(document.getElementById("visit")!).getByText("Locations list")).toBeTruthy();
});

it("groups consecutive weekdays that share opening hours", () => {
  expect(groupOpeningHours(east.weekOpeningHours)).toEqual([
    { days: "Monday – Friday", hours: "08:00–22:00" },
    { days: "Saturday – Sunday", hours: "09:00–20:00" },
  ]);
  expect(groupOpeningHours(week((day) => (day === 2 ? [] : day === 4 ? [...open(480, 720), ...open(900, 1200)] : open(480, 720))))).toEqual([
    { days: "Monday – Tuesday", hours: "08:00–12:00" },
    { days: "Wednesday", hours: "Closed" },
    { days: "Thursday", hours: "08:00–12:00" },
    { days: "Friday", hours: "08:00–12:00, 15:00–20:00" },
    { days: "Saturday – Sunday", hours: "08:00–12:00" },
  ]);
});

it("lists every public location in order with address, weekly hours, directions and booking", async () => {
  await render$(ClubLocations, [east, west]);
  const list = screen.getByRole("list", { name: "Club locations" });
  const [first, second] = within(list).getAllByRole("listitem");
  expect(within(first).getByRole("heading", { level: 3 }).textContent).toBe("East Club");
  expect(first.querySelector("address")?.textContent).toBe("1 Court RoadCluj-Napoca, 400000Romania");
  expect([...first.querySelectorAll("dt")].map((term) => term.textContent)).toEqual(["Monday – Friday", "Saturday – Sunday"]);
  expect(within(first).getByRole("link", { name: /Get directions/ }).getAttribute("href")).toBe(
    `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("1 Court Road, Cluj-Napoca, 400000, Romania").replace(/%20/g, "+")}`,
  );
  expect(within(first).getByRole("link", { name: /Book at East Club/ }).getAttribute("href")).toBe(`/book?location=${east.id}`);

  // Missing address details are omitted rather than guessed, so no directions link either.
  expect(within(second).getByRole("heading", { level: 3 }).textContent).toBe("West Club");
  expect(second.querySelector("address")).toBeNull();
  expect(within(second).queryByRole("link", { name: /Get directions/ })).toBeNull();
  expect(second.textContent).toContain("MondayClosed");
  expect(within(second).getByRole("link", { name: /Book at West Club/ }).getAttribute("href")).toBe(`/book?location=${west.id}`);
  // Nothing beyond the configured location facts is presented as contact information.
  expect(list.textContent).not.toMatch(/@|tel:|phone/i);
});

it("renders a single location without list numbering", async () => {
  await render$(ClubLocations, [east]);
  expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(1);
  expect(screen.queryByText("01")).toBeNull();
});

it("renders empty and failure states without booking links", async () => {
  await render$(ClubLocations, []);
  expect(screen.getByText("No club locations are currently open to the public.")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  cleanup();
  await render$(ClubLocations, new Error("db"));
  expect(screen.getByText("Location information is currently unavailable.")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
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
