import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { loadDay, loadLocations, loadCoaching, loadLessons } = vi.hoisted(() => ({ loadDay: vi.fn(), loadLocations: vi.fn(), loadCoaching: vi.fn(), loadLessons: vi.fn() }));
vi.mock("@/lib/coaching/public", () => ({ readPublicCoaching: loadCoaching }));
vi.mock("@/lib/coaching/lesson-availability", () => ({ readPublicCoachingLessonAvailability: loadLessons }));
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


// Central Club: two coaches with different program assignments, one coach whose
// programs cannot be booked online, and a coach teaching only at Riverside.
const central = { ...eligible, id: "c0000000-0000-4000-8000-000000000001", name: "Central Club" };
const riverside = { ...eligible, id: "c0000000-0000-4000-8000-000000000002", name: "Riverside Club" };
const ron = (durationMinutes: number, amountMinor: number) => ({ durationMinutes, amountMinor, currency: "RON" });
const programs = [
  { id: "private", name: "Private", type: "private", durations: [45, 60, 90, 120], courtRentalIncluded: false, prices: [ron(60, 20000), ron(90, 28000)] },
  { id: "semi", name: "Semi-private", type: "semi_private", durations: [60], courtRentalIncluded: true, prices: [ron(60, 26000)] },
  { id: "group", name: "Group", type: "group", durations: [90], courtRentalIncluded: false, prices: [ron(90, 9000)] },
];
const place = (...items: typeof eligible[]) => items.map(({ id, name }) => ({ id, name }));
const andrei = { id: "andrei", displayName: "Andrei", locations: place(central, riverside), programs: [{ id: "private" }, { id: "semi" }],
  rates: [{ ...ron(60, 25000), programId: "private" }] };
const sofia = { id: "sofia", displayName: "Sofia", locations: place(central), programs: [{ id: "semi" }], rates: [{ ...ron(60, 24000), programId: "semi" }] };
const maria = { id: "maria", displayName: "Maria", locations: place(central), programs: [{ id: "group" }], rates: [] };
const elena = { id: "elena", displayName: "Elena", locations: place(central), programs: [], rates: [] };
const dan = { id: "dan", displayName: "Dan", locations: place(riverside), programs: [{ id: "private" }], rates: [] };
const start = { startMinute: 600, endMinute: 660, startsAt: "", endsAt: "", courts: [] };

type Node = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const nodes = (node: Node) => [node.props.children].flat(3).filter((child): child is Node => Boolean(child) && typeof child === "object");
const text = (node: Node) => [node.props.children].flat(3).filter(item => typeof item === "string").join("");
const coaching = async (params: Record<string, string>, includeDate = true) => {
  const element = await BookingContent({ searchParams: Promise.resolve({ mode: "coaching", ...(includeDate ? { date: "2099-10-15" } : {}), ...params }) }) as Node;
  const root = await (element.type as (props: unknown) => Promise<Node>)(element.props);
  const [calendar, ...rest] = nodes(root);
  const day = rest.at(-1);
  const content = typeof day?.type === "function" && day.props.data ? await (day.type as (props: unknown) => Promise<Node>)(day.props) : null;
  const children = content ? nodes(content) : rest;
  return { calendar: calendar.props, controls: content ? children[0].props : null, booking: content ? children.at(-1)!.props.coaching as Record<string, unknown> : null,
    alerts: children.filter(child => child.props.role === "alert" || (child.type as { name?: string }).name === "Alert").map(text), status: children.filter(child => child.props.role === "status").map(text) };
};

beforeEach(() => {
  loadLocations.mockResolvedValue([central, riverside]);
  loadCoaching.mockResolvedValue({ programs, coaches: [andrei, elena, maria, sofia, dan] });
  loadLessons.mockReset().mockResolvedValue({ program: { participantCount: 1, courtRentalIncluded: false }, durations: [{ durationMinutes: 60, starts: [start] }, { durationMinutes: 90, starts: [] }] });
});

