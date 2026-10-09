// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { saveCoverageAction, removeCoverageAction } = vi.hoisted(() => ({ saveCoverageAction: vi.fn(), removeCoverageAction: vi.fn() }));
vi.mock("../../src/app/admin/courts/actions", () => ({ saveCoverageAction, removeCoverageAction }));
import { CoveragePeriods } from "../../src/app/admin/courts/coverage-periods";
const courtId = "c5000000-0000-4000-8000-000000000001";
const period = { id: "c5000000-0000-4000-8000-000000000002", court_id: courtId,
  starts_on: "2026-10-15", ends_on: "2027-04-15", created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z" };
beforeEach(() => { vi.clearAllMocks(); saveCoverageAction.mockResolvedValue({ ok: true, id: period.id }); removeCoverageAction.mockResolvedValue({ ok: true, id: period.id });
  installDialogMock();
});
it("enables coverage Save only after an edit differs from the persisted dates", () => {
  render(<CoveragePeriods courtId={courtId} periods={[period]} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit period" }));
  const save = screen.getByRole("button", { name: "Save period" }) as HTMLButtonElement;
  const start = screen.getByLabelText("Start date") as HTMLInputElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(start, { target: { value: "2026-11-01" } });
  expect(save.disabled).toBe(false);
  fireEvent.change(start, { target: { value: period.starts_on } });
  expect(save.disabled).toBe(true);
});
afterEach(cleanup);
it.each([
  [{ ok: false, reason: "invalid-input", fieldErrors: { ends_on: "End date must be on or after start date." } }, "Check the coverage dates."],
])("shows safe errors and retains entered dates", async (result, message) => {
  saveCoverageAction.mockResolvedValue(result);
  render(<CoveragePeriods courtId={courtId} periods={[period]} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit period" }));
  fireEvent.submit(screen.getByRole("button", { name: "Save period" }).closest("form")!);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(message));
  expect((screen.getByLabelText("Start date") as HTMLInputElement).value).toBe(period.starts_on);
});
