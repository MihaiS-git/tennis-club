// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminLocation } from "../../src/lib/admin/locations";

const { listAdminLocations, listAdminCourts, listAdminCourtCoverage, listAdminPricingRules, listAdminLocationsWithReadiness, listAdminLocationOpeningHours, mutateOpeningHoursAction, saveLocationAction, archiveLocationAction, setLocationPublicationAction, refresh, push } = vi.hoisted(() => ({
  listAdminLocations: vi.fn(), listAdminCourts: vi.fn(), listAdminCourtCoverage: vi.fn(), listAdminPricingRules: vi.fn(), listAdminLocationsWithReadiness: vi.fn(), listAdminLocationOpeningHours: vi.fn(), mutateOpeningHoursAction: vi.fn(), saveLocationAction: vi.fn(), archiveLocationAction: vi.fn(), setLocationPublicationAction: vi.fn(), refresh: vi.fn(), push: vi.fn(),
}));
vi.mock("../../src/lib/admin/locations", () => ({ listAdminLocations, listAdminLocationsWithReadiness }));
vi.mock("../../src/lib/admin/courts", () => ({ listAdminCourts }));
vi.mock("../../src/lib/admin/court-coverage", () => ({ listAdminCourtCoverage }));
vi.mock("../../src/lib/admin/pricing", () => ({ listAdminPricingRules }));
vi.mock("../../src/lib/admin/opening-hours", () => ({ listAdminLocationOpeningHours }));
vi.mock("../../src/app/admin/locations/actions", () => ({ saveLocationAction, archiveLocationAction, setLocationPublicationAction }));
vi.mock("../../src/app/admin/locations/opening-hours-actions", () => ({ mutateOpeningHoursAction }));
vi.mock("../../src/app/admin/courts/actions", () => ({ saveCourtAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push }),
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
import { LocationForm } from "../../src/app/admin/locations/location-form";
import { PublicationControl } from "../../src/app/admin/locations/publication-control";
import { LocationArchiveControl } from "../../src/app/admin/locations/location-archive-control";
import AdminLocationsPage from "../../src/app/admin/locations/page";
import NewLocationPage from "../../src/app/admin/locations/new/page";
import LocationManagementPage from "../../src/app/admin/locations/[locationId]/page";
import { LocationItem } from "../../src/app/admin/locations/location-item";

const location: AdminLocation = {
  allow_pay_at_club: false, id: "a1000000-0000-4000-8000-000000000001", name: "Central Club", slug: "central-club",
  address_line1: "Street 1", address_line2: null, city: "Cluj", postal_code: "400000", country_code: "RO",
  customer_cancellation_notice_minutes: 1440, timezone: "Europe/Bucharest", currency: "RON", is_active: false, is_public: false, archived_at: null, display_order: 2,
  created_at: "2026-09-29T10:00:00Z", updated_at: "2026-09-29T10:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
  listAdminLocationOpeningHours.mockResolvedValue([]);
  listAdminLocations.mockResolvedValue([location]);
  listAdminCourts.mockResolvedValue([]);
  listAdminCourtCoverage.mockResolvedValue([]);
  listAdminPricingRules.mockResolvedValue([]);
  window.history.replaceState(null, "", `/admin/locations/${location.id}`);
  installDialogMock();
});
afterEach(cleanup);

function openEditLocation(value: AdminLocation = location) {
  render(<LocationForm location={value} />);
}

function renderLocationRow() {
  render(<table><tbody><LocationItem location={location} missing={[]} countryName="Romania" /></tbody></table>);
  return screen.getByRole("row", { name: `Manage location ${location.name}` });
}

