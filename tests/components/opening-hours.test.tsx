// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpeningInterval } from "../../src/lib/admin/opening-hours-validation";
const { mutateOpeningHoursAction, checkOpeningHoursRemovalAction, refresh, onUpdated, success } = vi.hoisted(() => ({
  mutateOpeningHoursAction: vi.fn(), checkOpeningHoursRemovalAction: vi.fn(), refresh: vi.fn(), onUpdated: vi.fn(), success: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success } }));
vi.mock("../../src/app/admin/locations/opening-hours-actions", () => ({ mutateOpeningHoursAction, checkOpeningHoursRemovalAction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
import { OpeningHours } from "../../src/app/admin/locations/opening-hours";
import { LocationOpeningHours } from "../../src/app/admin/locations/location-opening-hours";
import { ProfileUnsavedChanges } from "../../src/app/profile/unsaved-changes";

const locationId = "c6000000-0000-4000-8000-000000000011";
const row = (weekday: number, opens_at_minute = 420, closes_at_minute = 1440): OpeningInterval => ({
  id: `c6000000-0000-4000-8000-${String(weekday * 10000 + opens_at_minute).padStart(12, "0")}`,
  location_id: locationId, weekday, opens_at_minute, closes_at_minute,
  created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z",
});
const renderHours = (intervals: OpeningInterval[] = []) => render(<OpeningHours locationId={locationId} intervals={intervals} onUpdated={onUpdated} />);
beforeEach(() => { vi.resetAllMocks(); mutateOpeningHoursAction.mockResolvedValue({ ok: true, intervals: [] });
  checkOpeningHoursRemovalAction.mockResolvedValue({ ok: true, intervals: [] });
  installDialogMock();
});
afterEach(cleanup);

it("offers mouse-selectable half-hour suggestions and permits manually typed HH:mm", async () => {
  renderHours();
  fireEvent.click(screen.getByRole("button", { name: "Weekend" }));
  const opening = screen.getByLabelText("Opening time") as HTMLInputElement;
  const closing = screen.getByLabelText("Closing time") as HTMLInputElement;
  fireEvent.focus(opening);
  expect(screen.getByRole("option", { name: "07:30" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "24:00" })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "07:30" }));
  expect(opening.value).toBe("07:30");
  fireEvent.focus(closing);
  expect(screen.getByRole("option", { name: "24:00" })).toBeTruthy();
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

it("balances the schedule and editor on desktop and stacks them on mobile with compact time inputs", () => {
  renderHours([row(0)]);
  const schedule = screen.getByRole("list", { name: "Current weekly schedule" });
  const editor = screen.getByRole("form", { name: "Opening hours editor" });
  expect(editor.parentElement).toBe(schedule.parentElement?.parentElement);
  expect(editor.parentElement?.className).toContain("grid-cols-1");
  expect(editor.parentElement?.className).toContain("lg:grid-cols-2");
  expect(screen.getByLabelText("Opening time").parentElement?.parentElement?.className).toBe("w-32");
  expect(editor.contains(screen.getByRole("button", { name: "Apply to selected days" }))).toBe(true);
});

it("offers alternatives for populated times, supports keyboard selection and 24:00", () => {
  renderHours([row(0, 420, 1320)]);
  fireEvent.click(screen.getByRole("button", { name: "Edit Mon 07:00–22:00" }));
  const opening = screen.getByLabelText("Opening time");
  fireEvent.focus(opening);
  expect(within(screen.getByRole("listbox", { name: "Opening time suggestions" })).getAllByRole("option")).toHaveLength(48);
  expect(opening).toHaveProperty("value", "07:00");
  fireEvent.keyDown(opening, { key: "ArrowDown" });
  fireEvent.keyDown(opening, { key: "Enter" });
  expect(opening).toHaveProperty("value", "07:30");
  const closing = screen.getByLabelText("Closing time");
  fireEvent.focus(closing);
  fireEvent.click(screen.getByRole("option", { name: "24:00" }));
  expect(closing).toHaveProperty("value", "24:00");
});

it("disables unchanged, invalid, overlapping and incomplete drafts, including direct form submission", () => {
  renderHours([row(0, 420, 1320)]);
  fireEvent.click(screen.getByRole("button", { name: "Edit Mon 07:00–22:00" }));
  const apply = screen.getByRole("button", { name: "Apply changes to selected days" });
  expect(apply).toHaveProperty("disabled", true);
  fireEvent.submit(apply.closest("form")!);
  expect(mutateOpeningHoursAction).not.toHaveBeenCalled();
  for (const value of ["bad", "06:00", "07:00", ""]) {
    fireEvent.change(screen.getByLabelText("Closing time"), { target: { value } });
    expect(apply).toHaveProperty("disabled", true);
  }
  fireEvent.change(screen.getByLabelText("Closing time"), { target: { value: "23:00" } });
  expect(apply).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: "Add interval" }));
  expect(apply).toHaveProperty("disabled", true);
  fireEvent.change(screen.getAllByLabelText("Opening time")[1], { target: { value: "22:00" } });
  fireEvent.change(screen.getAllByLabelText("Closing time")[1], { target: { value: "24:00" } });
  expect(apply).toHaveProperty("disabled", true);
  fireEvent.change(screen.getAllByLabelText("Opening time")[1], { target: { value: "23:00" } });
  expect(apply).toHaveProperty("disabled", false);
});