it("defaults to the first public location, first priced coach/program, 60 minutes and local today", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-02T22:30:00Z"));
  const page = await coaching({}, false);
  expect(page.calendar).toMatchObject({ locationId: central.id, date: "2026-10-03", today: "2026-10-03" });
  expect(page.controls).toMatchObject({ coachId: "andrei", programId: "private", durationMinutes: 60, date: "2026-10-03" });
  expect(page.booking).toMatchObject({ coachId: "andrei", programId: "private", durationMinutes: 60, starts: [start] });
  expect(loadLessons).toHaveBeenCalledExactlyOnceWith({ locationId: central.id, programId: "private", coachId: "andrei", date: "2026-10-03" }, expect.any(Date));
  expect(page.status).toEqual([]);
  expect(page.booking).not.toHaveProperty("selection");
});

it("keeps explicit invalid location feedback without selecting another location", async () => {
  const unknown = await coaching({ location: "c0000000-0000-4000-8000-000000000009", coach: "andrei" });
  expect(unknown.calendar.locationId).toBeUndefined();
  expect(unknown.alerts).toEqual(["The selected location is not available for booking. Choose a location."]);
  expect(loadLessons).not.toHaveBeenCalled();
});

it("lists every eligible coach while defaulting to the first coach with a priced online program", async () => {
  const page = await coaching({ location: central.id });
  expect(page.controls?.coaches).toEqual([andrei, elena, maria, sofia].map(({ id, displayName }) => ({ id, displayName })));
  expect(page.controls).toMatchObject({ coachId: "andrei", programId: "private", durationMinutes: 60 });
  expect((await coaching({ location: riverside.id })).controls?.coaches).toEqual([andrei, dan].map(({ id, displayName }) => ({ id, displayName })));
  expect((await coaching({ location: riverside.id })).controls).toMatchObject({ coachId: "andrei", programId: "private", durationMinutes: 60 });
  loadCoaching.mockResolvedValueOnce({ programs, coaches: [dan] });
  expect((await coaching({ location: central.id })).status).toEqual(["No coaches currently teach at Central Club."]);
});

it("offers the selected coach's own program assignments, with clear empty states", async () => {
  const programsOf = async (coach: string) => (await coaching({ location: central.id, coach })).controls?.programs;
  expect(await programsOf("andrei")).toEqual([{ id: "private", name: "Private", bookable: true }, { id: "semi", name: "Semi-private", bookable: true }]);
  expect(await programsOf("sofia")).toEqual([{ id: "semi", name: "Semi-private", bookable: true }]);
  expect(await programsOf("maria")).toEqual([{ id: "group", name: "Group", bookable: false }]);
  expect((await coaching({ location: central.id, coach: "maria" })).status).toEqual(["None of Maria’s programs can be booked online."]);
  expect((await coaching({ location: central.id, coach: "elena" })).status).toEqual(["Elena has no programs assigned yet."]);
  expect((await coaching({ location: central.id, coach: "andrei" })).controls).toMatchObject({ programId: "private", durationMinutes: 60 });
});

it("lists the program's lesson-grid durations with the coach override ?? club default in the location currency", async () => {
  const andreiPrivate = await coaching({ location: central.id, coach: "andrei", program: "private" });
  expect(andreiPrivate.controls?.durations).toEqual([
    { durationMinutes: 60, price: { amountMinor: 25000, currency: "RON", source: "coach" } },
    { durationMinutes: 90, price: { amountMinor: 28000, currency: "RON", source: "club" } },
    { durationMinutes: 120, price: null },
  ]);
  expect(andreiPrivate.controls?.durationMinutes).toBe(60);
  expect((await coaching({ location: central.id, coach: "sofia", program: "semi" })).controls?.durations)
    .toEqual([{ durationMinutes: 60, price: { amountMinor: 24000, currency: "RON", source: "coach" } }]);
  expect((await coaching({ location: central.id, coach: "andrei", program: "semi" })).controls?.durations)
    .toEqual([{ durationMinutes: 60, price: { amountMinor: 26000, currency: "RON", source: "club" } }]);
  // No conversion and no price from another currency.
  loadLocations.mockResolvedValueOnce([{ ...central, currency: "EUR" }]);
  expect((await coaching({ location: central.id, coach: "andrei", program: "private" })).controls?.durations)
    .toEqual([60, 90, 120].map(durationMinutes => ({ durationMinutes, price: null })));
  expect((await coaching({ location: central.id, coach: "andrei", program: "private" })).controls?.durationMinutes).toBe(60);
});

