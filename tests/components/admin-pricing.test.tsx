// @vitest-environment jsdom
import { lastToast } from "../helpers/notifications";
import { installDialogMock } from "../helpers/dialog";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { savePricingRuleAction, removePricingRuleAction, listAdminLocations, listAdminPricingRules, listAdminCourts, listAdminLocationOpeningHours, push } = vi.hoisted(() => ({
  savePricingRuleAction: vi.fn(), removePricingRuleAction: vi.fn(), listAdminLocations: vi.fn(), listAdminPricingRules: vi.fn(), listAdminCourts: vi.fn(), listAdminLocationOpeningHours: vi.fn(), push: vi.fn(),
}));
vi.mock("../../src/app/admin/pricing/actions", () => ({ savePricingRuleAction, removePricingRuleAction }));
vi.mock("../../src/lib/admin/locations", () => ({ listAdminLocations }));
vi.mock("../../src/lib/admin/pricing", () => ({ listAdminPricingRules }));
vi.mock("../../src/lib/admin/courts", () => ({ listAdminCourts }));
vi.mock("../../src/lib/admin/opening-hours", () => ({ listAdminLocationOpeningHours }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(
    (callback) => { window.addEventListener("popstate", callback); return () => window.removeEventListener("popstate", callback); },
    () => window.location.search,
  )),
}));
import { PricingRules } from "../../src/app/admin/pricing/pricing-rules";
import { PricingRuleForm } from "../../src/app/admin/pricing/pricing-rule-form";
import type { PricingRuleSet } from "../../src/lib/pricing/validation";
const location = { id: "c7000000-0000-4000-8000-000000000011", name: "Central Club", currency: "EUR", timezone: "Europe/Bucharest" } as const;
const courts = [
  { id: "c7000000-0000-4000-8000-000000000031", location_id: location.id, name: "Court 1", surface: "clay", environment: "outdoor" },
  { id: "c7000000-0000-4000-8000-000000000032", location_id: location.id, name: "Court 2", surface: "clay", environment: "outdoor" },
  { id: "c7000000-0000-4000-8000-000000000033", location_id: location.id, name: "Court 3", surface: "hard", environment: "indoor" },
] as const;
const rule = { revision: "fixture-revision", rule_set_id: "c7000000-0000-4000-8000-000000000041", location_id: location.id, court_ids: [courts[0].id, courts[1].id],
  court_state: "outdoor", weekdays: [0, 1, 2, 3, 4], starts_at_minute: 960, ends_at_minute: 1200,
  starts_on: null, ends_on: null, price_per_hour_minor: 1200,
  created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z" } as const;
const openingHours = Array.from({ length: 7 }, (_, weekday) => ({
  id: `c7000000-0000-4000-8000-00000000005${weekday}`, location_id: location.id, schedule_id: rule.rule_set_id, starts_on: "0001-01-01", ends_on: null, weekday,
  opens_at_minute: 420, closes_at_minute: 1440,
  created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z",
}));
const schedules = [{ id: rule.rule_set_id, location_id: location.id, starts_on: "0001-01-01", ends_on: null, revision: 1 }];
const seasonalCourts = Array.from({ length: 4 }, (_, index) => ({ ...courts[0],
  id: `c7000000-0000-4000-8000-00000000003${index + 1}`, name: `C${index + 1}` }));
const indoorCourts = [5, 6].map((index) => ({ ...courts[2], id: `c7000000-0000-4000-8000-00000000003${index}`, name: `I${index}` }));

it.each(["create", "edit"])("%s keeps C1–C4 Covered selection through errors and submits the correct rule identity", async (mode) => {
  const onSave = vi.fn();
  const original: PricingRuleSet = { ...rule, court_ids: seasonalCourts.map((court) => court.id), weekdays: [...rule.weekdays] };
  const before = structuredClone(original);
  const props = { location, courts: seasonalCourts, openingHours, schedules, today: "2026-07-01", pending: false,
    onSave, rule: mode === "edit" ? original : undefined };
  const view = render(<PricingRuleForm {...props} fieldErrors={{}} />);
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  const select = screen.getByLabelText("Court state");
  expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["Outdoor", "Covered"]);
  for (const option of within(select).getAllByRole("option")) expect(option).toHaveProperty("disabled", false);
  // Chromium emits input before change for native keyboard selection. The form's
  // input handler can rerender the controlled select before change is dispatched.
  fireEvent.input(select, { target: { value: "covered" } });
  expect(select).toHaveProperty("value", "covered");
  fireEvent.change(select, { target: { value: "covered" } });
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "08:00" } });
  fireEvent.change(screen.getByLabelText("End time"), { target: { value: "09:00" } });
  fireEvent.change(screen.getByLabelText("Price per hour (EUR)"), { target: { value: "25.00" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save rule" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ court_ids: seasonalCourts.map((court) => court.id), court_state: "covered" }));
  if (mode === "create") expect(onSave.mock.calls[0][0]).not.toHaveProperty("rule_set_id");
  else expect(onSave.mock.calls[0][0]).toMatchObject({ rule_set_id: original.rule_set_id, revision: original.revision });
  view.rerender(<PricingRuleForm {...props} fieldErrors={{ price_per_hour: "Review this price." }} />);
  expect(screen.getByLabelText("Court state")).toHaveProperty("value", "covered");
  expect(screen.getByLabelText("Price per hour (EUR)")).toHaveProperty("value", "25.00");
  for (const court of seasonalCourts) expect(screen.getByRole("checkbox", { name: new RegExp(court.name) })).toHaveProperty("checked", true);
  expect(original).toEqual(before);
});

it.each(["create", "edit"])("%s supports environment-scoped Select all, Clear all, individual selection and automatic Indoor submission", async (mode) => {
  const onSave = vi.fn();
  render(<PricingRuleForm location={location} courts={[...seasonalCourts, ...indoorCourts]} openingHours={openingHours}
    schedules={schedules} today="2026-07-01" pending={false} fieldErrors={{}} onSave={onSave}
    rule={mode === "edit" ? { ...rule, court_ids: [seasonalCourts[0].id], weekdays: [...rule.weekdays] } : undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  for (const court of seasonalCourts) expect(screen.getByRole("checkbox", { name: new RegExp(court.name) })).toHaveProperty("checked", true);
  expect(screen.getByRole("checkbox", { name: /I5/ })).toHaveProperty("checked", false);
  fireEvent.click(screen.getByRole("checkbox", { name: /C2/ }));
  expect(screen.getByRole("checkbox", { name: /C2/ })).toHaveProperty("checked", false);
  fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
  for (const court of seasonalCourts) expect(screen.getByRole("checkbox", { name: new RegExp(court.name) })).toHaveProperty("checked", false);
  fireEvent.click(screen.getByRole("checkbox", { name: /I5/ }));
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  expect(screen.getByRole("checkbox", { name: /I6/ })).toHaveProperty("checked", true);
  expect(screen.getByRole("checkbox", { name: /C1/ })).toHaveProperty("checked", false);
  expect(screen.queryByLabelText("Court state")).toBeNull();
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "08:00" } });
  fireEvent.change(screen.getByLabelText("End time"), { target: { value: "09:00" } });
  fireEvent.change(screen.getByLabelText("Price per hour (EUR)"), { target: { value: "25.00" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save rule" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ court_ids: indoorCourts.map((court) => court.id), court_state: "indoor" }));
});

it.each(["create", "edit"])("%s blocks mixed environment submission and recovers without losing Covered or other values", async (mode) => {
  const onSave = vi.fn();
  render(<PricingRuleForm location={location} courts={[...seasonalCourts, ...indoorCourts]} openingHours={openingHours}
    schedules={schedules} today="2026-07-01" pending={false} fieldErrors={{}} onSave={onSave}
    rule={mode === "edit" ? { ...rule, court_ids: [seasonalCourts[0].id], weekdays: [...rule.weekdays] } : undefined} />);
  if (mode === "create") fireEvent.click(screen.getByRole("checkbox", { name: /C1/ }));
  fireEvent.change(screen.getByLabelText("Court state"), { target: { value: "covered" } });
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "08:00" } });
  fireEvent.change(screen.getByLabelText("End time"), { target: { value: "09:00" } });
  fireEvent.change(screen.getByLabelText("Price per hour (EUR)"), { target: { value: "25.00" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /I5/ }));
  expect(screen.getByText(/Indoor and Outdoor courts cannot share/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save rule" })).toHaveProperty("disabled", true);
  fireEvent.submit(screen.getByRole("form", { name: "Pricing rule" }));
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I5/ }));
  expect(screen.getByLabelText("Court state")).toHaveProperty("value", "covered");
  expect(screen.getByLabelText("Price per hour (EUR)")).toHaveProperty("value", "25.00");
  await waitFor(() => expect(screen.getByRole("button", { name: "Save rule" })).toHaveProperty("disabled", false));
});
beforeEach(() => { vi.resetAllMocks(); savePricingRuleAction.mockResolvedValue({ ok: true, id: rule.rule_set_id }); removePricingRuleAction.mockResolvedValue({ ok: true, id: rule.rule_set_id });
  window.history.replaceState(null, "", `/admin/locations/${location.id}?tab=pricing`);
  const originalPush = window.history.pushState.bind(window.history);
  vi.spyOn(window.history, "pushState").mockImplementation((...args) => { originalPush(...args); window.dispatchEvent(new PopStateEvent("popstate")); });
  listAdminLocationOpeningHours.mockResolvedValue(openingHours);
  installDialogMock();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(["create", "edit"])("reopens time suggestions after an opening-hours error in %s and preserves the form", async (mode) => {
  // Keep Monday/Tuesday occurrences within the rule's October validity period.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T09:00:00Z"));
  const hours = openingHours.map((interval) => ({ ...interval, closes_at_minute: 1200 }));
  render(<PricingRules schedules={schedules} openingHours={hours} location={location} courts={[...courts]}
    rules={mode === "edit" ? [{ ...rule, court_ids: [...rule.court_ids], weekdays: [...rule.weekdays] }] : []} />);
  if (mode === "edit") fireEvent.click(screen.getByRole("row", { name: /Edit pricing rule/ }));
  else {
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Court 1/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Court 2/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tuesday" }));
  }
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "08:15" } });
  fireEvent.change(screen.getByLabelText("Valid from (optional)"), { target: { value: "2026-10-01" } });
  fireEvent.change(screen.getByLabelText("Valid until (optional)"), { target: { value: "2026-10-31" } });
  fireEvent.change(screen.getByLabelText("Price per hour (EUR)"), { target: { value: "15.50" } });
  const end = screen.getByRole("combobox", { name: "End time" }) as HTMLInputElement;
  fireEvent.change(end, { target: { value: "21:15" } });
  expect(screen.getByText(/outside .* opening hours/)).toBeTruthy();
  expect(end.getAttribute("aria-invalid")).toBe("true");
  expect((screen.getByRole("button", { name: "Save rule" }) as HTMLButtonElement).disabled).toBe(true);

  // Blur and focus must show the full list even when the typed value has no matching suggestion.
  fireEvent.blur(end);
  fireEvent.focus(end);
  expect(end.value).toBe("21:15");
  expect(within(screen.getByRole("listbox", { name: "End time suggestions" })).getByRole("option", { name: "19:00" })).toBeTruthy();
  fireEvent.keyDown(end, { key: "Escape" });
  fireEvent.click(end);
  fireEvent.click(within(screen.getByRole("listbox", { name: "End time suggestions" })).getByRole("option", { name: "19:00" }));
  await waitFor(() => expect(screen.queryByText(/outside .* opening hours/)).toBeNull());
  expect(end.value).toBe("19:00");
  expect(end.getAttribute("aria-invalid")).toBe("false");
  expect((screen.getByRole("button", { name: "Save rule" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole("dialog", { name: mode === "edit" ? "Edit pricing" : "Add pricing" })).toBeTruthy();
  expect((screen.getByLabelText("Start time") as HTMLInputElement).value).toBe("08:15");
  expect((screen.getByLabelText("Valid from (optional)") as HTMLInputElement).value).toBe("2026-10-01");
  expect((screen.getByLabelText("Valid until (optional)") as HTMLInputElement).value).toBe("2026-10-31");
  expect((screen.getByLabelText("Price per hour (EUR)") as HTMLInputElement).value).toBe("15.50");
  for (const name of [/Court 1/, /Court 2/, "Monday", "Tuesday"]) {
    expect((screen.getByRole("checkbox", { name }) as HTMLInputElement).checked).toBe(true);
  }
  const start = screen.getByRole("combobox", { name: "Start time" });
  fireEvent.focus(start);
  expect(within(screen.getByRole("listbox", { name: "Start time suggestions" })).getByRole("option", { name: "08:00" })).toBeTruthy();
});

it("shows an actionable error for an out-of-hours create rule and enables Save after correction", () => {
  render(<PricingRules schedules={schedules} openingHours={openingHours} location={location} courts={[...courts]} rules={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Court 1/ }));
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "06:30" } });
  fireEvent.change(screen.getByLabelText("End time"), { target: { value: "09:00" } });
  fireEvent.change(screen.getByLabelText("Price per hour (EUR)"), { target: { value: "12.00" } });
  expect(screen.getByText(/outside Monday opening hours/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save rule" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "08:00" } });
  expect(screen.queryByText(/outside Monday opening hours/)).toBeNull();
  expect((screen.getByRole("button", { name: "Save rule" }) as HTMLButtonElement).disabled).toBe(false);
});
it("preserves entered values and displays the server's current-hours error after stale client data", async () => {
  savePricingRuleAction.mockResolvedValue({ ok: false, reason: "invalid-input", fieldErrors: { ends_at: "Sunday is closed. Remove Sunday or change the location's opening hours." } });
  render(<PricingRules schedules={schedules} openingHours={openingHours} location={location} courts={[...courts]} rules={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Court 1/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Sunday" }));
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "08:00" } });
  fireEvent.change(screen.getByLabelText("End time"), { target: { value: "09:00" } });
  fireEvent.change(screen.getByLabelText("Price per hour (EUR)"), { target: { value: "12.00" } });
  fireEvent.submit(screen.getByRole("form", { name: "Pricing rule" }));
  await waitFor(() => expect(screen.getByText(/Sunday is closed. Remove Sunday/)).toBeTruthy());
  expect((screen.getByLabelText("Start time") as HTMLInputElement).value).toBe("08:00");
  expect((screen.getByLabelText("End time") as HTMLInputElement).value).toBe("09:00");
  expect((screen.getByRole("checkbox", { name: "Sunday" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("button", { name: "Save rule" }) as HTMLButtonElement).disabled).toBe(false);
  const end = screen.getByRole("combobox", { name: "End time" });
  fireEvent.focus(end);
  fireEvent.click(within(screen.getByRole("listbox", { name: "End time suggestions" })).getByRole("option", { name: "09:30" }));
  await waitFor(() => expect(screen.queryByText(/Sunday is closed. Remove Sunday/)).toBeNull());
  expect((end as HTMLInputElement).value).toBe("09:30");
  expect((screen.getByRole("checkbox", { name: "Sunday" }) as HTMLInputElement).checked).toBe(true);
});
it("cancels pricing removal and keeps a failed removal open with its error", async () => {
  removePricingRuleAction.mockResolvedValue({ ok: false, reason: "not-found" });
  render(<PricingRules schedules={schedules} openingHours={openingHours} location={location} courts={[...courts]} rules={[{ ...rule, court_ids: [...rule.court_ids], weekdays: [...rule.weekdays] }]} />);
  fireEvent.click(screen.getByRole("row", { name: /Edit pricing rule/ }));
  fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
  const confirmation = screen.getByRole("dialog", { name: "Remove pricing rule?" });
  expect(within(confirmation).getByText(/Court 1, Court 2 on Mon–Fri/)).toBeTruthy();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  expect(removePricingRuleAction).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Edit pricing" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Remove pricing rule?" })).getByRole("button", { name: "Remove rule" }));
  await waitFor(() => expect(lastToast()).toContain("no longer exists"));
});

