// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminCourt } from "../../src/lib/admin/courts";
const { listAdminCourts, listAdminLocations, saveCourtAction } = vi.hoisted(() => ({ listAdminCourts: vi.fn(), listAdminLocations: vi.fn(), saveCourtAction: vi.fn() }));
vi.mock("../../src/lib/admin/courts", () => ({ listAdminCourts }));
vi.mock("../../src/lib/admin/locations", () => ({ listAdminLocations }));
vi.mock("../../src/app/admin/courts/actions", () => ({ saveCourtAction }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("../../src/lib/admin/court-coverage", () => ({ listAdminCourtCoverage: vi.fn().mockResolvedValue([]) }));
import AdminCourtsPage from "../../src/app/admin/courts/page";
import { CourtDialog } from "../../src/app/admin/courts/court-dialog";
const locations = [
  { id: "c3000000-0000-4000-8000-000000000001", name: "Central", is_active: true },
  { id: "c3000000-0000-4000-8000-000000000002", name: "North", is_active: false },
];
const court: AdminCourt = { id: "c3000000-0000-4000-8000-000000000003", location_id: locations[0].id,
  name: "Court One", slug: "court-one", surface: "hard", environment: "indoor", has_lighting: true,
  is_active: false, display_order: 2, created_at: "2026-09-29T10:00:00Z", updated_at: "2026-09-29T10:00:00Z" };
beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
});
afterEach(cleanup);
it("groups courts under the correct locations and distinguishes inactive courts and locations", async () => {
  listAdminLocations.mockResolvedValue(locations);
  listAdminCourts.mockResolvedValue([court, { ...court, id: "other", name: "Court Two", location_id: locations[1].id, is_active: true }]);
  render(await AdminCourtsPage());
  const central = within(screen.getByRole("region", { name: "Central" }));
  const north = within(screen.getByRole("region", { name: "North" }));
  expect(central.getAllByText("Court One")).toHaveLength(2);
  expect(central.queryByText("Court Two")).toBeNull();
  expect(north.getAllByText("Court Two")).toHaveLength(2);
  expect(north.getByText(/Inactive location/)).toBeTruthy();
  expect(central.getAllByText("Inactive")[0].className).toContain("text-danger");
  expect(screen.getByText("2 courts across 2 locations")).toBeTruthy();
});
it("handles no locations and prevents court creation", async () => {
  listAdminLocations.mockResolvedValue([]); listAdminCourts.mockResolvedValue([]);
  render(await AdminCourtsPage());
  expect(screen.getByRole("link", { name: "Create a location" }).getAttribute("href")).toBe("/admin/locations");
  expect(screen.getByRole("button", { name: "Create court" }).hasAttribute("disabled")).toBe(true);
});
it("shows empty locations with a create control preselecting the location", async () => {
  listAdminLocations.mockResolvedValue(locations); listAdminCourts.mockResolvedValue([]);
  render(await AdminCourtsPage());
  const north = within(screen.getByRole("region", { name: "North" }));
  expect(north.getByText("No courts at this location.")).toBeTruthy();
  fireEvent.click(north.getByRole("button", { name: "Create court" }));
  expect((screen.getByLabelText("Location") as HTMLSelectElement).value).toBe(locations[1].id);
});
it.each([false, true])("exposes exactly the required fields and constrained options (editing=%s)", (editing) => {
  render(<CourtDialog court={editing ? court : undefined} locations={locations} />);
  fireEvent.click(screen.getByRole("button", { name: editing ? "Edit court" : "Create court" }));
  for (const label of ["Location", "Name", "Surface", "Environment", "Lighting", "Status", "Display order"]) expect(screen.getByLabelText(label)).toBeTruthy();
  expect(within(screen.getByLabelText("Surface")).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(["clay", "hard", "grass", "carpet"]);
  expect(within(screen.getByLabelText("Environment")).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(["outdoor", "indoor"]);
  expect(within(screen.getByLabelText("Location")).getByRole("option", { name: "North (Inactive)" })).toBeTruthy();
  expect((screen.getByLabelText("Surface") as HTMLSelectElement).value).toBe(editing ? "hard" : "clay");
  expect(screen.queryByLabelText(/slug|balloon|price|opening|booking/i)).toBeNull();
});
it("submits a move, reactivation and new display order without sending a slug", async () => {
  saveCourtAction.mockResolvedValue({ ok: true, id: court.id });
  render(<CourtDialog court={court} locations={locations} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit court" }));
  fireEvent.change(screen.getByLabelText("Location"), { target: { value: locations[1].id } });
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "true" } });
  fireEvent.change(screen.getByLabelText("Display order"), { target: { value: "4" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save court" }).closest("form")!);
  await waitFor(() => expect(saveCourtAction).toHaveBeenCalledOnce());
  expect(saveCourtAction.mock.calls[0][0]).toEqual({ id: court.id, fields: { location_id: locations[1].id,
    name: "Court One", surface: "hard", environment: "indoor", has_lighting: true, is_active: true, display_order: 4 } });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("shows input errors while retaining the draft", async () => {
  saveCourtAction.mockResolvedValue({ ok: false, reason: "invalid-input", fieldErrors: { name: "Enter a court name." } });
  render(<CourtDialog court={court} locations={locations} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit court" }));
  fireEvent.submit(screen.getByRole("button", { name: "Save court" }).closest("form")!);
  await waitFor(() => expect(screen.getByText("Enter a court name.")).toBeTruthy());
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Court One");
  expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
});
it("explains a move collision without suggesting a rename that cannot change the slug", async () => {
  saveCourtAction.mockResolvedValue({ ok: false, reason: "duplicate-slug" });
  render(<CourtDialog court={court} locations={locations} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit court" }));
  fireEvent.submit(screen.getByRole("button", { name: "Save court" }).closest("form")!);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Choose a different location."));
});
it("blocks duplicate submissions while pending", async () => {
  let resolve!: (value: { ok: true; id: string }) => void;
  saveCourtAction.mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<CourtDialog court={court} locations={locations} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit court" }));
  const form = screen.getByRole("button", { name: "Save court" }).closest("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(saveCourtAction).toHaveBeenCalledOnce();
  expect(form.querySelector("fieldset")?.disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Close" }).hasAttribute("disabled")).toBe(true);
  resolve({ ok: true, id: court.id });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("shows coverage management only for outdoor courts in both layouts", async () => {
  listAdminLocations.mockResolvedValue([locations[0]]);
  listAdminCourts.mockResolvedValue([court, { ...court, id: "outdoor", name: "Outdoor Court", environment: "outdoor" }]);
  render(await AdminCourtsPage());
  expect(screen.getAllByRole("button", { name: "Add coverage period" })).toHaveLength(2);
  for (const name of screen.getAllByText("Court One")) {
    const container = name.closest("article") ?? name.closest("tr");
    expect(container?.querySelector("section")).toBeNull();
  }
});
