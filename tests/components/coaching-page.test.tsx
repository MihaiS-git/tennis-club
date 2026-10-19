// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PublicCoaching } from "@/lib/coaching/public";
import { formatMoney } from "@/lib/pricing/money";

const { readPublicCoaching, listPublicLocationsWithCourts } = vi.hoisted(() => ({ readPublicCoaching: vi.fn(), listPublicLocationsWithCourts: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/coaching/public", () => ({ readPublicCoaching }));
vi.mock("@/lib/courts/public", () => ({ listPublicLocationsWithCourts }));
vi.mock("@/app/coaching/coaching-sections", async (original) => ({
  ...(await original<typeof import("@/app/coaching/coaching-sections")>()),
  CoachingPrograms: () => <p>Programs list</p>, CoachingCoaches: () => <p>Coaches list</p>, CoachingPrices: () => <p>Prices list</p>,
}));

import CoachingPage, { metadata } from "@/app/coaching/page";
import { pricesByLocation, startingPrices } from "@/app/coaching/coaching-sections";

const { CoachingCoaches, CoachingPrices, CoachingPrograms } =
  await vi.importActual<typeof import("@/app/coaching/coaching-sections")>("@/app/coaching/coaching-sections");

const program = { id: "a1000000-0000-4000-8000-000000000001", name: "Private lesson", description: "One player, one coach.",
  type: "private" as const, durations: [60, 90], minParticipants: 1, maxParticipants: 1, courtRentalIncluded: true,
  prices: [
    { locationId: "b1", locationName: "East Club", durationMinutes: 60, amountMinor: 12000, currency: "RON" as const },
    { locationId: "b2", locationName: "West Club", durationMinutes: 60, amountMinor: 3000, currency: "EUR" as const },
    { locationId: "b1", locationName: "East Club", durationMinutes: 90, amountMinor: 17000, currency: "RON" as const },
  ] };
const group = { ...program, id: "a1000000-0000-4000-8000-000000000002", name: "Group drills", type: "group" as const, description: "",
  durations: [90], minParticipants: 3, maxParticipants: 6, courtRentalIncluded: false, prices: [] };
const coach = { id: "c1", displayName: "Ana Pop", bio: "Former junior champion.", qualifications: "Level 2 coach",
  specialties: ["Serve", "Footwork"], languages: ["Romanian", "English"],
  locations: [{ id: "b1", name: "East Club" }], programs: [{ id: program.id, name: "Private lesson" }],
  rates: [{ programId: program.id, programName: "Private lesson", courtRentalIncluded: true, locationId: "b1", locationName: "East Club",
    durationMinutes: 60, amountMinor: 15000, currency: "RON" as const }] };
const data: PublicCoaching = { programs: [program, group], coaches: [coach] };
const empty: PublicCoaching = { programs: [], coaches: [] };

const show = async (component: typeof CoachingPrograms, value: PublicCoaching | Error) =>
  render(await component({ coaching: value instanceof Error ? Promise.reject(value) : Promise.resolve(value) }));

afterEach(cleanup);

it("composes the public coaching sections from one shared read", async () => {
  listPublicLocationsWithCourts.mockResolvedValue([]);
  readPublicCoaching.mockResolvedValue(empty);
  render(<CoachingPage />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Better tennis, one lesson at a time.");
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "Find the right way to train.", "The people on the other side of the net.", "What a lesson costs.",
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
  expect(document.getElementById("faq")!.textContent).toContain("Group and Junior programs are not available for online booking");
});

it("shows active programs with durations, group size, court rental and starting prices per currency", async () => {
  await show(CoachingPrograms, data);
  const [first, second] = within(screen.getByRole("list", { name: "Coaching programs" })).getAllByRole("listitem");
  expect(first.textContent).toContain("Private lesson");
  expect(first.textContent).toContain("60 min · 90 min");
  expect(first.textContent).toContain("1 player");
  expect(first.textContent).toContain("Court rental included");
  expect(first.textContent).toContain(`From ${startingPrices(program).join(" · ")}`);
  expect(startingPrices(program)).toEqual([formatMoney(3000, "EUR"), formatMoney(12000, "RON")]);
  expect(second.textContent).toContain("Court rental not included");
  expect(second.textContent).toContain("3–6 players");
  expect(second.textContent).toContain("Not yet published");
});

it("shows public coach profiles with individual prices and no account details", async () => {
  await show(CoachingCoaches, data);
  const card = within(screen.getByRole("list", { name: "Coaches" })).getAllByRole("listitem")[0];
  expect(within(card).getByRole("heading", { level: 3 }).textContent).toBe("Ana Pop");
  expect(within(card).getByRole("list", { name: "Ana Pop’s specialties" }).textContent).toBe("ServeFootwork");
  for (const text of ["Former junior champion.", "Level 2 coach", "Romanian, English", "East Club", `Private lesson, 60 min: ${formatMoney(15000, "RON")}`]) {
    expect(card.textContent).toContain(text);
  }
  expect(card.textContent).not.toMatch(/@|phone|c1/);
  // Both the name and the profile link lead to the coach's stable public route.
  expect(within(card).getByRole("link", { name: "Ana Pop" }).getAttribute("href")).toBe("/coaching/coaches/c1");
  expect(within(card).getByRole("link", { name: "View Ana Pop’s profile" }).getAttribute("href")).toBe("/coaching/coaches/c1");
});

it("lists club prices per location with coach prices beneath", async () => {
  await show(CoachingPrices, data);
  const east = screen.getByRole("region", { name: "Coaching prices at East Club" });
  expect(east.textContent).toContain(`Private lesson · 60 minCourt rental includedAna Pop: ${formatMoney(15000, "RON")}${formatMoney(12000, "RON")}Club price`);
  expect(screen.getByRole("region", { name: "Coaching prices at West Club" }).textContent).toContain(formatMoney(3000, "EUR"));
  // A coach-only price is listed without inventing a club price.
  const coachOnly = pricesByLocation({ programs: [group], coaches: [{ ...coach, rates: [{ ...coach.rates[0], programId: group.id, programName: group.name, durationMinutes: 90 }] }] });
  expect(coachOnly).toMatchObject([{ name: "East Club", rows: [{ amount: null, coaches: [{ name: "Ana Pop", amount: formatMoney(15000, "RON") }] }] }]);
});

it("renders empty and unavailable states without invented data", async () => {
  await show(CoachingPrograms, empty);
  expect(screen.getByText(/No coaching programs are published yet/)).toBeTruthy();
  cleanup();
  await show(CoachingCoaches, empty);
  expect(screen.getByText(/Coach profiles have not been published yet/)).toBeTruthy();
  cleanup();
  await show(CoachingPrices, { programs: [group], coaches: [] });
  expect(screen.getByText("Coaching prices have not been published yet.")).toBeTruthy();
  cleanup();
  await show(CoachingCoaches, new Error("db"));
  expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
  expect(document.body.textContent).not.toMatch(/RON|EUR|€/);
});
