// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { saveCoverageAction, removeCoverageAction } = vi.hoisted(() => ({ saveCoverageAction: vi.fn(), removeCoverageAction: vi.fn() }));
vi.mock("../../src/app/admin/courts/actions", () => ({ saveCoverageAction, removeCoverageAction }));
import { CoveragePeriods } from "../../src/app/admin/courts/coverage-periods";
const courtId = "c5000000-0000-4000-8000-000000000001";
const period = { id: "c5000000-0000-4000-8000-000000000002", court_id: courtId,
  starts_on: "2026-10-15", ends_on: "2027-04-15", created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z" };
beforeEach(() => { vi.clearAllMocks(); saveCoverageAction.mockResolvedValue({ ok: true, id: period.id }); removeCoverageAction.mockResolvedValue({ ok: true, id: period.id }); });
afterEach(cleanup);
it.each([false, true])("adds/edits calendar dates (editing=%s)", async (editing) => {
  render(<CoveragePeriods courtId={courtId} periods={editing ? [period] : []} />);
  fireEvent.click(screen.getByRole("button", { name: editing ? "Edit period" : "Add coverage period" }));
  expect(screen.getByLabelText("Start date").getAttribute("type")).toBe("date");
  fireEvent.change(screen.getByLabelText("Start date"), { target: { value: period.starts_on } });
  fireEvent.change(screen.getByLabelText("End date"), { target: { value: period.ends_on } });
  fireEvent.submit(screen.getByRole("button", { name: "Save period" }).closest("form")!);
  await waitFor(() => expect(saveCoverageAction).toHaveBeenCalledExactlyOnceWith({ ...(editing ? { id: period.id } : {}), court_id: courtId, dates: { starts_on: period.starts_on, ends_on: period.ends_on } }));
  await waitFor(() => expect(screen.queryByLabelText("Start date")).toBeNull());
});
it("removes an interval", async () => {
  render(<CoveragePeriods courtId={courtId} periods={[period]} />);
  expect(screen.getByText("15 Oct 2026 — 15 Apr 2027")).toBeTruthy();
  const edit = screen.getByRole("button", { name: "Edit period" });
  const remove = screen.getByRole("button", { name: "Remove period" });
  expect(edit.title).toBe("Edit period");
  expect(remove.title).toBe("Remove period");
  expect(edit.querySelector("svg")).toBeTruthy();
  expect(remove.querySelector("svg")).toBeTruthy();
  expect(edit.textContent).toBe("");
  expect(remove.textContent).toBe("");
  expect(edit.className).toContain("size-8");
  expect(remove.className).toContain("size-8");
  expect(edit.parentElement).toBe(remove.parentElement);
  expect(edit.parentElement?.previousElementSibling?.textContent).toBe("15 Oct 2026 — 15 Apr 2027");
  const add = screen.getByRole("button", { name: "Add coverage period" });
  expect(add.textContent?.trim()).toBe("Add period");
  expect(add.querySelector("svg")).toBeTruthy();
  expect(add.className).not.toContain("border");
  fireEvent.click(screen.getByRole("button", { name: "Remove period" }));
  await waitFor(() => expect(removeCoverageAction).toHaveBeenCalledExactlyOnceWith({ court_id: courtId, id: period.id }));
});
it.each([
  [{ ok: false, reason: "overlap" }, "These dates overlap an existing coverage period."],
  [{ ok: false, reason: "invalid-input", fieldErrors: { ends_on: "End date must be on or after start date." } }, "Check the coverage dates."],
])("shows safe errors and retains entered dates", async (result, message) => {
  saveCoverageAction.mockResolvedValue(result);
  render(<CoveragePeriods courtId={courtId} periods={[period]} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit period" }));
  fireEvent.submit(screen.getByRole("button", { name: "Save period" }).closest("form")!);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(message));
  expect((screen.getByLabelText("Start date") as HTMLInputElement).value).toBe(period.starts_on);
});
