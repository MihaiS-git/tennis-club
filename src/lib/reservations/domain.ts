import { z } from "zod";
import type { OpeningInterval } from "@/lib/admin/opening-hours-validation";
import { mondayWeekday } from "@/lib/pricing/resolution";

export const reservationReasonSchema = z.string().trim().min(1, "Enter a reason.").max(255, "Use at most 255 characters.");

const scheduleFields = {
  courtId: z.uuid(), date: z.iso.date(),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
  reason: reservationReasonSchema,
};
const alignedInterval = (value: { startMinute: number; endMinute: number }) => value.startMinute % 30 === 0 && value.endMinute % 30 === 0
  && value.endMinute - value.startMinute >= 60;
const intervalIssue = { message: "Choose at least 60 minutes in 30-minute steps.", path: ["startMinute"] };
export const reservationInputSchema = z.strictObject({ locationId: z.uuid(), ...scheduleFields }).refine(alignedInterval, intervalIssue);
const reservationScheduleEditSchema = z.strictObject(scheduleFields).refine(alignedInterval, intervalIssue);

const editIdentity = { id: z.uuid(), expectedUpdatedAt: z.iso.datetime({ offset: true }) };
export const reservationEditSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...editIdentity, kind: z.literal("reason"), reason: reservationReasonSchema }),
  z.strictObject({ ...editIdentity, kind: z.literal("schedule"), schedule: reservationScheduleEditSchema }),
]);

export function reservationEditInput(input: {
  id: string; expectedUpdatedAt: string; courtId: string; bookingDate: string;
  startMinute: number; endMinute: number; date: string; selection: ReservationSelection | null;
  reason: string; reasonOnly: boolean;
}) {
  const unchanged = input.selection?.courtId === input.courtId && input.date === input.bookingDate
    && input.selection.startMinute === input.startMinute && input.selection.endMinute === input.endMinute;
  return input.reasonOnly || unchanged
    ? { kind: "reason" as const, id: input.id, expectedUpdatedAt: input.expectedUpdatedAt, reason: input.reason }
    : { kind: "schedule" as const, id: input.id, expectedUpdatedAt: input.expectedUpdatedAt,
      schedule: { courtId: input.selection?.courtId, date: input.date, startMinute: input.selection?.startMinute,
        endMinute: input.selection?.endMinute, reason: input.reason } };
}

export function fitsOpeningHours(hours: readonly OpeningInterval[], date: string, start: number, end: number) {
  return hours.some((hour) => hour.weekday === mondayWeekday(date)
    && hour.opens_at_minute <= start && end <= hour.closes_at_minute);
}

export type ReservationCell = "available" | "booked" | "closed" | "past";
export type Occupancy = { court_id: string; starts_at_minute: number; ends_at_minute: number };

export function buildReservationDay(input: {
  date: string; today: string; currentMinute: number; courts: readonly { id: string; name: string }[];
  hours: readonly OpeningInterval[]; reservations: readonly Occupancy[];
}) {
  const hours = input.hours.filter((hour) => hour.weekday === mondayWeekday(input.date));
  const first = hours.length ? Math.floor(Math.min(...hours.map((hour) => hour.opens_at_minute)) / 30) * 30 : 0;
  const last = hours.length ? Math.ceil(Math.max(...hours.map((hour) => hour.closes_at_minute)) / 30) * 30 : 0;
  const times = Array.from({ length: (last - first) / 30 }, (_, index) => first + index * 30);
  const courts = input.courts.map((court) => ({ court, cells: times.map((minute): ReservationCell => {
    if (!hours.some((hour) => hour.opens_at_minute <= minute && minute + 30 <= hour.closes_at_minute)) return "closed";
    if (input.reservations.some((row) => row.court_id === court.id && row.starts_at_minute < minute + 30 && minute < row.ends_at_minute)) return "booked";
    if (input.date < input.today || (input.date === input.today && minute < input.currentMinute)) return "past";
    return "available";
  }) }));
  return { times, courts };
}

export type ReservationSelection = { courtId: string; startRow: number; endRow: number; startMinute: number; endMinute: number };
type SelectionGrid = { courtId: string; times: readonly number[]; cells: readonly ReservationCell[] };
export function reservationSelectionForInterval(grid: SelectionGrid, startMinute: number, endMinute: number): ReservationSelection | null {
  const startRow = grid.times.indexOf(startMinute);
  const endRow = grid.times.indexOf(endMinute - 30) + 1;
  return getReservationSelection(grid, startRow, endRow);
}

function getReservationSelection(grid: SelectionGrid, startRow: number, endRow: number): ReservationSelection | null {
  if (startRow < 0 || endRow > grid.times.length || endRow - startRow < 2) return null;
  if (grid.cells.slice(startRow, endRow).some((cell) => cell !== "available")) return null;
  const startMinute = grid.times[startRow];
  const endMinute = grid.times[endRow - 1] + 30;
  if (endMinute > 1440 || endMinute - startMinute !== (endRow - startRow) * 30) return null;
  return { courtId: grid.courtId, startRow, endRow, startMinute, endMinute };
}

export function selectReservationCell(grid: SelectionGrid, current: ReservationSelection | null, row: number): ReservationSelection | null {
  const choice = (startRow: number, endRow: number) => getReservationSelection(grid, startRow, endRow);
  if (grid.cells[row] !== "available") return current;
  if (current?.courtId === grid.courtId) {
    if (row === current.endRow - 1) return choice(current.startRow, current.endRow - 1);
    if (row === current.startRow) return choice(current.startRow + 1, current.endRow);
    if (row < current.startRow) return choice(row, current.endRow) ?? current;
    if (row >= current.endRow) return choice(current.startRow, row + 1) ?? current;
  }
  return choice(row, row + 2) ?? choice(row - 1, row + 1) ?? current;
}

export type ReservationInterval = Pick<z.infer<typeof reservationInputSchema>,
  "courtId" | "date" | "startMinute" | "endMinute">;
export function reservationIntervalsOverlap(a: ReservationInterval, b: ReservationInterval): boolean {
  return a.courtId.toLowerCase() === b.courtId.toLowerCase() && a.date === b.date
    && a.startMinute < b.endMinute && b.startMinute < a.endMinute;
}
