// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CoachAvailabilityLocation, CoachAvailabilityView } from "@/lib/coaching/availability";

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/coach/availability" }));

import { AvailabilityManager } from "@/components/coach-availability/availability-manager";

const weekdayHours = [0, 1, 2, 3, 4].map((weekday) => ({ weekday, opens_at_minute: 480, closes_at_minute: 1320 }));
// Current schedule: Mon–Fri 08:00–22:00, Saturday 09:00–21:00, Sunday closed; a later summer schedule follows.
const east: CoachAvailabilityLocation = { id: "b1000000-0000-4000-8000-000000000001", name: "East Club", timezone: "Europe/Bucharest", is_active: true, archived: false,
  today: "2099-05-01", opening_hours: [
    { starts_on: "2099-01-01", ends_on: "2099-06-30", status: "current", intervals: [...weekdayHours, { weekday: 5, opens_at_minute: 540, closes_at_minute: 1260 }] },
    { starts_on: "2099-07-01", ends_on: null, status: "scheduled", intervals: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at_minute: 420, closes_at_minute: 1380 })) },
  ] };
const old: CoachAvailabilityLocation = { id: "b1000000-0000-4000-8000-000000000002", name: "Old Club", timezone: "UTC", is_active: false, archived: true,
  today: "2099-05-01", opening_hours: [] };
