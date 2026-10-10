// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Toaster, toast } from "sonner";
import { installDialogMock } from "../helpers/dialog";
import type { AdminLocation } from "../../src/lib/admin/locations";
import type { AdminCourt } from "../../src/lib/admin/courts";

const mocks = vi.hoisted(() => ({
  locations: vi.fn(), readiness: vi.fn(), courts: vi.fn(), coverage: vi.fn(), hours: vi.fn(), pricing: vi.fn(),
  saveLocation: vi.fn(), publication: vi.fn(), archive: vi.fn(), saveCourt: vi.fn(), saveCoverage: vi.fn(), removeCoverage: vi.fn(),
  savePricing: vi.fn(), removePricing: vi.fn(), saveHours: vi.fn(), checkHoursRemoval: vi.fn(), push: vi.fn(), refresh: vi.fn(),
}));
vi.mock("../../src/lib/admin/locations", () => ({ listAdminLocations: mocks.locations, listAdminLocationsWithReadiness: mocks.readiness }));
vi.mock("../../src/lib/admin/courts", () => ({ listAdminCourts: mocks.courts }));
vi.mock("../../src/lib/admin/court-coverage", () => ({ listAdminCourtCoverage: mocks.coverage }));
vi.mock("../../src/lib/admin/opening-hours", () => ({ listAdminLocationOpeningHours: mocks.hours }));
vi.mock("../../src/lib/admin/pricing", () => ({ listAdminPricingRules: mocks.pricing }));
vi.mock("../../src/app/admin/locations/actions", () => ({ saveLocationAction: mocks.saveLocation, setLocationPublicationAction: mocks.publication, archiveLocationAction: mocks.archive }));
vi.mock("../../src/app/admin/locations/opening-hours-actions", () => ({ mutateOpeningHoursAction: mocks.saveHours, checkOpeningHoursRemovalAction: mocks.checkHoursRemoval }));
vi.mock("../../src/app/admin/courts/actions", () => ({ saveCourtAction: mocks.saveCourt, saveCoverageAction: mocks.saveCoverage, removeCoverageAction: mocks.removeCoverage }));
vi.mock("../../src/app/admin/pricing/actions", () => ({ savePricingRuleAction: mocks.savePricing, removePricingRuleAction: mocks.removePricing }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
  usePathname: () => window.location.pathname,
  // Next integrates native History updates with useSearchParams. This mock
  // subscribes to the synthetic popstate dispatched by our history spy below.
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(
    (callback) => { window.addEventListener("popstate", callback); return () => window.removeEventListener("popstate", callback); },
    () => window.location.search,
  )),
}));
import LocationManagementPage from "../../src/app/admin/locations/[locationId]/page";
import { AdminNavigation } from "../../src/components/admin-navigation";
import { ProfileDepartureProvider } from "../../src/components/profile-departure-navigation";

const location: AdminLocation = {
  id: "a1000000-0000-4000-8000-000000000001", name: "Central", slug: "central", is_active: true, is_public: false,
  archived_at: null, address_line1: "Street 1", address_line2: null, city: "Cluj", postal_code: null, country_code: "RO",
  timezone: "Europe/Bucharest", currency: "RON", allow_pay_at_club: false, customer_cancellation_notice_minutes: 1440,
  display_order: 0, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
};
const other = { ...location, id: "a1000000-0000-4000-8000-000000000002", name: "North" };
const court: AdminCourt = {
  id: "a1000000-0000-4000-8000-000000000003", location_id: location.id, name: "Court One", slug: "court-one",
  is_active: true, surface: "clay", environment: "outdoor", has_lighting: false,
  created_at: location.created_at, updated_at: location.updated_at,
};
const hours = [{ id: "a1000000-0000-4000-8000-000000000004", location_id: location.id, weekday: 0,
  opens_at_minute: 480, closes_at_minute: 1200, created_at: location.created_at, updated_at: location.updated_at }];
const rule = { rule_set_id: "a1000000-0000-4000-8000-000000000005", location_id: location.id, court_ids: [court.id],
  court_state: "outdoor", weekdays: [0], starts_at_minute: 480, ends_at_minute: 600, starts_on: null, ends_on: null,
  price_per_hour_minor: 1200, created_at: location.created_at, updated_at: location.updated_at };
