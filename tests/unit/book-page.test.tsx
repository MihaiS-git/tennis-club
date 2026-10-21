import { afterEach, expect, it, vi } from "vitest";

const { loadDay, loadLocations, loadCoaching, loadLessons, loadSchedule } = vi.hoisted(() => ({ loadDay: vi.fn(), loadLocations: vi.fn(), loadCoaching: vi.fn(), loadLessons: vi.fn(), loadSchedule: vi.fn() }));
vi.mock("@/lib/coaching/public", () => ({ readPublicCoaching: loadCoaching }));
vi.mock("@/lib/coaching/lesson-availability", () => ({ readPublicCoachingLessonAvailability: loadLessons }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: {} }) }));
vi.mock("@/lib/db/repositories/coach-availability.repository", () => ({
  listCoachingSelectorAvailability: loadSchedule.mockImplementation(async (_manager: unknown, ids: string[], locationId: string) => ({
    weekly: ids.flatMap(coachUserId => Array.from({ length: 7 }, (_, weekday) => ({ coachUserId, locationId, weekday,
      startMinute: 0, endMinute: 1440, validFrom: "2000-01-01", validUntil: null }))), exceptions: [],
    schedules: [{ id: "s", startsOn: "2000-01-01", endsOn: null }],
    hours: Array.from({ length: 7 }, (_, weekday) => ({ scheduleId: "s", weekday, opensAtMinute: 0, closesAtMinute: 1440 })),
  })),
}));
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


it("loads the selected private coach/program/date through the existing service and keys duration changes", async () => {
  const program = { id: "private", name: "Private", type: "private", durations: [60, 90], prices: [60, 90].map(durationMinutes => ({ locationId: eligible.id, durationMinutes, currency: "RON" })) };
  const coach = { id: "coach", displayName: "Ana", rates: [], programs: [{ id: program.id }], locations: [{ id: eligible.id }] };
  loadLocations.mockResolvedValue([eligible]);
  loadCoaching.mockResolvedValue({ programs: [program, { id: "group", type: "group" }], coaches: [coach] });
  loadLessons.mockResolvedValue({ program: { courtRentalIncluded: true }, durations: [{ durationMinutes: 60, starts: [] }, { durationMinutes: 90, starts: [] }] });
  const renderDay = async (duration: string) => {
    const root = await BookingContent({ searchParams: Promise.resolve({ mode: "coaching", program: "private", coach: "coach", duration, date: "2099-10-15" }) });
    const day = root.props.children.at(-1);
    return day.type(day.props);
  };
  const content = await renderDay("90");
  const controls = content.props.children[0];
  expect(controls.props.programs).toEqual([program]);
  expect(controls.props.coaches).toEqual([coach]);
  expect(controls.props.durationMinutes).toBe(90);
  const calendar = content.props.children.at(-1);
  expect(calendar.props.coaching).toMatchObject({ programId: "private", coachId: "coach", durationMinutes: 90, starts: [] });
  expect(loadLessons).toHaveBeenLastCalledWith({ locationId: eligible.id, programId: "private", coachId: "coach", date: "2099-10-15" }, expect.any(Date));
  const shorter = await renderDay("60");
  expect(shorter.props.children.at(-1).props.coaching.durationMinutes).toBe(60);
  const invalid = await renderDay("120");
  expect(invalid.props.children.at(-1).props.coaching).toMatchObject({ durationMinutes: 0, starts: [] });
});

it("preselects a coach's eligible location and rejects incompatible program/coach URL combinations", async () => {
  const second = { ...eligible, id: "second" };
  loadLocations.mockResolvedValue([eligible, second]);
  loadCoaching.mockResolvedValue({ programs: [{ id: "private", type: "private", name: "Private", durations: [60], prices: [{ locationId: eligible.id, durationMinutes: 60, currency: "RON" }] }],
    coaches: [{ id: "coach", displayName: "Ana", rates: [], programs: [{ id: "private" }], locations: [{ id: "second" }] }] });
  loadLessons.mockClear();
  const root = await BookingContent({ searchParams: Promise.resolve({ mode: "coaching", coach: "coach", program: "incompatible" }) });
  expect(root.props.children[0].props.locationId).toBe("second");
  const day = root.props.children.at(-1);
  const content = await day.type(day.props);
  expect(content.props.children.at(-1).props.coaching.starts).toEqual([]);
  expect(loadLessons).not.toHaveBeenCalled();
});


