// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicLocation } from "@/lib/courts/public";
import type { CourtDay } from "@/lib/courts/calendar";

const mocks = vi.hoisted(() => ({ day: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/courts/public-calendar", () => ({ getPublicCourtDay: mocks.day }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
import { CourtAvailabilityCard } from "@/app/home-court-availability";
import { HeroCourtSummary, FacilitiesCourtsSummary } from "@/app/home-court-summary";
import { HomeLocationSelect } from "@/app/home-location-select";

const location: PublicLocation = { id: "11111111-1111-4111-8111-111111111111", name: "East Club", slug: "east",
  address_line1: null, address_line2: null, city: null, postal_code: null, country_code: null,
  timezone: "Europe/Bucharest", currency: "RON", allow_pay_at_club: false, todayOpeningHours: [],
  courts: [{ id: "22222222-2222-4222-8222-222222222222", name: "Court 1", slug: "court-1",
    surface: "clay", environment: "outdoor", has_lighting: false }] };
const west: PublicLocation = { ...location, id: "33333333-3333-4333-8333-333333333333", name: "West Club", timezone: "America/Los_Angeles" };
const row = (cells: CourtDay["cells"], index = 1): CourtDay => ({ court: { ...location.courts[0], id: String(index), name: `Court ${index}` },
  cells, hourlyPrices: cells.map(() => 5000), rates: cells.map(() => 5000), stateLabel: "Outdoor" });
const availableDay = { times: [480, 510, 540, 570, 600], courts: [row(Array(5).fill("available"))] };
const card = (locations: PublicLocation[] = [location, west], selection?: string | string[]) => CourtAvailabilityCard({
  locations: Promise.resolve(locations), searchParams: Promise.resolve({ location: selection }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T22:30:00Z"));
  mocks.day.mockResolvedValue(availableDay);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it.each([undefined, "invalid", "44444444-4444-4444-8444-444444444444", [west.id, location.id]])(
  "defaults missing, invalid, unpublished and repeated selections to the first published location (%s)", async (selection) => {
    render(await card(undefined, selection));
    expect(mocks.day).toHaveBeenCalledExactlyOnceWith(location, "2026-10-15", "2026-10-15", new Date());
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(location.id);
    expect(screen.getByRole("link", { name: /View courts/ }).getAttribute("href")).toBe(`/book?location=${location.id}`);
  });

it("loads only the selected location's local date and renders capped starting times", async () => {
  render(await card(undefined, west.id));
  expect(mocks.day).toHaveBeenCalledExactlyOnceWith(west, "2026-10-14", "2026-10-14", new Date());
  expect(screen.getByRole("list").textContent).toBe("08:0008:3009:00");
  expect(screen.getByRole("link", { name: "Court 1" }).getAttribute("href")).toBe(`/book?location=${west.id}`);
});

// The previous homepage offered booking navigation from each time chip.
it("preserves booking navigation from a displayed starting time", async () => {
  render(await card([location]));
  for (const time of ["08:00", "08:30", "09:00"]) {
    expect(screen.getByRole("link", { name: `Book Court 1 at ${time}` }).getAttribute("href"))
      .toBe(`/book?location=${location.id}`);
  }
});

it("changes location through homepage navigation without scrolling and server selection changes the availability", async () => {
  render(<HomeLocationSelect locations={[location, west]} selectedId={location.id} />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: west.id } });
  expect(mocks.push).toHaveBeenCalledWith(`/?location=${west.id}`, { scroll: false });
  cleanup();
  mocks.day.mockResolvedValue({ times: [], courts: [row([])] });
  render(await card(undefined, west.id));
  expect(screen.getByText("West Club is closed today.")).toBeTruthy();
});

it("shows a single location name without a selector", async () => {
  render(await card([location]));
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getByText(location.name)).toBeTruthy();
});

it("does not query daily availability when there are no public locations", async () => {
  render(await card([]));
  expect(screen.getByText("No club locations are open for booking.")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  expect(mocks.day).not.toHaveBeenCalled();
});

it.each(["closed", "booked", "unpriced"])("renders the %s empty state", async (kind) => {
  mocks.day.mockResolvedValue(kind === "closed" ? { times: [], courts: [row([])] }
    : { times: [480, 510], courts: [row(kind === "booked" ? ["booked", "booked"] : ["unavailable", "unavailable"])] });
  render(await card([location]));
  expect(screen.getByText(kind === "closed" ? "East Club is closed today." : "No court availability today.")).toBeTruthy();
  expect(screen.queryByRole("list")).toBeNull();
});

it.each(["locations", "day"])("handles a %s database read failure", async (kind) => {
  if (kind === "day") mocks.day.mockRejectedValue(new Error("database unavailable"));
  render(await CourtAvailabilityCard({ locations: kind === "locations" ? Promise.reject(new Error("database unavailable")) : Promise.resolve([location]),
    searchParams: Promise.resolve({}) }));
  expect(screen.getByText("Court availability is currently unavailable.")).toBeTruthy();
  expect(screen.getByRole("link", { name: /View courts/ }).getAttribute("href")).toBe("/book");
  if (kind === "locations") expect(mocks.day).not.toHaveBeenCalled();
});

it("shows an available start when only the fifth court has availability", async () => {
  mocks.day.mockResolvedValue({ times: [480, 510], courts: [
    ...Array.from({ length: 4 }, (_, i) => row(["booked", "booked"], i + 1)), row(["available", "available"], 5),
  ] });
  render(await card([location]));
  expect(screen.queryAllByText("No suitable availability today")).toHaveLength(3);
  expect(screen.queryByText("No court availability today.")).toBeNull();
  expect(screen.getAllByRole("link", { name: /^Court / }).map((link) => link.textContent))
    .toEqual(["Court 5", "Court 1", "Court 2", "Court 3"]);
  expect(screen.getByRole("link", { name: "Book Court 5 at 08:00" }).getAttribute("href"))
    .toBe(`/book?location=${location.id}`);
});

it.each([0, 1, 2])("renders club-wide figures and surface grammar for %s locations", async (count) => {
  const locations = [location, { ...west, courts: [{ ...west.courts[0], surface: "hard" as const }] }].slice(0, count);
  render(await HeroCourtSummary({ locations: Promise.resolve(locations) }));
  render(await FacilitiesCourtsSummary({ locations: Promise.resolve(locations) }));
  if (count === 0) {
    expect(screen.getByText("No club locations are currently open for public booking.")).toBeTruthy();
    expect(screen.getByText(/Court details will appear/)).toBeTruthy();
  } else {
    expect(screen.getByText(count === 1 ? location.name : "2 locations")).toBeTruthy();
    expect(screen.getByText(`${count} ${count === 1 ? "court" : "courts"} across ${count} ${count === 1 ? "location" : "locations"}`)).toBeTruthy();
    expect(screen.getByText(count === 1 ? "1 clay court for training, casual play and competitive matches."
      : "1 clay court and 1 hard court for training, casual play and competitive matches.")).toBeTruthy();
  }
});

it("renders safe summary fallbacks on database failure", async () => {
  render(await HeroCourtSummary({ locations: Promise.reject(new Error("database unavailable")) }));
  render(await FacilitiesCourtsSummary({ locations: Promise.reject(new Error("database unavailable")) }));
  expect(screen.getAllByText("Court information is currently unavailable.")).toHaveLength(2);
});

it("renders plural mixed-surface totals", async () => {
  const courts = [location.courts[0], location.courts[0], { ...location.courts[0], surface: "grass" as const }];
  render(await FacilitiesCourtsSummary({ locations: Promise.resolve([{ ...location, courts }]) }));
  expect(screen.getByText("3 courts across 1 location")).toBeTruthy();
  expect(screen.getByText("2 clay courts and 1 grass court for training, casual play and competitive matches.")).toBeTruthy();
});