const url = `/admin/locations/${location.id}`;
const tab = (name: string) => fireEvent.click(within(screen.getByRole("navigation", { name: "Location management" })).getByRole("link", { name: new RegExp(`^${name}`) }));
const panel = (name: string) => screen.getByRole("region", { name });
const unload = () => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
async function workspace() {
  const content = await LocationManagementPage({ params: Promise.resolve({ locationId: location.id }) });
  return render(<ProfileDepartureProvider><AdminNavigation />{content}<Toaster /></ProfileDepartureProvider>);
}
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", url);
  const originalPush = window.history.pushState.bind(window.history);
  const originalReplace = window.history.replaceState.bind(window.history);
  vi.spyOn(window.history, "pushState").mockImplementation((...args) => { originalPush(...args); window.dispatchEvent(new PopStateEvent("popstate")); });
  vi.spyOn(window.history, "replaceState").mockImplementation((...args) => { originalReplace(...args); window.dispatchEvent(new PopStateEvent("popstate")); });
  mocks.readiness.mockResolvedValue([{ ...location, missing: [] }]);
  mocks.locations.mockResolvedValue([location, other]);
  mocks.courts.mockResolvedValue([court, { ...court, id: "a1000000-0000-4000-8000-000000000006", location_id: other.id, name: "North Court" }]);
  mocks.coverage.mockResolvedValue([]); mocks.hours.mockResolvedValue(hours); mocks.pricing.mockResolvedValue([rule]);
  mocks.saveLocation.mockResolvedValue({ ok: true, id: location.id });
  mocks.saveCourt.mockResolvedValue({ ok: true, id: court.id });
  mocks.saveCoverage.mockResolvedValue({ ok: true, id: "period" });
  mocks.removeCoverage.mockResolvedValue({ ok: true, id: "period" });
  mocks.savePricing.mockResolvedValue({ ok: true, id: rule.rule_set_id });
  mocks.removePricing.mockResolvedValue({ ok: true, id: rule.rule_set_id });
  mocks.publication.mockResolvedValue({ ok: true, id: location.id });
  installDialogMock();
});
afterEach(() => { cleanup(); act(() => toast.dismiss()); vi.restoreAllMocks(); });

