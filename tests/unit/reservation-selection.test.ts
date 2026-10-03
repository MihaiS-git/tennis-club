import { expect, it } from "vitest";
import { buildReservationDay, reservationSelectionForInterval, selectReservationCell } from "@/lib/reservations/domain";
import { mondayWeekday } from "@/lib/pricing/resolution";

const date = "2099-10-15";
const courts = [{ id: "a", name: "Court A" }, { id: "b", name: "Court B" }];
const hourBase = { id: "hour", location_id: "location", created_at: "2099-01-01T00:00:00Z", updated_at: "2099-01-01T00:00:00Z",
  weekday: mondayWeekday(date) };

it("shows booked, closed and past cells while keeping another court available", () => {
  const day = buildReservationDay({ date, today: date, currentMinute: 630, courts,
    hours: [{ ...hourBase, opens_at_minute: 600, closes_at_minute: 660 },
      { ...hourBase, opens_at_minute: 690, closes_at_minute: 720 }],
    reservations: [{ court_id: "a", starts_at_minute: 630, ends_at_minute: 660 }] });
  expect(day.courts[0].cells).toEqual(["past", "booked", "closed", "available"]);
  expect(day.courts[1].cells).toEqual(["past", "available", "closed", "available"]);
});

it("preselects a 90-minute current interval and uses 30-minute contiguous adjustments", () => {
  const grid = { courtId: "a", times: [600, 630, 660, 690, 720], cells: ["available", "available", "available", "available", "booked"] as const };
  const initial = reservationSelectionForInterval(grid, 600, 690);
  expect(initial).toMatchObject({ courtId: "a", startMinute: 600, endMinute: 690 });
  expect(selectReservationCell(grid, initial, 3)).toMatchObject({ startMinute: 600, endMinute: 720 });
  expect(selectReservationCell(grid, initial, 2)).toMatchObject({ startMinute: 600, endMinute: 660 });
  expect(reservationSelectionForInterval(grid, 600, 630)).toBeNull();
  expect(selectReservationCell(grid, initial, 4)).toEqual(initial);
  const otherCourt = { ...grid, courtId: "b", cells: ["available", "available", "available", "available", "available"] as const };
  expect(selectReservationCell(otherCourt, initial, 1)).toMatchObject({ courtId: "b", startMinute: 630, endMinute: 690 });
  expect(reservationSelectionForInterval({ ...grid, cells: ["available", "booked", "available", "available", "available"] }, 600, 690)).toBeNull();
  for (const blocked of ["booked", "closed", "past"] as const) {
    expect(selectReservationCell({ ...grid, cells: [blocked, "available", "available", "available", "available"] }, null, 0)).toBeNull();
  }
});
