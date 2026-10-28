// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { PublicLocation } from "@/lib/courts/public";

import { HomeLocations } from "@/app/home-locations";

const court = { id: "22222222-2222-4222-8222-222222222222", name: "Court 1", slug: "court-1", surface: "clay", environment: "outdoor", has_lighting: false } as const;
const east: PublicLocation = { id: "11111111-1111-4111-8111-111111111111", name: "East Club", slug: "east",
  address_line1: "1 Court Road", address_line2: null, city: "Cluj-Napoca", postal_code: "400000", country_code: "RO",
  timezone: "Europe/Bucharest", currency: "RON", allow_pay_at_club: false, customer_cancellation_notice_minutes: null,
  courts: [court], todayOpeningHours: [{ opens_at_minute: 480, closes_at_minute: 720 }, { opens_at_minute: 780, closes_at_minute: 1440 }] };
const west: PublicLocation = { ...east, id: "44444444-4444-4444-8444-444444444444", name: "West Club", city: null, todayOpeningHours: [] };

const section = async (locations: PublicLocation[] | Error) => render(<>{await HomeLocations({
  locations: locations instanceof Error ? Promise.reject(locations) : Promise.resolve(locations),
})}</>);

afterEach(cleanup);

it("links each public location to its details and map on the Contact page, without loading a map", async () => {
  await section([east, west]);
  const [first, second] = within(screen.getByRole("list", { name: "Club locations" })).getAllByRole("link");
  expect(first.getAttribute("href")).toBe(`/contact?location=${east.id}`);
  expect(first.textContent).toContain("East Club");
  expect(first.textContent).toContain("Cluj-Napoca · Today 08:00–12:00, 13:00–24:00");
  expect(second.getAttribute("href")).toBe(`/contact?location=${west.id}`);
  expect(second.textContent).toContain("Today Closed today");
  expect(document.querySelector("iframe")).toBeNull();
});

it("renders nothing for empty or failed reads", async () => {
  const empty = await section([]);
  expect(empty.container.textContent).toBe("");
  cleanup();
  const failed = await section(new Error("db"));
  expect(failed.container.textContent).toBe("");
});
