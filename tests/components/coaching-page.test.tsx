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
  CoachingGroupPrices: () => <p>Group prices list</p>,
}));

import CoachingPage, { metadata } from "@/app/coaching/page";
import { pricesByCurrency, startingPrices } from "@/app/coaching/coaching-sections";

const { CoachingCoaches, CoachingGroupPrices, CoachingPrices, CoachingPrograms } =
  await vi.importActual<typeof import("@/app/coaching/coaching-sections")>("@/app/coaching/coaching-sections");

const program = { id: "a1000000-0000-4000-8000-000000000001", name: "Private lesson", description: "One player, one coach.",
  type: "private" as const, durations: [60, 90], minParticipants: 1, maxParticipants: 1, courtRentalIncluded: true,
  prices: [
    { durationMinutes: 60, amountMinor: 12000, currency: "RON" as const },
    { durationMinutes: 60, amountMinor: 3000, currency: "EUR" as const },
    { durationMinutes: 90, amountMinor: 17000, currency: "RON" as const },
  ], participantPrices: [] };
const group = { ...program, id: "a1000000-0000-4000-8000-000000000002", name: "Group drills", type: "group" as const, description: "",
  durations: [90], minParticipants: 3, maxParticipants: 6, courtRentalIncluded: false, prices: [],
  participantPrices: [
    { participantCount: 3, amountMinor: 6000, currency: "RON" as const },
    { participantCount: 4, amountMinor: 5000, currency: "RON" as const },
    { participantCount: 3, amountMinor: 1500, currency: "EUR" as const },
  ] };
const junior = { ...group, id: "a1000000-0000-4000-8000-000000000003", name: "Junior squad", type: "junior" as const,
  description: "Ages 8–12.", durations: [60, 90], minParticipants: 4, maxParticipants: 8, participantPrices: [] };
const coach = { id: "c1", displayName: "Ana Pop", bio: "Former junior champion.", qualifications: "Level 2 coach",
  specialties: ["Serve", "Footwork"], languages: ["Romanian", "English"],
  locations: [{ id: "b1", name: "East Club" }], programs: [{ id: program.id, name: "Private lesson" }],
  rates: [{ programId: program.id, programName: "Private lesson", courtRentalIncluded: true,
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
    "Group and junior sessions.", "From first question to first lesson.", "Questions, answered.",
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

it("explains how group and junior sessions are organized and paid, without booking links", () => {
  render(<CoachingPage />);
  const section = document.getElementById("group-prices")!;
  for (const text of ["organized by the coach or the club", "reserve the court", "cannot be booked online",
    "indicative", "per person for 60 minutes", "confirmed by the club", "contact the club or your coach", "payment is made at the club"]) {
    expect(section.textContent).toContain(text);
  }
  const links = within(section).getAllByRole("link");
  expect(links.map((link) => link.getAttribute("href"))).toEqual(["/club#visit"]);
});

it("shows active programs with durations, group size, court rental and starting prices per currency", async () => {
  await show(CoachingPrograms, { ...data, programs: [program, group, junior] });
  const [first, second, third] = within(screen.getByRole("list", { name: "Coaching programs" })).getAllByRole("listitem");
  expect(first.textContent).toContain("Private lesson");
  expect(first.textContent).toContain("60 min · 90 min");
  expect(first.textContent).toContain("1 player");
  expect(first.textContent).toContain("Court rental included");
  expect(first.textContent).toContain(`From ${startingPrices(program).join(" · ")}`);
  expect(startingPrices(program)).toEqual([formatMoney(3000, "EUR"), formatMoney(12000, "RON")]);
  expect(second.textContent).toContain("Court rental not included");
  expect(second.textContent).toContain("3–6 players");
  expect(first.textContent).not.toContain("Paid at the club");
  // Group/Junior programs start from their club rate per person per 60 minutes and are arranged offline.
  expect(second.textContent).toContain(`From ${formatMoney(1500, "EUR")} · ${formatMoney(5000, "RON")} per person / 60 min`);
  expect(second.textContent).toContain("Arranged with the coach or club · Paid at the club");
  expect(third.textContent).toContain("4–8 players");
  expect(third.textContent).toContain("Not yet published");
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

it("lists club-wide prices per currency with coach prices beneath", async () => {
  await show(CoachingPrices, data);
  const ron = screen.getByRole("region", { name: "Coaching prices in RON" });
  expect(ron.textContent).toContain(`Private lesson · 60 minCourt rental includedAna Pop: ${formatMoney(15000, "RON")}${formatMoney(12000, "RON")}Club price`);
  expect(screen.getByRole("region", { name: "Coaching prices in EUR" }).textContent).toContain(formatMoney(3000, "EUR"));
  expect(document.body.textContent).not.toContain("East Club");
  // A coach-only price is listed without inventing a club price.
  const unpriced = { ...program, id: "a1000000-0000-4000-8000-000000000004", name: "Private match play", prices: [] };
  const coachOnly = pricesByCurrency({ programs: [unpriced], coaches: [{ ...coach, rates: [{ ...coach.rates[0], programId: unpriced.id, programName: unpriced.name, durationMinutes: 90 }] }] });
  expect(coachOnly).toMatchObject([{ currency: "RON", rows: [{ amount: null, coaches: [{ name: "Ana Pop", amount: formatMoney(15000, "RON") }] }] }]);
});

it("lists group and junior club rates by player count, per currency, with no coach prices or booking", async () => {
  const withCoachRate = { ...coach, rates: [...coach.rates] };
  await show(CoachingGroupPrices, { programs: [program, group, junior], coaches: [withCoachRate] });
  const list = screen.getByRole("list", { name: "Group and junior coaching prices" });
  const [groupItem, juniorItem] = within(list).getAllByRole("listitem");
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(list.textContent).not.toContain("Private lesson");
  expect(groupItem.textContent).toContain("Group drills");
  expect(groupItem.textContent).toContain("3–6 players");
  expect(groupItem.textContent).toContain("90 min");
  const rows = (name: string) => within(screen.getByRole("table", { name })).getAllByRole("row").slice(1)
    .map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
  expect(rows("Group drills club prices in RON")).toEqual([["3", formatMoney(6000, "RON")], ["4", formatMoney(5000, "RON")]]);
  expect(rows("Group drills club prices in EUR")).toEqual([["3", formatMoney(1500, "EUR")]]);
  expect(juniorItem.textContent).toContain("Junior squad");
  expect(juniorItem.textContent).toContain("Ages 8–12.");
  expect(juniorItem.textContent).toContain("4–8 players");
  expect(juniorItem.textContent).toContain("Prices for this program have not been published yet.");
  expect(within(juniorItem).queryByRole("table")).toBeNull();
  expect(list.textContent).not.toContain("Ana Pop");
  expect(within(list).queryAllByRole("link")).toHaveLength(0);
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
  await show(CoachingGroupPrices, { programs: [program], coaches: [] });
  expect(screen.getByText("No group or junior programs are published at the moment.")).toBeTruthy();
  cleanup();
  await show(CoachingCoaches, new Error("db"));
  expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
  expect(document.body.textContent).not.toMatch(/RON|EUR|€/);
});
