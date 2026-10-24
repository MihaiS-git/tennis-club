import { describe, expect, it, vi } from "vitest";
import { projectCoachingLessonAvailability } from "@/lib/coaching/lesson-availability";
import { listCoachingLessonOffers, listCoachingRescheduleOffers, quoteCoachingLesson, quoteCoachingReschedule, type CoachingLessonDay } from "@/lib/coaching/lesson-quote";
import type { PublicCoachingFacts } from "@/lib/db/repositories/coaching.repository";
import type { PricingRule } from "@/lib/pricing/validation";
import { mondayWeekday } from "@/lib/pricing/resolution";

vi.mock("@/lib/db/data-source", () => ({ getDataSource: vi.fn() }));

const ids = {
  private: "a1000000-0000-4000-8000-000000000001", included: "a1000000-0000-4000-8000-000000000002",
  group: "a1000000-0000-4000-8000-000000000003", junior: "a1000000-0000-4000-8000-000000000004",
  east: "b1000000-0000-4000-8000-000000000001", west: "b1000000-0000-4000-8000-000000000002",
  ana: "c1000000-0000-4000-8000-00000000000a",
  court1: "d1000000-0000-4000-8000-000000000001", court2: "d1000000-0000-4000-8000-000000000002",
  court3: "d1000000-0000-4000-8000-000000000003",
};
const stamp = "2026-10-01T00:00:00Z";
const date = "2026-10-21";

const program = (id: string, name: string, program_type: string, court_rental_included: boolean, durations: number[],
  min_participants: number | null = 1, max_participants: number | null = 1) => ({
  id, name, description: "", program_type, min_participants, max_participants, court_rental_included, durations,
});
const price = (program_id: string, duration_minutes: number, amount_minor: number, currency: string, coach_user_id: string | null = null) =>
  ({ program_id, duration_minutes, coach_user_id, amount_minor, currency });
const facts: PublicCoachingFacts = {
  programs: [
    program(ids.private, "Private", "private", false, [60, 90, 120]),
    program(ids.included, "Private court included", "private", true, [60]),
    program(ids.group, "Group", "group", false, [60], 3, 6),
    program(ids.junior, "Junior", "junior", true, [60], 4, 12),
  ],
  coaches: [{ user_id: ids.ana, display_name: "Ana", bio: "", qualifications: "", specialties: [], languages: [],
    location_ids: [ids.east, ids.west], program_ids: [ids.private, ids.included, ids.group, ids.junior] }],
  prices: [
    price(ids.private, 60, 10000, "RON"),
    price(ids.private, 90, 14000, "RON"),
    price(ids.private, 90, 16000, "RON", ids.ana),
    price(ids.included, 60, 15000, "RON"),
    price(ids.group, 60, 5000, "RON"),
    price(ids.junior, 60, 4000, "RON"),
    // EUR has no 90-minute price: RON amounts are never converted.
    price(ids.private, 60, 7000, "EUR"),
  ],
  participant_prices: [],
};

const court = (id: string, name: string) => ({ id, name, slug: name.toLowerCase().replace(" ", "-"), surface: "clay" as const,
  environment: "outdoor" as const, has_lighting: true });
const hours = (location_id: string, onDate: string, opens_at_minute = 480, closes_at_minute = 1320) => ({
  id: crypto.randomUUID(), location_id, weekday: mondayWeekday(onDate), opens_at_minute, closes_at_minute, created_at: stamp, updated_at: stamp,
});
const rule = (location_id: string, court_id: string, onDate: string, price_per_hour_minor: number, starts_at_minute = 480, ends_at_minute = 1320): PricingRule => ({
  id: crypto.randomUUID(), rule_set_id: crypto.randomUUID(), location_id, court_id, court_state: "outdoor",
  weekday: mondayWeekday(onDate), starts_at_minute, ends_at_minute, starts_on: null, ends_on: null, price_per_hour_minor,
  created_at: stamp, updated_at: stamp,
});
const weekly = (location_id: string, onDate: string, start_minute: number, end_minute: number) =>
  ({ location_id, weekday: mondayWeekday(onDate), start_minute, end_minute });