const multiRule: PricingRuleSet = { ...rule, court_ids: [...rule.court_ids], weekdays: [...rule.weekdays] };
it.each(["outdoor", "covered"])("offers and saves %s pricing for the same outdoor courts independently of today", async (state) => {
  render(<PricingRules schedules={schedules} openingHours={openingHours} location={location} courts={[...courts]} rules={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  const form = screen.getByRole("form", { name: "Pricing rule" });
  fireEvent.click(within(form).getByRole("checkbox", { name: /Court 1/ }));
  fireEvent.click(within(form).getByRole("checkbox", { name: /Court 2/ }));
  const select = within(form).getByLabelText("Court state");
  expect(within(select).getByRole("option", { name: "Outdoor" })).toBeTruthy();
  expect(within(select).getByRole("option", { name: "Covered" })).toBeTruthy();
  fireEvent.change(select, { target: { value: state } });
  fireEvent.change(within(form).getByLabelText("Start time"), { target: { value: "08:00" } });
  fireEvent.change(within(form).getByLabelText("End time"), { target: { value: "09:00" } });
  fireEvent.change(within(form).getByLabelText("Price per hour (EUR)"), { target: { value: "25.00" } });
  expect(within(form).getByRole("button", { name: "Save rule" })).toHaveProperty("disabled", false);
  fireEvent.submit(form);
  await waitFor(() => expect(savePricingRuleAction).toHaveBeenCalledWith(expect.objectContaining({
    court_ids: [courts[0].id, courts[1].id], court_state: state,
  })));
});
const indoorRule: PricingRuleSet = { ...multiRule, rule_set_id: "c7000000-0000-4000-8000-000000000042",
  court_ids: [courts[2].id], court_state: "indoor", weekdays: [5, 6], starts_at_minute: 540, ends_at_minute: 660,
  starts_on: "2026-10-01", ends_on: "2026-10-31", price_per_hour_minor: 900 };
function pricing(rules: PricingRuleSet[] = [multiRule, indoorRule]) {
  return <PricingRules schedules={schedules} openingHours={openingHours} location={location} courts={[...courts]} rules={rules} />;
}
const tableRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

it("combines filters, matches multi-court/day rules, shows empty results and resets only filters", () => {
  window.history.replaceState(null, "", `/admin/locations/${location.id}?tab=pricing&status=inactive&sort=name&page=3&keep=yes#pricing`);
  render(pricing());
  fireEvent.change(screen.getByLabelText("Court"), { target: { value: courts[1].id } });
  expect(tableRows()).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Day"), { target: { value: "4" } });
  fireEvent.change(screen.getByLabelText("Court state"), { target: { value: "outdoor" } });
  fireEvent.change(screen.getByLabelText("Applies on"), { target: { value: "2026-10-31" } });
  expect(tableRows()[0].textContent).toContain("Court 1, Court 2");
  fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "Time" }));
  fireEvent.change(screen.getByLabelText("Court state"), { target: { value: "indoor" } });
  expect(screen.getByRole("status").textContent).toBe("No pricing rules match these filters.");
  expect(screen.queryByRole("table")).toBeNull();
  expect(savePricingRuleAction).not.toHaveBeenCalled();
  expect(removePricingRuleAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
  expect(tableRows()).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
  const query = new URLSearchParams(window.location.search);
  expect(Object.fromEntries(query)).toEqual({ tab: "pricing", status: "inactive", sort: "name", keep: "yes", pricingSort: "time", pricingDir: "asc" });
  expect(window.location.pathname).toBe(`/admin/locations/${location.id}`);
  expect(window.location.hash).toBe("#pricing");
});