it("shows all five URL tabs with only the selected content and no repeated location selector", async () => {
  await workspace();
  const nav = screen.getByRole("navigation", { name: "Location management" });
  expect(within(nav).getAllByRole("link")).toHaveLength(5);
  expect(panel("Details")).toBeTruthy();
  for (const name of ["Opening hours", "Courts", "Pricing", "Public booking"]) {
    tab(name);
    expect(panel(name)).toBeTruthy();
    expect(within(nav).getByRole("link", { name }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("region", { name: "Details" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Central" })).toBeTruthy();
  }
  expect(window.location.search).toBe("?tab=public-booking");
  expect(mocks.push).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
  tab("Courts");
  expect(within(panel("Courts")).queryByLabelText("Location")).toBeNull();
  expect(within(panel("Courts")).queryByText("North Court")).toBeNull();
  tab("Pricing");
  expect(within(panel("Pricing")).queryByLabelText("Location")).toBeNull();
  expect(mocks.hours).toHaveBeenCalledWith(location.id);
  expect(mocks.pricing).toHaveBeenCalledWith(location.id);
});

it.each(["?tab=pricing", "?tab=unknown", "?tab=pricing&tab=courts"])("resolves initial selection from %s and keeps it on data refresh", async (query) => {
  window.history.replaceState(null, "", `${url}${query}`);
  const view = await workspace();
  const expected = query === "?tab=pricing" ? "Pricing" : "Details";
  expect(panel(expected)).toBeTruthy();
  view.rerender(<ProfileDepartureProvider><AdminNavigation />{await LocationManagementPage({ params: Promise.resolve({ locationId: location.id }) })}<Toaster /></ProfileDepartureProvider>);
  expect(panel(expected)).toBeTruthy();
});

it("preserves dirty Details through tabs, browser Back/Forward and sibling refreshes", async () => {
  const view = await workspace();
  const name = screen.getByLabelText("Name");
  fireEvent.change(name, { target: { value: "Draft name" } });
  expect(unload()).toBe(true);
  tab("Opening hours"); tab("Pricing");
  await act(async () => { window.history.back(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(panel("Opening hours")).toBeTruthy();
  await act(async () => { window.history.forward(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(panel("Pricing")).toBeTruthy();
  mocks.readiness.mockResolvedValue([{ ...location, is_public: true, updated_at: "2026-10-02T00:00:00Z", missing: [] }]);
  view.rerender(<ProfileDepartureProvider><AdminNavigation />{await LocationManagementPage({ params: Promise.resolve({ locationId: location.id }) })}<Toaster /></ProfileDepartureProvider>);
  tab("Details");
  expect(screen.getByLabelText("Name")).toBe(name);
  expect(name).toHaveProperty("value", "Draft name");
  expect(unload()).toBe(true);
  expect(screen.queryByText(/^You have unsaved changes/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save location" }));
  await waitFor(() => expect(mocks.saveLocation).toHaveBeenCalled());
  expect(mocks.saveLocation.mock.calls[0][0].fields).toMatchObject({ name: "Draft name", is_public: true });
  await waitFor(() => expect(unload()).toBe(false));
});

it("uses the existing Stay/Leave protection for ordinary links leaving dirty forms", async () => {
  await workspace();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Draft name" } });
  fireEvent.click(screen.getByRole("link", { name: "Locations" }));
  await screen.findByText("You have unsaved changes in Details.");
  expect(mocks.push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stay" }));
  expect(screen.getByLabelText("Name")).toHaveProperty("value", "Draft name");
  await waitFor(() => expect(screen.queryByText("You have unsaved changes in Details.")).toBeNull());
  fireEvent.click(screen.getByRole("link", { name: "Locations" }));
  fireEvent.click(await screen.findByRole("button", { name: "Leave without saving" }));
  expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/admin/locations");
});

it("edits opening hours inline and retains its unsaved interval across tabs", async () => {
  mocks.saveHours.mockResolvedValue({ ok: true, intervals: [{ ...hours[0], opens_at_minute: 540 }] });
  await workspace(); tab("Opening hours");
  fireEvent.click(screen.getByRole("button", { name: "Edit Mon 08:00–20:00" }));
  const opening = screen.getByLabelText("Opening time");
  fireEvent.change(opening, { target: { value: "09:00" } });
  tab("Details"); tab("Opening hours");
  expect(screen.getByLabelText("Opening time")).toBe(opening);
  expect(opening).toHaveProperty("value", "09:00");
  expect(unload()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Apply changes to selected days" }));
  await screen.findByRole("button", { name: "Edit Mon 09:00–20:00" });
  expect(mocks.saveHours).toHaveBeenCalledWith({ location_id: location.id, weekdays: [0], replace_ids: [hours[0].id], intervals: [{ opens_at: "09:00", closes_at: "20:00" }] });
  expect(unload()).toBe(false);
});

it("navigates from blocked hours deletion to the current Pricing tab and hides the deletion dialog", async () => {
  mocks.checkHoursRemoval.mockResolvedValue({ ok: false, reason: "pricing-conflict", message: "Update pricing before deleting opening hours.",
    conflicts: [{ id: "conflict", rule_set_id: rule.rule_set_id, court_name: court.name, court_state: "outdoor", weekday: 0,
      starts_at_minute: 480, ends_at_minute: 600, starts_on: null, ends_on: null }] });
  await workspace(); tab("Opening hours");
  fireEvent.click(screen.getByRole("button", { name: "Remove Mon 08:00–20:00" }));
  const manage = await screen.findByRole("link", { name: "Manage conflicting pricing" });
  expect(screen.getByRole("button", { name: "Remove hours" })).toHaveProperty("disabled", true);
  fireEvent.click(manage);
  expect(window.location.pathname).toBe(url);
  expect(window.location.search).toBe("?tab=pricing");
  expect(panel("Pricing")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(mocks.saveHours).not.toHaveBeenCalled();
  // Returning from pricing allows a new authoritative dependency check.
  mocks.checkHoursRemoval.mockResolvedValue({ ok: true, intervals: hours });
  tab("Opening hours");
  fireEvent.click(screen.getByRole("button", { name: "Check dependencies again" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Remove hours" })).toHaveProperty("disabled", false));
});

it("creates a local court and edits/moves it with the existing dialog", async () => {
  await workspace(); tab("Courts");
  fireEvent.click(screen.getByRole("button", { name: "Create court" }));
  let dialog = screen.getByRole("dialog", { name: "Create court" });
  expect(within(dialog).getByLabelText("Location")).toHaveProperty("value", location.id);
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Court Two" } });
  fireEvent.submit(within(dialog).getByRole("button", { name: "Save court" }).closest("form")!);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mocks.saveCourt.mock.calls[0][0].fields).toMatchObject({ name: "Court Two", location_id: location.id });
  fireEvent.click(within(screen.getByRole("table", { name: "Central courts" })).getByRole("row", { name: "Edit court Court One" }));
  dialog = screen.getByRole("dialog", { name: "Edit court" });
  expect(within(dialog).getByRole("option", { name: "North" })).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText("Location"), { target: { value: other.id } });
  fireEvent.submit(within(dialog).getByRole("button", { name: "Save court" }).closest("form")!);
  await waitFor(() => expect(mocks.saveCourt).toHaveBeenCalledTimes(2));
  expect(mocks.saveCourt.mock.calls[1][0]).toMatchObject({ id: court.id, fields: { location_id: other.id } });
  expect(window.location.search).toBe("?tab=courts");
});

it("preserves coverage drafts through court filtering, sorting and tab selection", async () => {
  await workspace(); tab("Courts");
  const table = screen.getByRole("table", { name: "Central courts" });
  fireEvent.click(within(table).getByRole("button", { name: "Add coverage period" }));
  const start = within(table).getByLabelText("Start date");
  fireEvent.change(start, { target: { value: "2026-11-01" } });
  fireEvent.change(within(table).getByLabelText("End date"), { target: { value: "2026-12-01" } });
  expect(unload()).toBe(true);
  fireEvent.change(within(panel("Courts")).getByLabelText("Status"), { target: { value: "inactive" } });
  expect(screen.getByText("No courts match these filters at this location.")).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Clear filters" }));
  expect(within(table).getByLabelText("Start date")).toBe(start);
  fireEvent.click(within(table).getByRole("link", { name: "Name" }));
  expect(window.location.search).toContain("sort=name");
  tab("Details"); tab("Courts");
  expect(within(table).getByLabelText("Start date")).toHaveProperty("value", "2026-11-01");
  fireEvent.click(within(table).getByRole("button", { name: "Save period" }));
  await waitFor(() => expect(mocks.saveCoverage).toHaveBeenCalledWith({ court_id: court.id, dates: { starts_on: "2026-11-01", ends_on: "2026-12-01" } }));
});

it("creates, edits and removes pricing using the shared dialogs and time combobox", async () => {
  await workspace(); tab("Pricing");
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Court One/ }));
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "08:15" } });
  const end = screen.getByRole("combobox", { name: "End time" });
  fireEvent.focus(end);
  fireEvent.click(within(screen.getByRole("listbox", { name: "End time suggestions" })).getByRole("option", { name: "10:00" }));
  fireEvent.change(screen.getByLabelText("Price per hour (RON)"), { target: { value: "15.50" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save rule" })).toHaveProperty("disabled", false));
  fireEvent.submit(screen.getByRole("form", { name: "Pricing rule" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mocks.savePricing.mock.calls[0][0]).toMatchObject({ location_id: location.id, court_ids: [court.id], weekdays: [0], starts_at: "08:15", ends_at: "10:00" });
  fireEvent.click(screen.getByRole("row", { name: "Edit pricing rule for Court One" }));
  fireEvent.change(screen.getByLabelText("Price per hour (RON)"), { target: { value: "16.00" } });
  fireEvent.submit(screen.getByRole("form", { name: "Pricing rule" }));
  await waitFor(() => expect(mocks.savePricing).toHaveBeenCalledTimes(2));
  expect(mocks.savePricing.mock.calls[1][0]).toMatchObject({ rule_set_id: rule.rule_set_id, location_id: location.id, price_per_hour: "16.00" });
  fireEvent.click(screen.getByRole("row", { name: "Edit pricing rule for Court One" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Remove pricing rule?" })).getByRole("button", { name: "Remove rule" }));
  await waitFor(() => expect(mocks.removePricing).toHaveBeenCalledWith({ location_id: location.id, rule_set_id: rule.rule_set_id }));
  expect(window.location.search).toBe("?tab=pricing");
});

it("links each missing publication requirement to its tab and preserves drafts", async () => {
  mocks.readiness.mockResolvedValue([{ ...location, missing: ["opening hours", "an active court", "pricing for every active court"] }]);
  await workspace();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Draft" } });
  tab("Public booking");
  expect(screen.getByRole("button", { name: "Enable public booking" })).toHaveProperty("disabled", true);
  const requirements = within(panel("Public booking")).getAllByRole("link");
  expect(requirements.map((link) => link.getAttribute("href"))).toEqual(["?tab=opening-hours", "?tab=courts", "?tab=pricing"]);
  fireEvent.click(requirements[0]);
  expect(panel("Opening hours")).toBeTruthy();
  tab("Details"); expect(screen.getByLabelText("Name")).toHaveProperty("value", "Draft");
});

it("publishes through the existing action without changing the selected tab", async () => {
  await workspace(); tab("Public booking");
  fireEvent.click(screen.getByRole("button", { name: "Enable public booking" }));
  await waitFor(() => expect(mocks.publication).toHaveBeenCalledWith({ id: location.id, is_public: true }));
  expect(mocks.refresh).toHaveBeenCalled();
  expect(window.location.search).toBe("?tab=public-booking");
});

it("edits and removes the current court's coverage using the existing controls", async () => {
  const period = { id: "a1000000-0000-4000-8000-000000000007", court_id: court.id, starts_on: "2026-11-01", ends_on: "2026-12-01",
    created_at: location.created_at, updated_at: location.updated_at };
  mocks.coverage.mockResolvedValue([period, { ...period, id: "other-period", court_id: "other-court" }]);
  await workspace(); tab("Courts");
  const table = screen.getByRole("table", { name: "Central courts" });
  expect(within(table).getAllByRole("button", { name: "Edit period" })).toHaveLength(1);
  fireEvent.click(within(table).getByRole("button", { name: "Edit period" }));
  fireEvent.change(within(table).getByLabelText("End date"), { target: { value: "2026-12-15" } });
  fireEvent.click(within(table).getByRole("button", { name: "Save period" }));
  await waitFor(() => expect(mocks.saveCoverage).toHaveBeenCalledWith({ id: period.id, court_id: court.id, dates: { starts_on: "2026-11-01", ends_on: "2026-12-15" } }));
  await waitFor(() => expect(within(table).getByRole("button", { name: "Remove period" })).toHaveProperty("disabled", false));
  fireEvent.click(within(table).getByRole("button", { name: "Remove period" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Remove coverage period from Court One?" })).getByRole("button", { name: "Remove period" }));
  await waitFor(() => expect(mocks.removeCoverage).toHaveBeenCalledWith({ id: period.id, court_id: court.id }));
});

it.each(["court", "pricing"])("hides an open %s dialog on history navigation without discarding its draft", async (kind) => {
  await workspace();
  tab(kind === "court" ? "Courts" : "Pricing");
  if (kind === "court") {
    fireEvent.click(screen.getByRole("button", { name: "Create court" }));
    fireEvent.change(screen.getByRole("dialog").querySelector<HTMLInputElement>('input[name="name"]')!, { target: { value: "Draft Court" } });
  } else {
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.change(screen.getByLabelText("Price per hour (RON)"), { target: { value: "18.50" } });
  }
  const title = kind === "court" ? "Create court" : "Add pricing";
  const dialog = screen.getByRole("dialog", { name: title });
  await act(async () => { window.history.back(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(panel("Details")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(unload()).toBe(true);
  await act(async () => { window.history.forward(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(screen.getByRole("dialog", { name: title })).toBe(dialog);
  expect(within(dialog).getByLabelText(kind === "court" ? "Name" : "Price per hour (RON)"))
    .toHaveProperty("value", kind === "court" ? "Draft Court" : "18.50");
});
