import { createClient } from "@supabase/supabase-js";
import { beforeEach, expect, test, vi } from "vitest";
import { CourtEntity } from "@/lib/db/entities/court.entity";
import { CourtCoveragePeriodEntity } from "@/lib/db/entities/court-coverage-period.entity";
import { LocationPricingRuleEntity } from "@/lib/db/entities/location-pricing-rule.entity";
import { courtSlotRates } from "@/lib/courts/calendar";
import { toCalendarCoveragePeriod, toCalendarPricingRule } from "@/lib/courts/calendar-projections";
import { mondayWeekday } from "@/lib/pricing/resolution";
import { addDays } from "@/lib/courts/local-time";
import { loadBookingEditDay, withCourtRates } from "@/lib/bookings/reschedule";
import { readCurrentAccount } from "@/lib/auth/account";
import { readCustomerBookingEditContext } from "@/lib/bookings/commands";
import { listBookingEditDayCoverage, listCheckoutLocationCourts } from "@/lib/db/repositories/clubs.repository";
import { listBookingEditDayPricing } from "@/lib/db/repositories/pricing.repository";

vi.mock("@/lib/auth/account");
vi.mock("@/lib/bookings/commands");
vi.mock("@/lib/db/repositories/clubs.repository");
vi.mock("@/lib/db/repositories/pricing.repository");
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: {} }) }));