it("links creation to the full-page shared form", async () => {
  listAdminLocationsWithReadiness.mockResolvedValue([]);
  render(await AdminLocationsPage({}));
  expect(screen.getByRole("link", { name: "Create location" }).getAttribute("href")).toBe("/admin/locations/new");
  expect(screen.queryByRole("dialog")).toBeNull();
  cleanup();
  render(<NewLocationPage />);
  expect(screen.getByRole("heading", { name: "Create location" })).toBeTruthy();
  expect(screen.getByRole("form", { name: "Create location" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Back to locations" })).toBeNull();
});

it("opens the workspace with persisted values and refreshes it after editing", async () => {
  listAdminLocationsWithReadiness.mockResolvedValue([{ ...location, missing: [] }]);
  saveLocationAction.mockResolvedValue({ ok: true, id: location.id });
  const { rerender } = render(await LocationManagementPage({ params: Promise.resolve({ locationId: location.id }) }));
  const form = screen.getByRole("form", { name: "Edit location" });
  for (const [label, value] of [["Name", location.name], ["Address line 1", "Street 1"], ["City", "Cluj"],
    ["Postal code", "400000"], ["Currency", "RON"], ["Status", "false"], ["Customer cancellation notice", "1440"]]) {
    expect(within(form).getByLabelText(label)).toHaveProperty("value", value);
  }
  expect(new FormData(form as HTMLFormElement).get("timezone")).toBe(location.timezone);
  expect(within(form).getByRole("button", { name: "Save location" })).toHaveProperty("disabled", true);
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Renamed Club" } });
  fireEvent.click(within(form).getByRole("button", { name: "Save location" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(push).not.toHaveBeenCalled();
  expect(saveLocationAction.mock.calls[0][0]).toMatchObject({ id: location.id, fields: { name: "Renamed Club" } });
  expect(within(form).getByLabelText("Name")).toHaveProperty("value", "Renamed Club");
  listAdminLocationsWithReadiness.mockResolvedValue([{ ...location, name: "Renamed Club", updated_at: "2026-10-09T10:00:00Z", missing: [] }]);
  rerender(await LocationManagementPage({ params: Promise.resolve({ locationId: location.id }) }));
  expect(screen.getByRole("heading", { name: "Renamed Club" })).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("button", { name: "Save location" })).toHaveProperty("disabled", true));
  expect(screen.getByRole("form", { name: "Edit location" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it.each(["Enter", " "])("navigates from the focused location row with %s", (key) => {
  const row = renderLocationRow();
  row.focus();
  fireEvent.keyDown(row, { key });
  expect(push).toHaveBeenCalledExactlyOnceWith(`/admin/locations/${location.id}`);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("navigates on row clicks and preserves native management/configuration links", () => {
  const row = renderLocationRow();
  fireEvent.click(within(row).getByText("RON"));
  expect(push).toHaveBeenCalledExactlyOnceWith(`/admin/locations/${location.id}`);
  push.mockClear();
  const name = within(row).getByRole("link", { name: location.name });
  expect(name.getAttribute("href")).toBe(`/admin/locations/${location.id}`);
  fireEvent.click(name);
  const manage = within(row).getByRole("link", { name: `Manage location ${location.name}` });
  expect(manage.getAttribute("href")).toBe(`/admin/locations/${location.id}`);
  fireEvent.click(manage);
  const hours = within(row).getByRole("link", { name: "Opening hours configured" });
  expect(hours.getAttribute("href")).toBe(`/admin/locations/${location.id}?tab=opening-hours`);
  fireEvent.click(hours);
  fireEvent.keyDown(hours, { key: "Enter" });
  expect(push).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("does not offer opening hours when creating a location", () => {
  render(<LocationForm />);
  expect(screen.queryByRole("button", { name: "Opening hours" })).toBeNull();
});

it("shows a contextual publication failure when server readiness changes", async () => {
  setLocationPublicationAction.mockResolvedValue({ ok: false, reason: "not-ready",
    message: "This location cannot be published yet. Configure pricing for every active court." });
  render(<PublicationControl id={location.id} published={false} blocked={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Enable public booking" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Configure pricing"));
});

it("disables publishing incomplete configuration while allowing explicit unpublication", () => {
  const { rerender } = render(<PublicationControl id={location.id} published={false} blocked />);
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  rerender(<PublicationControl id={location.id} published blocked />);
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
});

it("confirms an active location deactivation without losing other edits on Cancel", async () => {
  saveLocationAction.mockResolvedValue({ ok: true, id: location.id });
  openEditLocation({ ...location, is_active: true });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed Club" } });
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "false" } });
  const form = screen.getByRole("button", { name: "Save location" }).closest("form")!;
  fireEvent.submit(form);
  expect(saveLocationAction).not.toHaveBeenCalled();
  const confirmation = screen.getByRole("dialog", { name: "Deactivate Central Club?" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  expect(saveLocationAction).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Renamed Club");
  expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("false");
  fireEvent.submit(form);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Deactivate Central Club?" })).getByRole("button", { name: "Deactivate location" }));
  await waitFor(() => expect(saveLocationAction).toHaveBeenCalledOnce());
  expect(saveLocationAction.mock.calls[0][0].fields).toMatchObject({ name: "Renamed Club", is_active: false });
});

it("shows inline validation and keeps form values", async () => {
  saveLocationAction.mockResolvedValue({ ok: false, reason: "invalid-input", fieldErrors: { timezone: "Enter an IANA timezone." } });
  openEditLocation();
  const timezone = screen.getByRole("combobox", { name: "Timezone" });
  fireEvent.focus(timezone);
  fireEvent.change(timezone, { target: { value: "paris" } });
  fireEvent.keyDown(timezone, { key: "Enter" });
  fireEvent.submit(screen.getByRole("button", { name: "Save location" }).closest("form")!);
  await waitFor(() => expect(screen.getByText("Enter an IANA timezone.")).toBeTruthy());
  expect((screen.getByLabelText("Timezone") as HTMLInputElement).value).toMatch(/^UTC[+-]\d{2}:\d{2} · Europe\/Paris$/);
  expect(screen.getByLabelText("Timezone").getAttribute("aria-invalid")).toBe("true");
});

it("never submits arbitrary timezone search text as a timezone value", async () => {
  saveLocationAction.mockResolvedValue({ ok: false, reason: "invalid-input", fieldErrors: { timezone: "Select a timezone." } });
  render(<LocationForm />);
  const timezone = screen.getByRole("combobox", { name: "Timezone" });
  fireEvent.focus(timezone);
  fireEvent.change(timezone, { target: { value: "Mars/Olympus" } });
  fireEvent.submit(screen.getByRole("button", { name: "Create location" }).closest("form")!);
  await waitFor(() => expect(saveLocationAction).toHaveBeenCalledOnce());
  expect(saveLocationAction.mock.calls[0][0].fields.timezone).toBe("");
});

it("keeps archive confirmation open with contextual safe feedback on failure", async () => {
  archiveLocationAction.mockRejectedValue(new Error("private database error"));
  render(<LocationArchiveControl id={location.id} name={location.name} archived={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Archive Central Club" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Archive Central Club" })).getByRole("button", { name: "Archive location" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Unable to archive"));
  expect(screen.getByRole("dialog", { name: "Archive Central Club" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).not.toContain("private database error");
});

it.each([0, 1440])("creates a location with default or selected notice %s", async (notice) => {
  saveLocationAction.mockResolvedValue({ ok: true, id: location.id });
  render(<LocationForm />);
  expect((screen.getByLabelText("Customer cancellation notice") as HTMLSelectElement).value).toBe("1440");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Club" } });
  const timezone = screen.getByRole("combobox", { name: "Timezone" });
  fireEvent.focus(timezone);
  fireEvent.change(timezone, { target: { value: "buch" } });
  fireEvent.keyDown(timezone, { key: "Enter" });
  fireEvent.change(screen.getByLabelText("Customer cancellation notice"), { target: { value: String(notice) } });
  expect(screen.queryByLabelText("Public booking")).toBeNull();
  fireEvent.submit(screen.getByRole("button", { name: "Create location" }).closest("form")!);
  await waitFor(() => expect(saveLocationAction).toHaveBeenCalledOnce());
  expect(saveLocationAction.mock.calls[0][0].fields.customer_cancellation_notice_minutes).toBe(notice);
  expect(saveLocationAction.mock.calls[0][0].fields.is_public).toBe(false);
  expect(push).toHaveBeenCalledWith(`/admin/locations/${location.id}`);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("archives and restores from the shared workspace form", async () => {
  archiveLocationAction.mockResolvedValue({ ok: true, id: location.id });
  const { rerender } = render(<LocationForm location={location} />);
  fireEvent.click(screen.getByRole("button", { name: "Archive Central Club" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Archive Central Club" })).getByRole("button", { name: "Archive location" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(archiveLocationAction).toHaveBeenCalledWith({ id: location.id, archived: true });
  expect(push).not.toHaveBeenCalled();
  rerender(<LocationForm key="archived" location={{ ...location, archived_at: "2026-10-09T10:00:00Z" }} />);
  expect(screen.getByLabelText("Name").matches(":disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: "Save location" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Opening hours" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(archiveLocationAction).toHaveBeenLastCalledWith({ id: location.id, archived: false });
});

it.each([
  { ok: false, reason: "duplicate-slug", message: "already exists" },
  { ok: false, reason: "not-ready", message: "Configure pricing before saving." },
])("preserves edits on $reason without navigating", async (result) => {
  saveLocationAction.mockResolvedValue(result);
  openEditLocation();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved name" } });
  fireEvent.click(screen.getByRole("button", { name: "Save location" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(result.message));
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Unsaved name");
  expect(push).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Save location" })).toHaveProperty("disabled", false);
});

it("preserves creation input after failure and navigates only after a successful retry", async () => {
  saveLocationAction.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce({ ok: true, id: location.id });
  render(<NewLocationPage />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Club" } });
  const timezone = screen.getByRole("combobox", { name: "Timezone" });
  fireEvent.focus(timezone);
  fireEvent.change(timezone, { target: { value: "buch" } });
  fireEvent.keyDown(timezone, { key: "Enter" });
  const form = screen.getByRole("form", { name: "Create location" });
  fireEvent.submit(form);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Unable to save location"));
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "New Club");
  expect(new FormData(form as HTMLFormElement).get("timezone")).toBe("Europe/Bucharest");
  expect(push).not.toHaveBeenCalled();
  fireEvent.submit(form);
  await waitFor(() => expect(push).toHaveBeenCalledExactlyOnceWith(`/admin/locations/${location.id}`));
  expect(refresh).not.toHaveBeenCalled();
});


it.each(["create", "edit"])("gates %s location saving on current validity and edit dirtiness", async (mode) => {
  render(<LocationForm location={mode === "edit" ? location : undefined} />);
  const save = screen.getByRole("button", { name: mode === "edit" ? "Save location" : "Create location" });
  const name = screen.getByLabelText("Name");
  expect(save).toHaveProperty("disabled", true);
  fireEvent.change(name, { target: { value: "Valid draft" } });
  if (mode === "create") {
    expect(save).toHaveProperty("disabled", true);
    const timezone = screen.getByRole("combobox", { name: "Timezone" });
    fireEvent.focus(timezone);
    fireEvent.change(timezone, { target: { value: "buch" } });
    fireEvent.keyDown(timezone, { key: "Enter" });
  }
  await waitFor(() => expect(save).toHaveProperty("disabled", false));
  for (const value of ["", "   ", "x".repeat(101)]) {
    fireEvent.change(name, { target: { value } });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.click(save);
    expect(saveLocationAction).not.toHaveBeenCalled();
  }
  fireEvent.change(name, { target: { value: "Valid draft" } });
  expect(save).toHaveProperty("disabled", false);
  fireEvent.change(screen.getByLabelText("Address line 1"), { target: { value: "x".repeat(201) } });
  expect(save).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Address line 1"), { target: { value: mode === "edit" ? location.address_line1 : "" } });
  expect(save).toHaveProperty("disabled", false);
  fireEvent.change(name, { target: { value: mode === "edit" ? location.name : "" } });
  expect(save).toHaveProperty("disabled", true);
});

it.each(["create", "edit"])("disables pending %s location saves and preserves validation errors and values for retry", async (mode) => {
  let rejectSave: (error: Error) => void = () => { throw new Error("Save has not started"); };
  saveLocationAction.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }))
    .mockResolvedValueOnce({ ok: false, reason: "invalid-input", fieldErrors: { name: "Choose another name." } })
    .mockResolvedValueOnce({ ok: true, id: location.id });
  render(<LocationForm location={mode === "edit" ? location : undefined} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Retry draft" } });
  if (mode === "create") {
    const timezone = screen.getByRole("combobox", { name: "Timezone" });
    fireEvent.focus(timezone);
    fireEvent.change(timezone, { target: { value: "buch" } });
    fireEvent.keyDown(timezone, { key: "Enter" });
  }
  const save = screen.getByRole("button", { name: mode === "edit" ? "Save location" : "Create location" });
  await waitFor(() => expect(save).toHaveProperty("disabled", false));
  fireEvent.click(save);
  expect(save).toHaveProperty("disabled", true);
  expect(save.getAttribute("aria-busy")).toBe("true");
  expect(screen.getByLabelText("Name").matches(":disabled")).toBe(true);
  fireEvent.click(save);
  expect(saveLocationAction).toHaveBeenCalledTimes(1);
  await act(async () => rejectSave(new Error("Unavailable")));
  expect(screen.getByRole("alert").textContent).toContain("Unable to save location");
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
  await waitFor(() => expect(mode === "edit" ? refresh : push).toHaveBeenCalledOnce());
  expect(saveLocationAction.mock.calls[2][0]).toEqual(saveLocationAction.mock.calls[0][0]);
  expect(screen.queryByText("Choose another name.")).toBeNull();
  if (mode === "edit") expect(save).toHaveProperty("disabled", true);
});

it.each(["create", "edit"])("starts a fresh %s location session when remounted", (mode) => {
  const props = mode === "edit" ? { location } : {};
  const first = render(<LocationForm {...props} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Discarded draft" } });
  first.unmount();
  render(<LocationForm {...props} />);
  expect(screen.getByLabelText("Name")).toHaveProperty("value", mode === "edit" ? location.name : "");
  expect(screen.getByRole("button", { name: mode === "edit" ? "Save location" : "Create location" })).toHaveProperty("disabled", true);
});
