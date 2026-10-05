// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminLocation } from "../../src/lib/admin/locations";

const { listAdminLocations, listAdminOpeningHours, saveLocationAction, archiveLocationAction, refresh } = vi.hoisted(() => ({
  listAdminLocations: vi.fn(), listAdminOpeningHours: vi.fn(), saveLocationAction: vi.fn(), archiveLocationAction: vi.fn(), refresh: vi.fn(),
}));
vi.mock("../../src/lib/admin/locations", () => ({ listAdminLocations }));
vi.mock("../../src/lib/admin/opening-hours", () => ({ listAdminOpeningHours }));
vi.mock("../../src/app/admin/locations/actions", () => ({ saveLocationAction, archiveLocationAction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
import AdminLocationsPage from "../../src/app/admin/locations/page";
import { LocationDialog } from "../../src/app/admin/locations/location-dialog";
import { LocationItem } from "../../src/app/admin/locations/location-item";
import { LocationArchiveControl } from "../../src/app/admin/locations/location-archive-control";

const location: AdminLocation = {
  allow_pay_at_club: false, id: "a1000000-0000-4000-8000-000000000001", name: "Central Club", slug: "central-club",
  address_line1: "Street 1", address_line2: null, city: "Cluj", postal_code: "400000", country_code: "RO",
  customer_cancellation_notice_minutes: 1440, timezone: "Europe/Bucharest", currency: "RON", is_active: false, is_public: false, archived_at: null, display_order: 2,
  created_at: "2026-09-29T10:00:00Z", updated_at: "2026-09-29T10:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
  listAdminOpeningHours.mockResolvedValue([]);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
});
afterEach(cleanup);

function openEditLocation(value: AdminLocation = location) {
  render(<table><tbody><LocationItem location={value} intervals={[]} /></tbody></table>);
  fireEvent.click(screen.getByRole("row", { name: `Edit location ${value.name}` }));
  return screen.getByRole("dialog", { name: "Edit location" });
}

it("enables location Save only while normalized fields differ, including after a failed save", async () => {
  saveLocationAction.mockResolvedValue({ ok: false, reason: "invalid-input", fieldErrors: { name: "Choose another name." } });
  openEditLocation();
  const save = screen.getByRole("button", { name: "Save location" }) as HTMLButtonElement;
  const name = screen.getByLabelText("Name") as HTMLInputElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(name, { target: { value: " Central Club " } });
  expect(save.disabled).toBe(true);
  fireEvent.change(name, { target: { value: "West Club" } });
  expect(save.disabled).toBe(false);
  fireEvent.submit(save.closest("form")!);
  await waitFor(() => expect(screen.getByText("Choose another name.")).toBeTruthy());
  expect(name.value).toBe("West Club");
  expect(save.disabled).toBe(false);
  fireEvent.change(name, { target: { value: "Central Club" } });
  expect(save.disabled).toBe(true);
});

it("keeps publication enabled in the form after server readiness rejects it", async () => {
  saveLocationAction.mockResolvedValue({ ok: false, reason: "not-ready",
    message: "This location cannot be published yet. Configure pricing for every active court." });
  openEditLocation();
  const publication = screen.getByLabelText("Public booking") as HTMLSelectElement;
  fireEvent.change(publication, { target: { value: "true" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save location" }).closest("form")!);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Configure pricing"));
  expect(publication.value).toBe("true");
  expect(saveLocationAction.mock.calls[0][0].fields.is_public).toBe(true);
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
it("keeps a rejected location deactivation in its confirmation dialog", async () => {
  saveLocationAction.mockResolvedValue({ ok: false, reason: "not-found" });
  openEditLocation({ ...location, is_active: true });
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "false" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save location" }).closest("form")!);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Deactivate Central Club?" })).getByRole("button", { name: "Deactivate location" }));
  await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Deactivate Central Club?" })).getByRole("alert").textContent).toContain("no longer exists"));
  expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("false");
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

it("finds Bucharest by timezone search and stores the selected IANA identifier", () => {
  render(<LocationDialog />);
  fireEvent.click(screen.getByRole("button", { name: "Create location" }));
  const timezone = screen.getByRole("combobox", { name: "Timezone" }) as HTMLInputElement;
  fireEvent.focus(timezone);
  fireEvent.change(timezone, { target: { value: "buch" } });
  const option = within(screen.getByRole("listbox", { name: "Timezones" })).getByRole("option", { name: / · Europe\/Bucharest$/ });
  expect(option).toBeTruthy();
  fireEvent.keyDown(timezone, { key: "Enter" });
  expect(timezone.value).toMatch(/^UTC[+-]\d{2}:\d{2} · Europe\/Bucharest$/);
  expect((document.querySelector('input[name="timezone"]') as HTMLInputElement).value).toBe("Europe/Bucharest");
});

it("never submits arbitrary timezone search text as a timezone value", async () => {
  saveLocationAction.mockResolvedValue({ ok: false, reason: "invalid-input", fieldErrors: { timezone: "Select a timezone." } });
  render(<LocationDialog />);
  fireEvent.click(screen.getByRole("button", { name: "Create location" }));
  const timezone = screen.getByRole("combobox", { name: "Timezone" });
  fireEvent.focus(timezone);
  fireEvent.change(timezone, { target: { value: "Mars/Olympus" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save location" }).closest("form")!);
  await waitFor(() => expect(saveLocationAction).toHaveBeenCalledOnce());
  expect(saveLocationAction.mock.calls[0][0].fields.timezone).toBe("");
});

it.each(["Enter", " "])("opens the mobile item editor with %s", async (key) => {
  listAdminLocations.mockResolvedValue([location]);
  render(await AdminLocationsPage({}));
  const item = within(screen.getByRole("list", { name: "Locations" })).getByRole("listitem");
  item.focus();
  fireEvent.keyDown(item, { key });
  const dialog = screen.getByRole("dialog", { name: "Edit location" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit location" })).toBeNull());
});

it("opens the existing hours dialog from mobile Edit Location and preserves unsaved fields", async () => {
  listAdminLocations.mockResolvedValue([location]);
  render(await AdminLocationsPage({}));
  const item = within(screen.getByRole("list", { name: "Locations" })).getByRole("listitem");
  fireEvent.click(item);
  const editDialog = screen.getByRole("dialog", { name: "Edit location" });
  fireEvent.change(within(editDialog).getByRole("textbox", { name: "Name" }), { target: { value: "Unsaved name" } });
  fireEvent.click(within(editDialog).getByRole("button", { name: "Manage opening hours" }));
  const dialog = screen.getByRole("dialog", { name: "Central Club opening hours" });
  expect(dialog).toBeTruthy();
  expect(within(dialog).getAllByRole("button", { name: "Close" })).toHaveLength(1);
  expect(screen.getByRole("dialog", { name: "Edit location" })).toBe(editDialog);
  expect(document.body.style.overflow).toBe("hidden");
  expect(document.documentElement.style.overflow).toBe("hidden");
  expect(getComputedStyle(dialog).overflowY).toBe("auto");
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Central Club opening hours" })).toBeNull());
  expect((within(editDialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Unsaved name");
  expect(document.body.style.overflow).toBe("hidden");
  expect(document.documentElement.style.overflow).toBe("hidden");
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

it("edits cancellation notice in Booking policy and submits integer minutes", async () => {
  saveLocationAction.mockResolvedValue({ ok: true, id: location.id });
  openEditLocation();
  expect(screen.getByText("Booking policy")).toBeTruthy();
  const notice = screen.getByLabelText("Customer cancellation notice") as HTMLSelectElement;
  expect(notice.value).toBe("1440");
  fireEvent.change(notice, { target: { value: "120" } });
  const save = screen.getByRole("button", { name: "Save location" }) as HTMLButtonElement;
  expect(save.disabled).toBe(false);
  fireEvent.submit(save.closest("form")!);
  await waitFor(() => expect(saveLocationAction).toHaveBeenCalledOnce());
  expect(saveLocationAction.mock.calls[0][0]).toMatchObject({ id: location.id,
    fields: { customer_cancellation_notice_minutes: 120 } });
});

it.each([1440, 0])("creates a location with default or selected notice %s", async (notice) => {
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
  fireEvent.submit(screen.getByRole("button", { name: "Save location" }).closest("form")!);
  await waitFor(() => expect(saveLocationAction).toHaveBeenCalledOnce());
  expect(saveLocationAction.mock.calls[0][0].fields.customer_cancellation_notice_minutes).toBe(notice);
});

it("preserves non-preset saved minutes and contextual policy errors", async () => {
  saveLocationAction.mockResolvedValue({ ok: false, reason: "invalid-input",
    fieldErrors: { customer_cancellation_notice_minutes: "Check cancellation notice." } });
  openEditLocation({ ...location, customer_cancellation_notice_minutes: 90 });
  const notice = screen.getByLabelText("Customer cancellation notice") as HTMLSelectElement;
  expect(notice.value).toBe("90");
  fireEvent.change(notice, { target: { value: "60" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save location" }).closest("form")!);
  await waitFor(() => expect(screen.getByText("Check cancellation notice.")).toBeTruthy());
  expect(notice.value).toBe("60");
  expect(notice.getAttribute("aria-invalid")).toBe("true");
});