it("uses committed intervals through equivalent server rerenders, authoritative refresh, reload and reopen", async () => {
  const original = [row(0, 420, 1320)];
  const saved = [{ ...row(0, 480, 1380), updated_at: "2026-10-09T00:00:00Z" }];
  mutateOpeningHoursAction.mockResolvedValue({ ok: true, intervals: saved });
  const view = render(<LocationOpeningHours locationId={locationId} intervals={original} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Mon 07:00–22:00" }));
  fireEvent.change(screen.getByLabelText("Opening time"), { target: { value: "08:00" } });
  fireEvent.change(screen.getByLabelText("Closing time"), { target: { value: "23:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply changes to selected days" }));
  await screen.findByRole("button", { name: "Edit Mon 08:00–23:00" });
  expect(success).toHaveBeenCalledExactlyOnceWith("Opening hours updated.");
  expect(refresh).toHaveBeenCalledOnce();
  // A newly deserialized, unchanged source must not resurrect pre-save values.
  view.rerender(<LocationOpeningHours locationId={locationId} intervals={original.map((interval) => ({ ...interval }))} />);
  expect(screen.queryByRole("button", { name: "Edit Mon 07:00–22:00" })).toBeNull();
  view.rerender(<LocationOpeningHours locationId={locationId} intervals={saved} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Mon 08:00–23:00" }));
  expect(screen.getByLabelText("Opening time")).toHaveProperty("value", "08:00");
  expect(screen.getByLabelText("Closing time")).toHaveProperty("value", "23:00");
  expect(screen.getByRole("button", { name: "Apply changes to selected days" })).toHaveProperty("disabled", true);
  view.unmount();
  render(<LocationOpeningHours locationId={locationId} intervals={saved} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Mon 08:00–23:00" }));
  expect(screen.getByLabelText("Opening time")).toHaveProperty("value", "08:00");
});

it.each(["rejected", "failed", "unchanged"])("preserves a %s draft without a success toast and permits retry", async (failure) => {
  if (failure === "failed") mutateOpeningHoursAction.mockRejectedValueOnce(new Error("Persistence failed"));
  else mutateOpeningHoursAction.mockResolvedValueOnce(failure === "unchanged" ? { ok: false, reason: "unchanged" }
    : { ok: false, reason: "overlap", weekdays: [0] });
  render(<ProfileUnsavedChanges onDeparture={() => {}}>
    <OpeningHours locationId={locationId} intervals={[row(0, 420, 1320)]} onUpdated={onUpdated} />
  </ProfileUnsavedChanges>);
  const isDirty = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  fireEvent.click(screen.getByRole("button", { name: "Edit Mon 07:00–22:00" }));
  fireEvent.change(screen.getByLabelText("Opening time"), { target: { value: "08:00" } });
  const apply = screen.getByRole("button", { name: "Apply changes to selected days" });
  fireEvent.click(apply);
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Opening time")).toHaveProperty("value", "08:00");
  expect(success).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(apply).toHaveProperty("disabled", false);
  expect(isDirty()).toBe(true);
  fireEvent.click(apply);
  await waitFor(() => expect(success).toHaveBeenCalledOnce());
  expect(mutateOpeningHoursAction).toHaveBeenCalledTimes(2);
  expect(isDirty()).toBe(false);
});

it("disables a day-only edit that would leave the saved schedule unchanged", () => {
  renderHours([row(0, 420, 1320), row(1, 420, 1320)]);
  fireEvent.click(screen.getByRole("button", { name: "Edit Mon, Tue 07:00–22:00" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Tue" }));
  expect(screen.getByRole("button", { name: "Apply changes to selected days" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Wed" }));
  expect(screen.getByRole("button", { name: "Apply changes to selected days" })).toHaveProperty("disabled", false);
});

it("blocks duplicate submission while persistence is pending", async () => {
  let complete!: (result: { ok: true; intervals: OpeningInterval[] }) => void;
  mutateOpeningHoursAction.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  renderHours([row(0, 420, 1320)]);
  fireEvent.click(screen.getByRole("button", { name: "Edit Mon 07:00–22:00" }));
  fireEvent.change(screen.getByLabelText("Opening time"), { target: { value: "08:00" } });
  const form = screen.getByRole("form", { name: "Opening hours editor" });
  fireEvent.submit(form); fireEvent.submit(form);
  expect(mutateOpeningHoursAction).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
  expect(success).not.toHaveBeenCalled();
  complete({ ok: true, intervals: [row(0, 480, 1320)] });
  await waitFor(() => expect(success).toHaveBeenCalledOnce());
});

const pricingConflict = {
  ok: false, reason: "pricing-conflict", message: "These opening hours conflict with existing pricing on Monday (10:00–14:00).",
  conflicts: [{ id: "rule-1", rule_set_id: "set-1", court_name: "Centre Court", court_state: "outdoor", weekday: 0,
    starts_at_minute: 600, ends_at_minute: 840, starts_on: null, ends_on: null }],
};

it("checks dependencies before enabling deletion and shows success only after persistence", async () => {
  let complete!: (result: { ok: true; intervals: OpeningInterval[] }) => void;
  mutateOpeningHoursAction.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  render(<LocationOpeningHours locationId={locationId} intervals={[row(0, 420, 1320)]} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove Mon 07:00–22:00" }));
  const remove = screen.getByRole("button", { name: "Remove hours" });
  expect(remove).toHaveProperty("disabled", true);
  await waitFor(() => expect(remove).toHaveProperty("disabled", false));
  expect(checkOpeningHoursRemovalAction).toHaveBeenCalledExactlyOnceWith({ location_id: locationId, weekdays: [0],
    replace_ids: [row(0, 420, 1320).id], intervals: [] });
  expect(mutateOpeningHoursAction).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
  fireEvent.click(remove);
  expect(mutateOpeningHoursAction).toHaveBeenCalledExactlyOnceWith({ location_id: locationId, weekdays: [0],
    replace_ids: [row(0, 420, 1320).id], intervals: [] });
  expect(success).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Edit Mon 07:00–22:00" })).toBeTruthy();
  complete({ ok: true, intervals: [] });
  await waitFor(() => expect(success).toHaveBeenCalledExactlyOnceWith("Opening hours updated."));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit Mon 07:00–22:00" })).toBeNull();
  expect(refresh).toHaveBeenCalledOnce();
});

it("identifies conflicting rules, disables deletion and links to this location's Pricing tab", async () => {
  checkOpeningHoursRemovalAction.mockResolvedValue(pricingConflict);
  renderHours([row(0, 420, 1320)]);
  fireEvent.click(screen.getByRole("button", { name: "Remove Mon 07:00–22:00" }));
  const conflicts = await screen.findByRole("list", { name: "Conflicting pricing rules" });
  expect(conflicts.textContent).toContain("Centre Court · Outdoor · Monday · 10:00–14:00");
  expect(screen.getByText(/Update or remove the affected pricing rules/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove hours" })).toHaveProperty("disabled", true);
  const manage = screen.getByRole("link", { name: "Manage conflicting pricing" });
  expect(manage.getAttribute("href")).toBe(`/admin/locations/${locationId}?tab=pricing`);
  fireEvent.click(screen.getByRole("button", { name: "Remove hours" }));
  expect(mutateOpeningHoursAction).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
  fireEvent.click(manage);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("permits deletion after conflicting pricing has been resolved and checked again", async () => {
  checkOpeningHoursRemovalAction.mockResolvedValueOnce(pricingConflict).mockResolvedValueOnce({ ok: true, intervals: [row(0)] });
  renderHours([row(0, 420, 1320)]);
  fireEvent.click(screen.getByRole("button", { name: "Remove Mon 07:00–22:00" }));
  await screen.findByRole("list", { name: "Conflicting pricing rules" });
  fireEvent.click(screen.getByRole("button", { name: "Check dependencies again" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Remove hours" })).toHaveProperty("disabled", false));
  expect(screen.queryByRole("list", { name: "Conflicting pricing rules" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove hours" }));
  await waitFor(() => expect(success).toHaveBeenCalledOnce());
});

it.each(["dependency failure", "persistence failure", "new conflict"])("preserves the schedule without success after %s", async (failure) => {
  if (failure === "dependency failure") checkOpeningHoursRemovalAction.mockRejectedValueOnce(new Error("Read failed"));
  else if (failure === "persistence failure") mutateOpeningHoursAction.mockRejectedValueOnce(new Error("Delete failed"));
  else mutateOpeningHoursAction.mockResolvedValueOnce(pricingConflict);
  renderHours([row(0, 420, 1320)]);
  fireEvent.click(screen.getByRole("button", { name: "Remove Mon 07:00–22:00" }));
  if (failure !== "dependency failure") {
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove hours" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Remove hours" }));
  }
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Edit Mon 07:00–22:00" })).toBeTruthy();
  expect(onUpdated).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  if (failure !== "persistence failure") expect(screen.getByRole("button", { name: "Remove hours" })).toHaveProperty("disabled", true);
  if (failure === "new conflict") expect(screen.getByRole("list", { name: "Conflicting pricing rules" })).toBeTruthy();
});