it("loads lesson starts for the complete selection through the existing availability service", async () => {
  const page = await coaching({ location: central.id, coach: "andrei", program: "private", duration: "60" });
  expect(loadLessons).toHaveBeenCalledExactlyOnceWith({ locationId: central.id, programId: "private", coachId: "andrei", date: "2099-10-15" }, expect.any(Date));
  expect(page.controls).toMatchObject({ coachId: "andrei", programId: "private", durationMinutes: 60, courtRentalIncluded: false });
  expect(page.booking).toMatchObject({ coachId: "andrei", programId: "private", coachName: "Andrei", programName: "Private", durationMinutes: 60, starts: [start] });
  expect(page.status).toEqual([]);
  const empty = await coaching({ location: central.id, coach: "andrei", program: "private", duration: "90" });
  expect(empty.status).toEqual(["No lessons are available for this coach and lesson length on this date."]);
  expect(empty.controls?.coaches).toHaveLength(4);
  loadLessons.mockResolvedValueOnce(null);
  expect((await coaching({ location: central.id, coach: "andrei", program: "private", duration: "60" })).status)
    .toEqual(["Andrei does not currently offer Private at Central Club."]);
});

it("blocks checkout for an unpriced duration without loading lesson starts", async () => {
  const page = await coaching({ location: central.id, coach: "andrei", program: "private", duration: "120" });
  expect(page.controls?.durationMinutes).toBe(120);
  expect(page.alerts).toEqual(["Pricing is unavailable for this lesson length at Central Club, so it cannot be booked."]);
  expect(page.booking).toMatchObject({ durationMinutes: 0, starts: [] });
  expect(loadLessons).not.toHaveBeenCalled();
});

it("reports invalid URL selections and never substitutes another coach, program or duration", async () => {
  const otherLocation = await coaching({ location: central.id, coach: "dan", program: "private", duration: "60" });
  expect(otherLocation.alerts).toEqual(["The selected coach is not available at Central Club. Choose a coach."]);
  expect(otherLocation.controls).toMatchObject({ coachId: "", programId: "", durationMinutes: 0, programs: [] });
  const otherProgram = await coaching({ location: central.id, coach: "sofia", program: "private", duration: "60" });
  expect(otherProgram.alerts).toEqual(["Sofia does not offer the selected program online. Choose a program."]);
  expect(otherProgram.controls).toMatchObject({ coachId: "sofia", programId: "", durationMinutes: 0, durations: [] });
  expect((await coaching({ location: central.id, coach: "maria", program: "group" })).controls).toMatchObject({ coachId: "maria", programId: "" });
  for (const duration of ["45", "75"]) {
    const page = await coaching({ location: central.id, coach: "andrei", program: "private", duration });
    expect(page.alerts).toEqual(["The selected lesson length is not offered for Private. Choose a lesson length."]);
    expect(page.controls).toMatchObject({ programId: "private", durationMinutes: 0 });
  }
  expect(loadLessons).not.toHaveBeenCalled();
});

it("keeps a linked coach and selects their first public location when no location was provided", async () => {
  const single = await coaching({ coach: "sofia" });
  expect(single.calendar.locationId).toBe(central.id);
  expect(single.controls).toMatchObject({ coachId: "sofia", programId: "semi", durationMinutes: 60 });
  const several = await coaching({ coach: "andrei" });
  expect(several.calendar.locationId).toBe(central.id);
  expect(several.controls).toMatchObject({ coachId: "andrei", programId: "private", durationMinutes: 60 });
  expect((await coaching({ coach: "unknown" })).alerts).toEqual(["The selected coach is not available at Central Club. Choose a coach."]);
});