const id = (n: number) => `ca000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const date = "2099-10-15", now = new Date("2099-10-14T12:00:00Z"), stamp = now.toISOString();
const weekday = mondayWeekday(date);
const hours = [{ id: id(90), location_id: id(1), weekday, opens_at_minute: 600, closes_at_minute: 720,
  created_at: stamp, updated_at: stamp }];
const client = createClient("http://localhost:54321", "user-key", { auth: { persistSession: false } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readCurrentAccount).mockResolvedValue({ state: "active", userId: id(2), email: "owner@example.test", roles: [] });
});

test.each([1, 4, 12])("%i courts preserve per-court rates with one coverage and one pricing read", async (count) => {
  const courts = Array.from({ length: count }, (_, index) => Object.assign(new CourtEntity(), {
    id: id(index + 10), name: `Court ${index}`, slug: `court-${index}`, surface: "clay",
    environment: index % 4 === 2 ? "indoor" : "outdoor", hasLighting: false,
  }));
  const coverage = courts.filter((_, index) => index % 4 === 1).map((court) => Object.assign(new CourtCoveragePeriodEntity(), {
    id: id(60), courtId: court.id, startsOn: date, endsOn: date, createdAt: now, updatedAt: now,
  }));
  const pricing = courts.flatMap((court, index) => index % 4 === 3 ? [] :
    ["outdoor", "covered", "indoor"].map((courtState, state) => Object.assign(new LocationPricingRuleEntity(), {
      id: id(70 + state), ruleSetId: id(80), locationId: id(1), courtId: court.id, courtState, weekday,
      startsAtMinute: 600, endsAtMinute: 720, startsOn: date, endsOn: date,
      pricePerHourMinor: 1200 * (state + 1), createdAt: now, updatedAt: now,
    })));
  const displayed = [...courts].reverse().map(({ id, name, environment }) => ({ id, name, environment, is_active: true }));
  vi.mocked(readCustomerBookingEditContext).mockResolvedValue({
    payment_method: "pay_at_club", financial: { captured: 0, refunded: 0, refundObligations: 0, netPaid: 0, outstanding: 1200 },
    refunds: [], location_id: id(1), location_timezone: "UTC", court_id: courts[0].id,
    booking_date: date, starts_at_minute: 600, ends_at_minute: 660, updated_at: stamp, current_revision_id: id(3),
    total_amount_minor: 1200, currency: "RON", coaching: null,
    location: { id: id(1), name: "Private location", timezone: "UTC", is_active: true, archived_at: null, courts: displayed },
    hours, occupancy: [{ court_id: courts[0].id, starts_at_minute: 600, ends_at_minute: 660 }],
  });
  vi.mocked(listCheckoutLocationCourts).mockResolvedValue(courts);
  vi.mocked(listBookingEditDayCoverage).mockResolvedValue(coverage);
  vi.mocked(listBookingEditDayPricing).mockResolvedValue(pricing);
  const result = await loadBookingEditDay(id(4), date, client, now);
  expect(result.day.currency).toBe("RON");
  expect(result.day.courts.map((row) => row.court.id)).toEqual(displayed.map((row) => row.id));
  for (const [index, court] of courts.entries()) {
    const row = result.day.courts.find((row) => row.court.id === court.id)!;
    const previous = courtSlotRates({ court, date, times: result.day.times, hours,
      coverage: coverage.filter((item) => item.courtId === court.id).map(toCalendarCoveragePeriod),
      pricing: pricing.filter((item) => item.courtId === court.id).map(toCalendarPricingRule) });
    expect(row.rates).toEqual(previous.rates);
    expect(row.rates).toEqual(Array(4).fill([1200, 2400, 3600, null][index % 4]));
  }
  expect(result.day.courts.find((row) => row.court.id === courts[0].id)?.cells.slice(0, 2)).toEqual(["booked", "booked"]);
  expect(listCheckoutLocationCourts).not.toHaveBeenCalled();
  expect(listBookingEditDayCoverage).toHaveBeenCalledExactlyOnceWith({}, id(1), displayed.map((court) => court.id), date);
  expect(listBookingEditDayPricing).toHaveBeenCalledExactlyOnceWith({}, id(1), displayed.map((court) => court.id), weekday, date);
  // Internal environment metadata does not change the returned booking contract.
  expect(result.booking.location.courts).toEqual(displayed.map(({ id, name, is_active }) => ({ id, name, is_active })));

  vi.mocked(listBookingEditDayCoverage).mockClear();
  vi.mocked(listBookingEditDayPricing).mockClear();
  const standalone = await withCourtRates(result.day, id(1), date, hours, "RON");
  expect(standalone).toEqual(result.day);
  expect(listCheckoutLocationCourts).toHaveBeenCalledExactlyOnceWith({}, id(1));
  expect(listBookingEditDayCoverage).toHaveBeenCalledExactlyOnceWith({}, id(1), courts.map((court) => court.id), date);
  expect(listBookingEditDayPricing).toHaveBeenCalledExactlyOnceWith({}, id(1), courts.map((court) => court.id), weekday, date);

  // Standalone reads still leave a court absent from the active collection unpriced.
  vi.mocked(listCheckoutLocationCourts).mockResolvedValue(courts.slice(1));
  const missing = await withCourtRates(result.day, id(1), date, hours, "RON");
  expect(missing.courts.find((row) => row.court.id === courts[0].id)?.rates).toEqual([null, null, null, null]);

  vi.mocked(listCheckoutLocationCourts).mockClear();
  const empty = await withCourtRates(result.day, id(1), date, hours, "RON", []);
  expect(listCheckoutLocationCourts).not.toHaveBeenCalled();
  expect(empty.courts.every((row) => row.rates.every((rate) => rate === null))).toBe(true);
});

// Europe/Bucharest skips 03:00–04:00 on 2027-03-28 and repeats it on 2027-10-31.
test.each([
  ["2027-03-28", [150, 180, 210]],
  ["2027-10-31", [150]],
])("the owner's edit timetable cannot select local times that do not elapse as priced on %s", async (dstDate, invalid) => {
  const court = Object.assign(new CourtEntity(), { id: id(10), name: "Court", slug: "court", surface: "clay", environment: "outdoor", hasLighting: false });
  const dayHours = [{ ...hours[0], weekday: mondayWeekday(dstDate), opens_at_minute: 0, closes_at_minute: 1440 }];
  vi.mocked(readCustomerBookingEditContext).mockResolvedValue({
    payment_method: "online", financial: { captured: 1200, refunded: 0, refundObligations: 0, netPaid: 1200, outstanding: 0 },
    refunds: [], location_id: id(1), location_timezone: "Europe/Bucharest", court_id: court.id,
    booking_date: dstDate, starts_at_minute: 600, ends_at_minute: 660, updated_at: stamp, current_revision_id: id(3),
    total_amount_minor: 1200, currency: "RON", coaching: null,
    location: { id: id(1), name: "Club", timezone: "Europe/Bucharest", is_active: true, archived_at: null,
      courts: [{ id: court.id, name: court.name, environment: court.environment, is_active: true }] },
    hours: dayHours, occupancy: [],
  });
  vi.mocked(listCheckoutLocationCourts).mockResolvedValue([court]);
  vi.mocked(listBookingEditDayCoverage).mockResolvedValue([]);
  vi.mocked(listBookingEditDayPricing).mockResolvedValue([]);
  const result = await loadBookingEditDay(id(4), dstDate, client, new Date(`${addDays(dstDate, -1)}T12:00:00Z`));
  const [row] = result.day.courts;
  const closed = result.day.times.filter((minute, index) => row.cells[index] === "closed");
  expect(closed).toEqual(invalid);
  // Adjacent and midnight intervals stay selectable.
  for (const minute of [0, 120, 240, 270, 1410]) expect(row.cells[result.day.times.indexOf(minute)]).toBe("available");
});
