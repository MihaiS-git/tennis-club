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
import { LocationArchiveControl } from "../../src/app/admin/locations/location-archive-control";

const location: AdminLocation = { id: "a1000000-0000-4000-8000-000000000001", name: "Central Club", slug: "central-club",
  address_line1: "Street 1", address_line2: null, city: "Cluj", postal_code: "400000", country_code: "RO",
  timezone: "Europe/Bucharest", currency: "RON", is_active: false, archived_at: null, display_order: 2,
  created_at: "2026-09-29T10:00:00Z", updated_at: "2026-09-29T10:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
  listAdminOpeningHours.mockResolvedValue([]);
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
});
afterEach(cleanup);

it("renders one compact management row per location without repeated cards or expanded weekly schedules", async () => {
  listAdminLocations.mockResolvedValue([location, { ...location, id: "other", name: "North", is_active: true }]);
  render(await AdminLocationsPage({}));
  expect(screen.getByRole("heading", { name: "Locations" })).toBeTruthy();
  expect(screen.queryByRole("navigation", { name: "Admin navigation" })).toBeNull();
  expect(screen.queryByText("2 locations")).toBeNull();
  expect(screen.queryAllByRole("article")).toHaveLength(0);
  expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(3);
  const row = within(screen.getByRole("table")).getAllByRole("row")[1];
  expect(within(row).getByText("Central Club")).toBeTruthy();
  expect(within(row).getByText("Inactive")).toBeTruthy();
  expect(within(row).queryByRole("button", { name: /status/i })).toBeNull();
  expect(within(within(screen.getByRole("table")).getAllByRole("row")[2]).getByText("Active")).toBeTruthy();
  expect(within(row).getByText("🇷🇴 Romania")).toBeTruthy();
  expect(within(screen.getByRole("table")).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
    "Location", "Status", "City / Country", "Timezone", "Currency",
  ]);
  expect(within(row).queryByText("Not configured")).toBeNull();
  expect(screen.getByRole("button", { name: "Create location" })).toBeTruthy();
  expect(row.getAttribute("tabindex")).toBe("0");
  expect(row.getAttribute("aria-label")).toBe("Edit location Central Club");
  expect(within(row).queryAllByRole("button")).toHaveLength(0);
  expect(within(screen.getByRole("table")).queryByRole("columnheader", { name: "Order" })).toBeNull();
  expect(screen.getByRole("link", { name: "Archived" }).getAttribute("href")).toBe("/admin/locations?view=archived");
  expect(screen.getByRole("list", { name: "Locations" }).className).toContain("lg:hidden");
  expect(screen.getByRole("table").parentElement?.className).toContain("max-lg:hidden");
  expect(screen.getByRole("table").parentElement?.className).not.toContain("overflow-x-auto");
  expect(screen.getByRole("table").outerHTML).not.toContain("sticky");
});

it.each([false, true])("exposes every editable field and exactly five currencies (editing=%s)", (editing) => {
  render(<LocationDialog location={editing ? location : undefined} />);
  fireEvent.click(screen.getByRole("button", { name: editing ? "Edit location Central Club" : "Create location" }));
  for (const label of ["Name", "Address line 1", "Address line 2", "City", "Postal code", "Country", "Timezone", "Currency", "Status"]) {
    expect(screen.getByLabelText(label)).toBeTruthy();
  }
  const currency = screen.getByRole("combobox", { name: "Currency" });
  expect(within(currency).getAllByRole("option").map((option) => [option.getAttribute("value"), option.textContent])).toEqual([
    ["EUR", "🇪🇺 EUR — Euro"], ["USD", "🇺🇸 USD — US Dollar"], ["GBP", "🇬🇧 GBP — Pound sterling"],
    ["RON", "🇷🇴 RON — Romanian leu"], ["CHF", "🇨🇭 CHF — Swiss franc"],
  ]);
  expect(currency.getAttribute("name")).toBe("currency");
  expect((currency as HTMLSelectElement).value).toBe(editing ? "RON" : "EUR");
  expect(screen.queryByLabelText(/slug/i)).toBeNull();
  expect(screen.queryByLabelText("Display order")).toBeNull();
  expect((screen.getByLabelText("Country") as HTMLInputElement).value).toBe(editing ? "🇷🇴 Romania" : "Not specified");
  expect((screen.getByLabelText("Timezone") as HTMLInputElement).value).toMatch(editing ? /^UTC[+-]\d{2}:\d{2} · Europe\/Bucharest$/ : /^$/);
  expect(screen.getByRole("combobox", { name: "Country" }).getAttribute("aria-autocomplete")).toBe("list");
  expect(screen.getByRole("combobox", { name: "Timezone" }).getAttribute("aria-autocomplete")).toBe("list");
  expect(within(screen.getByRole("dialog")).getAllByRole("button", { name: "Close" })).toHaveLength(1);
  expect(within(screen.getByRole("dialog")).getAllByRole("button", { name: "Save location" })).toHaveLength(1);
});

