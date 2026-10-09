// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminLocation } from "../../src/lib/admin/locations";

const { listAdminLocationsWithReadiness, listAdminLocationOpeningHours, saveLocationAction, archiveLocationAction, setLocationPublicationAction, refresh, push } = vi.hoisted(() => ({
  listAdminLocationsWithReadiness: vi.fn(), listAdminLocationOpeningHours: vi.fn(), saveLocationAction: vi.fn(), archiveLocationAction: vi.fn(), setLocationPublicationAction: vi.fn(), refresh: vi.fn(), push: vi.fn(),
}));
vi.mock("../../src/lib/admin/locations", () => ({ listAdminLocationsWithReadiness }));
vi.mock("../../src/lib/admin/opening-hours", () => ({ listAdminLocationOpeningHours }));
vi.mock("../../src/app/admin/locations/actions", () => ({ saveLocationAction, archiveLocationAction, setLocationPublicationAction }));
vi.mock("../../src/app/admin/courts/actions", () => ({ saveCourtAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
import { LocationDialog } from "../../src/app/admin/locations/location-dialog";
import { PublicationControl } from "../../src/app/admin/locations/publication-control";
import { LocationArchiveControl } from "../../src/app/admin/locations/location-archive-control";

const location: AdminLocation = {
  allow_pay_at_club: false, id: "a1000000-0000-4000-8000-000000000001", name: "Central Club", slug: "central-club",
  address_line1: "Street 1", address_line2: null, city: "Cluj", postal_code: "400000", country_code: "RO",
  customer_cancellation_notice_minutes: 1440, timezone: "Europe/Bucharest", currency: "RON", is_active: false, is_public: false, archived_at: null, display_order: 2,
  created_at: "2026-09-29T10:00:00Z", updated_at: "2026-09-29T10:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
  listAdminLocationOpeningHours.mockResolvedValue([]);
  installDialogMock();
});
afterEach(cleanup);

function openEditLocation(value: AdminLocation = location) {
  render(<LocationDialog location={value} inline />);
}

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
  render(<LocationDialog />);
  fireEvent.click(screen.getByRole("button", { name: "Create location" }));
  const timezone = screen.getByRole("combobox", { name: "Timezone" });
  fireEvent.focus(timezone);
  fireEvent.change(timezone, { target: { value: "Mars/Olympus" } });
  fireEvent.submit(within(screen.getByRole("dialog")).getByRole("button", { name: "Create location" }).closest("form")!);
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

it.each([0])("creates a location with default or selected notice %s", async (notice) => {
  saveLocationAction.mockResolvedValue({ ok: true, id: location.id });
  render(<LocationDialog />);
  fireEvent.click(screen.getByRole("button", { name: "Create location" }));
  expect((screen.getByLabelText("Customer cancellation notice") as HTMLSelectElement).value).toBe("1440");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Club" } });
  const timezone = screen.getByRole("combobox", { name: "Timezone" });
  fireEvent.focus(timezone);
  fireEvent.change(timezone, { target: { value: "buch" } });
  fireEvent.keyDown(timezone, { key: "Enter" });
  fireEvent.change(screen.getByLabelText("Customer cancellation notice"), { target: { value: String(notice) } });
  expect(screen.queryByLabelText("Public booking")).toBeNull();
  fireEvent.submit(within(screen.getByRole("dialog")).getByRole("button", { name: "Create location" }).closest("form")!);
  await waitFor(() => expect(saveLocationAction).toHaveBeenCalledOnce());
  expect(saveLocationAction.mock.calls[0][0].fields.customer_cancellation_notice_minutes).toBe(notice);
  expect(saveLocationAction.mock.calls[0][0].fields.is_public).toBe(false);
  expect(push).toHaveBeenCalledWith(`/admin/locations/${location.id}`);
  expect(screen.queryByRole("dialog")).toBeNull();
});