function eastDay(overrides: Partial<CoachingLessonDay> = {}, coach: Partial<CoachingLessonDay["coach"]> = {}): CoachingLessonDay {
  const onDate = overrides.date ?? date;
  return {
    location: { id: ids.east, name: "East", timezone: "Europe/Bucharest", currency: "RON",
      courts: [court(ids.court1, "Court 1"), court(ids.court2, "Court 2")] },
    date: onDate, today: "2026-10-20", currentMinute: 0,
    hours: [hours(ids.east, onDate)], coverage: [],
    pricing: [rule(ids.east, ids.court1, onDate, 6000), rule(ids.east, ids.court2, onDate, 8000)],
    courtOccupancy: [], coaching: facts,
    ...overrides,
    coach: { userId: ids.ana, weekly: [weekly(ids.east, onDate, 600, 780), weekly(ids.west, onDate, 900, 1020)],
      exceptions: [], occupancy: [], ...coach },
  };
}
function westDay(overrides: Partial<CoachingLessonDay> = {}): CoachingLessonDay {
  return eastDay({
    location: { id: ids.west, name: "West", timezone: "America/New_York", currency: "EUR", courts: [court(ids.court3, "Court 3")] },
    hours: [hours(ids.west, date)], pricing: [rule(ids.west, ids.court3, date, 3000)], ...overrides,
  });
}
const lesson = (overrides = {}) => ({ programId: ids.private, courtId: ids.court1, startMinute: 600, durationMinutes: 60, participantCount: 1, ...overrides });
const reason = (day: CoachingLessonDay, request = lesson()) => {
  const result = quoteCoachingLesson(day, request);
  return result.ok ? "ok" : result.reason;
};

