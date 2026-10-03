import { describe, expect, it } from "vitest";
import { buildCourtDay } from "@/lib/courts/calendar";
import { getCalendarSelection, selectCalendarCell } from "@/lib/courts/interval-selection";
import type { OpeningInterval } from "@/lib/admin/opening-hours-validation";
import type { PricingRule } from "@/lib/pricing/validation";

const locationId = "11111111-1111-4111-8111-111111111111";
const courtId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const stamp = "2026-10-01T00:00:00Z";
const courts = [courtId, otherId].map((id, index) => ({ id, name: `Court ${index + 1}`, slug: `court-${index + 1}`,
  surface: "clay" as const, environment: "outdoor" as const, has_lighting: false }));
const hours = (opens_at_minute: number, closes_at_minute: number): OpeningInterval => ({
  id: crypto.randomUUID(), location_id: locationId, weekday: 3, opens_at_minute, closes_at_minute,
  created_at: stamp, updated_at: stamp,
});
const pricing = (id: string, starts_at_minute: number, ends_at_minute: number, price_per_hour_minor = 1200): PricingRule => ({
  id: crypto.randomUUID(), rule_set_id: crypto.randomUUID(), location_id: locationId, court_id: id,
  court_state: "outdoor", weekday: 3, starts_at_minute, ends_at_minute,
  starts_on: null, ends_on: null, price_per_hour_minor, created_at: stamp, updated_at: stamp,
});
const base = { date: "2026-10-01", today: "2026-09-30", currentMinute: 0, courts,
  hours: [hours(1020, 1200)], coverage: [], pricing: [pricing(courtId, 1020, 1200), pricing(otherId, 1020, 1200)], reservations: [] };

function grid(day: ReturnType<typeof buildCourtDay>, courtIndex = 0) {
  return { courtId: day.courts[courtIndex].court.id, times: day.times,
    cells: day.courts[courtIndex].cells, hourlyPrices: day.courts[courtIndex].hourlyPrices };
}

describe("one-day court availability", () => {
  it("derives 30-minute cells for every supplied active court and their hourly prices", () => {
    const day = buildCourtDay(base);
    expect(day.courts.map((item) => item.court.id)).toEqual([courtId, otherId]);
    expect(day.times).toEqual([1020, 1050, 1080, 1110, 1140, 1170]);
    expect(day.courts[0].cells).toEqual(Array(6).fill("available"));
    expect(day.courts[0].hourlyPrices).toEqual(Array(6).fill(1200));
    expect(buildCourtDay({ ...base, courts: courts.slice(0, 1) }).courts).toHaveLength(1);
  });

  it("preserves closed gaps, past cells, and a closed weekday", () => {
    const day = buildCourtDay({ ...base, today: base.date, currentMinute: 1050,
      hours: [hours(1020, 1080), hours(1140, 1200)] });
    expect(day.courts[0].cells).toEqual(["past", "available", "closed", "closed", "available", "available"]);
    expect(buildCourtDay({ ...base, hours: [] }).times).toEqual([]);
    expect(getCalendarSelection(grid(day), 1, 5)).toBeNull();
  });

  it("blocks only the reserved court on the selected date with half-open boundaries", () => {
    const day = buildCourtDay({ ...base, reservations: [
      { court_id: courtId, booking_date: base.date, starts_at_minute: 1050, ends_at_minute: 1110 },
      { court_id: otherId, booking_date: "2026-10-02", starts_at_minute: 1020, ends_at_minute: 1080 },
    ] });
    expect(day.courts[0].cells).toEqual(["available", "booked", "booked", "available", "available", "available"]);
    expect(day.courts[1].cells).toEqual(Array(6).fill("available"));
  });

  it("selects, extends, shrinks, and switches courts with exact mixed-rate totals", () => {
    const day = buildCourtDay({ ...base, pricing: [pricing(courtId, 1020, 1080), pricing(courtId, 1080, 1200, 2000),
      pricing(otherId, 1020, 1200)] });
    const first = selectCalendarCell(grid(day), null, 1);
    expect([first?.startMinute, first?.endMinute, first?.priceMinor]).toEqual([1050, 1110, 1600]);
    const extended = selectCalendarCell(grid(day), first, 3);
    expect([extended?.endMinute, extended?.priceMinor]).toEqual([1140, 2600]);
    expect(selectCalendarCell(grid(day), extended, 3)?.endMinute).toBe(1110);
    expect([selectCalendarCell(grid(day), first, 0)?.startMinute, selectCalendarCell(grid(day), first, 0)?.endMinute]).toEqual([1020, 1110]);
    expect(selectCalendarCell(grid(day, 1), first, 2)?.courtId).toBe(otherId);
    expect(getCalendarSelection(grid(day), 0, 1)).toBeNull();
  });
});
