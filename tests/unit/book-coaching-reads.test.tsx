import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Real page, coaching and court-day services over mocked repositories: counts the
// database reads of one /book?mode=coaching render and of the transactional lesson read.
const db = vi.hoisted(() => ({
  locations: vi.fn(), facts: vi.fn(), hours: vi.fn(), coverage: vi.fn(), pricing: vi.fn(), courtOccupancy: vi.fn(),
  coachSchedules: vi.fn(), coachDay: vi.fn(), coachOccupancy: vi.fn(),
}));
vi.mock("next/server", () => ({ connection: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/courts/public", () => ({ listPublicLocationsWithCourts: db.locations }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: {} }) }));
vi.mock("@/lib/db/repositories/coaching.repository", () => ({ readPublicCoachingFacts: db.facts }));
vi.mock("@/lib/db/repositories/clubs.repository", () => ({ listPublicDayOpeningHours: db.hours, listPublicDayCoverage: db.coverage }));
vi.mock("@/lib/db/repositories/pricing.repository", () => ({ listPublicDayPricing: db.pricing }));
vi.mock("@/lib/db/repositories/reservations.repository", () => ({ listPublicDayOccupancy: db.courtOccupancy, listCoachDayOccupancy: db.coachOccupancy }));
vi.mock("@/lib/db/repositories/coach-availability.repository", () => ({ listLocationCoachBookingAvailability: db.coachSchedules, listCoachDayAvailability: db.coachDay }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/bookings/prefill", () => ({ bookingContactPrefill: async () => ({ customerName: "", customerEmail: "", customerPhone: "" }) }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: async () => ({ state: "anonymous" }) }));
vi.mock("@/lib/payments/settings", () => ({ activeOnlinePaymentProvider: async () => null }));
vi.mock("@/app/book/booking-calendar", () => ({ BookingCalendar: () => null }));

import { BookingContent } from "@/app/book/booking-content";
import { readCoachingLessonDay } from "@/lib/coaching/lesson-availability";
import { buildCourtDay } from "@/lib/courts/calendar";

const location = {
  id: "c0000000-0000-4000-8000-000000000001", name: "Central Club", timezone: "Europe/Bucharest", currency: "RON", customer_cancellation_notice_minutes: 180,
  courts: [{ id: "22222222-2222-4222-8222-222222222222", name: "Court 1", environment: "outdoor" }],
};
const coach = "a0000000-0000-4000-8000-000000000001";
const program = "b0000000-0000-4000-8000-000000000001";
const facts = {
  programs: [{ id: program, name: "Private", description: "", program_type: "private", min_participants: 1, max_participants: 1, court_rental_included: false, durations: [60] }],
  coaches: [{ user_id: coach, display_name: "Andrei", bio: "", qualifications: "", specialties: [], languages: [], location_ids: [location.id], program_ids: [program] }],
  prices: [{ program_id: program, duration_minutes: 60, participant_count: 1, coach_user_id: null, amount_minor: 20000, currency: "RON" }],
 
};
const stamp = "2099-01-01T00:00:00Z";
const hours = Array.from({ length: 7 }, (_, weekday) => ({ id: `e0000000-0000-4000-8000-00000000000${weekday}`, location_id: location.id,
  weekday, opens_at_minute: 480, closes_at_minute: 1200, created_at: stamp, updated_at: stamp }));
const occupancy = [{ court_id: location.courts[0].id, booking_date: "2099-10-15", starts_at_minute: 600, ends_at_minute: 660 }];

type Node = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const nodes = (node: Node) => [node.props.children].flat(3).filter((child): child is Node => Boolean(child) && typeof child === "object");
const call = (node: Node) => (node.type as (props: unknown) => Promise<Node>)(node.props);
// Renders BookingContent → CoachingContent → CoachingDay → BookingDay and returns the calendar.
async function render(params: Record<string, string>) {
  const content = await call(await BookingContent({ searchParams: Promise.resolve({ mode: "coaching", date: "2099-10-15", ...params }) }) as Node);
  const coachingDay = await call(nodes(content).at(-1)!);
  return (await call(nodes(coachingDay).at(-1)!)).props;
}

afterEach(() => vi.useRealTimers());
beforeEach(() => {
  vi.clearAllMocks();
  // 09:00 in Bucharest on the rendered date.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2099-10-15T06:00:00Z"));
  db.locations.mockResolvedValue([location]);
  db.facts.mockResolvedValue(facts);
  db.hours.mockResolvedValue(hours);
  db.coverage.mockResolvedValue([]);
  db.pricing.mockResolvedValue([]);
  db.courtOccupancy.mockResolvedValue(occupancy);
  db.coachSchedules.mockResolvedValue({ weekly: [{ coachUserId: coach, weekday: 3, startMinute: 480, endMinute: 1200, validFrom: "2000-01-01", validUntil: null }], extra: [] });
  db.coachDay.mockResolvedValue({ weekly: [], exceptions: [] });
  db.coachOccupancy.mockResolvedValue([]);
});

it("loads locations, coaching facts, day configuration and court occupancy once for a selected lesson", async () => {
  const calendar = await render({ location: location.id });
  expect(calendar.coaching).toMatchObject({ coachId: coach, programId: program, participantCount: 1 });
  expect(db.locations).toHaveBeenCalledTimes(1);
  expect(db.facts).toHaveBeenCalledTimes(1);
  // The cancellation notice is the location projection's value.
  expect(calendar.cancellationNoticeMinutes).toBe(180);
  for (const read of [db.hours, db.coverage, db.pricing, db.courtOccupancy, db.coachDay, db.coachOccupancy]) expect(read).toHaveBeenCalledTimes(1);
  // The calendar grid is the pure court day of the lesson read's own configuration and occupancy.
  expect(calendar.day).toEqual(buildCourtDay({ timezone: location.timezone, date: "2099-10-15", today: "2099-10-15", currentMinute: 540,
    courts: location.courts as never, hours, coverage: [], pricing: [], reservations: occupancy }));
  expect((calendar.day as { courts: { cells: string[] }[] }).courts[0].cells).toContain("booked");
});

it("renders court mode with the projected cancellation notice", async () => {
  const content = await BookingContent({ searchParams: Promise.resolve({ location: location.id, date: "2099-10-15" }) }) as Node;
  const calendar = (await call(nodes(content).at(-1)!)).props;
  expect(calendar.cancellationNoticeMinutes).toBe(180);
  expect(calendar.coaching).toBeUndefined();
  expect(db.locations).toHaveBeenCalledTimes(1);
  expect((calendar.day as { courts: { cells: string[] }[] }).courts[0].cells).toContain("booked");
});

it("loads the court day itself when no lesson is selected", async () => {
  const calendar = await render({ location: location.id, participants: "3" });
  expect(calendar.coaching).toMatchObject({ participantCount: 0, starts: [] });
  expect(db.facts).toHaveBeenCalledTimes(1);
  for (const read of [db.hours, db.coverage, db.pricing, db.courtOccupancy]) expect(read).toHaveBeenCalledTimes(1);
  expect(db.coachDay).not.toHaveBeenCalled();
  expect(db.coachOccupancy).not.toHaveBeenCalled();
  expect((calendar.day as { courts: { cells: string[] }[] }).courts[0].cells).toContain("booked");
});

it("keeps an unoffered program unavailable without a lesson read", async () => {
  const calendar = await render({ location: location.id, coach, program: "b0000000-0000-4000-8000-000000000009" });
  expect(calendar.coaching).toMatchObject({ programId: "", starts: [] });
  expect(db.coachDay).not.toHaveBeenCalled();
  expect(db.courtOccupancy).toHaveBeenCalledTimes(1);
});

it("falls back to loading the court day when the lesson read fails", async () => {
  db.coachDay.mockRejectedValueOnce(new Error("down"));
  const calendar = await render({ location: location.id });
  expect(calendar.coaching).toMatchObject({ durationMinutes: 0, starts: [] });
  expect(db.courtOccupancy).toHaveBeenCalledTimes(2);
  expect(calendar.day).toBeDefined();
});

it("transactional lesson reads reload coaching facts and day facts on their own manager", async () => {
  const manager = { queryRunner: {} } as never;
  const day = await readCoachingLessonDay(manager, location as never, coach, "2099-10-15", new Date(), "d0000000-0000-4000-8000-000000000001");
  expect(day?.coaching).toBe(facts);
  expect(db.facts).toHaveBeenCalledExactlyOnceWith(manager);
  for (const read of [db.hours, db.coverage, db.pricing, db.courtOccupancy, db.coachDay, db.coachOccupancy]) {
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toBe(manager);
  }
  expect(db.courtOccupancy.mock.calls[0].at(-1)).toBe("d0000000-0000-4000-8000-000000000001");
  expect(db.locations).not.toHaveBeenCalled();
});
