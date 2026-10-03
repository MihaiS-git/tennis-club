import { expect, it, vi } from "vitest";

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

it("does not load booking-day data without a valid selected date", async () => {
  loadDay.mockClear();
  loadLocations.mockResolvedValue([eligible]);
  await BookingContent({ searchParams: Promise.resolve({}) });
  await BookingContent({ searchParams: Promise.resolve({ date: "2000-01-01" }) });
  expect(loadDay).not.toHaveBeenCalled();
});

it("passes the one eligible location to visible controls without a timetable read", async () => {
  loadLocations.mockResolvedValue([eligible]);
  loadDay.mockClear();
  const content = await BookingContent({ searchParams: Promise.resolve({}) });
  const controls = content.props.children[0];
  expect(controls.type).toBe(CalendarControls);
  expect(controls.props.locations).toEqual([eligible]);
  expect(controls.props.locationId).toBe(eligible.id);
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
