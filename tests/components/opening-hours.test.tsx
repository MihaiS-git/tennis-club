// @vitest-environment jsdom
import { expectToast } from "../helpers/notifications";
import { toast } from "sonner";
import { installDialogMock } from "../helpers/dialog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpeningInterval } from "../../src/lib/admin/opening-hours-validation";
const { mutateOpeningHoursAction, refresh, onUpdated } = vi.hoisted(() => ({
  mutateOpeningHoursAction: vi.fn(), refresh: vi.fn(), onUpdated: vi.fn(),
}));
vi.mock("../../src/app/admin/locations/opening-hours-actions", () => ({ mutateOpeningHoursAction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
import { OpeningHours } from "../../src/app/admin/locations/opening-hours";
import { LocationOpeningHours } from "../../src/app/admin/locations/location-opening-hours";
import { ProfileUnsavedChanges } from "../../src/app/profile/unsaved-changes";

const locationId = "c6000000-0000-4000-8000-000000000011";
const schedule = { id: "c6000000-0000-4000-8000-000000000099", location_id: locationId, starts_on: "2026-01-01", ends_on: null, revision: 1 };
const future = { ...schedule, id: "c6000000-0000-4000-8000-000000000098", starts_on: "2027-01-01" };
const row = (weekday: number, opens_at_minute = 420, closes_at_minute = 1440): OpeningInterval => ({
  id: `c6000000-0000-4000-8000-${String(weekday * 10000 + opens_at_minute).padStart(12, "0")}`,
  location_id: locationId, schedule_id: schedule.id, weekday, opens_at_minute, closes_at_minute,
  created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z",
});
const renderHours = (intervals: OpeningInterval[] = [row(0)]) => render(<OpeningHours locationId={locationId}
  schedules={intervals.length ? [schedule] : []} today="2026-10-10" intervals={intervals} onUpdated={onUpdated} />);
const form = () => screen.getByRole("form", { name: "Opening hours editor" });
const save = () => screen.getByRole("button", { name: "Save changes" });
const time = (label: "Opening time" | "Closing time", index: number, value: string) => fireEvent.change(screen.getAllByLabelText(label)[index], { target: { value } });
function days(index: number, preset: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Days for interval ${index + 1}:`) }));
  fireEvent.click(screen.getByRole("button", { name: preset }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
}
beforeEach(() => { vi.resetAllMocks(); installDialogMock(); mutateOpeningHoursAction.mockResolvedValue({ ok: true, intervals: [row(0, 480)], schedules: [{ ...schedule, revision: 2 }], scheduleId: schedule.id }); });
afterEach(cleanup);

it("loads every weekday group into one editable table and changes only the edited row", async () => {
  const intervals = [...[0, 1, 2, 3, 4].map((day) => row(day, 420, 720)), row(5, 540, 1200), row(6, 540, 1200)];
  renderHours(intervals);
  expect(screen.getAllByRole("table")).toHaveLength(1);
  expect(screen.queryByRole("list")).toBeNull();
  expect(screen.getAllByLabelText("Opening time")).toHaveLength(2);
  expect(save()).toHaveProperty("disabled", true);
  time("Opening time", 0, "08:00");
  expect(screen.getAllByLabelText("Opening time")[1]).toHaveProperty("value", "09:00");
  fireEvent.click(save());
  await waitFor(() => expect(mutateOpeningHoursAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    operation: "update", revision: 1, replace_ids: intervals.slice(0, 5).map((h) => h.id), weekdays: [], intervals: [],
    rows: [{ weekdays: [0,1,2,3,4], opens_at: "08:00", closes_at: "12:00" }],
  })));
});

it("adds independent weekend intervals, deletes locally and reverts the entire draft", () => {
  renderHours([row(0, 420, 720)]);
  for (const [start, end] of [["09:00", "12:00"], ["13:00", "20:00"]]) {
    fireEvent.click(screen.getByRole("button", { name: "Add interval" }));
    const index = screen.getAllByLabelText("Opening time").length - 1;
    days(index, "Weekend"); time("Opening time", index, start); time("Closing time", index, end);
  }
  expect(save()).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: "Delete interval 1" }));
  expect(screen.getAllByLabelText("Opening time")).toHaveLength(2);
  expect(mutateOpeningHoursAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
  expect(screen.getAllByLabelText("Opening time")).toHaveLength(1);
  expect(screen.getByLabelText("Opening time")).toHaveProperty("value", "07:00");
  expect(save()).toHaveProperty("disabled", true);
});

it("supports arbitrary per-row weekdays and keyboard dismissal with restored focus", () => {
  renderHours([row(0), row(1)]);
  const trigger = screen.getByRole("button", { name: /^Days for interval 1:/ });
  fireEvent.click(trigger);
  const group = screen.getByRole("group", { name: "Weekdays for interval 1" });
  fireEvent.click(within(group).getByRole("checkbox", { name: "Tuesday" }));
  fireEvent.click(within(group).getByRole("checkbox", { name: "Thursday" }));
  fireEvent.keyDown(within(group).getByRole("checkbox", { name: "Thursday" }), { key: "Escape" });
  expect(trigger).toHaveProperty("textContent", "Mon, Thu");
  expect(trigger).toHaveProperty("ariaExpanded", "false");
  expect(document.activeElement).toBe(trigger);
  expect(save()).toHaveProperty("disabled", false);
});

it("uses the same empty table for the first schedule, accepts typed minutes and keyboard time suggestions", async () => {
  renderHours([]);
  expect(screen.getAllByRole("table")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Valid from"), { target: { value: "2026-11-01" } });
  fireEvent.click(screen.getByRole("button", { name: "Add interval" })); days(0, "Weekend");
  const opening = screen.getByLabelText("Opening time");
  fireEvent.focus(opening);
  expect(within(screen.getByRole("listbox", { name: "Opening time suggestions" })).getAllByRole("option")).toHaveLength(48);
  expect(screen.queryByRole("option", { name: "24:00" })).toBeNull();
  fireEvent.keyDown(opening, { key: "ArrowDown" }); fireEvent.keyDown(opening, { key: "Enter" });
  expect(opening).toHaveProperty("value", "00:30");
  time("Opening time", 0, "07:17");
  fireEvent.focus(screen.getByLabelText("Closing time"));
  fireEvent.click(screen.getByRole("option", { name: "24:00" }));
  fireEvent.submit(form());
  await waitFor(() => expect(mutateOpeningHoursAction).toHaveBeenCalledWith(expect.objectContaining({ operation: "create", adjustment: null,
    rows: [{ weekdays: [5, 6], opens_at: "07:17", closes_at: "24:00" }],
  })));
});

it("copies all current rows into a future schedule and previews the cutoff", async () => {
  renderHours([row(0, 420, 720), row(0, 780, 1320), row(6, 540, 1200)]);
  fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
  expect(screen.getAllByLabelText("Opening time").map((input) => (input as HTMLInputElement).value)).toEqual(["07:00", "13:00", "09:00"]);
  expect(save()).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Valid from"), { target: { value: "2026-10-31" } });
  expect(screen.getByRole("status").textContent).toContain("on 2026-10-30");
  fireEvent.click(save());
  await waitFor(() => expect(mutateOpeningHoursAction).toHaveBeenCalledWith(expect.objectContaining({
    operation: "create", replace_ids: [], adjustment: { id: schedule.id, revision: 1 }, starts_on: "2026-10-31",
  })));
});

it("validates row-specific times/days, overlaps only on shared days, and date bounds before submission", () => {
  renderHours([row(0, 420, 720)]);
  time("Closing time", 0, "bad");
  expect(screen.getByRole("alert").textContent).toContain("Interval 1");
  expect(save()).toHaveProperty("disabled", true);
  time("Closing time", 0, "12:00");
  fireEvent.click(screen.getByRole("button", { name: "Add interval" }));
  expect(screen.getAllByRole("alert").some((error) => error.textContent?.includes("Select at least one day"))).toBe(true);
  time("Opening time", 1, "11:00"); time("Closing time", 1, "13:00"); days(1, "Weekend");
  expect(save()).toHaveProperty("disabled", false);
  days(1, "All days");
  expect(screen.getByRole("alert").textContent).toContain("Monday intervals cannot overlap");
  fireEvent.submit(form()); expect(mutateOpeningHoursAction).not.toHaveBeenCalled();
  time("Opening time", 1, "12:00");
  expect(save()).toHaveProperty("disabled", false);
  fireEvent.change(screen.getByLabelText("Valid until (optional)"), { target: { value: "2025-12-31" } });
  expect(screen.getByRole("alert").textContent).toContain("on or after");
});

it.each(["stale", "failure", "overlap"])("retains all entered values after %s and prevents duplicate pending submissions", async (failure) => {
  let complete!: (value: object) => void;
  mutateOpeningHoursAction.mockReturnValueOnce(new Promise((resolve, reject) => {
    complete = failure === "failure" ? () => reject(new Error("Failure")) : resolve;
  }));
  renderHours(); time("Opening time", 0, "08:00");
  fireEvent.submit(form()); fireEvent.submit(form());
  expect(mutateOpeningHoursAction).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
  complete({ ok: false, reason: failure, weekdays: [0] });
  await expectToast();
  expect(screen.getByLabelText("Opening time")).toHaveProperty("value", "08:00");
  expect(save()).toHaveProperty("disabled", false);
  expect(toast.success).not.toHaveBeenCalled(); expect(onUpdated).not.toHaveBeenCalled();
});

it("uses authoritative mutation results across equivalent server rerenders and reload", async () => {
  const original = [row(0)]; const saved = [row(0, 480)];
  const view = render(<LocationOpeningHours locationId={locationId} intervals={original} schedules={[schedule]} today="2026-10-10" />);
  time("Opening time", 0, "08:00"); fireEvent.click(save());
  await waitFor(() => expect(toast.success).toHaveBeenCalledOnce());
  expect(save()).toHaveProperty("disabled", true); expect(refresh).toHaveBeenCalledOnce();
  view.rerender(<LocationOpeningHours locationId={locationId} intervals={original.map((h) => ({ ...h }))} schedules={[schedule]} today="2026-10-10" />);
  expect(screen.getByLabelText("Opening time")).toHaveProperty("value", "08:00");
  view.unmount();
  render(<LocationOpeningHours locationId={locationId} intervals={saved} schedules={[{ ...schedule, revision: 2 }]} today="2026-10-10" />);
  expect(save()).toHaveProperty("disabled", true);
});

it("retains a dirty revision on refresh, then loads latest persisted hours on cancel", async () => {
  const view = render(<LocationOpeningHours locationId={locationId} intervals={[row(0)]} schedules={[schedule]} today="2026-10-10" />);
  time("Opening time", 0, "08:00");
  view.rerender(<LocationOpeningHours locationId={locationId} intervals={[row(0, 540)]} schedules={[{ ...schedule, revision: 2 }]} today="2026-10-10" />);
  mutateOpeningHoursAction.mockResolvedValueOnce({ ok: false, reason: "stale" });
  fireEvent.click(save()); await expectToast();
  expect(mutateOpeningHoursAction.mock.calls[0][0]).toMatchObject({ revision: 1, replace_ids: [row(0).id] });
  expect(screen.getByLabelText("Opening time")).toHaveProperty("value", "08:00");
  fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
  expect(screen.getByLabelText("Opening time")).toHaveProperty("value", "09:00");
});

it("protects dirty drafts when selecting scheduled policies or History; expired hours are read-only", () => {
  const expired = { ...schedule, id: "c6000000-0000-4000-8000-000000000097", starts_on: "2025-01-01", ends_on: "2025-12-31" };
  render(<ProfileUnsavedChanges onDeparture={() => {}}><OpeningHours locationId={locationId} schedules={[expired, schedule, future]}
    today="2026-10-10" intervals={[row(0), { ...row(0, 540), schedule_id: expired.id }]} onUpdated={onUpdated} /></ProfileUnsavedChanges>);
  expect(screen.getByLabelText("Current/Scheduled schedule")).toHaveProperty("value", schedule.id);
  time("Opening time", 0, "08:00");
  fireEvent.change(screen.getByLabelText("Current/Scheduled schedule"), { target: { value: future.id } });
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.getByLabelText("Valid from")).toHaveProperty("value", future.starts_on);
  fireEvent.change(screen.getByLabelText("Valid until (optional)"), { target: { value: "2027-12-31" } });
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.getByLabelText("Opening time")).toHaveProperty("disabled", true);
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  expect(mutateOpeningHoursAction).not.toHaveBeenCalled();
});

it("rejects ambiguous future overlaps and retains the original cutoff preview across refresh", async () => {
  const view = render(<OpeningHours locationId={locationId} intervals={[row(0)]} schedules={[schedule]} today="2026-10-10" onUpdated={onUpdated} />);
  fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
  fireEvent.change(screen.getByLabelText("Valid from"), { target: { value: "2026-11-01" } });
  view.rerender(<OpeningHours locationId={locationId} intervals={[row(0, 540)]} schedules={[{ ...schedule, revision: 2 }, future]} today="2026-10-10" onUpdated={onUpdated} />);
  fireEvent.click(save());
  await waitFor(() => expect(mutateOpeningHoursAction).toHaveBeenCalledWith(expect.objectContaining({ adjustment: { id: schedule.id, revision: 1 } })));
  fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
  fireEvent.change(screen.getByLabelText("Valid from"), { target: { value: "2026-11-01" } });
  expect(screen.getByRole("alert").textContent).toContain("scheduled future policies");
  expect(save()).toHaveProperty("disabled", true);
});
