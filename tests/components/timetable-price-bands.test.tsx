// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, test } from "vitest";
import { ReservationTimetable } from "@/components/reservation-timetable";
import { formatHourlyRate, priceBands } from "@/lib/courts/price-bands";

afterEach(cleanup);
const court = { id: "11111111-1111-4111-8111-111111111111", name: "C1" };
const times = Array.from({ length: 12 }, (_, index) => 480 + index * 30);
const cells = times.map(() => "available" as const);

test("bands split on every rate change, skip unpriced slots and repeat labels on long spans", () => {
  expect(priceBands([5000, 5000, 6000, null, 6000, 6000, 6000, 6000, 6000, 6000], 4)).toEqual([
    { startIndex: 0, endIndex: 2, rate: 5000, labels: [0] },
    { startIndex: 2, endIndex: 3, rate: 6000, labels: [2] },
    { startIndex: 4, endIndex: 10, rate: 6000, labels: [4, 8] },
  ]);
  expect(formatHourlyRate(6250, "RON")).toBe("RON 62.50/h");
  expect(formatHourlyRate(5000, "EUR")).toBe("EUR 50/h");
});

it("customer edit timetable shows rate bands with repeated labels", () => {
  render(<ReservationTimetable date="2099-10-15" selection={null} onChoose={() => {}}
    day={{ times, currency: "RON", courts: [{ court, cells, rates: times.map((minute) => minute < 600 ? 5000 : 7000) }] }} />);
  const bands = within(screen.getByRole("row", { name: "C1 hourly prices" })).getAllByRole("cell").filter((cell) => cell.hasAttribute("aria-colspan"));
  expect(bands.map((band) => band.getAttribute("aria-label"))).toEqual([
    "C1 08:00–10:00, RON 50/h", "C1 10:00–12:00, RON 70/h", "C1 12:00–14:00, RON 70/h"]);
  expect(screen.getByRole("button", { name: "C1 2099-10-15 08:00–08:30, Available" }).textContent).toBe("");
});

it("Admin reservation timetables without rates show no prices", () => {
  render(<ReservationTimetable date="2099-10-15" selection={null} onChoose={() => {}} day={{ times, courts: [{ court, cells }] }} />);
  expect(screen.queryByRole("row", { name: /hourly prices/ })).toBeNull();
  expect(screen.queryByText(/\/h/)).toBeNull();
});