describe("coaching lesson quote", () => {
  it("quotes a lesson when the coach and the court are both available", () => {
    const result = quoteCoachingLesson(eastDay(), lesson());
    expect(result).toMatchObject({ ok: true, quote: {
      location: { id: ids.east, name: "East", timezone: "Europe/Bucharest" }, court: { id: ids.court1, name: "Court 1" },
      coach: { userId: ids.ana, displayName: "Ana" },
      program: { id: ids.private, name: "Private", type: "private", courtRentalIncluded: false },
      date, startMinute: 600, endMinute: 660, durationMinutes: 60,
      startsAt: "2026-10-21T07:00:00.000Z", endsAt: "2026-10-21T08:00:00.000Z",
      coachingAmountMinor: 10000, courtAmountMinor: 6000, totalAmountMinor: 16000, currency: "RON",
      evidence: {
        coachingPrice: { amountMinor: 10000, currency: "RON", source: "club", programId: ids.private, durationMinutes: 60,
          coachUserId: ids.ana },
        courtRentalMinor: 6000,
        courtPricing: { version: 1, rounding: "half-hour-sum-round", courtState: "outdoor" },
      },
    } });
    if (result.ok) expect(result.quote.evidence.courtPricing.slots.map((slot) => [slot.minute, slot.hourlyMinor]))
      .toEqual([[600, 6000], [630, 6000]]);
  });

  it("requires the whole lesson inside the coach's availability", () => {
    expect(reason(eastDay(), lesson({ startMinute: 720, durationMinutes: 90 }))).toBe("coach-unavailable");
    expect(reason(eastDay(), lesson({ startMinute: 540 }))).toBe("coach-unavailable");
    expect(reason(eastDay({}, { exceptions: [{ date, kind: "unavailable", location_id: null, start_minute: 630, end_minute: 660 }] })))
      .toBe("coach-unavailable");
    expect(reason(eastDay({}, { exceptions: [{ date, kind: "unavailable", location_id: null, start_minute: null, end_minute: null }] })))
      .toBe("coach-unavailable");
    expect(reason(eastDay({}, { weekly: [] }))).toBe("coach-unavailable");
  });

  it("joins contiguous weekly and additional windows at the location", () => {
    const day = eastDay({}, { exceptions: [{ date, kind: "available", location_id: ids.east, start_minute: 780, end_minute: 840 }] });
    expect(reason(day, lesson({ startMinute: 720, durationMinutes: 90 }))).toBe("ok");
    expect(reason(day, lesson({ startMinute: 780, durationMinutes: 90 }))).toBe("coach-unavailable");
  });

  it("requires a bookable court", () => {
    const occupied = [{ court_id: ids.court1, booking_date: date, starts_at_minute: 630, ends_at_minute: 690 }];
    expect(reason(eastDay({ courtOccupancy: occupied }))).toBe("court-unavailable");
    expect(reason(eastDay({ courtOccupancy: occupied }), lesson({ courtId: ids.court2 }))).toBe("ok");
    expect(reason(eastDay({ hours: [hours(ids.east, date, 630, 1320)] }))).toBe("court-unavailable");
    expect(reason(eastDay({ pricing: [rule(ids.east, ids.court1, date, 6000, 630, 1320)] }))).toBe("court-unavailable");
    expect(reason(eastDay({ today: date, currentMinute: 610 }))).toBe("court-unavailable");
    expect(reason(eastDay(), lesson({ courtId: ids.court3 }))).toBe("court-unavailable");
  });

  it("rejects an existing coaching reservation at any court or location on the date", () => {
    const busy = (booking_date: string, starts_at_minute: number, ends_at_minute: number) =>
      eastDay({}, { occupancy: [{ booking_date, starts_at_minute, ends_at_minute }] });
    expect(reason(busy(date, 630, 690))).toBe("coach-booked");
    expect(reason(busy(date, 570, 601))).toBe("coach-booked");
    expect(reason(busy(date, 660, 720))).toBe("ok");
    expect(reason(busy("2026-10-22", 600, 660))).toBe("ok");
  });

  it("enforces 30-minute starts, configured durations and the court grid", () => {
    expect(reason(eastDay(), lesson({ startMinute: 615 }))).toBe("invalid-time");
    expect(reason(eastDay(), lesson({ durationMinutes: 45 }))).toBe("invalid-time");
    expect(reason(eastDay(), lesson({ durationMinutes: 75 }))).toBe("invalid-time");
    expect(reason(eastDay(), lesson({ startMinute: 1410, durationMinutes: 60 }))).toBe("invalid-time");
    expect(reason(eastDay(), lesson({ durationMinutes: 180 }))).toBe("invalid-time");
    expect(reason(eastDay(), lesson({ programId: ids.included, durationMinutes: 90 }))).toBe("invalid-duration");
    expect(reason(eastDay(), lesson({ durationMinutes: 150 }))).toBe("invalid-time");
    expect(reason(eastDay(), lesson({ durationMinutes: 90, startMinute: 720 }))).toBe("coach-unavailable");
  });

  it("adds the court rental only when the program does not include it", () => {
    const included = quoteCoachingLesson(eastDay(), lesson({ programId: ids.included, courtId: ids.court2 }));
    expect(included).toMatchObject({ ok: true, quote: { coachingAmountMinor: 15000, courtAmountMinor: 0, totalAmountMinor: 15000,
      currency: "RON", program: { courtRentalIncluded: true }, evidence: { courtRentalMinor: 8000 } } });
    const excluded = quoteCoachingLesson(eastDay(), lesson({ courtId: ids.court2 }));
    expect(excluded).toMatchObject({ ok: true, quote: { coachingAmountMinor: 10000, courtAmountMinor: 8000, totalAmountMinor: 18000 } });
    // Included rental still needs a real, available court.
    const occupied = [{ court_id: ids.court2, booking_date: date, starts_at_minute: 600, ends_at_minute: 660 }];
    expect(reason(eastDay({ courtOccupancy: occupied }), lesson({ programId: ids.included, courtId: ids.court2 }))).toBe("court-unavailable");
  });

  it("prices with the coach's override over the club default", () => {
    expect(quoteCoachingLesson(eastDay(), lesson({ durationMinutes: 90 }))).toMatchObject({ ok: true, quote: {
      coachingAmountMinor: 16000, courtAmountMinor: 9000, totalAmountMinor: 25000,
      evidence: { coachingPrice: { source: "coach", amountMinor: 16000 } } } });
  });

  it("applies club-wide prices at every assigned location charging in that currency", () => {
    const ronWest = westDay({ location: { id: ids.west, name: "West", timezone: "America/New_York", currency: "RON", courts: [court(ids.court3, "Court 3")] } });
    expect(quoteCoachingLesson(ronWest, lesson({ courtId: ids.court3, startMinute: 900 }))).toMatchObject({ ok: true, quote: {
      coachingAmountMinor: 10000, currency: "RON", evidence: { coachingPrice: { source: "club" } } } });
    expect(quoteCoachingLesson(ronWest, lesson({ courtId: ids.court3, startMinute: 900, durationMinutes: 90 }))).toMatchObject({ ok: true, quote: {
      coachingAmountMinor: 16000, currency: "RON", evidence: { coachingPrice: { source: "coach" } } } });
    // Program eligibility needs only the coach's program and location assignments.
    const onlyWest = { ...facts, coaches: [{ ...facts.coaches[0], location_ids: [ids.west], program_ids: [ids.private] }] };
    expect(reason(westDay({ coaching: onlyWest }), lesson({ courtId: ids.court3, startMinute: 900 }))).toBe("ok");
  });

  it("never offers a lesson without an applicable coaching price or eligibility", () => {
    expect(reason(eastDay(), lesson({ durationMinutes: 120 }))).toBe("unpriced");
    expect(reason(westDay(), lesson({ courtId: ids.court3, startMinute: 900, durationMinutes: 90 }))).toBe("unpriced");
    expect(reason(eastDay(), lesson({ programId: "a1000000-0000-4000-8000-0000000000ff" }))).toBe("not-offered");
    // Inactive programs and ineligible coaches are absent from the public facts.
    expect(reason(eastDay({ coaching: { ...facts, coaches: [] } }))).toBe("not-offered");
    expect(reason(eastDay({ coaching: { ...facts, coaches: [{ ...facts.coaches[0], location_ids: [ids.west] }] } }))).toBe("not-offered");
    expect(reason(eastDay({ coaching: { ...facts, coaches: [{ ...facts.coaches[0], program_ids: [ids.included] }] } }))).toBe("not-offered");
  });

  it("offers only Private and Semi-private lessons online, within the configured participant range", () => {
    for (const [programId, participantCount] of [[ids.private, 2], [ids.private, 0], [ids.private, 1.5]] as const)
      expect(reason(eastDay(), lesson({ programId, participantCount }))).toBe("invalid-participants");
    // Group and Junior sessions are organized by the coach or club: no quote, offer or availability
    // for any count, even when assigned, priced, available and inside the configured range.
    for (const [programId, participantCount] of [[ids.group, 3], [ids.group, 6], [ids.junior, 4], [ids.junior, 12]] as const) {
      expect(reason(eastDay(), lesson({ programId, participantCount }))).toBe("not-offered");
      expect(listCoachingLessonOffers(eastDay(), { programId, durationMinutes: 60 })).toEqual([]);
      expect(projectCoachingLessonAvailability(eastDay(), programId)).toBeNull();
    }
    // Missing or invalid configured limits make a Private program unavailable online, whatever the count.
    for (const limits of [{ min_participants: null }, { max_participants: null }, { min_participants: 7, max_participants: 6 }, { max_participants: 101 }]) {
      const day = eastDay({ coaching: { ...facts, programs: facts.programs.map(p => p.id === ids.private ? { ...p, ...limits } : p) } });
      expect(reason(day, lesson({ participantCount: 1 }))).toBe("not-offered");
      expect(listCoachingLessonOffers(day, { programId: ids.private, durationMinutes: 60 })).toEqual([]);
      expect(projectCoachingLessonAvailability(day, ids.private)).toBeNull();
    }
  });

  it("keeps locations, prices, currencies and coach windows separate", () => {
    expect(quoteCoachingLesson(westDay(), lesson({ courtId: ids.court3, startMinute: 900 }))).toMatchObject({ ok: true, quote: {
      location: { id: ids.west, timezone: "America/New_York" }, court: { id: ids.court3 },
      coachingAmountMinor: 7000, courtAmountMinor: 3000, totalAmountMinor: 10000, currency: "EUR",
      startsAt: "2026-10-21T19:00:00.000Z", endsAt: "2026-10-21T20:00:00.000Z" } });
    // East availability does not make the coach available at West, and vice versa.
    expect(reason(westDay(), lesson({ courtId: ids.court3 }))).toBe("coach-unavailable");
    expect(reason(eastDay(), lesson({ startMinute: 900 }))).toBe("coach-unavailable");
    // A lesson at West occupies the coach at East at the same wall time.
    expect(reason(eastDay({}, { occupancy: [{ booking_date: date, starts_at_minute: 600, ends_at_minute: 660 }] }))).toBe("coach-booked");
  });

  it("uses the location's timezone and rejects lessons across a clock change", () => {
    const springForward = "2026-03-29";
    const day = eastDay({ date: springForward, today: "2026-03-01", hours: [hours(ids.east, springForward, 0, 1440)],
      pricing: [rule(ids.east, ids.court1, springForward, 6000, 0, 1440), rule(ids.east, ids.court2, springForward, 8000, 0, 1440)] },
    { weekly: [weekly(ids.east, springForward, 0, 1440)] });
    expect(reason(day, lesson({ startMinute: 150, durationMinutes: 90 }))).toBe("invalid-time");
    expect(quoteCoachingLesson(day, lesson({ startMinute: 600 }))).toMatchObject({ ok: true, quote: {
      startsAt: "2026-03-29T07:00:00.000Z", endsAt: "2026-03-29T08:00:00.000Z" } });
    expect(quoteCoachingLesson(eastDay(), lesson())).toMatchObject({ ok: true, quote: { startsAt: "2026-10-21T07:00:00.000Z" } });
  });
});

