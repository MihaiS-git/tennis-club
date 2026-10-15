// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReservationTimetable } from "@/components/reservation-timetable";

afterEach(cleanup);

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
