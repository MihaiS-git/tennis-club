// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CoachAvailabilityView } from "@/lib/coaching/availability";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/coach/availability" }));

import { AvailabilityManager } from "@/components/coach-availability/availability-manager";

const east = { id: "b1000000-0000-4000-8000-000000000001", name: "East Club", timezone: "Europe/Bucharest", is_active: true, archived: false };
const old = { id: "b1000000-0000-4000-8000-000000000002", name: "Old Club", timezone: "UTC", is_active: false, archived: true };
const view: CoachAvailabilityView = {
  coach: { user_id: "c1000000-0000-4000-8000-00000000000a", display_name: "Ana Pop", ineligibility: null },
  locations: [east, old],
  weekly: [
    { id: "d1000000-0000-4000-8000-000000000001", location_id: east.id, weekday: 0, start_minute: 540, end_minute: 720 },
    { id: "d1000000-0000-4000-8000-000000000002", location_id: east.id, weekday: 0, start_minute: 900, end_minute: 1140 },
  ],
  exceptions: [
    { id: "e1000000-0000-4000-8000-000000000001", date: "2099-06-01", kind: "unavailable", location_id: null, start_minute: null, end_minute: null, note: "Vacation" },
    { id: "e1000000-0000-4000-8000-000000000002", date: "2000-01-03", kind: "available", location_id: east.id, start_minute: 1080, end_minute: 1200, note: "" },
  ],
  today: "2099-05-01", horizon: "2100-05-02",
};

beforeEach(() => { vi.clearAllMocks(); installDialogMock(); });
afterEach(cleanup);

it("shows assigned locations, a compact weekly schedule and upcoming exceptions", () => {
  render(<AvailabilityManager view={view} action={vi.fn()} />);
  expect(screen.getByText("Old Club (archived)")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Monday working hours" })).getAllByRole("button").map((button) => button.textContent))
    .toEqual(["09:00–12:00East Club", "15:00–19:00East Club"]);
  expect(screen.getAllByText("Not available")).toHaveLength(6);
  const rows = within(screen.getByRole("table", { name: "Upcoming date exceptions" })).getAllByRole("row");
  expect(rows[1].textContent).toContain("Whole day");
  expect(rows[1].textContent).toContain("All locations");
  expect(screen.getByText("Past exceptions (1)")).toBeTruthy();
});

function openAddDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Add working hours" }));
  return screen.getByRole("dialog", { name: "Add working hours" });
}

function fillAddDialog(dialog: HTMLElement, days: string[], from: string, until: string) {
  for (const day of days) fireEvent.click(within(dialog).getByRole("checkbox", { name: day }));
  fireEvent.change(within(dialog).getByRole("combobox", { name: "From" }), { target: { value: from } });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Until" }), { target: { value: until } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
}

it("offers one Add working hours action instead of per-day buttons", () => {
  render(<AvailabilityManager view={view} action={vi.fn()} />);
  expect(screen.getAllByRole("button", { name: /^Add/ }).map((button) => button.textContent)).toEqual(["Add working hours", "Add exception"]);
  const dialog = openAddDialog();
  expect(within(dialog).getAllByRole("checkbox").map((box) => [box.parentElement?.textContent, (box as HTMLInputElement).checked]))
    .toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => [day, false]));
  expect(within(dialog).queryByRole("combobox", { name: "Day" })).toBeNull();
  const location = within(dialog).getByRole("combobox", { name: "Location" }) as HTMLSelectElement;
  expect([...location.options].filter((option) => !option.disabled).map((option) => option.text)).toEqual(["East Club"]);
});

it("adds one interval to an arbitrary, non-consecutive combination of weekdays in one save", async () => {
  const action = vi.fn().mockResolvedValue({ ok: true, id: "d1000000-0000-4000-8000-000000000003", ids: ["a", "b", "c"] });
  render(<AvailabilityManager view={view} action={action} />);
  fillAddDialog(openAddDialog(), ["Sunday", "Tuesday", "Thursday"], "600", "840");
  await waitFor(() => expect(action).toHaveBeenCalledWith({ operation: "add-weekly",
    fields: { location_id: east.id, weekdays: [1, 3, 6], start_minute: 600, end_minute: 840 } }));
  expect(action).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  expect(screen.queryByRole("dialog", { name: "Add working hours" })).toBeNull();
});

it("adds a single day through the same dialog", async () => {
  const action = vi.fn().mockResolvedValue({ ok: true, id: "d1000000-0000-4000-8000-000000000003", ids: ["d1000000-0000-4000-8000-000000000003"] });
  render(<AvailabilityManager view={view} action={action} />);
  fillAddDialog(openAddDialog(), ["Saturday"], "480", "600");
  await waitFor(() => expect(action).toHaveBeenCalledWith({ operation: "add-weekly",
    fields: { location_id: east.id, weekdays: [5], start_minute: 480, end_minute: 600 } }));
});