describe("coaching lesson offers", () => {
  it("offers every available court at each start, with each court's price", () => {
    const offers = listCoachingLessonOffers(eastDay(), { programId: ids.private, durationMinutes: 60 });
    expect(offers.map((offer) => [offer.startMinute, offer.court.id, offer.totalAmountMinor])).toEqual(
      [600, 630, 660, 690, 720].flatMap((start) => [[start, ids.court1, 16000], [start, ids.court2, 18000]]));
    const occupied = [{ court_id: ids.court1, booking_date: date, starts_at_minute: 630, ends_at_minute: 690 }];
    expect(listCoachingLessonOffers(eastDay({ courtOccupancy: occupied }), { programId: ids.private, durationMinutes: 60 })
      .map((offer) => [offer.startMinute, offer.court.id]))
      .toEqual([[600, ids.court2], [630, ids.court2], [660, ids.court2], [690, ids.court1], [690, ids.court2],
        [720, ids.court1], [720, ids.court2]]);
  });

  it("never duplicates a court and time, and keeps the supplied court order", () => {
    const base = eastDay();
    const [court1, court2] = base.location.courts;
    const day = { ...base, location: { ...base.location, courts: [court2, court1, { ...court2, id: court2.id.toUpperCase() }] } };
    const offers = listCoachingLessonOffers(day, { programId: ids.private, durationMinutes: 60 });
    expect(offers.filter((offer) => offer.startMinute === 600).map((offer) => offer.court.id)).toEqual([ids.court2, ids.court1]);
    expect(new Set(offers.map((offer) => `${offer.startMinute}:${offer.court.id}`)).size).toBe(offers.length);
  });

  it("excludes the coach's booked time and returns nothing when the lesson is not offered", () => {
    const busy = eastDay({}, { occupancy: [{ booking_date: date, starts_at_minute: 660, ends_at_minute: 720 }] });
    expect(listCoachingLessonOffers(busy, { programId: ids.private, durationMinutes: 60 }).map((offer) => offer.startMinute)).toEqual([600, 600, 720, 720]);
    expect(listCoachingLessonOffers(eastDay(), { programId: "a1000000-0000-4000-8000-0000000000ff", durationMinutes: 60 })).toEqual([]);
    expect(listCoachingLessonOffers(eastDay(), { programId: ids.private, durationMinutes: 120 })).toEqual([]);
  });
});

