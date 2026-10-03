import type { CalendarCellState } from "./calendar";

export type CalendarSelection = {
  courtId: string;
  startMinute: number;
  endMinute: number;
  durationMinutes: number;
  priceMinor: number;
  startRowIndex: number;
  endRowIndex: number;
};

type CourtGrid = {
  courtId: string;
  times: readonly number[];
  cells: readonly CalendarCellState[];
  hourlyPrices: readonly (number | null)[];
};

export function getCalendarSelection(grid: CourtGrid, startRowIndex: number, endRowIndex: number): CalendarSelection | null {
  const startMinute = grid.times[startRowIndex];
  const endMinute = endRowIndex === grid.times.length ? (grid.times.at(-1) ?? -30) + 30 : grid.times[endRowIndex];
  if (startMinute === undefined || endMinute === undefined || endRowIndex <= startRowIndex) return null;
  const durationMinutes = endMinute - startMinute;
  if (startMinute < 0 || endMinute > 1440 || startMinute % 30 !== 0 || endMinute % 30 !== 0
    || durationMinutes < 60 || durationMinutes % 30 !== 0) return null;

  let sumHourlyMinor = 0;
  for (let index = startRowIndex; index < endRowIndex; index += 1) {
    const hourlyPrice = grid.hourlyPrices[index];
    if (grid.times[index] !== startMinute + (index - startRowIndex) * 30 || grid.cells[index] !== "available"
      || hourlyPrice === null || hourlyPrice === undefined) return null;
    sumHourlyMinor += hourlyPrice;
  }
  return { courtId: grid.courtId, startMinute, endMinute, durationMinutes,
    priceMinor: Math.round(sumHourlyMinor / 2), startRowIndex, endRowIndex };
}

export function selectCalendarCell(grid: CourtGrid, current: CalendarSelection | null, rowIndex: number): CalendarSelection | null {
  if (grid.cells[rowIndex] !== "available") return current;
  const choice = (start: number, end: number) => getCalendarSelection(grid, start, end);
  if (current?.courtId === grid.courtId) {
    if (rowIndex === current.endRowIndex - 1) {
      return current.endRowIndex - current.startRowIndex > 2
        ? choice(current.startRowIndex, current.endRowIndex - 1) : null;
    }
    if (rowIndex === current.startRowIndex) {
      return current.endRowIndex - current.startRowIndex > 2
        ? choice(current.startRowIndex + 1, current.endRowIndex) : null;
    }
    if (rowIndex < current.startRowIndex) return choice(rowIndex, current.endRowIndex) ?? current;
    if (rowIndex >= current.endRowIndex) return choice(current.startRowIndex, rowIndex + 1) ?? current;
  }
  return choice(rowIndex, rowIndex + 2) ?? choice(rowIndex - 1, rowIndex + 1) ?? current;
}