it("uses the same ordered fields for Create and Edit", () => {
  const labels = () => [...screen.getByRole("dialog").querySelectorAll("form label")].map((label) => label.textContent);
  const create = render(<LocationDialog />);
  fireEvent.click(screen.getByRole("button", { name: "Create location" }));
  const createLabels = labels();
  expect(createLabels).toEqual(["Name", "Address line 1", "Address line 2", "City", "Postal code", "Country", "Timezone", "Currency", "Status"]);
  create.unmount();
  render(<LocationDialog location={location} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit location Central Club" }));
  expect(labels()).toEqual(createLabels);
  expect(screen.queryByLabelText("Display order")).toBeNull();
});

it("submits edits including reactivation while preserving the stored order", async () => {
  saveLocationAction.mockResolvedValue({ ok: true, id: location.id });
  render(<LocationDialog location={location} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit location Central Club" }));
  expect(document.body.style.overflow).toBe("hidden");
  expect(document.documentElement.style.overflow).toBe("hidden");
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "true" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save location" }).closest("form")!);
  await waitFor(() => expect(saveLocationAction).toHaveBeenCalledOnce());
  expect(saveLocationAction.mock.calls[0][0]).toEqual({ id: location.id, fields: {
    name: location.name, address_line1: "Street 1", address_line2: "", city: "Cluj", postal_code: "400000",
    country_code: "RO", timezone: location.timezone, currency: "RON", is_active: true, display_order: 2,
  } });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.body.style.overflow).toBe(""));
  expect(document.documentElement.style.overflow).toBe("");
});

it("creates a location with the existing default order and no order control", async () => {
  saveLocationAction.mockResolvedValue({ ok: true, id: location.id });
  render(<LocationDialog />);
  fireEvent.click(screen.getByRole("button", { name: "Create location" }));
  expect(screen.queryByLabelText("Display order")).toBeNull();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "East Club" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save location" }).closest("form")!);
  await waitFor(() => expect(saveLocationAction).toHaveBeenCalledOnce());
  expect(saveLocationAction.mock.calls[0][0].fields.display_order).toBe(0);
});