describe("public coaching lesson availability", () => {
  it("groups every available court under its start with exact quoted amounts and no internals", () => {
    const occupied = [{ court_id: ids.court1, booking_date: date, starts_at_minute: 630, ends_at_minute: 690 }];
    const availability = projectCoachingLessonAvailability(eastDay({ courtOccupancy: occupied }), ids.private.toUpperCase());
    expect(availability).toMatchObject({
      location: { id: ids.east, name: "East", timezone: "Europe/Bucharest" }, coach: { id: ids.ana, displayName: "Ana" },
      program: { id: ids.private, name: "Private", courtRentalIncluded: false }, date, currency: "RON",
    });
    // The unpriced 120-minute duration is omitted.
    expect(availability?.durations.map((duration) => duration.durationMinutes)).toEqual([60, 90]);
    const sixty = availability!.durations[0].starts;
    expect(sixty.map((start) => [start.startMinute, start.courts.map((court) => court.id)])).toEqual([
      [600, [ids.court2]], [630, [ids.court2]], [660, [ids.court2]], [690, [ids.court1, ids.court2]], [720, [ids.court1, ids.court2]],
    ]);
    expect(sixty[3]).toEqual({ startMinute: 690, endMinute: 750, startsAt: "2026-10-21T08:30:00.000Z", endsAt: "2026-10-21T09:30:00.000Z",
      courts: [
        { id: ids.court1, name: "Court 1", coachingAmountMinor: 10000, courtAmountMinor: 6000, totalAmountMinor: 16000 },
        { id: ids.court2, name: "Court 2", coachingAmountMinor: 10000, courtAmountMinor: 8000, totalAmountMinor: 18000 },
      ] });
    expect(availability!.durations[1].starts.map((start) => start.startMinute)).toEqual([600, 630, 660, 690]);
    const serialized = JSON.stringify(availability);
    for (const internal of ["evidence", "ruleId", "source", "bio", "booking_date", "weekly"]) expect(serialized).not.toContain(internal);
  });

  it("excludes coach exceptions and the coach's lessons at other locations", () => {
    const day = eastDay({}, { exceptions: [{ date, kind: "unavailable", location_id: null, start_minute: 600, end_minute: 660 }],
      occupancy: [{ booking_date: date, starts_at_minute: 720, ends_at_minute: 780 }] });
    expect(projectCoachingLessonAvailability(day, ids.private)?.durations[0].starts.map((start) => start.startMinute)).toEqual([660]);
  });

  it("uses the location's timezone and currency", () => {
    const west = projectCoachingLessonAvailability(westDay(), ids.private);
    expect(west).toMatchObject({ location: { timezone: "America/New_York" }, currency: "EUR" });
    expect(west?.durations.map((duration) => duration.durationMinutes)).toEqual([60]);
    expect(west?.durations[0].starts[0]).toMatchObject({ startMinute: 900, startsAt: "2026-10-21T19:00:00.000Z",
      courts: [{ id: ids.court3, totalAmountMinor: 10000 }] });
  });

  it("returns nothing unless the coach publicly offers the program at the location", () => {
    expect(projectCoachingLessonAvailability(eastDay(), ids.private)).toMatchObject({ program: { id: ids.private, participants: { min: 1, max: 1 } },
      durations: expect.arrayContaining([{ durationMinutes: 60, starts: expect.arrayContaining([expect.objectContaining({ startMinute: 600 })]) }]) });
    expect(projectCoachingLessonAvailability(eastDay(), "a1000000-0000-4000-8000-0000000000ff")).toBeNull();
    // Inactive programs and ineligible coaches are absent from the public facts.
    expect(projectCoachingLessonAvailability(eastDay({ coaching: { ...facts, programs: facts.programs.slice(1) } }), ids.private)).toBeNull();
    expect(projectCoachingLessonAvailability(eastDay({ coaching: { ...facts, coaches: [] } }), ids.private)).toBeNull();
    expect(projectCoachingLessonAvailability(eastDay({ coaching: { ...facts,
      coaches: [{ ...facts.coaches[0], location_ids: [ids.west] }] } }), ids.private)).toBeNull();
    // An offered program with no free time that day is still described, with no starts.
    expect(projectCoachingLessonAvailability(eastDay({}, { weekly: [] }), ids.private)?.durations
      .every((duration) => duration.starts.length === 0)).toBe(true);
  });
});


