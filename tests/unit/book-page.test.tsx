import { afterEach, expect, it, vi } from "vitest";

const { loadDay, loadLocations } = vi.hoisted(() => ({ loadDay: vi.fn(), loadLocations: vi.fn() }));
vi.mock("next/server", () => ({ connection: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/courts/public-calendar", () => ({ getPublicCourtDay: loadDay }));
vi.mock("@/lib/courts/public", () => ({ listPublicLocationsWithCourts: loadLocations }));
const eligible = {
  id: "11111111-1111-4111-8111-111111111111", name: "Club", timezone: "Europe/Bucharest", currency: "RON",
  courts: [{ id: "22222222-2222-4222-8222-222222222222", name: "Court 1" }],
};
vi.mock("@/app/book/booking-calendar", () => ({ BookingCalendar: () => null }));

import { BookingContent } from "@/app/book/booking-content";

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

it("uses an eligible location when the URL names an unpublished location", async () => {
  loadLocations.mockResolvedValue([eligible]);
  loadDay.mockResolvedValue({ times: [], courts: [] });
  const content = await BookingContent({ searchParams: Promise.resolve({ location: "33333333-3333-4333-8333-333333333333", date: "2099-10-02" }) });
  const day = content.props.children.at(-1);
  expect(day.props.location).toBe(eligible);
  expect(content.props.children[0].props.locationId).toBe(eligible.id);
});

it("preselects the linked location and its local today rather than the first location", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T22:30:00Z"));
  const linked = { ...eligible, id: "44444444-4444-4444-8444-444444444444", timezone: "America/Los_Angeles" };
  loadLocations.mockResolvedValue([eligible, linked]);
  const content = await BookingContent({ searchParams: Promise.resolve({ location: linked.id }) });
  expect(content.props.children[0].props.locationId).toBe(linked.id);
  const day = content.props.children.at(-1);
  expect(day.props.location).toBe(linked);
  expect(day.props.date).toBe("2026-10-14");
  expect(day.props.today).toBe("2026-10-14");
});