it("fails closed in coaching mode when public options or lesson availability cannot be loaded", async () => {
  loadLocations.mockResolvedValue([eligible]);
  loadCoaching.mockRejectedValueOnce(new Error("Unavailable"));
  const unavailable = await BookingContent({ searchParams: Promise.resolve({ mode: "coaching" }) });
  expect(unavailable.props.children[0].props.coaching).toBeDefined();
  expect(unavailable.props.children.at(-1).props.role).toBe("alert");
  loadCoaching.mockResolvedValue({ programs: [{ id: "private", type: "private", name: "Private", durations: [60], prices: [{ locationId: eligible.id, durationMinutes: 60, currency: "RON" }] }],
    coaches: [{ id: "coach", displayName: "Ana", rates: [], programs: [{ id: "private" }], locations: [{ id: eligible.id }] }] });
  loadLessons.mockRejectedValueOnce(new Error("Unavailable"));
  const root = await BookingContent({ searchParams: Promise.resolve({ mode: "coaching" }) });
  const day = root.props.children.at(-1);
  const content = await day.type(day.props);
  expect(content.props.children[1].props.role).toBe("alert");
  expect(content.props.children.at(-1).props.coaching.starts).toEqual([]);
});


it("offers only priced Private and Semi-private assignments of the selected coach/location", async () => {
  const price = { locationId: eligible.id, durationMinutes: 60, currency: "RON" };
  const privateProgram = { id: "private", name: "Individual technique", type: "private", durations: [60, 90], prices: [price] };
  const semiProgram = { ...privateProgram, id: "semi", name: "Semi-private coaching", type: "semi_private", prices: [] };
  const extra = [
    { ...privateProgram, id: "other-coach" }, { ...privateProgram, id: "unpriced", prices: [] },
    { ...privateProgram, id: "other-location", prices: [{ ...price, locationId: "other" }] },
    { ...privateProgram, id: "group", type: "group" }, { ...privateProgram, id: "junior", type: "junior" },
  ];
  const programs = [privateProgram, semiProgram, ...extra];
  const coach = { id: "coach", displayName: "Ana", locations: [{ id: eligible.id }],
    programs: programs.filter(p => p.id !== "other-coach").map(p => ({ id: p.id })), rates: [{ ...price, programId: "semi" }] };
  loadLocations.mockResolvedValue([eligible]);
  loadCoaching.mockResolvedValue({ programs, coaches: [coach,
    { ...coach, id: "second", programs: [{ id: "other-coach" }], rates: [] }] });
  loadLessons.mockResolvedValue({ program: { participantCount: 2, courtRentalIncluded: false }, durations: [{ durationMinutes: 60, starts: [] }] });
  const root = await BookingContent({ searchParams: Promise.resolve({ mode: "coaching", coach: "coach", program: "semi" }) });
  const day = root.props.children.at(-1);
  const content = await day.type(day.props);
  expect(content.props.children[0].props.programs).toEqual([privateProgram, semiProgram, extra[0]]);
  expect(content.props.children[0].props.programId).toBe("semi");
  expect(content.props.children[0].props.durations).toEqual([60]);
  expect(content.props.children.at(-1).props.coaching).toMatchObject({ programName: "Semi-private coaching", participantCount: 2 });
  // Program changes can select another eligible coach.
  const defaultRoot = await BookingContent({ searchParams: Promise.resolve({ mode: "coaching" }) });
  const defaultDay = defaultRoot.props.children.at(-1);
  expect((await defaultDay.type(defaultDay.props)).props.children[0].props.programs).toEqual([privateProgram, semiProgram, extra[0]]);
});