describe("semi-private complete-session quotes", () => {
  it.each([false, true])("uses configured durations and session price (court included=%s)", included => {
    const coaching = { ...facts, programs: facts.programs.map(p => p.id === ids.private
      ? { ...p, name: "Semi-private coaching", program_type: "semi_private", min_participants: 2, max_participants: 2, court_rental_included: included } : p) };
    const day = eastDay({ coaching });
    expect(projectCoachingLessonAvailability(day, ids.private)?.program).toMatchObject({ name: "Semi-private coaching", participants: { min: 2, max: 2 } });
    expect(projectCoachingLessonAvailability(day, ids.private)?.durations.map(d => d.durationMinutes)).toEqual([60, 90]);
    for (const [durationMinutes, amountMinor, source, rental] of [[60, 10000, "club", 6000], [90, 16000, "coach", 9000]] as const) {
      expect(quoteCoachingLesson(day, lesson({ durationMinutes, participantCount: 2 }))).toMatchObject({ ok: true, quote: {
        program: { type: "semi_private", participants: { min: 2, max: 2 } }, coachingAmountMinor: amountMinor,
        courtAmountMinor: included ? 0 : rental, totalAmountMinor: amountMinor + (included ? 0 : rental),
        evidence: { coachingPrice: { source } },
      } });
    }
    expect(reason(day, lesson({ durationMinutes: 120, participantCount: 2 }))).toBe("unpriced");
    expect(reason(day, lesson({ durationMinutes: 90, startMinute: 720, participantCount: 2 }))).toBe("coach-unavailable");
    expect(reason(eastDay({ coaching }, { occupancy: [{ booking_date: date, starts_at_minute: 630, ends_at_minute: 660 }] }), lesson({ participantCount: 2 }))).toBe("coach-booked");
    expect(reason(day)).toBe("invalid-participants");
    // The same configuration as a Junior program is not offered online.
    expect(reason(eastDay({ coaching: { ...coaching, programs: coaching.programs.map(p => ({ ...p, program_type: "junior" })) } }), lesson({ participantCount: 2 }))).toBe("not-offered");
  });
});

