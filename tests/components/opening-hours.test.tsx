// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
beforeEach(() => { vi.resetAllMocks(); mutateOpeningHoursAction.mockResolvedValue({ ok: true, intervals: [] });
  installDialogMock();
});
afterEach(cleanup);

it("offers mouse-selectable half-hour suggestions and permits manually typed HH:mm", async () => {
  renderHours();
  fireEvent.click(screen.getByRole("button", { name: "Weekend" }));
  const opening = screen.getByLabelText("Opening time") as HTMLInputElement;
  const closing = screen.getByLabelText("Closing time") as HTMLInputElement;
  const starts = document.getElementById(opening.getAttribute("list")!)!;
  const ends = document.getElementById(closing.getAttribute("list")!)!;
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

it("preserves a rejected opening-hours draft and shows the pricing conflict", async () => {
  mutateOpeningHoursAction.mockResolvedValue({ ok: false, reason: "pricing-conflict",
    message: "These opening hours conflict with existing pricing on Monday (18:00–21:00). Update or remove the conflicting pricing rule before changing the opening hours." });
  renderHours([row(0, 420, 1320)]);
  fireEvent.click(screen.getByRole("button", { name: "Edit Mon 07:00–22:00" }));
  fireEvent.change(screen.getByLabelText("Closing time"), { target: { value: "20:00" } });
  fireEvent.submit(screen.getByRole("button", { name: "Apply changes to selected days" }).closest("form")!);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Monday (18:00–21:00)"));
  expect((screen.getByLabelText("Closing time") as HTMLInputElement).value).toBe("20:00");
  expect((screen.getByRole("checkbox", { name: "Mon" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("button", { name: "Apply changes to selected days" }) as HTMLButtonElement).disabled).toBe(false);
  expect(onUpdated).not.toHaveBeenCalled();
});
