// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminCourt } from "../../src/lib/admin/courts";
const { listAdminCourts, listAdminLocations, listAdminCourtCoverage, saveCourtAction, removeCoverageAction } = vi.hoisted(() => ({
  listAdminCourts: vi.fn(), listAdminLocations: vi.fn(), listAdminCourtCoverage: vi.fn(), saveCourtAction: vi.fn(), removeCoverageAction: vi.fn(),
}));
const navigation = vi.hoisted(() => ({ query: "", replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace, push: navigation.push }),
  usePathname: () => "/admin/courts",
  useSearchParams: () => new URLSearchParams(navigation.query),
}));
vi.mock("../../src/lib/admin/courts", () => ({ listAdminCourts }));
vi.mock("../../src/lib/admin/locations", () => ({ listAdminLocations }));
vi.mock("../../src/app/admin/courts/actions", () => ({ saveCourtAction, removeCoverageAction }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("../../src/lib/admin/court-coverage", () => ({ listAdminCourtCoverage }));
import { CourtItem } from "../../src/app/admin/courts/court-item";
import { CourtDialog } from "../../src/app/admin/courts/court-dialog";
const locations = [
  { id: "c3000000-0000-4000-8000-000000000001", name: "Central", is_active: true },
  { id: "c3000000-0000-4000-8000-000000000002", name: "North", is_active: false },
];
const court: AdminCourt = { id: "c3000000-0000-4000-8000-000000000003", location_id: locations[0].id,
  name: "Court One", slug: "court-one", surface: "hard", environment: "indoor", has_lighting: true,
  is_active: false, created_at: "2026-09-29T10:00:00Z", updated_at: "2026-09-29T10:00:00Z" };
beforeEach(() => {
  vi.clearAllMocks();
  navigation.query = "";
  listAdminCourtCoverage.mockResolvedValue([]);
  removeCoverageAction.mockResolvedValue({ ok: true, id: "period-1" });
  installDialogMock();
});
afterEach(cleanup);
function openEditCourt() {
  render(<table><CourtItem court={court} locations={locations} periods={[]} /></table>);
  fireEvent.click(screen.getByRole("row", { name: "Edit court Court One" }));
  return screen.getByRole("dialog", { name: "Edit court" });
}
it("reopens Create court with fresh validity and no previous draft", async () => {
  saveCourtAction.mockResolvedValue({ ok: true, id: court.id });
  render(<CourtDialog locations={locations} />);
  fireEvent.click(screen.getByRole("button", { name: "Create court" }));
  expect(screen.getByRole("button", { name: "Save court" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Created court" } });
  expect(screen.getByRole("button", { name: "Save court" })).toHaveProperty("disabled", false);
  fireEvent.click(screen.getByRole("button", { name: "Save court" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Create court" }));
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "");
  expect(screen.getByRole("button", { name: "Save court" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Discarded draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Create court" }));
  expect(screen.getByRole("button", { name: "Save court" })).toHaveProperty("disabled", true);
});

it("reopens Edit court with the refreshed record as its pristine baseline", () => {
  const { rerender } = render(<table><CourtItem court={court} locations={locations} periods={[]} /></table>);
  fireEvent.click(screen.getByRole("row", { name: "Edit court Court One" }));
  expect(screen.getByRole("button", { name: "Save court" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Discarded draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  rerender(<table><CourtItem court={{ ...court, name: "Refreshed court" }} locations={locations} periods={[]} /></table>);
  fireEvent.click(screen.getByRole("row", { name: "Edit court Refreshed court" }));
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Refreshed court");
  expect(screen.getByRole("button", { name: "Save court" })).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Discarded draft" } });
  expect(screen.getByRole("button", { name: "Save court" })).toHaveProperty("disabled", false);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Refreshed court" } });
  expect(screen.getByRole("button", { name: "Save court" })).toHaveProperty("disabled", true);
});
it("confirms active court deactivation and retains edits when cancelled", async () => {
  saveCourtAction.mockResolvedValue({ ok: true, id: court.id });
  const activeCourt = { ...court, is_active: true };
  render(<table><CourtItem court={activeCourt} locations={locations} periods={[]} /></table>);
  fireEvent.click(screen.getByRole("row", { name: "Edit court Court One" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Court East" } });
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "false" } });
  const form = screen.getByRole("button", { name: "Save court" }).closest("form")!;
  fireEvent.submit(form);
  expect(saveCourtAction).not.toHaveBeenCalled();
  const confirmation = screen.getByRole("dialog", { name: "Deactivate Court One?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Court East");
  fireEvent.submit(form);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Deactivate Court One?" })).getByRole("button", { name: "Deactivate court" }));
  await waitFor(() => expect(saveCourtAction).toHaveBeenCalledOnce());
  expect(saveCourtAction.mock.calls[0][0].fields).toMatchObject({ name: "Court East", is_active: false });
});
it("keeps a rejected court deactivation open with an error", async () => {
  saveCourtAction.mockResolvedValue({ ok: false, reason: "not-found" });
  render(<table><CourtItem court={{ ...court, is_active: true }} locations={locations} periods={[]} /></table>);
  fireEvent.click(screen.getByRole("row", { name: "Edit court Court One" }));
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "false" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save court" }).closest("form")!);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Deactivate Court One?" })).getByRole("button", { name: "Deactivate court" }));
  await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Deactivate Court One?" })).getByRole("alert").textContent).toContain("no longer exists"));
  expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("false");
});

it("shows input errors while retaining the draft", async () => {
  saveCourtAction.mockResolvedValue({ ok: false, reason: "invalid-input", fieldErrors: { name: "Enter a court name." } });
  openEditCourt();
  fireEvent.submit(screen.getByRole("button", { name: "Save court" }).closest("form")!);
  await waitFor(() => expect(screen.getByText("Enter a court name.")).toBeTruthy());
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Court One");
  expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
});
it("explains that pricing must be changed before a dependent court can move", async () => {
  saveCourtAction.mockResolvedValue({ ok: false, reason: "has-pricing" });
  openEditCourt();
  fireEvent.submit(screen.getByRole("button", { name: "Save court" }).closest("form")!);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("pricing rules still depend on it"));
  expect(screen.getByRole("alert").textContent).not.toContain("pricing_court_fk");
});


it.each(["create", "edit"])("gates %s court saving on current validity and edit dirtiness", (mode) => {
  if (mode === "edit") openEditCourt();
  else {
    render(<CourtDialog locations={locations} />);
    fireEvent.click(screen.getByRole("button", { name: "Create court" }));
  }
  const save = screen.getByRole("button", { name: "Save court" });
  const name = screen.getByLabelText("Name");
  expect(save).toHaveProperty("disabled", true);
  fireEvent.change(name, { target: { value: "Valid draft" } });
  expect(save).toHaveProperty("disabled", false);
  for (const value of ["", "   ", "x".repeat(101)]) {
    fireEvent.change(name, { target: { value } });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.click(save);
    expect(saveCourtAction).not.toHaveBeenCalled();
  }
  fireEvent.change(name, { target: { value: "Valid draft" } });
  expect(save).toHaveProperty("disabled", false);
  fireEvent.change(screen.getByLabelText("Location"), { target: { value: "" } });
  expect(save).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Location"), { target: { value: locations[0].id } });
  expect(save).toHaveProperty("disabled", false);
  fireEvent.change(name, { target: { value: mode === "edit" ? court.name : "" } });
  expect(save).toHaveProperty("disabled", true);
});

it.each(["create", "edit"])("disables pending %s court saves and preserves validation errors and values for retry", async (mode) => {
  let rejectSave: (error: Error) => void = () => { throw new Error("Save has not started"); };
  saveCourtAction.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }))
    .mockResolvedValueOnce({ ok: false, reason: "invalid-input", fieldErrors: { name: "Choose another name." } })
    .mockResolvedValueOnce({ ok: true, id: court.id });
  if (mode === "edit") openEditCourt();
  else {
    render(<CourtDialog locations={locations} />);
    fireEvent.click(screen.getByRole("button", { name: "Create court" }));
  }
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Retry draft" } });
  const save = screen.getByRole("button", { name: "Save court" });
  expect(save).toHaveProperty("disabled", false);
  fireEvent.click(save);
  expect(save).toHaveProperty("disabled", true);
  expect(save.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByRole("button", { name: "Close" })).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("Name").matches(":disabled")).toBe(true);
  fireEvent.click(save);
  expect(saveCourtAction).toHaveBeenCalledTimes(1);
  await act(async () => rejectSave(new Error("Unavailable")));
  expect(screen.getByRole("alert").textContent).toContain("Unable to save court");
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Retry draft");
  expect(save).toHaveProperty("disabled", false);
  fireEvent.click(save);
  await waitFor(() => expect(screen.getByText("Choose another name.")).toBeTruthy());
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Retry draft");
  expect(save).toHaveProperty("disabled", false);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "   " } });
  expect(save).toHaveProperty("disabled", true);
  expect(screen.getByText("Choose another name.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Retry draft" } });
  expect(save).toHaveProperty("disabled", false);
  expect(screen.getByText("Choose another name.")).toBeTruthy();
  fireEvent.click(save);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(saveCourtAction.mock.calls[2][0]).toEqual(saveCourtAction.mock.calls[0][0]);
  fireEvent.click(mode === "edit" ? screen.getByRole("row", { name: "Edit court Court One" }) : screen.getByRole("button", { name: "Create court" }));
  expect(screen.getByLabelText("Name")).toHaveProperty("value", mode === "edit" ? court.name : "");
  expect(screen.queryByText("Choose another name.")).toBeNull();
  expect(screen.getByRole("button", { name: "Save court" })).toHaveProperty("disabled", true);
});
