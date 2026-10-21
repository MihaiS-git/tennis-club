// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReservationTimetable, type OccupiedInterval } from "@/components/reservation-timetable";

afterEach(cleanup);

it.each([60, 90, 180])("labels each occupied block once across a %i-minute interval and preserves its click target", (duration) => {
  const onOccupiedClick = vi.fn();
  const onChoose = vi.fn();
  const times = Array.from({ length: duration / 30 }, (_, index) => 600 + index * 30);
  const intervals: OccupiedInterval[] = ([
    { id: "staff", courtId: "staff-court", kind: "reservation", label: "Reservation · Staff" },
    { id: "coaching", courtId: "coaching-court", kind: "booking", includesCoaching: true, label: "Coaching · Customer" },
    { id: "booking", courtId: "booking-court", kind: "booking", label: "Booking · Customer" },
  ] satisfies Omit<OccupiedInterval, "startsAtMinute" | "endsAtMinute">[]).map(item => ({ ...item, startsAtMinute: 600, endsAtMinute: 600 + duration }));
  render(<ReservationTimetable date="2099-10-15" selection={null} onChoose={onChoose} onOccupiedClick={onOccupiedClick}
    day={{ times, courts: intervals.map(item => ({ court: { id: item.courtId, name: item.courtId }, cells: times.map(() => "booked") })) }}
    occupiedIntervals={intervals} />);

  for (const interval of intervals) {
    const block = screen.getByRole("button", { name: new RegExp(interval.label) });
    expect(block.parentElement?.style.gridColumn).toBe(`2 / span ${duration / 30}`);
    if (interval.kind === "reservation") {
      expect(within(block).getAllByText("Reservation")).toHaveLength(1);
      expect(block.className).toContain("bg-clay-300");
    } else if (interval.includesCoaching) {
      expect(within(block).getAllByText("Coaching")).toHaveLength(1);
    } else {
      expect(block.textContent).toBe("");
    }
    fireEvent.click(block);
  }
  expect(screen.getAllByRole("button")).toHaveLength(3);
  expect(onOccupiedClick.mock.calls).toEqual([["staff"], ["coaching"], ["booking"]]);
  expect(onChoose).not.toHaveBeenCalled();
});

it("renders natural name order independent of occupancy and preserves selection and court identity", () => {
  const courts = [10, 3, 1, 4, 2].map(number => ({ court: { id: `${number}`, name: `C${number}` }, cells: ["available", "available"] as const }));
  const onChoose = vi.fn();
  const day = { times: [600, 630], courts: courts.map(row => ({ ...row, cells: [...row.cells] })) };
  const view = render(<ReservationTimetable day={day} date="2099-10-15" selection={{ courtId: "10", startRow: 0, endRow: 2, startMinute: 600, endMinute: 660 }} onChoose={onChoose} />);
  expect(screen.getAllByRole("rowheader").map(element => element.textContent)).toEqual(["C1", "C2", "C3", "C4", "C10"]);
  expect(screen.getByRole("button", { name: /C10 .*10:00–10:30/ })).toHaveProperty("ariaPressed", "true");
  fireEvent.click(screen.getByRole("button", { name: /C3 .*10:00–10:30/ }));
  expect(onChoose).toHaveBeenCalledWith("3", ["available", "available"], 0);
  view.rerender(<ReservationTimetable day={{ ...day, courts: [...day.courts].reverse() }} date="2099-10-15" selection={null} onChoose={onChoose} />);
  expect(screen.getAllByRole("rowheader").map(element => element.textContent)).toEqual(["C1", "C2", "C3", "C4", "C10"]);
});

it("renders one duration-spanning reservation block without invoking creation", () => {
  const onChoose = vi.fn();
  const onOccupiedClick = vi.fn();
  render(<ReservationTimetable date="2099-10-15" selection={null} onChoose={onChoose} onOccupiedClick={onOccupiedClick}
    day={{ times: [750, 780, 810, 840, 870], courts: [{ court: { id: "court", name: "Court 1" },
      cells: ["booked", "booked", "booked", "available", "available"] }] }}
    occupiedIntervals={[{ id: "reservation", courtId: "court", startsAtMinute: 750, endsAtMinute: 840,
      label: "Reservation · Mihai S" }]} />);
  expect(screen.getAllByLabelText(/Reservation · Mihai S/)).toHaveLength(1);
  const block = screen.getByRole("button", { name: /Court 1 2099-10-15 12:30–14:00, Reservation · Mihai S/ });
  expect(block.parentElement?.style.gridColumn).toBe("2 / span 3");
  fireEvent.click(block);
  expect(onOccupiedClick.mock.calls).toEqual([["reservation"]]);
  expect(onChoose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Court 1 2099-10-15 14:00–14:30, Available/ }));
  expect(onChoose).toHaveBeenCalledOnce();
});

it("lists only present states in the legend and keeps unavailable time out of danger styling", () => {
  render(<ReservationTimetable date="2099-10-15" selection={null} onChoose={vi.fn()} onOccupiedClick={vi.fn()}
    day={{ times: [600, 630, 660, 690, 720], courts: [{ court: { id: "court", name: "Court 1" },
      cells: ["past", "booked", "booked", "available", "available"] }] }}
    occupiedIntervals={[{ id: "reservation", courtId: "court", startsAtMinute: 630, endsAtMinute: 690, label: "Reservation · Staff", kind: "reservation" }]} />);
  const legend = screen.getByRole("list", { name: "Timetable legend" });
  // Booked time is fully drawn as a staff reservation block, so only that entry describes it.
  expect(Array.from(legend.querySelectorAll("li"), item => item.textContent)).toEqual(["Available", "Past", "Selected", "Reservation"]);
  expect(screen.getByLabelText(/10:00–10:30, Past/).className).not.toMatch(/danger/);
  expect(screen.getByRole("button", { name: /Reservation · Staff/ }).className).toContain("bg-clay-300");
});
