import { expect, it } from "vitest";
import { hourlyStartPreview, summarizeClubCourts, countLabel } from "@/lib/courts/summary";
import type { CalendarCellState, CourtDay } from "@/lib/courts/calendar";

function court(index: number, cells: CalendarCellState[]): CourtDay {
  return { court: { id: String(index), name: `Court ${index}`, slug: `court-${index}`,
    surface: "clay", environment: "outdoor", has_lighting: false },
  cells, hourlyPrices: cells.map(() => null), rates: cells.map(() => null), stateLabel: "Outdoor" };
}

it("counts zero, one and multiple locations and surface totals with singular/plural labels", () => {
  expect(summarizeClubCourts([])).toEqual({ locationCount: 0, courtCount: 0, surfaces: [] });
  const clay = court(1, []).court;
  expect(summarizeClubCourts([{ courts: [clay] }])).toEqual({ locationCount: 1, courtCount: 1,
    surfaces: [{ surface: "clay", count: 1 }] });
  expect(summarizeClubCourts([{ courts: [clay, clay] }, { courts: [
    { ...clay, surface: "hard" }, { ...clay, surface: "grass" }, { ...clay, surface: "carpet" },
  ] }])).toEqual({ locationCount: 2, courtCount: 5, surfaces: [
    { surface: "clay", count: 2 }, { surface: "hard", count: 1 },
    { surface: "grass", count: 1 }, { surface: "carpet", count: 1 },
  ] });
  expect([0, 1, 2].map((n) => countLabel(n, "court"))).toEqual(["0 courts", "1 court", "2 courts"]);
});

it.each(["booked", "closed", "unavailable", "past"] as const)("does not start a booking across a %s cell", (state) => {
  const preview = hourlyStartPreview({ times: [480, 510, 540, 570, 600],
    courts: [court(1, ["available", state, "available", "available", state])] });
  expect(preview.courts[0].starts).toEqual([540]);
});

it("requires consecutive half hours and caps courts and chronological starts at four and three", () => {
  expect(hourlyStartPreview({ times: [480, 540], courts: [court(1, ["available", "available"])] }).available).toBe(false);
  const preview = hourlyStartPreview({ times: [480, 510, 540, 570, 600],
    courts: Array.from({ length: 6 }, (_, i) => court(i, Array(5).fill("available"))) });
  expect(preview.courts).toHaveLength(4);
  expect(preview.courts.map(({ court }) => court.id)).toEqual(["0", "1", "2", "3"]);
  expect(preview.courts.every((row) => JSON.stringify(row.starts) === JSON.stringify([480, 510, 540]))).toBe(true);
});

it("checks courts beyond the display limit before declaring the location unavailable", () => {
  const preview = hourlyStartPreview({ times: [480, 510], courts: [
    ...Array.from({ length: 4 }, (_, i) => court(i, ["booked", "booked"])),
    court(5, ["available", "available"]),
  ] });
  expect(preview.available).toBe(true);
  expect(preview.courts).toHaveLength(4);
  expect(preview.courts.map(({ court }) => court.id)).toEqual(["5", "0", "1", "2"]);
  expect(preview.courts.map(({ starts }) => starts)).toEqual([[480], [], [], []]);
});

it("distinguishes closed and fully booked days", () => {
  expect(hourlyStartPreview({ times: [], courts: [court(1, [])] }).closed).toBe(true);
  const booked = hourlyStartPreview({ times: [480, 510], courts: [court(1, ["booked", "booked"])] });
  expect(booked.closed).toBe(false);
  expect(booked.available).toBe(false);
});