it.each(["Courts", "State", "Days", "Time", "Validity", "Price/hour"])("toggles the %s header and exposes its active direction", (name) => {
  render(pricing());
  const button = within(screen.getByRole("table")).getByRole("button", { name });
  fireEvent.click(button);
  const first = name === "Courts" ? "descending" : "ascending";
  expect(button.closest("th")?.getAttribute("aria-sort")).toBe(first);
  fireEvent.click(button);
  expect(button.closest("th")?.getAttribute("aria-sort")).toBe(first === "ascending" ? "descending" : "ascending");
});

it("restores URL filters and sort on Back/Forward", async () => {
  render(pricing());
  fireEvent.change(screen.getByLabelText("Day"), { target: { value: "6" } });
  fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: "Price/hour" }));
  expect(new URLSearchParams(window.location.search).get("pricingSort")).toBe("price");
  await act(async () => { window.history.back(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  await waitFor(() => expect(screen.getByLabelText("Sort pricing by")).toHaveProperty("value", "courts"));
  expect(screen.getByLabelText("Day")).toHaveProperty("value", "6");
  await act(async () => { window.history.back(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  await waitFor(() => expect(screen.getByLabelText("Day")).toHaveProperty("value", ""));
  expect(tableRows()).toHaveLength(2);
  await act(async () => { window.history.forward(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  await waitFor(() => expect(screen.getByLabelText("Day")).toHaveProperty("value", "6"));
  expect(tableRows()).toHaveLength(1);
  await act(async () => { window.history.forward(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  await waitFor(() => expect(screen.getByLabelText("Sort pricing by")).toHaveProperty("value", "price"));
  expect(new URLSearchParams(window.location.search).get("tab")).toBe("pricing");
});

it("keeps mobile cards and desktop rows in the same filtered order with accessible mobile sorting", () => {
  render(pricing());
  fireEvent.change(screen.getByLabelText("Sort pricing by"), { target: { value: "price" } });
  expect(tableRows()[0].textContent).toContain("Court 3");
  const cards = screen.getAllByRole("button", { name: /Edit pricing rule for/ });
  expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(tableRows().map((row) => row.getAttribute("aria-label")));
  fireEvent.click(screen.getByRole("button", { name: "Sort descending" }));
  expect(tableRows()[0].textContent).toContain("Court 1, Court 2");
  fireEvent.change(screen.getByLabelText("Court state"), { target: { value: "indoor" } });
  expect(tableRows()).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: /Edit pricing rule for/ })).toHaveLength(1);
});

it("keeps active filters and sorting after create/edit/remove and applies them to refreshed records", async () => {
  window.history.replaceState(null, "", `/admin/locations/${location.id}?tab=pricing&pricingCourt=${courts[0].id}&pricingDay=0&pricingSort=price&pricingDir=desc`);
  const view = render(pricing());
  const query = window.location.search;
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Court 1/ }));
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "08:00" } });
  fireEvent.change(screen.getByLabelText("End time"), { target: { value: "09:00" } });
  fireEvent.change(screen.getByLabelText("Price per hour (EUR)"), { target: { value: "25.00" } });
  fireEvent.submit(screen.getByRole("form", { name: "Pricing rule" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(savePricingRuleAction.mock.calls[0][0]).toMatchObject({ location_id: location.id, court_ids: [courts[0].id] });
  const created = { ...multiRule, rule_set_id: "new", court_ids: [courts[0].id], starts_at_minute: 480, ends_at_minute: 540, price_per_hour_minor: 2500 };
  view.rerender(pricing([multiRule, indoorRule, created]));
  expect(tableRows()).toHaveLength(2);
  expect(tableRows()[0].textContent).toContain("25.00");
  fireEvent.click(tableRows()[0]);
  fireEvent.change(screen.getByLabelText("Price per hour (EUR)"), { target: { value: "5.00" } });
  fireEvent.submit(screen.getByRole("form", { name: "Pricing rule" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(savePricingRuleAction.mock.calls[1][0]).toMatchObject({ rule_set_id: "new", location_id: location.id, price_per_hour: "5.00" });
  view.rerender(pricing([multiRule, indoorRule, { ...created, price_per_hour_minor: 500 }]));
  expect(tableRows()[1].textContent).toContain("5.00");
  fireEvent.click(tableRows()[1]);
  fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Remove pricing rule?" })).getByRole("button", { name: "Remove rule" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(removePricingRuleAction).toHaveBeenCalledWith({ rule_set_id: "new", location_id: location.id, revision: "fixture-revision" });
  view.rerender(pricing([multiRule, indoorRule]));
  expect(tableRows()).toHaveLength(1);
  expect(window.location.search).toBe(query);
  expect(screen.getByLabelText("Court")).toHaveProperty("value", courts[0].id);
});