it.each(["2026-12-20", "2026-12-21", "2026-12-31", "2027-01-01", "2027-01-10", "2027-01-11"])(
  "blocks booking quotes only inside the inclusive local time-off range: %s", onDate => {
    const day = eastDay({ date: onDate }, { exceptions: [{ date: "2026-12-21", until_date: "2027-01-10", kind: "unavailable", location_id: null, start_minute: null, end_minute: null }] });
    const inside = onDate >= "2026-12-21" && onDate <= "2027-01-10";
    expect(quoteCoachingLesson(day, lesson()).ok).toBe(!inside);
    expect(listCoachingLessonOffers(day, { programId: ids.private, durationMinutes: 60 }).length === 0).toBe(inside);
  },
);

describe("purchased lesson reschedule quotes", () => {
  // The agreed fee differs from every configured price: it is never repriced.
  const agreed = { programId: ids.private, coachUserId: ids.ana, locationId: ids.east, durationMinutes: 90, source: "coach" as const,
    amountMinor: 12345, currency: "RON" as const, courtRentalIncluded: false, courtRentalMinor: 9000, courtAmountMinor: 9000 };

  it("keeps the agreed fee and duration and charges only the current court rental", () => {
    const result = quoteCoachingReschedule(eastDay(), agreed, { courtId: ids.court2, startMinute: 660 });
    expect(result).toMatchObject({ ok: true, quote: { court: { id: ids.court2, name: "Court 2" }, startMinute: 660, endMinute: 750,
      totalAmountMinor: 12345 + 12000 } });
    if (result.ok) expect(result.quote.pricingEvidence.coaching).toEqual({ ...agreed, courtRentalMinor: 12000, courtAmountMinor: 12000 });
    const included = quoteCoachingReschedule(eastDay(), { ...agreed, courtRentalIncluded: true, courtAmountMinor: 0 }, { courtId: ids.court2, startMinute: 660 });
    expect(included).toMatchObject({ ok: true, quote: { totalAmountMinor: 12345,
      pricingEvidence: { coaching: { courtRentalIncluded: true, courtRentalMinor: 12000, courtAmountMinor: 0 } } } });
  });

  it("does not need the coach's public profile, program or price to stay published", () => {
    const unpublished = { ...eastDay(), coaching: { programs: [], coaches: [], prices: [], participant_prices: [] } };
    expect(quoteCoachingReschedule(unpublished, agreed, { courtId: ids.court1, startMinute: 600 })).toMatchObject({ ok: true });
  });

  it("still requires the coach's availability, a free coach and a free court for the whole lesson", () => {
    const reason = (day: CoachingLessonDay, startMinute: number, courtId = ids.court1) => {
      const result = quoteCoachingReschedule(day, agreed, { courtId, startMinute });
      return result.ok ? "ok" : result.reason;
    };
    expect(reason(eastDay(), 720)).toBe("coach-unavailable");
    expect(reason(eastDay(), 615)).toBe("invalid-time");
    expect(reason(eastDay({}, { occupancy: [{ booking_date: date, starts_at_minute: 660, ends_at_minute: 720 }] }), 600)).toBe("coach-booked");
    const busyCourt = eastDay({ courtOccupancy: [{ court_id: ids.court1, booking_date: date, starts_at_minute: 630, ends_at_minute: 690 }] });
    expect(reason(busyCourt, 600)).toBe("court-unavailable");
    expect(reason(busyCourt, 600, ids.court2)).toBe("ok");
    expect(listCoachingRescheduleOffers(busyCourt, agreed).map((offer) => [offer.startMinute, offer.court.id]))
      .toEqual([[600, ids.court2], [630, ids.court2], [660, ids.court2], [690, ids.court1], [690, ids.court2]]);
  });
});
