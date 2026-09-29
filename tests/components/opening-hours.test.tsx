// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { saveOpeningHoursAction, removeOpeningHoursAction } = vi.hoisted(() => ({ saveOpeningHoursAction: vi.fn(), removeOpeningHoursAction: vi.fn() }));
vi.mock("../../src/app/admin/locations/opening-hours-actions", () => ({ saveOpeningHoursAction, removeOpeningHoursAction }));
import { OpeningHours } from "../../src/app/admin/locations/opening-hours";
const locationId = "c6000000-0000-4000-8000-000000000011";
const interval = { id: "c6000000-0000-4000-8000-000000000021", location_id: locationId, weekday: 0,
  opens_at_minute: 420, closes_at_minute: 1440, created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z" };
beforeEach(() => { vi.resetAllMocks(); saveOpeningHoursAction.mockResolvedValue({ ok: true, id: interval.id }); removeOpeningHoursAction.mockResolvedValue({ ok: true, id: interval.id }); });
afterEach(cleanup);

it("renders an unconfigured schedule without inferring fallback intervals", () => {
  render(<OpeningHours locationId={locationId} intervals={[]} />);
  expect(screen.getByText(/Opening hours not configured/)).toBeTruthy();
  expect(screen.getAllByText("Closed")).toHaveLength(7);
  expect(screen.queryByText("07:00–24:00")).toBeNull();
});
it("renders closed weekdays and multiple intervals in deterministic weekly/time order", () => {
  render(<OpeningHours locationId={locationId} intervals={[
    { ...interval, id: "late", opens_at_minute: 900 }, { ...interval, id: "early", closes_at_minute: 720 },
  ]} />);
  expect(screen.queryByText(/not configured/)).toBeNull();
  const days = screen.getAllByRole("listitem");
  expect(days.map((day) => day.querySelector("span")?.textContent)).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
  const monday = within(days[0]);
  expect(monday.getByText("07:00–12:00").compareDocumentPosition(monday.getByText("15:00–24:00")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(days[6]).getByText("Closed")).toBeTruthy();
});
it.each([false, true])("adds/edits HH:mm inputs, including 24:00 (editing=%s)", async (editing) => {
  render(<OpeningHours locationId={locationId} intervals={editing ? [interval] : []} />);
  fireEvent.click(screen.getByRole("button", { name: editing ? "Edit Monday 07:00 interval" : "Add Monday interval" }));
  expect(screen.getByLabelText("Closing time").getAttribute("type")).toBe("text");
  fireEvent.change(screen.getByLabelText("Opening time"), { target: { value: "07:00" } });
  fireEvent.change(screen.getByLabelText("Closing time"), { target: { value: "24:00" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save interval" }).closest("form")!);
  await waitFor(() => expect(saveOpeningHoursAction).toHaveBeenCalledExactlyOnceWith({ ...(editing ? { id: interval.id } : {}), location_id: locationId, weekday: 0, opens_at: "07:00", closes_at: "24:00" }));
  await waitFor(() => expect(screen.queryByLabelText("Opening time")).toBeNull());
});
it("removes an interval and then renders the refreshed closed day", async () => {
  const view = render(<OpeningHours locationId={locationId} intervals={[interval]} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove Monday 07:00 interval" }));
  await waitFor(() => expect(removeOpeningHoursAction).toHaveBeenCalledExactlyOnceWith({ location_id: locationId, id: interval.id }));
  view.rerender(<OpeningHours locationId={locationId} intervals={[]} />);
  expect(within(screen.getAllByRole("listitem")[0]).getByText("Closed")).toBeTruthy();
});
it.each([
  [{ ok: false, reason: "overlap" }, "This interval overlaps existing opening hours for this day."],
  [{ ok: false, reason: "invalid-input", fieldErrors: { closes_at: "Closing time must be after opening time." } }, "Check the opening hours."],
])("safely displays errors and preserves entered hours", async (result, message) => {
  saveOpeningHoursAction.mockResolvedValue(result);
  render(<OpeningHours locationId={locationId} intervals={[interval]} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Monday 07:00 interval" }));
  fireEvent.submit(screen.getByRole("button", { name: "Save interval" }).closest("form")!);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(message));
  expect((screen.getByLabelText("Closing time") as HTMLInputElement).value).toBe("24:00");
});
it("blocks duplicate writes while a mutation is pending", async () => {
  let resolve: ((result: { ok: true; id: string }) => void) | undefined;
  saveOpeningHoursAction.mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<OpeningHours locationId={locationId} intervals={[interval]} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Monday 07:00 interval" }));
  const form = screen.getByRole("button", { name: "Save interval" }).closest("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(saveOpeningHoursAction).toHaveBeenCalledOnce();
  expect((screen.getByRole("button", { name: "Remove Monday 07:00 interval" }) as HTMLButtonElement).disabled).toBe(true);
  resolve?.({ ok: true, id: interval.id });
  await waitFor(() => expect(screen.queryByLabelText("Opening time")).toBeNull());
});
