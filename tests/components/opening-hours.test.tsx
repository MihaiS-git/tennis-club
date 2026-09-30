// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpeningInterval } from "../../src/lib/admin/opening-hours-validation";
const { mutateOpeningHoursAction, refresh, onUpdated } = vi.hoisted(() => ({
  mutateOpeningHoursAction: vi.fn(), refresh: vi.fn(), onUpdated: vi.fn(),
}));
vi.mock("../../src/app/admin/locations/opening-hours-actions", () => ({ mutateOpeningHoursAction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
import { OpeningHours } from "../../src/app/admin/locations/opening-hours";

const locationId = "c6000000-0000-4000-8000-000000000011";
const row = (weekday: number, opens_at_minute = 420, closes_at_minute = 1440): OpeningInterval => ({
  id: `c6000000-0000-4000-8000-${String(weekday * 10000 + opens_at_minute).padStart(12, "0")}`,
  location_id: locationId, weekday, opens_at_minute, closes_at_minute,
  created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z",
});
const renderHours = (intervals: OpeningInterval[] = []) => render(<OpeningHours locationId={locationId} intervals={intervals} onUpdated={onUpdated} />);
beforeEach(() => { vi.resetAllMocks(); mutateOpeningHoursAction.mockResolvedValue({ ok: true, intervals: [] }); });
afterEach(cleanup);

it("starts with no selected day and applies each preset exactly", () => {
  renderHours();
  const selected = () => screen.getAllByRole("checkbox").filter((checkbox) => (checkbox as HTMLInputElement).checked).map((checkbox) => checkbox.parentElement?.textContent);
  expect(selected()).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Weekdays" }));
  expect(selected()).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri"]);
  fireEvent.click(screen.getByRole("button", { name: "Weekend" }));
  expect(selected()).toEqual(["Sat", "Sun"]);
  fireEvent.click(screen.getByRole("button", { name: "All days" }));
  expect(selected()).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  fireEvent.click(screen.getByRole("checkbox", { name: "Sun" }));
  expect(selected()).toHaveLength(6);
});

it("offers mouse-selectable half-hour suggestions and permits manually typed HH:mm", async () => {
  renderHours();
  fireEvent.click(screen.getByRole("button", { name: "Weekend" }));
  const opening = screen.getByLabelText("Opening time") as HTMLInputElement;
  const closing = screen.getByLabelText("Closing time") as HTMLInputElement;
  const starts = document.getElementById(opening.getAttribute("list")!)!;
  const ends = document.getElementById(closing.getAttribute("list")!)!;
  expect(starts.querySelectorAll("option")).toHaveLength(48);
  expect(starts.querySelector('option[value="07:30"]')).toBeTruthy();
  expect(starts.querySelector('option[value="24:00"]')).toBeNull();
  expect(ends.querySelector('option[value="24:00"]')).toBeTruthy();
  fireEvent.change(opening, { target: { value: "07:17" } });
  fireEvent.change(closing, { target: { value: "23:43" } });
  fireEvent.submit(screen.getByRole("button", { name: "Apply to selected days" }).closest("form")!);
  await waitFor(() => expect(mutateOpeningHoursAction).toHaveBeenCalledExactlyOnceWith({
    location_id: locationId, weekdays: [5, 6], replace_ids: [], intervals: [{ opens_at: "07:17", closes_at: "23:43" }],
  }));
});

it("allows one split only after the first interval is valid and offers Add again after removal", () => {
  renderHours();
  const add = () => screen.queryByRole("button", { name: "Add interval" }) as HTMLButtonElement | null;
  expect(screen.getAllByLabelText("Opening time")).toHaveLength(1);
  expect(add()?.disabled).toBe(true);

  fireEvent.change(screen.getByLabelText("Opening time"), { target: { value: "07:00" } });
  expect(add()?.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Closing time"), { target: { value: "06:00" } });
  expect(add()?.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Closing time"), { target: { value: "12:00" } });
  expect(add()?.disabled).toBe(false);
  fireEvent.click(add()!);
  expect(screen.getAllByLabelText("Opening time")).toHaveLength(2);
  expect(add()).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Remove draft interval 2" }));
  expect(screen.getAllByLabelText("Opening time")).toHaveLength(1);
  expect(add()?.disabled).toBe(false);
});

it("applies multiple adjacent intervals to all selected days in one operation", async () => {
  renderHours();
  fireEvent.click(screen.getByRole("button", { name: "Weekdays" }));
  fireEvent.change(screen.getByLabelText("Opening time"), { target: { value: "07:00" } });
  fireEvent.change(screen.getByLabelText("Closing time"), { target: { value: "12:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Add interval" }));
  fireEvent.change(screen.getAllByLabelText("Opening time")[1], { target: { value: "14:00" } });
  fireEvent.change(screen.getAllByLabelText("Closing time")[1], { target: { value: "24:00" } });
  fireEvent.submit(screen.getByRole("button", { name: "Apply to selected days" }).closest("form")!);
  await waitFor(() => expect(mutateOpeningHoursAction).toHaveBeenCalledExactlyOnceWith({
    location_id: locationId, weekdays: [0, 1, 2, 3, 4], replace_ids: [], intervals: [
      { opens_at: "07:00", closes_at: "12:00" }, { opens_at: "14:00", closes_at: "24:00" },
    ],
  }));
  expect(onUpdated).toHaveBeenCalledWith([]);
  expect(refresh).toHaveBeenCalledOnce();
});

it("shows complete schedule groups and edits every interval in the clicked group", async () => {
  const intervals = [0, 1, 2, 3, 4].map((day) => row(day));
  renderHours(intervals);
  const schedule = screen.getByRole("list", { name: "Current weekly schedule" });
  expect(within(schedule).getByText("Mon–Fri")).toBeTruthy();
  expect(within(schedule).getByRole("button", { name: "Edit Mon–Fri 07:00–24:00" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add Monday interval" })).toBeNull();
  fireEvent.click(within(schedule).getByRole("button", { name: "Edit Mon–Fri 07:00–24:00" }));
  expect(screen.getAllByRole("checkbox").filter((checkbox) => (checkbox as HTMLInputElement).checked)).toHaveLength(5);
  fireEvent.change(screen.getByLabelText("Opening time"), { target: { value: "08:00" } });
  fireEvent.submit(screen.getByRole("button", { name: "Apply changes to selected days" }).closest("form")!);
  await waitFor(() => expect(mutateOpeningHoursAction).toHaveBeenCalledExactlyOnceWith({
    location_id: locationId, weekdays: [0, 1, 2, 3, 4], replace_ids: intervals.map((interval) => interval.id),
    intervals: [{ opens_at: "08:00", closes_at: "24:00" }],
  }));
});

it("removes a grouped interval for every intended day in one operation", async () => {
  const intervals = [0, 1, 2, 3, 4].map((day) => row(day));
  renderHours(intervals);
  fireEvent.click(screen.getByRole("button", { name: "Remove Mon–Fri 07:00–24:00" }));
  await waitFor(() => expect(mutateOpeningHoursAction).toHaveBeenCalledExactlyOnceWith({
    location_id: locationId, weekdays: [0, 1, 2, 3, 4], replace_ids: intervals.map((interval) => interval.id), intervals: [],
  }));
});

it("keeps an unchecked day unchanged when editing a grouped interval", async () => {
  const intervals = [0, 1, 2, 3, 4].map((day) => row(day));
  renderHours(intervals);
  fireEvent.click(screen.getByRole("button", { name: "Edit Mon–Fri 07:00–24:00" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Fri" }));
  fireEvent.change(screen.getByLabelText("Opening time"), { target: { value: "08:00" } });
  fireEvent.submit(screen.getByRole("button", { name: "Apply changes to selected days" }).closest("form")!);
  await waitFor(() => expect(mutateOpeningHoursAction).toHaveBeenCalledExactlyOnceWith({
    location_id: locationId, weekdays: [0, 1, 2, 3], replace_ids: intervals.slice(0, 4).map((interval) => interval.id),
    intervals: [{ opens_at: "08:00", closes_at: "24:00" }],
  }));
});

it("keeps selected days and times after a conflict and identifies the day", async () => {
  mutateOpeningHoursAction.mockResolvedValue({ ok: false, reason: "overlap", weekdays: [1] });
  renderHours();
  fireEvent.click(screen.getByRole("button", { name: "Weekdays" }));
  fireEvent.change(screen.getByLabelText("Opening time"), { target: { value: "07:00" } });
  fireEvent.change(screen.getByLabelText("Closing time"), { target: { value: "24:00" } });
  fireEvent.submit(screen.getByRole("button", { name: "Apply to selected days" }).closest("form")!);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Tuesday conflicts"));
  expect((screen.getByRole("checkbox", { name: "Tue" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText("Closing time") as HTMLInputElement).value).toBe("24:00");
  expect(onUpdated).not.toHaveBeenCalled();
});