it("shows inline validation and keeps form values", async () => {
  saveLocationAction.mockResolvedValue({ ok: false, reason: "invalid-input", fieldErrors: { timezone: "Enter an IANA timezone." } });
  render(<LocationDialog location={location} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit location Central Club" }));
  const timezone = screen.getByRole("combobox", { name: "Timezone" });
  fireEvent.focus(timezone);
  fireEvent.change(timezone, { target: { value: "paris" } });
  fireEvent.keyDown(timezone, { key: "Enter" });
  fireEvent.submit(screen.getByRole("button", { name: "Save location" }).closest("form")!);
  await waitFor(() => expect(screen.getByText("Enter an IANA timezone.")).toBeTruthy());
  expect((screen.getByLabelText("Timezone") as HTMLInputElement).value).toMatch(/^UTC[+-]\d{2}:\d{2} · Europe\/Paris$/);
  expect(screen.getByLabelText("Timezone").getAttribute("aria-invalid")).toBe("true");
});

it("prevents duplicate submissions and disables controls while pending", async () => {
  let resolve!: (value: { ok: true; id: string }) => void;
  saveLocationAction.mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<LocationDialog location={location} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit location Central Club" }));
  const form = screen.getByRole("button", { name: "Save location" }).closest("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(saveLocationAction).toHaveBeenCalledOnce();
  expect(form.querySelector("fieldset")?.disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Close" }).hasAttribute("disabled")).toBe(true);
  resolve({ ok: true, id: location.id });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("offers runtime IANA timezones and preserves a stored accepted alias", () => {
  render(<LocationDialog location={{ ...location, timezone: "US/Eastern" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit location Central Club" }));
  const selector = screen.getByRole("combobox", { name: "Timezone" }) as HTMLInputElement;
  expect(selector.value).toMatch(/^UTC[+-]\d{2}:\d{2} · US\/Eastern$/);
  fireEvent.focus(selector);
  const list = screen.getByRole("listbox", { name: "Timezones" });
  expect(within(list).getByRole("option", { name: / · US\/Eastern$/ }).getAttribute("aria-selected")).toBe("true");
  expect(within(list).getByRole("option", { name: / · Europe\/Bucharest$/ })).toBeTruthy();
  expect(within(list).getAllByRole("option").length).toBeGreaterThan(100);
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

it("shows the runtime offset in the closed timezone control and supports offset search", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
  try {
    render(<LocationDialog location={location} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit location Central Club" }));
    const timezone = screen.getByRole("combobox", { name: "Timezone" }) as HTMLInputElement;
    expect(timezone.value).toBe("UTC+03:00 · Europe/Bucharest");
    expect((document.querySelector('input[name="timezone"]') as HTMLInputElement).value).toBe("Europe/Bucharest");
    fireEvent.focus(timezone);
    fireEvent.change(timezone, { target: { value: "+03" } });
    expect(within(screen.getByRole("listbox", { name: "Timezones" })).getByRole("option", { name: "UTC+03:00 · Europe/Bucharest" })).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

it.each(["EUR", "USD", "GBP", "RON", "CHF"])("stores currency code %s after selecting its display label", async (code) => {
  saveLocationAction.mockResolvedValue({ ok: true, id: location.id });
  render(<LocationDialog location={location} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit location Central Club" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Currency" }), { target: { value: code } });
  fireEvent.submit(screen.getByRole("button", { name: "Save location" }).closest("form")!);
  await waitFor(() => expect(saveLocationAction.mock.calls[0][0].fields.currency).toBe(code));
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

it("filters countries by name and submits the selected ISO code", async () => {
  saveLocationAction.mockResolvedValue({ ok: true, id: location.id });
  render(<LocationDialog location={location} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit location Central Club" }));
  const country = screen.getByRole("combobox", { name: "Country" }) as HTMLInputElement;
  expect(country.value).toBe("🇷🇴 Romania");
  fireEvent.focus(country);
  fireEvent.change(country, { target: { value: "rom" } });
  const option = within(screen.getByRole("listbox", { name: "Countries" })).getByRole("option", { name: "🇷🇴 Romania" });
  expect(option.getAttribute("aria-selected")).toBe("true");
  fireEvent.click(option);
  expect(country.value).toBe("🇷🇴 Romania");
  expect((document.querySelector('input[name="country_code"]') as HTMLInputElement).value).toBe("RO");
  fireEvent.submit(screen.getByRole("button", { name: "Save location" }).closest("form")!);
  await waitFor(() => expect(saveLocationAction.mock.calls[0][0].fields.country_code).toBe("RO"));
});

it("keeps the selected country and timezone on Escape after searching", () => {
  render(<LocationDialog location={location} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit location Central Club" }));
  for (const [label, searchText, expected] of [
    ["Country", "united", "🇷🇴 Romania"], ["Timezone", "paris", "Europe/Bucharest"],
  ]) {
    const input = screen.getByRole("combobox", { name: label }) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: searchText } });
    fireEvent.keyDown(input, { key: "Escape" });
    if (label === "Timezone") expect(input.value).toMatch(/^UTC[+-]\d{2}:\d{2} · Europe\/Bucharest$/);
    else expect(input.value).toBe(expected);
  }
  expect((document.querySelector('input[name="country_code"]') as HTMLInputElement).value).toBe("RO");
  expect((document.querySelector('input[name="timezone"]') as HTMLInputElement).value).toBe("Europe/Bucharest");
});

it("selects a searched country by keyboard and stores the ISO code", () => {
  render(<LocationDialog location={location} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit location Central Club" }));
  const country = screen.getByRole("combobox", { name: "Country" }) as HTMLInputElement;
  fireEvent.focus(country);
  fireEvent.change(country, { target: { value: "united king" } });
  const option = within(screen.getByRole("listbox", { name: "Countries" })).getByRole("option", { name: "🇬🇧 United Kingdom" });
  expect(country.getAttribute("aria-activedescendant")).toBe(option.id);
  fireEvent.keyDown(country, { key: "Enter" });
  expect(country.value).toBe("🇬🇧 United Kingdom");
  expect((document.querySelector('input[name="country_code"]') as HTMLInputElement).value).toBe("GB");
});

it("opens the full editor from the desktop location identity and orders rows by name", async () => {
  listAdminLocations.mockResolvedValue([{ ...location, id: "north", name: "North" }, location]);
  render(await AdminLocationsPage({}));
  const table = screen.getByRole("table", { name: "Locations" });
  const toolbar = screen.getByRole("link", { name: "Archived" }).parentElement;
  expect(screen.getByRole("button", { name: "Create location" }).parentElement?.parentElement).toBe(toolbar);
  expect(toolbar?.nextElementSibling?.contains(table)).toBe(true);
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows[0].getAttribute("aria-label")).toBe("Edit location Central Club");
  expect(rows[1].getAttribute("aria-label")).toBe("Edit location North");
  fireEvent.click(rows[0]);
  const dialog = screen.getByRole("dialog", { name: "Edit location" });
  expect(within(dialog).getByRole("button", { name: "Archive Central Club" })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit location" })).toBeNull());
});

it("opens Edit location for the clicked rendered row", async () => {
  listAdminLocations.mockResolvedValue([location, { ...location, id: "b1000000-0000-4000-8000-000000000002", name: "North" }]);
  render(await AdminLocationsPage({}));
  const rows = within(screen.getByRole("table", { name: "Locations" })).getAllByRole("row").slice(1);
  fireEvent.click(rows[1]);
  const dialog = screen.getByRole("dialog", { name: "Edit location" });
  expect((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("North");
  for (const name of ["Manage opening hours", "Archive North"]) {
    const button = within(dialog).getByRole("button", { name }) as HTMLButtonElement;
    expect(button.type).toBe("button");
    expect(button.form).toBeNull();
  }
});

it.each(["Enter", " "])("opens the row editor with %s and returns focus to the row", async (key) => {
  listAdminLocations.mockResolvedValue([location]);
  render(await AdminLocationsPage({}));
  const row = within(screen.getByRole("table", { name: "Locations" })).getAllByRole("row")[1];
  row.focus();
  fireEvent.keyDown(row, { key });
  const dialog = screen.getByRole("dialog", { name: "Edit location" });
  expect(within(dialog).getByLabelText("Country")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit location" })).toBeNull());
  expect(document.activeElement).toBe(row);
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

it("opens the same editor from read-only table fields", async () => {
  listAdminLocations.mockResolvedValue([location]);
  render(await AdminLocationsPage({}));
  const row = within(screen.getByRole("table", { name: "Locations" })).getAllByRole("row")[1];
  for (const value of ["Inactive", "🇷🇴 Romania", "Europe/Bucharest", "RON"]) {
    fireEvent.click(within(row).getByText(value));
    const dialog = screen.getByRole("dialog", { name: "Edit location" });
    expect(within(dialog).getByRole("button", { name: "Save location" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit location" })).toBeNull());
  }
  expect(within(row).queryAllByRole("button")).toHaveLength(0);
  for (const cell of row.querySelectorAll("td")) {
    expect(cell.hasAttribute("onclick")).toBe(false);
    expect(cell.hasAttribute("tabindex")).toBe(false);
    expect(cell.getAttribute("role")).not.toBe("button");
  }
});

it("shows a concise mobile list and opens the location editor", async () => {
  listAdminLocations.mockResolvedValue([location]);
  render(await AdminLocationsPage({}));
  const list = screen.getByRole("list", { name: "Locations" });
  const item = within(list).getByRole("listitem");
  expect(item.textContent).toContain("Cluj, Romania");
  expect(item.textContent).not.toContain("Not configured");
  expect(item.textContent).toContain("Inactive");
  expect(within(item).queryByRole("button", { name: /status/i })).toBeNull();
  expect(within(item).queryAllByRole("button")).toHaveLength(0);
  fireEvent.click(item);
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

it("archives through a focused confirmation and restores through the archived view", async () => {
  archiveLocationAction.mockResolvedValue({ ok: true, id: location.id });
  render(<LocationArchiveControl id={location.id} name={location.name} archived={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Archive Central Club" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
  await waitFor(() => expect(archiveLocationAction).toHaveBeenCalledWith({ id: location.id, archived: true }));
  cleanup();
  render(<LocationArchiveControl id={location.id} name={location.name} archived />);
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(archiveLocationAction).toHaveBeenCalledWith({ id: location.id, archived: false }));
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("keeps archive confirmation open with contextual safe feedback on failure", async () => {
  archiveLocationAction.mockRejectedValue(new Error("private database error"));
  render(<LocationArchiveControl id={location.id} name={location.name} archived={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Archive Central Club" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Unable to archive"));
  expect(screen.getByRole("dialog", { name: "Archive Central Club" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).not.toContain("private database error");
});

it("shows archived records only in the archived view", async () => {
  listAdminLocations.mockResolvedValue([{ ...location, archived_at: "2026-09-30T10:00:00Z", is_active: false }]);
  render(await AdminLocationsPage({ searchParams: Promise.resolve({ view: "archived" }) }));
  expect(listAdminLocations).toHaveBeenCalledWith(undefined, "archived");
  expect(screen.getByRole("link", { name: "Current locations" }).getAttribute("href")).toBe("/admin/locations");
  expect(screen.getByRole("table", { name: "Archived locations" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create location" })).toBeNull();
  const row = within(screen.getByRole("table", { name: "Archived locations" })).getAllByRole("row")[1];
  fireEvent.click(row);
  const dialog = screen.getByRole("dialog", { name: "Edit location" });
  const restore = within(dialog).getByRole("button", { name: "Restore" }) as HTMLButtonElement;
  expect(restore.type).toBe("button");
  expect(restore.form).toBeNull();
  expect(restore.parentElement?.querySelector("p")).toBeNull();
  expect(within(dialog).getByLabelText("Name").closest("fieldset")?.disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Save location" })).toBeNull();
});

it("shows a Restore error only when restoring fails", async () => {
  archiveLocationAction.mockRejectedValue(new Error("private database error"));
  render(<LocationArchiveControl id={location.id} name={location.name} archived />);
  const restore = screen.getByRole("button", { name: "Restore" });
  expect(restore.parentElement?.querySelector("p")).toBeNull();
  fireEvent.click(restore);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Unable to restore"));
  expect(screen.getByRole("alert").textContent).not.toContain("private database error");
});

it("opens the existing weekly schedule for the edited location", async () => {
  listAdminLocations.mockResolvedValue([location]);
  listAdminOpeningHours.mockResolvedValue(Array.from({ length: 7 }, (_, weekday) => ({
    id: `${location.id}-${weekday}`, location_id: location.id, weekday, opens_at_minute: 420, closes_at_minute: 1440,
    created_at: location.created_at, updated_at: location.updated_at,
  })));
  render(await AdminLocationsPage({}));
  const row = within(screen.getByRole("table")).getAllByRole("row")[1];
  expect(within(row).queryByText("Daily · 07:00–24:00")).toBeNull();
  fireEvent.click(row);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Edit location" })).getByRole("button", { name: "Manage opening hours" }));
  const hours = screen.getByRole("dialog", { name: "Central Club opening hours" });
  expect(within(hours).getByText("Daily")).toBeTruthy();
  expect(within(hours).getByRole("button", { name: "Weekdays" })).toBeTruthy();
});

it("keeps Archive and Restore available inside Edit Location", async () => {
  listAdminLocations.mockResolvedValue([location]);
  archiveLocationAction.mockResolvedValue({ ok: true, id: location.id });
  render(await AdminLocationsPage({}));
  const row = within(screen.getByRole("table")).getAllByRole("row")[1];
  fireEvent.click(row);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Edit location" })).getByRole("button", { name: "Archive Central Club" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Archive Central Club" })).getByRole("button", { name: "Confirm archive" }));
  await waitFor(() => expect(archiveLocationAction).toHaveBeenCalledWith({ id: location.id, archived: true }));
  cleanup();
  listAdminLocations.mockResolvedValue([{ ...location, archived_at: "2026-09-30T10:00:00Z", is_active: false }]);
  render(await AdminLocationsPage({ searchParams: Promise.resolve({ view: "archived" }) }));
  fireEvent.click(within(screen.getByRole("table", { name: "Archived locations" })).getAllByRole("row")[1]);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Edit location" })).getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(archiveLocationAction).toHaveBeenCalledWith({ id: location.id, archived: false }));
});