it("names conflicting days, saves nothing and keeps the inputs", async () => {
  const action = vi.fn()
    .mockResolvedValueOnce({ ok: false, reason: "invalid-input", fieldErrors: { weekdays: "Select at least one day." } })
    .mockResolvedValueOnce({ ok: false, reason: "overlap", weekdays: [0, 2] });
  render(<AvailabilityManager view={view} action={action} />);
  const dialog = openAddDialog();
  fillAddDialog(dialog, [], "600", "840");
  await waitFor(() => expect(within(dialog).getByText("Select at least one day.")).toBeTruthy());
  fillAddDialog(dialog, ["Monday", "Wednesday", "Friday"], "600", "840");
  await waitFor(() => expect(within(dialog).getByText("This overlaps existing availability on Monday, Wednesday. Nothing was saved.")).toBeTruthy());
  expect(action).toHaveBeenLastCalledWith(expect.objectContaining({ fields: expect.objectContaining({ weekdays: [0, 2, 4] }) }));
  expect(within(dialog).getAllByRole("checkbox").map((box) => (box as HTMLInputElement).checked)).toEqual([true, false, true, false, true, false, false]);
  expect((within(dialog).getByRole("combobox", { name: "From" }) as HTMLSelectElement).value).toBe("600");
  expect((within(dialog).getByRole("combobox", { name: "Until" }) as HTMLSelectElement).value).toBe("840");
  expect(router.refresh).not.toHaveBeenCalled();
});

it("edits an existing block on its own day", async () => {
  const action = vi.fn().mockResolvedValue({ ok: true, id: view.weekly[1].id });
  render(<AvailabilityManager view={view} action={action} />);
  fireEvent.click(screen.getByRole("button", { name: /^15:00–19:00/ }));
  const dialog = screen.getByRole("dialog", { name: "Edit working hours" });
  expect(within(dialog).queryByRole("checkbox")).toBeNull();
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Day" }), { target: { value: "2" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(action).toHaveBeenCalledWith({ operation: "save-weekly", id: view.weekly[1].id,
    fields: { location_id: east.id, weekday: 2, start_minute: 900, end_minute: 1140 } }));
});

it("shows a server overlap rejection inside the dialog", async () => {
  const action = vi.fn().mockResolvedValue({ ok: false, reason: "overlap" });
  render(<AvailabilityManager view={view} action={action} />);
  fireEvent.click(screen.getByRole("button", { name: /^09:00–12:00/ }));
  const dialog = screen.getByRole("dialog", { name: "Edit working hours" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(within(dialog).getByText(/overlaps other availability/)).toBeTruthy());
  expect(action).toHaveBeenCalledWith(expect.objectContaining({ operation: "save-weekly", id: view.weekly[0].id }));
  expect(router.refresh).not.toHaveBeenCalled();
});

it("saves additional hours with a location, and whole-day absences without one", async () => {
  const action = vi.fn().mockResolvedValue({ ok: true, id: "e1000000-0000-4000-8000-000000000003" });
  render(<AvailabilityManager view={view} action={action} />);
  fireEvent.click(screen.getByRole("button", { name: "Add exception" }));
  let dialog = screen.getByRole("dialog", { name: "Add date exception" });
  fireEvent.change(within(dialog).getByLabelText("Date"), { target: { value: "2099-06-10" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(action).toHaveBeenLastCalledWith({ operation: "save-exception", fields: {
    date: "2099-06-10", kind: "unavailable", location_id: null, start_minute: null, end_minute: null, note: "" } }));
  fireEvent.click(screen.getByRole("button", { name: "Add exception" }));
  dialog = screen.getByRole("dialog", { name: "Add date exception" });
  fireEvent.change(within(dialog).getByLabelText("Date"), { target: { value: "2099-06-11" } });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Type" }), { target: { value: "available" } });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "From" }), { target: { value: "1080" } });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Until" }), { target: { value: "1200" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(action).toHaveBeenLastCalledWith({ operation: "save-exception", fields: {
    date: "2099-06-11", kind: "available", location_id: east.id, start_minute: 1080, end_minute: 1200, note: "" } }));
});

it("is read-only for an ineligible coach except for removal", async () => {
  const action = vi.fn().mockResolvedValue({ ok: true, id: view.weekly[0].id });
  render(<AvailabilityManager view={view} action={action} readOnly />);
  expect(screen.queryByRole("button", { name: /^Add/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^09:00–12:00/ }));
  const dialog = screen.getByRole("dialog", { name: "Edit working hours" });
  expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Remove working hours" })).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(action).toHaveBeenCalledWith({ operation: "remove-weekly", id: view.weekly[0].id }));
});