it("automatically selects the sole eligible program", async () => {
  const program = { id: "semi", name: "Doubles lesson", type: "semi_private", durations: [90],
    prices: [{ locationId: eligible.id, durationMinutes: 90, currency: "RON" }] };
  loadLocations.mockResolvedValue([eligible]);
  loadCoaching.mockResolvedValue({ programs: [program], coaches: [{ id: "coach", displayName: "Ana", rates: [],
    programs: [{ id: "semi" }], locations: [{ id: eligible.id }] }] });
  loadLessons.mockResolvedValue({ program: { participantCount: 2, courtRentalIncluded: false }, durations: [{ durationMinutes: 90, starts: [] }] });
  const root = await BookingContent({ searchParams: Promise.resolve({ mode: "coaching" }) });
  const day = root.props.children.at(-1);
  const content = await day.type(day.props);
  expect(content.props.children[0].props.programId).toBe("semi");
  expect(content.props.children[0].props.durationMinutes).toBe(90);
});

it("rejects an assigned coach with only another location's hours, including a direct coach URL", async () => {
  const program = { id: "private", name: "Private", type: "private", durations: [60], prices: [{ locationId: eligible.id, durationMinutes: 60, currency: "RON" }] };
  const coach = { id: "andrei", displayName: "Andrei Popescu", rates: [], programs: [{ id: program.id }], locations: [{ id: eligible.id }, { id: "riverside" }] };
  loadLocations.mockResolvedValue([eligible]);
  loadCoaching.mockResolvedValue({ programs: [program], coaches: [coach] });
  loadSchedule.mockResolvedValueOnce({ weekly: [{ coachUserId: "andrei", locationId: "riverside", weekday: 0,
    startMinute: 540, endMinute: 1020, validFrom: "2000-01-01", validUntil: null }], exceptions: [],
    schedules: [{ id: "s", startsOn: "2000-01-01", endsOn: null }],
    hours: [{ scheduleId: "s", weekday: 0, opensAtMinute: 540, closesAtMinute: 1020 }] });
  loadLessons.mockClear();
  const root = await BookingContent({ searchParams: Promise.resolve({ mode: "coaching", location: eligible.id, program: "private", coach: "andrei", date: "2099-10-15" }) });
  const day = root.props.children.at(-1);
  const content = await day.type(day.props);
  expect(content.props.children[0].props.coaches).toEqual([]);
  expect(content.props.children[0].props.coachId).toBe("");
  expect(content.props.children[0].props.invalidCoachUrl).not.toContain("coach=");
  expect(content.props.children.at(-1).props.coaching.starts).toEqual([]);
  expect(loadLessons).not.toHaveBeenCalled();
});

it("recalculates coaches on program changes and preserves a coach who still offers the program", async () => {
  const price = { locationId: eligible.id, durationMinutes: 60, currency: "RON" };
  const privateProgram = { id: "private", name: "Private", type: "private", durations: [60], prices: [price] };
  const semi = { ...privateProgram, id: "semi", name: "Semi", type: "semi_private" };
  const ana = { id: "ana", displayName: "Ana", rates: [], programs: [{ id: "private" }], locations: [{ id: eligible.id }] };
  const dan = { ...ana, id: "dan", displayName: "Dan", programs: [{ id: "private" }, { id: "semi" }] };
  loadLocations.mockResolvedValue([eligible]);
  loadCoaching.mockResolvedValue({ programs: [privateProgram, semi], coaches: [ana, dan] });
  loadLessons.mockResolvedValue({ program: {}, durations: [{ durationMinutes: 60, starts: [] }] });
  const controlsFor = async (program: string, coach: string) => {
    const root = await BookingContent({ searchParams: Promise.resolve({ mode: "coaching", program, coach }) });
    const day = root.props.children.at(-1);
    return (await day.type(day.props)).props.children[0].props;
  };
  expect((await controlsFor("private", "ana")).coaches).toEqual([ana, dan]);
  const changed = await controlsFor("semi", "ana");
  expect(changed.coaches).toEqual([dan]);
  expect(changed.coachId).toBe("");
  expect(changed.invalidCoachUrl).not.toContain("coach=");
  expect((await controlsFor("semi", "dan")).coachId).toBe("dan");
});