const view: CoachAvailabilityView = {
  coach: { user_id: "c1000000-0000-4000-8000-00000000000a", display_name: "Ana Pop", ineligibility: null },
  locations: [east, old],
  weekly: [
    { id: "d1000000-0000-4000-8000-000000000001", location_id: east.id, weekday: 0, start_minute: 540, end_minute: 720, valid_from: "2099-01-01", valid_until: null },
    { id: "d1000000-0000-4000-8000-000000000002", location_id: east.id, weekday: 0, start_minute: 900, end_minute: 1140, valid_from: "2099-01-01", valid_until: null },
  ],
  exceptions: [
    { id: "e1000000-0000-4000-8000-000000000001", date: "2099-06-01", until_date: "2099-06-01", kind: "unavailable", location_id: null, start_minute: null, end_minute: null, note: "Vacation" },
    { id: "e1000000-0000-4000-8000-000000000002", date: "2000-01-03", until_date: "2000-01-03", kind: "available", location_id: east.id, start_minute: 1080, end_minute: 1200, note: "" },
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

function openAddDialog(selectLocation = true) {
  fireEvent.click(screen.getByRole("button", { name: "Add working hours" }));
  const dialog = screen.getByRole("dialog", { name: "Add working hours" });
  if (selectLocation) fireEvent.change(within(dialog).getByRole("combobox", { name: "Location" }), { target: { value: east.id } });
  return dialog;
}

function fillAddDialog(dialog: HTMLElement, days: string[], from: string, until: string) {
  for (const day of days) fireEvent.click(within(dialog).getByRole("checkbox", { name: day }));
  fireEvent.change(within(dialog).getByRole("combobox", { name: "From" }), { target: { value: from } });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Until" }), { target: { value: until } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
}

it("adds and displays both weekday intervals around the location's lunch break", async () => {
  const weekdays = [0, 1, 2, 3, 4];
  const location: CoachAvailabilityLocation = { ...east, opening_hours: [{ starts_on: "2099-01-01", ends_on: null,
    status: "current", intervals: weekdays.flatMap((weekday) => [
      { weekday, opens_at_minute: 480, closes_at_minute: 720 },
      { weekday, opens_at_minute: 840, closes_at_minute: 1260 },
    ]) }] };
  const action = vi.fn().mockResolvedValue({ ok: true, id: "saved" });
  const schedule = { ...view, locations: [location], weekly: [] };
  const { rerender } = render(<AvailabilityManager view={schedule} action={action} />);
  const intervals = weekdays.flatMap((weekday) => [480, 840].map((start_minute) => ({
    id: `${weekday}-${start_minute}`, location_id: east.id, weekday, start_minute,
    end_minute: start_minute === 480 ? 720 : 1260, valid_from: east.today, valid_until: null,
  })));
  for (const [start, end] of [[480, 720], [840, 1260]]) {
    const dialog = openAddDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Weekdays" }));
    fillAddDialog(dialog, [], String(start), String(end));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add working hours" })).toBeNull());
    expect(action).toHaveBeenLastCalledWith({ operation: "add-weekly", fields: {
      location_id: east.id, weekdays, start_minute: start, end_minute: end, valid_from: east.today, valid_until: null,
    } });
    rerender(<AvailabilityManager view={{ ...schedule, weekly: intervals.filter((row) => row.start_minute <= start) }} action={action} />);
  }
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
    expect(within(screen.getByRole("list", { name: `${day} working hours` })).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["08:00–12:00East Club", "14:00–21:00East Club"]);
  }
  expect(action).toHaveBeenCalledTimes(2);
});

it("offers one Add working hours action instead of per-day buttons", () => {
  render(<AvailabilityManager view={view} action={vi.fn()} />);
  expect(screen.getAllByRole("button", { name: /^Add/ }).map((button) => button.textContent)).toEqual(["Add working hours", "Add time off", "Add extra availability"]);
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
  fillAddDialog(openAddDialog(), ["Saturday", "Tuesday", "Thursday"], "600", "840");
  await waitFor(() => expect(action).toHaveBeenCalledWith({ operation: "add-weekly",
    fields: { location_id: east.id, weekdays: [1, 3, 5], start_minute: 600, end_minute: 840, valid_from: "2099-05-01", valid_until: null } }));
  expect(action).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  expect(screen.queryByRole("dialog", { name: "Add working hours" })).toBeNull();
});

it("adds a single day through the same dialog", async () => {
  const action = vi.fn().mockResolvedValue({ ok: true, id: "d1000000-0000-4000-8000-000000000003", ids: ["d1000000-0000-4000-8000-000000000003"] });
  render(<AvailabilityManager view={view} action={action} />);
  fillAddDialog(openAddDialog(), ["Saturday"], "540", "660");
  await waitFor(() => expect(action).toHaveBeenCalledWith({ operation: "add-weekly",
    fields: { location_id: east.id, weekdays: [5], start_minute: 540, end_minute: 660, valid_from: "2099-05-01", valid_until: null } }));
});

it("names conflicting days, saves nothing and keeps the inputs", async () => {
  const action = vi.fn().mockResolvedValue({ ok: false, reason: "overlap", weekdays: [0, 2] });
  render(<AvailabilityManager view={view} action={action} />);
  const dialog = openAddDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  expect(within(dialog).getByText("Select at least one weekday.")).toBeTruthy();
  expect(action).not.toHaveBeenCalled();
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
    fields: { location_id: east.id, weekday: 2, start_minute: 900, end_minute: 1140, valid_from: "2099-01-01", valid_until: null } }));
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
  fireEvent.click(screen.getByRole("button", { name: "Add time off" }));
  let dialog = screen.getByRole("dialog", { name: "Add time off" });
  fireEvent.change(within(dialog).getByLabelText("From date"), { target: { value: "2099-06-10" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(action).toHaveBeenLastCalledWith({ operation: "save-exception", fields: {
    date: "2099-06-10", until_date: "2099-06-10", kind: "unavailable", location_id: null, start_minute: null, end_minute: null, note: "" } }));
  fireEvent.click(screen.getByRole("button", { name: "Add extra availability" }));
  dialog = screen.getByRole("dialog", { name: "Add extra availability" });
  fireEvent.change(within(dialog).getByLabelText("Date"), { target: { value: "2099-06-11" } });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "From" }), { target: { value: "1080" } });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Until" }), { target: { value: "1200" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(action).toHaveBeenLastCalledWith({ operation: "save-exception", fields: {
    date: "2099-06-11", until_date: "2099-06-11", kind: "available", location_id: east.id, start_minute: 1080, end_minute: 1200, note: "" } }));
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

