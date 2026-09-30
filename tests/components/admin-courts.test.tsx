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
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
});
afterEach(cleanup);
it("defaults to one location and never renders courts from other locations", async () => {
  listAdminLocations.mockResolvedValue(locations);
  listAdminCourts.mockResolvedValue([court, { ...court, id: "other", name: "Court Two", location_id: locations[1].id, is_active: true }]);
  render(await AdminCourtsPage());
  expect(screen.queryByRole("navigation", { name: "Admin navigation" })).toBeNull();
  const central = within(screen.getByRole("region", { name: "Central courts" }));
  expect((screen.getByRole("combobox", { name: "Location" }) as HTMLSelectElement).value).toBe(locations[0].id);
  const toolbar = screen.getByRole("combobox", { name: "Location" }).closest("label")?.parentElement;
  for (const name of ["Status", "Surface", "Environment"]) {
    expect(screen.getByRole("combobox", { name }).closest("label")?.parentElement).toBe(toolbar);
  }
  expect(screen.getByRole("button", { name: "Create court" }).parentElement?.parentElement).toBe(toolbar);
  expect(screen.queryByText("1 court")).toBeNull();
  expect(central.getAllByText("Court One")).toHaveLength(2);
  expect(central.queryByText("Court Two")).toBeNull();
  expect(screen.queryByText("Court Two")).toBeNull();
  expect(screen.queryByRole("region", { name: "North courts" })).toBeNull();
  expect(central.getAllByText("Inactive")[0].className).toContain("text-danger");
  expect(screen.getAllByRole("button", { name: "Create court" })).toHaveLength(1);
});
it("selects an inactive location from the URL and falls back for invalid or unknown IDs", async () => {
  listAdminLocations.mockResolvedValue(locations);
  listAdminCourts.mockResolvedValue([court, { ...court, id: "other", name: "Court Two", location_id: locations[1].id }]);
  const selected = render(await AdminCourtsPage({ searchParams: Promise.resolve({ location: locations[1].id }) }));
  expect((screen.getByRole("combobox", { name: "Location" }) as HTMLSelectElement).value).toBe(locations[1].id);
  expect(screen.queryByText("1 court · Inactive location")).toBeNull();
  expect(screen.getAllByText("Court Two")).toHaveLength(2);
  expect(screen.queryByText("Court One")).toBeNull();
  selected.unmount();
  for (const invalid of ["bad", "c3000000-0000-4000-8000-000000000099", [locations[1].id, locations[0].id]]) {
    const fallback = render(await AdminCourtsPage({ searchParams: Promise.resolve({ location: invalid }) }));
    expect((screen.getByRole("combobox", { name: "Location" }) as HTMLSelectElement).value).toBe(locations[0].id);
    fallback.unmount();
  }
});
it("handles no locations and prevents court creation", async () => {
  listAdminLocations.mockResolvedValue([]); listAdminCourts.mockResolvedValue([]);
  render(await AdminCourtsPage());
  expect(screen.getByRole("link", { name: "Create a location" }).getAttribute("href")).toBe("/admin/locations");
  expect(screen.getByRole("button", { name: "Create court" }).hasAttribute("disabled")).toBe(true);
});
it("shows the selected location empty state and preselects it for creation", async () => {
  listAdminLocations.mockResolvedValue(locations); listAdminCourts.mockResolvedValue([]);
  render(await AdminCourtsPage({ searchParams: Promise.resolve({ location: locations[1].id }) }));
  const north = within(screen.getByRole("region", { name: "North courts" }));
  expect(north.getByText("No courts at this location.")).toBeTruthy();
  expect(north.queryByRole("button", { name: "Create court" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create court" }));
  const location = within(screen.getByRole("dialog")).getByLabelText("Location") as HTMLSelectElement;
  expect(location.value).toBe(locations[1].id);
  fireEvent.change(location, { target: { value: locations[0].id } });
  expect(location.value).toBe(locations[0].id);
});
it.each([false, true])("exposes exactly the required fields and constrained options (editing=%s)", (editing) => {
  render(<CourtDialog court={editing ? court : undefined} locations={locations} />);
  fireEvent.click(screen.getByRole("button", { name: editing ? "Edit court" : "Create court" }));
  for (const label of ["Location", "Name", "Surface", "Environment", "Lighting", "Status"]) expect(screen.getByLabelText(label)).toBeTruthy();
  expect(screen.queryByLabelText("Display order")).toBeNull();
  expect(within(screen.getByLabelText("Surface")).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(["clay", "hard", "grass", "carpet"]);
  expect(within(screen.getByLabelText("Environment")).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(["outdoor", "indoor"]);
  expect(within(screen.getByLabelText("Location")).getByRole("option", { name: "North (Inactive)" })).toBeTruthy();
  expect((screen.getByLabelText("Surface") as HTMLSelectElement).value).toBe(editing ? "hard" : "clay");
  expect(screen.queryByLabelText(/slug|balloon|price|opening|booking/i)).toBeNull();
});
it("submits a move and reactivation without a slug", async () => {
  saveCourtAction.mockResolvedValue({ ok: true, id: court.id });
  render(<CourtDialog court={court} locations={locations} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit court" }));
  fireEvent.change(screen.getByLabelText("Location"), { target: { value: locations[1].id } });
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "true" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save court" }).closest("form")!);
  await waitFor(() => expect(saveCourtAction).toHaveBeenCalledOnce());
  expect(saveCourtAction.mock.calls[0][0]).toEqual({ id: court.id, fields: { location_id: locations[1].id,
    name: "Court One", surface: "hard", environment: "indoor", has_lighting: true, is_active: true } });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("creates a court without an ordering field", async () => {
  saveCourtAction.mockResolvedValue({ ok: true, id: court.id });
  render(<CourtDialog locations={locations} />);
  fireEvent.click(screen.getByRole("button", { name: "Create court" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New court" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save court" }).closest("form")!);
  await waitFor(() => expect(saveCourtAction).toHaveBeenCalledOnce());
  expect(saveCourtAction.mock.calls[0][0].fields).toEqual({
    location_id: locations[0].id, name: "New court", surface: "clay", environment: "outdoor",
    has_lighting: false, is_active: true,
  });
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
  listAdminLocations.mockResolvedValue(locations);
  listAdminCourts.mockResolvedValue([court, { ...court, id: "outdoor", name: "Outdoor Court", environment: "outdoor" },
    { ...court, id: "other-outdoor", name: "North Outdoor Court", location_id: locations[1].id, environment: "outdoor" }]);
  render(await AdminCourtsPage());
  expect(screen.getAllByRole("button", { name: "Add coverage period" })).toHaveLength(2);
  expect(screen.queryByText("North Outdoor Court")).toBeNull();
  const mobileCard = screen.getAllByText("Outdoor Court").map((name) => name.closest("article")).find(Boolean);
  expect(mobileCard?.nextElementSibling?.textContent).toContain("Coverage periods");
  const desktopGroup = screen.getAllByText("Outdoor Court").map((name) => name.closest("tbody")).find(Boolean);
  expect(desktopGroup?.querySelectorAll("tr")).toHaveLength(2);
  expect(desktopGroup?.querySelector("section")?.textContent).toContain("Coverage periods");
  for (const name of screen.getAllByText("Court One")) {
    const container = name.closest("article") ?? name.closest("tr");
    expect(container?.querySelector("section")).toBeNull();
  }
});

it("opens court editing from the row or card while coverage controls stay independent", async () => {
  listAdminLocations.mockResolvedValue(locations);
  listAdminCourts.mockResolvedValue([{ ...court, environment: "outdoor" }]);
  render(await AdminCourtsPage());
  const row = screen.getByRole("row", { name: "Edit court Court One" });
  const card = screen.getByRole("button", { name: "Edit court Court One" });
  fireEvent.click(screen.getAllByRole("button", { name: "Add coverage period" })[0]);
  expect(screen.queryByRole("dialog", { name: "Edit court" })).toBeNull();
  fireEvent.click(row);
  expect((screen.getByRole("dialog", { name: "Edit court" }) as HTMLDialogElement).open).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.keyDown(row, { key: "Enter" });
  expect((screen.getByRole("dialog", { name: "Edit court" }) as HTMLDialogElement).open).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.keyDown(row, { key: " " });
  expect((screen.getByRole("dialog", { name: "Edit court" }) as HTMLDialogElement).open).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(card);
  expect((screen.getByRole("dialog", { name: "Edit court" }) as HTMLDialogElement).open).toBe(true);
  expect(screen.queryByRole("columnheader", { name: "Actions" })).toBeNull();
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
  await waitFor(() => expect(removeCoverageAction).toHaveBeenCalledWith({ court_id: court.id, id: "period-1" }));
});

it("sorts names in the selected location by default", async () => {
  listAdminLocations.mockResolvedValue(locations);
  listAdminCourts.mockResolvedValue([
    { ...court, id: "z", name: "Zeta" },
    { ...court, id: "a", name: "Alpha" },
    { ...court, id: "n", name: "North court", location_id: locations[1].id },
  ]);
  render(await AdminCourtsPage());
  const central = within(screen.getByRole("region", { name: "Central courts" }));
  expect(central.getAllByRole("button", { name: /Edit court/ }).map((card) => card.querySelector("p")?.textContent)).toEqual(["Alpha", "Zeta"]);
  expect(central.getByRole("columnheader", { name: "Name" }).getAttribute("aria-sort")).toBe("ascending");
  expect(central.queryByRole("columnheader", { name: "Order" })).toBeNull();
  expect(central.getAllByRole("cell")).toHaveLength(10);
  expect(screen.queryByText("Display order")).toBeNull();
});

it("sorts selected columns and preserves location and filters in sort links", async () => {
  listAdminLocations.mockResolvedValue(locations);
  listAdminCourts.mockResolvedValue([
    { ...court, id: "z", name: "Zeta", is_active: false, surface: "hard" },
    { ...court, id: "a", name: "Alpha", is_active: true, surface: "clay" },
    { ...court, id: "n", name: "North court", location_id: locations[1].id, is_active: true, surface: "clay" },
  ]);
  render(await AdminCourtsPage({ searchParams: Promise.resolve({ location: locations[0].id, sort: "status", dir: "desc", surface: "hard" }) }));
  const central = within(screen.getByRole("region", { name: "Central courts" }));
  const status = central.getByRole("columnheader", { name: "Status" });
  expect(status.getAttribute("aria-sort")).toBe("descending");
  expect(status.querySelector("svg")?.classList.contains("lucide-arrow-down")).toBe(true);
  expect(new URL(within(status).getByRole("link").getAttribute("href")!, "http://localhost").searchParams.get("dir")).toBe("asc");
  const nameHref = central.getByRole("columnheader", { name: "Name" }).querySelector("a")!.getAttribute("href")!;
  expect(Object.fromEntries(new URL(nameHref, "http://localhost").searchParams)).toEqual({ location: locations[0].id, surface: "hard", sort: "name", dir: "asc" });
  expect(central.getAllByRole("button", { name: /Edit court/ })).toHaveLength(1);
  expect(screen.queryByRole("region", { name: "North courts" })).toBeNull();
  expect(screen.queryByText("North court")).toBeNull();
});

it("shows the filtered empty state only for the selected location", async () => {
  listAdminLocations.mockResolvedValue(locations);
  listAdminCourts.mockResolvedValue([court, { ...court, id: "other", name: "North court", location_id: locations[1].id }]);
  render(await AdminCourtsPage({ searchParams: Promise.resolve({ location: locations[0].id, surface: "clay" }) }));
  expect(screen.getByText("No courts match these filters at this location.")).toBeTruthy();
  expect(screen.queryByText("North court")).toBeNull();
});

it("removes a court from the selected inventory after it moves to another location", async () => {
  listAdminLocations.mockResolvedValue(locations);
  listAdminCourts.mockResolvedValue([court]);
  const view = render(await AdminCourtsPage({ searchParams: Promise.resolve({ location: locations[0].id }) }));
  expect(screen.getAllByText("Court One")).toHaveLength(2);
  listAdminCourts.mockResolvedValue([{ ...court, location_id: locations[1].id }]);
  view.rerender(await AdminCourtsPage({ searchParams: Promise.resolve({ location: locations[0].id }) }));
  expect(screen.queryByText("Court One")).toBeNull();
  expect(screen.queryByText("0 courts")).toBeNull();
  expect(screen.getByText("No courts at this location.")).toBeTruthy();
});
