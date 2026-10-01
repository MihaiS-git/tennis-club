// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import AdminCourtsPage from "../../src/app/admin/courts/page";
import { CourtItem } from "../../src/app/admin/courts/court-item";
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
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
});
afterEach(cleanup);
function openEditCourt() {
  render(<table><CourtItem court={court} locations={locations} periods={[]} /></table>);
  fireEvent.click(screen.getByRole("row", { name: "Edit court Court One" }));
  return screen.getByRole("dialog", { name: "Edit court" });
}
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
it("enables court Save only while normalized edits differ from the persisted court", () => {
  openEditCourt();
  const save = screen.getByRole("button", { name: "Save court" }) as HTMLButtonElement;
  const name = screen.getByLabelText("Name") as HTMLInputElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(name, { target: { value: " Court One " } });
  expect(save.disabled).toBe(true);
  fireEvent.change(name, { target: { value: "Court Two" } });
  expect(save.disabled).toBe(false);
  fireEvent.change(name, { target: { value: "Court One" } });
  expect(save.disabled).toBe(true);
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
it("blocks duplicate submissions while pending", async () => {
  let resolve!: (value: { ok: true; id: string }) => void;
  saveCourtAction.mockReturnValue(new Promise((done) => { resolve = done; }));
  openEditCourt();
  const form = screen.getByRole("button", { name: "Save court" }).closest("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(saveCourtAction).toHaveBeenCalledOnce();
  expect(form.querySelector("fieldset")?.disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Close" }).hasAttribute("disabled")).toBe(true);
  resolve({ ok: true, id: court.id });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("keeps period edit and removal separate from court editing", async () => {
  listAdminLocations.mockResolvedValue(locations);
  listAdminCourts.mockResolvedValue([{ ...court, environment: "outdoor" }]);
  listAdminCourtCoverage.mockResolvedValue([{ id: "period-1", court_id: court.id,
    starts_on: "2026-10-01", ends_on: "2027-04-01", created_at: court.created_at, updated_at: court.updated_at }]);
  render(await AdminCourtsPage());
  fireEvent.click(screen.getAllByRole("button", { name: "Edit period" })[0]);
  expect(screen.queryByRole("dialog", { name: "Edit court" })).toBeNull();
  expect(screen.getByLabelText("Start date")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Remove period" })[0]);
  expect(screen.queryByRole("dialog", { name: "Edit court" })).toBeNull();
  expect(removeCoverageAction).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog", { name: /Remove coverage period/ })).getByRole("button", { name: "Remove period" }));
  await waitFor(() => expect(removeCoverageAction).toHaveBeenCalledWith({ court_id: court.id, id: "period-1" }));
});
