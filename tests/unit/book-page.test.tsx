import { afterEach, expect, it, vi } from "vitest";

const { loadDay, loadLocations } = vi.hoisted(() => ({ loadDay: vi.fn(), loadLocations: vi.fn() }));
vi.mock("@/lib/courts/public-calendar", () => ({ getPublicCourtDay: loadDay }));
vi.mock("@/lib/courts/public", () => ({ listPublicLocationsWithCourts: loadLocations }));
const eligible = {
  id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "Europe/Bucharest", currency: "RON",
  courts: [{ id: "22222222-2222-4222-8222-222222222222", name: "Court 1" }],
};
vi.mock("@/app/book/booking-calendar", () => ({ BookingCalendar: () => null }));

import { BookingContent } from "@/app/book/booking-content";
import { CalendarControls } from "@/app/book/calendar-controls";

afterEach(() => vi.useRealTimers());

it("defaults to one location-local current day without a client redirect", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T22:30:00Z"));
  loadLocations.mockResolvedValue([eligible]);
  const content = await BookingContent({ searchParams: Promise.resolve({}) });
  const controls = content.props.children[0];
  const day = content.props.children.at(-1);
  expect(controls.props.date).toBe("2026-10-03");
  expect(day.props.date).toBe("2026-10-03");
  expect(day.props.today).toBe("2026-10-03");
  expect(day.props.location).toBe(eligible);
});

it("does not render booking-day reads for invalid or past explicit dates", async () => {
  loadDay.mockClear();
  loadLocations.mockResolvedValue([eligible]);
  for (const date of ["invalid", "2000-01-01"]) {
    const content = await BookingContent({ searchParams: Promise.resolve({ date }) });
    expect(content.props.children[0].props.date).toBeNull();
    expect(content.props.children.at(-1).type).toBe("p");
  }
  expect(loadDay).not.toHaveBeenCalled();
});

it("passes the eligible location to the controls and default day", async () => {
  loadLocations.mockResolvedValue([eligible]);
  loadDay.mockClear();
  const content = await BookingContent({ searchParams: Promise.resolve({}) });
  const controls = content.props.children[0];
  expect(controls.type).toBe(CalendarControls);
  expect(controls.props.locations).toEqual([eligible]);
  expect(controls.props.locationId).toBe(eligible.id);
  expect(content.props.children.at(-1).props.location).toBe(eligible);
  expect(loadDay).not.toHaveBeenCalled();
});

it("uses an eligible location when the URL names an unpublished location", async () => {
  loadLocations.mockResolvedValue([eligible]);
  loadDay.mockResolvedValue({ times: [], courts: [] });
  const content = await BookingContent({ searchParams: Promise.resolve({ location: "33333333-3333-4333-8333-333333333333", date: "2099-10-02" }) });
  const day = content.props.children.at(-1);
  expect(day.props.location).toBe(eligible);
  expect(content.props.children[0].props.locationId).toBe(eligible.id);
});

it("shows a public empty state when no locations are eligible", async () => {
  loadLocations.mockResolvedValue([]);
  loadDay.mockClear();
  const content = await BookingContent({ searchParams: Promise.resolve({ location: eligible.id, date: "2099-10-02" }) });
  expect(content.props.children).toContain("No locations are currently open for public booking");
  expect(loadDay).not.toHaveBeenCalled();
});