it("submits a holiday as one inclusive period, forces whole days and keeps values on booking conflict", async () => {
  const action = vi.fn().mockResolvedValue({ ok: false, reason: "booking-conflict" });
  render(<AvailabilityManager view={view} action={action} />);
  fireEvent.click(screen.getByRole("button", { name: "Add time off" }));
  const dialog = screen.getByRole("dialog", { name: "Add time off" });
  fireEvent.change(within(dialog).getByLabelText("From date"), { target: { value: "2099-12-21" } });
  fireEvent.change(within(dialog).getByLabelText("Until date (inclusive)"), { target: { value: "2100-01-10" } });
  fireEvent.change(within(dialog).getByLabelText(/Note/), { target: { value: "Christmas holiday" } });
  expect((within(dialog).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  expect(within(dialog).queryByRole("combobox", { name: "From" })).toBeNull();
  expect(within(dialog).queryByRole("combobox", { name: "Type" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(action).toHaveBeenCalledExactlyOnceWith({ operation: "save-exception", fields: {
    date: "2099-12-21", until_date: "2100-01-10", kind: "unavailable", location_id: null,
    start_minute: null, end_minute: null, note: "Christmas holiday",
  } }));
  expect(await within(dialog).findByText(/conflicts with an existing coaching booking/)).toBeTruthy();
  expect((within(dialog).getByLabelText(/Note/) as HTMLInputElement).value).toBe("Christmas holiday");
  expect(router.refresh).not.toHaveBeenCalled();
});

it("displays, edits and removes an entire period", async () => {
  const period = { ...view.exceptions[0], until_date: "2099-06-21" };
  const action = vi.fn().mockResolvedValue({ ok: true, id: period.id });
  render(<AvailabilityManager view={{ ...view, exceptions: [period] }} action={action} />);
  expect(screen.getByText(/1 Jun 2099.*21 Jun 2099/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Edit exception/ }));
  const dialog = screen.getByRole("dialog", { name: "Edit time off" });
  fireEvent.change(within(dialog).getByLabelText("Until date (inclusive)"), { target: { value: "2099-06-22" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(action).toHaveBeenLastCalledWith(expect.objectContaining({ id: period.id, fields: expect.objectContaining({ until_date: "2099-06-22" }) })));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit time off" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: /^Edit exception/ }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Edit time off" })).getByRole("button", { name: "Remove" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Remove time off" })).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(action).toHaveBeenLastCalledWith({ operation: "remove-exception", id: period.id }));
});

function checkedDays(dialog: HTMLElement) {
  return within(dialog).getAllByRole("checkbox").filter((box) => (box as HTMLInputElement).checked).map((box) => box.parentElement?.textContent);
}

it("selects and clears weekday and weekend groups without touching the other group", () => {
  render(<AvailabilityManager view={view} action={vi.fn()} />);
  const dialog = openAddDialog();
  const weekdays = within(dialog).getByRole("button", { name: "Weekdays" });
  const weekend = within(dialog).getByRole("button", { name: "Weekend" });
  fireEvent.click(weekdays);
  expect(checkedDays(dialog)).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
  expect(weekdays.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(weekend);
  expect(checkedDays(dialog)).toHaveLength(7);
  fireEvent.click(weekdays);
  expect(checkedDays(dialog)).toEqual(["Saturday", "Sunday"]);
  expect(weekdays.getAttribute("aria-pressed")).toBe("false");
  expect(weekend.getAttribute("aria-pressed")).toBe("true");
});

it("completes a partly selected group and keeps individual days outside it", () => {
  render(<AvailabilityManager view={view} action={vi.fn()} />);
  const dialog = openAddDialog();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Tuesday" }));
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Sunday" }));
  expect(within(dialog).getByRole("button", { name: "Weekdays" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(within(dialog).getByRole("button", { name: "Weekdays" }));
  expect(checkedDays(dialog)).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Sunday"]);
  // An individual change after a group action stays synchronized with the group state.
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Wednesday" }));
  expect(within(dialog).getByRole("button", { name: "Weekdays" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(within(dialog).getByRole("button", { name: "Weekend" }));
  expect(checkedDays(dialog)).toEqual(["Monday", "Tuesday", "Thursday", "Friday", "Saturday", "Sunday"]);
});

it("submits a mixed group and individual selection as one multi-day save", async () => {
  const action = vi.fn().mockResolvedValue({ ok: true, id: "a", ids: ["a", "b", "c", "d", "e", "f"] });
  render(<AvailabilityManager view={view} action={action} />);
  const dialog = openAddDialog();
  fireEvent.click(within(dialog).getByRole("button", { name: "Weekdays" }));
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Wednesday" }));
  fillAddDialog(dialog, ["Saturday"], "600", "840");
  await waitFor(() => expect(action).toHaveBeenCalledWith({ operation: "add-weekly",
    fields: { location_id: east.id, weekdays: [0, 1, 3, 4, 5], start_minute: 600, end_minute: 840, valid_from: "2099-05-01", valid_until: null } }));
  expect(action).toHaveBeenCalledTimes(1);
});

it("shows the selected location's current and upcoming opening hours, with closed days", () => {
  render(<AvailabilityManager view={view} action={vi.fn()} />);
  const dialog = openAddDialog();
  const panel = within(dialog).getByRole("region", { name: "East Club opening hours" });
  expect(panel.textContent).toContain("Europe/Bucharest");
  expect(panel.textContent).toContain("Current schedule, until 30 Jun 2099");
  expect(panel.textContent).toContain("Mon–Fri08:00–22:00");
  expect(panel.textContent).toContain("Sat09:00–21:00");
  expect(panel.textContent).toContain("SunClosed");
  // The later schedule is labelled with its own period instead of being presented as current.
  expect(panel.textContent).toContain("From 1 Jul 2099Daily07:00–23:00");
  // Selected days narrow the panel to their individual hours, without another request.
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Saturday" }));
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Sunday" }));
  expect(panel.textContent).not.toContain("Mon–Fri");
  expect(panel.textContent).toContain("Sat09:00–21:00");
  expect(panel.textContent).toContain("SunClosed");
});

it("limits times to common hours and explains when a selected day has none", () => {
  const action = vi.fn();
  render(<AvailabilityManager view={view} action={action} />);
  const dialog = openAddDialog();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Friday" }));
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Saturday" }));
  expect(timeValues(dialog, "From")).not.toContain("510");
  expect(timeValues(dialog, "From")).toContain("540");
  fireEvent.change(timeSelect(dialog, "From"), { target: { value: "540" } });
  expect(timeValues(dialog, "Until")).toContain("1260");
  expect(timeValues(dialog, "Until")).not.toContain("1290");
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Sunday" }));
  expect(within(dialog).getByText("No common opening hours are available for the selected days and dates.")).toBeTruthy();
  expect(timeSelect(dialog, "From").value).toBe("");
  expect(timeSelect(dialog, "From").disabled).toBe(true);
  expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  expect(action).not.toHaveBeenCalled();
});

it("applies the opening hours of the chosen validity dates", async () => {
  const action = vi.fn().mockResolvedValue({ ok: true, id: "a", ids: ["a"] });
  render(<AvailabilityManager view={view} action={action} />);
  const dialog = openAddDialog();
  // Sunday is closed under the current schedule but open 07:00–23:00 from 1 July.
  fireEvent.change(within(dialog).getByLabelText("Valid from"), { target: { value: "2099-07-01" } });
  fireEvent.change(within(dialog).getByLabelText("Valid until (optional)"), { target: { value: "2099-08-31" } });
  fillAddDialog(dialog, ["Sunday"], "420", "1380");
  await waitFor(() => expect(action).toHaveBeenCalledWith({ operation: "add-weekly",
    fields: { location_id: east.id, weekdays: [6], start_minute: 420, end_minute: 1380, valid_from: "2099-07-01", valid_until: "2099-08-31" } }));
});

it("shows a server opening-hours rejection, keeps validity on chips and makes ended hours removable only", async () => {
  const action = vi.fn().mockResolvedValue({ ok: false, reason: "outside-opening-hours", weekdays: [0] });
  const dated = { ...view.weekly[0], id: "d1000000-0000-4000-8000-000000000005", weekday: 2, valid_from: "2099-07-01", valid_until: "2099-08-31" };
  const ended = { ...view.weekly[0], id: "d1000000-0000-4000-8000-000000000006", weekday: 3, valid_from: "2099-01-01", valid_until: "2099-04-30" };
  render(<AvailabilityManager view={{ ...view, weekly: [...view.weekly, dated, ended] }} action={action} />);
  expect(within(screen.getByRole("list", { name: "Wednesday working hours" })).getByRole("button").textContent).toContain("1 Jul 2099 – Mon, 31 Aug 2099");
  expect(screen.queryByRole("list", { name: "Thursday working hours" })).toBeNull();
  expect(screen.getByText("Ended working hours (1)")).toBeTruthy();
  fireEvent.click(within(screen.getByRole("list", { name: "Ended working hours" })).getByRole("button"));
  let dialog = screen.getByRole("dialog", { name: "Edit working hours" });
  expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
  expect(within(dialog).getByRole("button", { name: "Remove" })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
  fireEvent.click(within(screen.getByRole("list", { name: "Monday working hours" })).getByRole("button", { name: /^09:00–12:00/ }));
  dialog = screen.getByRole("dialog", { name: "Edit working hours" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  expect(await within(dialog).findByText(/Outside the location's opening hours on Monday/)).toBeTruthy();
  expect(router.refresh).not.toHaveBeenCalled();
});

it("states when a location has no configured opening hours, or none for today", () => {
  const noCurrent: CoachAvailabilityLocation = { ...east, id: "b1000000-0000-4000-8000-000000000003", name: "North Club", opening_hours: [east.opening_hours[1]] };
  const unconfigured: CoachAvailabilityLocation = { ...east, id: "b1000000-0000-4000-8000-000000000004", name: "South Club", opening_hours: [] };
  render(<AvailabilityManager view={{ ...view, locations: [noCurrent, unconfigured] }} action={vi.fn()} />);
  const dialog = openAddDialog(false);
  const location = within(dialog).getByRole("combobox", { name: "Location" });
  expect(within(dialog).queryByRole("region", { name: /opening hours/ })).toBeNull();
  fireEvent.change(location, { target: { value: noCurrent.id } });
  expect(within(dialog).getByRole("region", { name: "North Club opening hours" }).textContent).toContain("No opening hours apply on 1 May 2099.");
  fireEvent.change(location, { target: { value: unconfigured.id } });
  expect(within(dialog).getByRole("region", { name: "South Club opening hours" }).textContent).toContain("Opening hours are not configured for this location.");
});

function timeSelect(dialog: HTMLElement, name: "From" | "Until") {
  return within(dialog).getByRole("combobox", { name }) as HTMLSelectElement;
}
function timeValues(dialog: HTMLElement, name: "From" | "Until") {
  return [...timeSelect(dialog, name).options].filter((option) => !option.disabled).map((option) => option.value);
}
const riverside: CoachAvailabilityLocation = { ...east, id: "b1000000-0000-4000-8000-000000000003", name: "Riverside Club",
  opening_hours: [{ starts_on: "2099-01-01", ends_on: null, status: "current", intervals: [0, 1, 2, 3, 4].flatMap((weekday) => [
    { weekday, opens_at_minute: 480, closes_at_minute: 720 }, { weekday, opens_at_minute: 840, closes_at_minute: 1260 },
  ]) }] };

it("requires an explicit location, weekdays and valid dates before enabling time inputs", () => {
  render(<AvailabilityManager view={view} action={vi.fn()} />);
  const dialog = openAddDialog(false);
  const location = within(dialog).getByRole("combobox", { name: "Location" }) as HTMLSelectElement;
  expect(location.value).toBe(""); // Even with only one current location.
  expect(timeSelect(dialog, "From").disabled).toBe(true);
  expect(timeSelect(dialog, "Until").disabled).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  expect(within(dialog).getByText("Select a location.")).toBeTruthy();
  expect(within(dialog).getByText("Select at least one weekday.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Monday" }));
  expect(timeSelect(dialog, "From").disabled).toBe(true);
  fireEvent.change(location, { target: { value: east.id } });
  expect(timeSelect(dialog, "From").disabled).toBe(false);
  expect(timeSelect(dialog, "Until").disabled).toBe(true);
  fireEvent.change(within(dialog).getByLabelText("Valid from"), { target: { value: "" } });
  expect(timeSelect(dialog, "From").disabled).toBe(true);
  expect(within(dialog).getByText("Select a valid start date.")).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText("Valid from"), { target: { value: "2099-06-01" } });
  fireEvent.change(within(dialog).getByLabelText("Valid until (optional)"), { target: { value: "2099-05-31" } });
  expect(timeSelect(dialog, "From").disabled).toBe(true);
  expect(within(dialog).getByText("Valid until must be on or after Valid from.")).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText("Valid until (optional)"), { target: { value: "" } });
  expect(timeSelect(dialog, "From").disabled).toBe(false);
  fireEvent.change(timeSelect(dialog, "From"), { target: { value: "480" } });
  expect(timeSelect(dialog, "Until").disabled).toBe(false);
});

it("excludes lunch and closing boundaries from starts and keeps ends in the same interval", () => {
  render(<AvailabilityManager view={{ ...view, locations: [riverside] }} action={vi.fn()} />);
  const dialog = openAddDialog(false);
  fireEvent.change(within(dialog).getByLabelText("Location"), { target: { value: riverside.id } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Weekdays" }));
  const starts = [...Array.from({ length: 8 }, (_, i) => String(480 + i * 30)), ...Array.from({ length: 14 }, (_, i) => String(840 + i * 30))];
  expect(timeValues(dialog, "From")).toEqual(starts);
  fireEvent.change(timeSelect(dialog, "From"), { target: { value: "480" } });
  expect(timeValues(dialog, "Until")).toEqual(Array.from({ length: 8 }, (_, i) => String(510 + i * 30)));
  fireEvent.change(timeSelect(dialog, "Until"), { target: { value: "720" } });
  fireEvent.change(timeSelect(dialog, "From"), { target: { value: "840" } });
  expect(timeSelect(dialog, "Until").value).toBe("");
  expect(timeValues(dialog, "Until")).toEqual(Array.from({ length: 14 }, (_, i) => String(870 + i * 30)));
  expect(within(dialog).getByText(/previous ending time was cleared/)).toBeTruthy();
});

it("clears incompatible times on location changes and retains a still-valid start", () => {
  const central = { ...east, opening_hours: [{ ...east.opening_hours[1], starts_on: "2099-01-01", status: "current" as const }] };
  render(<AvailabilityManager view={{ ...view, locations: [central, riverside] }} action={vi.fn()} />);
  const dialog = openAddDialog();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Monday" }));
  fireEvent.change(timeSelect(dialog, "From"), { target: { value: "420" } });
  fireEvent.change(timeSelect(dialog, "Until"), { target: { value: "960" } });
  fireEvent.change(within(dialog).getByLabelText("Location"), { target: { value: riverside.id } });
  expect(timeSelect(dialog, "From").value).toBe("");
  expect(timeSelect(dialog, "Until").value).toBe("");
  expect(timeSelect(dialog, "Until").disabled).toBe(true);
  expect(within(dialog).getByText("The previous time selection is outside Riverside Club's opening hours. Choose another interval.")).toBeTruthy();
  expect(within(dialog).queryByText("Select a start time.")).toBeNull();
  fireEvent.change(within(dialog).getByLabelText("Location"), { target: { value: central.id } });
  fireEvent.change(timeSelect(dialog, "From"), { target: { value: "480" } });
  fireEvent.change(timeSelect(dialog, "Until"), { target: { value: "960" } });
  fireEvent.change(within(dialog).getByLabelText("Location"), { target: { value: riverside.id } });
  expect(timeSelect(dialog, "From").value).toBe("480");
  expect(timeSelect(dialog, "Until").value).toBe("");
  expect(within(dialog).getByText(/previous ending time was cleared/)).toBeTruthy();
});

it("preserves valid edit values across compatible day, date and location changes", async () => {
  const action = vi.fn().mockResolvedValue({ ok: false, reason: "invalid-input", fieldErrors: { form: "Please retry." } });
  render(<AvailabilityManager view={{ ...view, locations: [east, riverside] }} action={action} />);
  fireEvent.click(screen.getByRole("button", { name: /^09:00–12:00/ }));
  const dialog = screen.getByRole("dialog", { name: "Edit working hours" });
  expect((within(dialog).getByLabelText("Location") as HTMLSelectElement).value).toBe(east.id);
  expect((within(dialog).getByLabelText("Valid from") as HTMLInputElement).value).toBe("2099-01-01");
  expect(timeSelect(dialog, "From").value).toBe("540");
  expect(timeSelect(dialog, "Until").value).toBe("720");
  fireEvent.change(within(dialog).getByLabelText("Day"), { target: { value: "1" } });
  fireEvent.change(within(dialog).getByLabelText("Valid until (optional)"), { target: { value: "2099-08-31" } });
  fireEvent.change(within(dialog).getByLabelText("Location"), { target: { value: riverside.id } });
  expect(timeSelect(dialog, "From").value).toBe("540");
  expect(timeSelect(dialog, "Until").value).toBe("720");
  expect(action).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  expect(await within(dialog).findByText("Please retry.")).toBeTruthy();
  expect(timeSelect(dialog, "From").value).toBe("540");
  expect(timeSelect(dialog, "Until").value).toBe("720");
});

it("recalculates times across future schedules and inclusive validity changes", () => {
  render(<AvailabilityManager view={view} action={vi.fn()} />);
  const dialog = openAddDialog();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Monday" }));
  expect(timeValues(dialog, "From")).not.toContain("420");
  fireEvent.change(within(dialog).getByLabelText("Valid from"), { target: { value: "2099-07-01" } });
  expect(timeValues(dialog, "From")).toContain("420");
  fireEvent.change(timeSelect(dialog, "From"), { target: { value: "420" } });
  fireEvent.change(timeSelect(dialog, "Until"), { target: { value: "1380" } });
  fireEvent.change(within(dialog).getByLabelText("Valid from"), { target: { value: "2099-06-01" } });
  expect(timeSelect(dialog, "From").value).toBe("");
  expect(timeSelect(dialog, "Until").value).toBe("");
  fireEvent.change(timeSelect(dialog, "From"), { target: { value: "480" } });
  fireEvent.change(timeSelect(dialog, "Until"), { target: { value: "1320" } });
  fireEvent.change(within(dialog).getByLabelText("Valid until (optional)"), { target: { value: "2099-06-30" } });
  expect(timeSelect(dialog, "From").value).toBe("480");
  expect(timeSelect(dialog, "Until").value).toBe("1320");
  expect(within(dialog).queryByText(/previous time selection/)).toBeNull();
});

it("recalculates on Valid until changes without losing a compatible start", () => {
  const location: CoachAvailabilityLocation = { ...east, opening_hours: [east.opening_hours[0],
    { ...east.opening_hours[1], intervals: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens_at_minute: 540, closes_at_minute: 1200 })) }] };
  render(<AvailabilityManager view={{ ...view, locations: [location] }} action={vi.fn()} />);
  const dialog = openAddDialog();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Monday" }));
  fireEvent.change(within(dialog).getByLabelText("Valid until (optional)"), { target: { value: "2099-06-30" } });
  fireEvent.change(timeSelect(dialog, "From"), { target: { value: "540" } });
  fireEvent.change(timeSelect(dialog, "Until"), { target: { value: "1320" } });
  fireEvent.change(within(dialog).getByLabelText("Valid until (optional)"), { target: { value: "2099-07-31" } });
  expect(timeSelect(dialog, "From").value).toBe("540");
  expect(timeSelect(dialog, "Until").value).toBe("");
  expect(timeValues(dialog, "Until").at(-1)).toBe("1200");
  expect(within(dialog).getByText(/previous ending time was cleared/)).toBeTruthy();
});

it("uses the selected location's local today for date prerequisites", () => {
  const tomorrow = { ...riverside, today: "2099-05-02" };
  render(<AvailabilityManager view={{ ...view, locations: [east, tomorrow] }} action={vi.fn()} />);
  const dialog = openAddDialog();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Monday" }));
  fireEvent.change(within(dialog).getByLabelText("Location"), { target: { value: tomorrow.id } });
  expect(timeSelect(dialog, "From").disabled).toBe(true);
  expect(within(dialog).getByText("Choose today or a later date.")).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText("Valid from"), { target: { value: tomorrow.today } });
  expect(timeSelect(dialog, "From").disabled).toBe(false);
});

it("requires common intervals even when all selected days are individually open", () => {
  const location = { ...east, opening_hours: [{ ...east.opening_hours[1], starts_on: "2099-01-01", intervals: [
    { weekday: 0, opens_at_minute: 480, closes_at_minute: 720 },
    { weekday: 1, opens_at_minute: 840, closes_at_minute: 1260 },
  ] }] };
  render(<AvailabilityManager view={{ ...view, locations: [location] }} action={vi.fn()} />);
  const dialog = openAddDialog();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Monday" }));
  expect(timeSelect(dialog, "From").disabled).toBe(false);
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Tuesday" }));
  expect(timeSelect(dialog, "From").disabled).toBe(true);
  expect(within(dialog).getByText("No common opening hours are available for the selected days and dates.")).toBeTruthy();
});

it("keeps the removal confirmation open with a pending label until the removal settles", async () => {
  let finish!: (value: { ok: true; id: string }) => void;
  const action = vi.fn().mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<AvailabilityManager view={view} action={action} />);
  fireEvent.click(screen.getByRole("button", { name: /^09:00–12:00/ }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Edit working hours" })).getByRole("button", { name: "Remove" }));
  const confirmation = screen.getByRole("dialog", { name: "Remove working hours" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Remove" }));
  const pending = await within(confirmation).findByRole("button", { name: "Removing…" });
  expect(pending).toHaveProperty("disabled", true);
  expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
  fireEvent.click(pending);
  expect(action).toHaveBeenCalledOnce();
  finish({ ok: true, id: view.weekly[0].id });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove working hours" })).toBeNull());
  expect(screen.queryByRole("dialog", { name: "Edit working hours" })).toBeNull();
});