it("honors valid URL selections and defaults only missing dependent choices", async () => {
  const explicit = await coaching({ location: central.id, coach: "andrei", program: "private", duration: "90" });
  expect(explicit.controls).toMatchObject({ coachId: "andrei", programId: "private", durationMinutes: 90 });
  expect(explicit.status).toEqual(["No lessons are available for this coach and lesson length on this date."]);
  expect((await coaching({ coach: "sofia", program: "semi" })).controls).toMatchObject({ coachId: "sofia", programId: "semi", durationMinutes: 60 });
  expect((await coaching({ location: central.id, program: "semi", duration: "60" })).controls)
    .toMatchObject({ coachId: "andrei", programId: "semi", durationMinutes: 60 });
  expect((await coaching({ location: central.id, coach: "andrei", duration: "90" })).controls)
    .toMatchObject({ programId: "private", durationMinutes: 90 });
  loadCoaching.mockResolvedValueOnce({ programs, coaches: [{ ...andrei, programs: [{ id: "private" }] }, sofia] });
  expect((await coaching({ location: central.id, program: "semi" })).controls)
    .toMatchObject({ coachId: "sofia", programId: "semi", durationMinutes: 60 });
});

it("chooses the first priced online program and prefers 60 minutes, then the shortest priced duration", async () => {
  loadCoaching.mockResolvedValueOnce({ programs: [
    { ...programs[0], prices: [] },
    { ...programs[1], durations: [90, 120], prices: [ron(120, 30000), ron(90, 22000)] },
    programs[2],
  ], coaches: [elena, maria, andrei, sofia] });
  const page = await coaching({ location: central.id });
  expect(page.controls).toMatchObject({ coachId: "andrei", programId: "private", durationMinutes: 60 });
  // Andrei's override keeps Private priced despite the missing club price.
  loadCoaching.mockResolvedValueOnce({ programs: [
    { ...programs[0], prices: [], durations: [90, 120] },
    { ...programs[1], durations: [120, 90], prices: [ron(120, 30000), ron(90, 22000)] },
    programs[2],
  ], coaches: [elena, maria, { ...andrei, rates: [] }, sofia] });
  const fallback = await coaching({ location: central.id });
  expect(fallback.controls).toMatchObject({ coachId: "andrei", programId: "semi", durationMinutes: 90 });
});

it("leaves missing defaults empty and shows existing contextual states", async () => {
  loadCoaching.mockResolvedValueOnce({ programs, coaches: [elena, maria] });
  const noPricedCoach = await coaching({ location: central.id });
  expect(noPricedCoach.controls).toMatchObject({ coachId: "", programId: "", durationMinutes: 0 });
  expect(noPricedCoach.controls?.coaches).toHaveLength(2);
  expect(noPricedCoach.status).toEqual(["Choose a coach to see their programs."]);
  expect(loadLessons).not.toHaveBeenCalled();
  loadCoaching.mockResolvedValueOnce({ programs, coaches: [elena] });
  expect((await coaching({ coach: "elena" })).status).toEqual(["Elena has no programs assigned yet."]);
  loadCoaching.mockResolvedValueOnce({ programs, coaches: [maria] });
  expect((await coaching({ coach: "maria" })).status).toEqual(["None of Maria’s programs can be booked online."]);
  loadCoaching.mockResolvedValueOnce({ programs: [{ ...programs[0], prices: [] }], coaches: [{ ...andrei, rates: [] }] });
  const unpriced = await coaching({ coach: "andrei", program: "private" });
  expect(unpriced.controls).toMatchObject({ coachId: "andrei", programId: "private", durationMinutes: 0 });
  expect(unpriced.status).toEqual(["Choose a lesson length."]);
});

it("rejects an explicit invalid date without loading coaching availability", async () => {
  const page = await coaching({ date: "bad-date", location: central.id });
  expect(page.alerts).toEqual(["Choose a valid date from today onward."]);
  expect(page.controls).toBeNull();
  expect(loadLessons).not.toHaveBeenCalled();
});

it("fails closed in coaching mode when public options or lesson availability cannot be loaded", async () => {
  loadCoaching.mockRejectedValueOnce(new Error("Unavailable"));
  expect((await coaching({})).alerts).toEqual(["Coaching information is temporarily unavailable. Please try again."]);
  loadLessons.mockRejectedValueOnce(new Error("Unavailable"));
  const page = await coaching({ location: central.id, coach: "andrei", program: "private", duration: "60" });
  expect(page.alerts).toEqual(["Unable to load lesson availability. Please try again."]);
  expect(page.booking).toMatchObject({ durationMinutes: 0, starts: [] });
});
