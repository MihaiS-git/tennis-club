// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminLocation } from "../../src/lib/admin/locations";

const { listAdminLocations, saveLocationAction } = vi.hoisted(() => ({ listAdminLocations: vi.fn(), saveLocationAction: vi.fn() }));
vi.mock("../../src/lib/admin/locations", () => ({ listAdminLocations }));
vi.mock("../../src/app/admin/locations/actions", () => ({ saveLocationAction }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
import AdminLocationsPage from "../../src/app/admin/locations/page";
import { LocationDialog } from "../../src/app/admin/locations/location-dialog";

const location: AdminLocation = { id: "a1000000-0000-4000-8000-000000000001", name: "Central Club", slug: "central-club",
  address_line1: "Street 1", address_line2: null, city: "Cluj", postal_code: "400000", country_code: "RO",
  timezone: "Europe/Bucharest", currency: "RON", is_active: false, display_order: 2,
  created_at: "2026-09-29T10:00:00Z", updated_at: "2026-09-29T10:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
});
afterEach(cleanup);

it("renders records and visibly distinguishes inactive locations in desktop and mobile views", async () => {
  listAdminLocations.mockResolvedValue([location, { ...location, id: "other", name: "North", is_active: true }]);
  render(await AdminLocationsPage());
  expect(screen.getByRole("heading", { name: "Locations" })).toBeTruthy();
  expect(screen.getByText("2 locations")).toBeTruthy();
  const row = within(screen.getByRole("table")).getAllByRole("row")[1];
  expect(within(row).getByText("Central Club")).toBeTruthy();
  expect(within(row).getByText("Inactive").className).toContain("text-danger");
  expect(within(screen.getAllByRole("article")[0]).getByText("Inactive")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create location" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Edit location" })).toHaveLength(4);
});

it.each([false, true])("exposes every editable field and exactly five currencies (editing=%s)", (editing) => {
  render(<LocationDialog location={editing ? location : undefined} />);
  fireEvent.click(screen.getByRole("button", { name: editing ? "Edit location" : "Create location" }));
  for (const label of ["Name", "Address line 1", "Address line 2", "City", "Postal code", "Country", "Timezone", "Currency", "Status", "Display order"]) {
    expect(screen.getByLabelText(label)).toBeTruthy();
  }
  const currency = screen.getByRole("combobox", { name: "Currency" });
  expect(within(currency).getAllByRole("option").map((option) => [option.getAttribute("value"), option.textContent])).toEqual([
    ["EUR", "EUR — Euro"], ["USD", "USD — US Dollar"], ["GBP", "GBP — British Pound"], ["RON", "RON — Romanian Leu"], ["CHF", "CHF — Swiss Franc"],
  ]);
  expect(currency.getAttribute("name")).toBe("currency");
  expect((currency as HTMLSelectElement).value).toBe(editing ? "RON" : "EUR");
  expect(screen.queryByLabelText(/slug/i)).toBeNull();
  expect((screen.getByLabelText("Country") as HTMLSelectElement).value).toBe(editing ? "RO" : "");
});

it("submits edits including reactivation and ordering without sending a slug", async () => {
  saveLocationAction.mockResolvedValue({ ok: true, id: location.id });
  render(<LocationDialog location={location} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit location" }));
  fireEvent.change(screen.getByLabelText("Status"), { target: { value: "true" } });
  fireEvent.change(screen.getByLabelText("Display order"), { target: { value: "4" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save location" }).closest("form")!);
  await waitFor(() => expect(saveLocationAction).toHaveBeenCalledOnce());
  expect(saveLocationAction.mock.calls[0][0]).toEqual({ id: location.id, fields: {
    name: location.name, address_line1: "Street 1", address_line2: "", city: "Cluj", postal_code: "400000",
    country_code: "RO", timezone: location.timezone, currency: "RON", is_active: true, display_order: 4,
  } });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("shows inline validation and keeps form values", async () => {
  saveLocationAction.mockResolvedValue({ ok: false, reason: "invalid-input", fieldErrors: { timezone: "Enter an IANA timezone." } });
  render(<LocationDialog location={location} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit location" }));
  fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "bad-timezone" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save location" }).closest("form")!);
  await waitFor(() => expect(screen.getByText("Enter an IANA timezone.")).toBeTruthy());
  expect((screen.getByLabelText("Timezone") as HTMLInputElement).value).toBe("bad-timezone");
  expect(screen.getByLabelText("Timezone").getAttribute("aria-invalid")).toBe("true");
});

it("prevents duplicate submissions and disables controls while pending", async () => {
  let resolve!: (value: { ok: true; id: string }) => void;
  saveLocationAction.mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<LocationDialog location={location} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit location" }));
  const form = screen.getByRole("button", { name: "Save location" }).closest("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(saveLocationAction).toHaveBeenCalledOnce();
  expect(form.querySelector("fieldset")?.disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Close" }).hasAttribute("disabled")).toBe(true);
  resolve({ ok: true, id: location.id });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
