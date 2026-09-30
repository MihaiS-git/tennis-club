// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { savePricingRuleAction, removePricingRuleAction, listAdminLocations, listAdminPricingRules, listAdminCourts, push } = vi.hoisted(() => ({
  savePricingRuleAction: vi.fn(), removePricingRuleAction: vi.fn(), listAdminLocations: vi.fn(), listAdminPricingRules: vi.fn(), listAdminCourts: vi.fn(), push: vi.fn(),
}));
vi.mock("../../src/app/admin/pricing/actions", () => ({ savePricingRuleAction, removePricingRuleAction }));
vi.mock("../../src/lib/admin/locations", () => ({ listAdminLocations }));
vi.mock("../../src/lib/admin/pricing", () => ({ listAdminPricingRules }));
vi.mock("../../src/lib/admin/courts", () => ({ listAdminCourts }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
import { PricingRules } from "../../src/app/admin/pricing/pricing-rules";
import AdminPricingPage from "../../src/app/admin/pricing/page";
const location = { id: "c7000000-0000-4000-8000-000000000011", name: "Central Club", currency: "EUR", timezone: "Europe/Bucharest" } as const;
const courts = [
  { id: "c7000000-0000-4000-8000-000000000031", location_id: location.id, name: "Court 1", surface: "clay", environment: "outdoor" },
  { id: "c7000000-0000-4000-8000-000000000032", location_id: location.id, name: "Court 2", surface: "clay", environment: "outdoor" },
  { id: "c7000000-0000-4000-8000-000000000033", location_id: location.id, name: "Court 3", surface: "hard", environment: "indoor" },
] as const;
const rule = { rule_set_id: "c7000000-0000-4000-8000-000000000041", location_id: location.id, court_ids: [courts[0].id, courts[1].id],
  court_state: "outdoor", weekdays: [0, 1, 2, 3, 4], starts_at_minute: 960, ends_at_minute: 1200,
  starts_on: null, ends_on: null, price_per_hour_minor: 1200,
  created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z" } as const;
beforeEach(() => { vi.resetAllMocks(); savePricingRuleAction.mockResolvedValue({ ok: true, id: rule.rule_set_id }); removePricingRuleAction.mockResolvedValue({ ok: true, id: rule.rule_set_id });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event("close")); };
});
afterEach(cleanup);

it("renders one compact table row for a multi-court Mon–Fri rule", () => {
  render(<PricingRules location={location} courts={[...courts]} rules={[{ ...rule, court_ids: [...rule.court_ids], weekdays: [...rule.weekdays] }]} />);
  const table = screen.getByRole("table");
  expect(within(table).getAllByRole("row")).toHaveLength(2);
  expect(within(table).getByText("Court 1, Court 2")).toBeTruthy();
  expect(within(table).getByText("Mon–Fri")).toBeTruthy();
  expect(within(table).getByText("16:00–20:00")).toBeTruthy();
  expect(within(table).getByText("All dates")).toBeTruthy();
  expect(within(table).getByText("€12.00")).toBeTruthy();
});
it.each([false, true])("uses the same form fields for create and edit (edit=%s)", async (editing) => {
  render(<PricingRules location={location} courts={[...courts]} rules={editing ? [{ ...rule, court_ids: [...rule.court_ids], weekdays: [...rule.weekdays] }] : []} />);
  fireEvent.click(editing ? screen.getByRole("row", { name: /Edit pricing rule/ }) : screen.getByRole("button", { name: "Add rule" }));
  expect((screen.getByRole("dialog", { name: editing ? "Edit pricing" : "Add pricing" }) as HTMLDialogElement).open).toBe(true);
  const form = screen.getByRole("form", { name: "Pricing rule" });
  expect(within(form).getByRole("group", { name: "Courts" })).toBeTruthy();
  expect(within(form).getByRole("group", { name: "Days" })).toBeTruthy();
  for (const label of ["Court state", "Start time", "End time", "Valid from (optional)", "Valid until (optional)", "Price per hour (EUR)"])
    expect(within(form).getByLabelText(label)).toBeTruthy();
  expect(within(form).queryByLabelText("Surface")).toBeNull();
  expect((within(form).getByRole("checkbox", { name: /Court 1/ }) as HTMLInputElement).checked).toBe(editing);
  if (editing) {
    expect(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].every((name) =>
      (within(form).getByRole("checkbox", { name }) as HTMLInputElement).checked)).toBe(true);
    expect(["Saturday", "Sunday"].every((name) =>
      !(within(form).getByRole("checkbox", { name }) as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(within(form).getByRole("checkbox", { name: "Friday" }));
    fireEvent.click(within(form).getByRole("checkbox", { name: /Court 2/ }));
  } else {
    fireEvent.click(within(form).getByRole("checkbox", { name: /Court 1/ }));
    fireEvent.click(within(form).getByRole("checkbox", { name: /Court 2/ }));
    fireEvent.click(within(form).getByRole("button", { name: "Monday–Friday" }));
    fireEvent.change(within(form).getByLabelText("Start time"), { target: { value: "16:00" } });
    fireEvent.change(within(form).getByLabelText("End time"), { target: { value: "20:00" } });
    fireEvent.change(within(form).getByLabelText("Price per hour (EUR)"), { target: { value: "12.00" } });
  }
  fireEvent.submit(form);
  await waitFor(() => expect(savePricingRuleAction).toHaveBeenCalledOnce());
  expect(savePricingRuleAction.mock.calls[0][0]).toMatchObject({
    ...(editing ? { rule_set_id: rule.rule_set_id, court_ids: [courts[0].id], weekdays: [0, 1, 2, 3] }
      : { court_ids: [courts[0].id, courts[1].id], weekdays: [0, 1, 2, 3, 4] }),
    location_id: location.id, court_state: "outdoor", starts_at: "16:00", ends_at: "20:00", price_per_hour: "12.00",
  });
});
it.each([
  ["Saturday–Sunday", [5, 6]],
  ["All days", [0, 1, 2, 3, 4, 5, 6]],
] as const)("supports the %s shortcut on the shared form", (shortcut, days) => {
  render(<PricingRules location={location} courts={[...courts]} rules={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  fireEvent.click(screen.getByRole("button", { name: shortcut }));
  expect(screen.getAllByRole("checkbox").filter((box) => (box as HTMLInputElement).checked)
    .map((box) => Number((box as HTMLInputElement).value))).toEqual(days);
});
it.each([false, true])("reports the same weekday validation for create and edit (edit=%s)", async (editing) => {
  savePricingRuleAction.mockResolvedValue({ ok: false, reason: "invalid-input", fieldErrors: { weekdays: "Select at least one weekday." } });
  render(<PricingRules location={location} courts={[...courts]} rules={editing ? [{ ...rule, court_ids: [...rule.court_ids], weekdays: [...rule.weekdays] }] : []} />);
  fireEvent.click(editing ? screen.getByRole("row", { name: /Edit pricing rule/ }) : screen.getByRole("button", { name: "Add rule" }));
  const form = screen.getByRole("form", { name: "Pricing rule" });
  if (editing) for (const name of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"])
    fireEvent.click(within(form).getByRole("checkbox", { name }));
  else fireEvent.click(within(form).getByRole("checkbox", { name: "Monday" }));
  fireEvent.submit(form);
  await waitFor(() => expect(screen.getByText("Select at least one weekday.")).toBeTruthy());
  expect(savePricingRuleAction.mock.calls[0][0].weekdays).toEqual([]);
  expect(within(form).getByRole("group", { name: "Days" }).getAttribute("aria-describedby"))
    .toBe(screen.getByText("Select at least one weekday.").id);
});
it("rejects incompatible court state in the form and allows selecting a compatible state", () => {
  render(<PricingRules location={location} courts={[...courts]} rules={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Court 3/ }));
  expect(screen.getByText(/Selected courts must share a valid state/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save rule" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Court state"), { target: { value: "indoor" } });
  expect((screen.getByRole("button", { name: "Save rule" }) as HTMLButtonElement).disabled).toBe(false);
});
it("removes the whole logical rule", async () => {
  render(<PricingRules location={location} courts={[...courts]} rules={[{ ...rule, court_ids: [...rule.court_ids], weekdays: [...rule.weekdays] }]} />);
  fireEvent.click(screen.getByRole("row", { name: /Edit pricing rule/ }));
  fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
  await waitFor(() => expect(removePricingRuleAction).toHaveBeenCalledExactlyOnceWith({ rule_set_id: rule.rule_set_id, location_id: location.id }));
});

it("opens edit from desktop and mobile rows with pointer and keyboard", () => {
  render(<PricingRules location={location} courts={[...courts]} rules={[{ ...rule, court_ids: [...rule.court_ids], weekdays: [...rule.weekdays] }]} />);
  const row = screen.getByRole("row", { name: /Edit pricing rule/ });
  const card = screen.getByRole("button", { name: /Edit pricing rule/ });
  fireEvent.click(row);
  expect((screen.getByRole("dialog", { name: "Edit pricing" }) as HTMLDialogElement).open).toBe(true);
  expect(screen.getByRole("form", { name: "Pricing rule" }).closest("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.keyDown(row, { key: "Enter" });
  expect((screen.getByRole("dialog", { name: "Edit pricing" }) as HTMLDialogElement).open).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(row, { key: " " });
  expect((screen.getByRole("dialog", { name: "Edit pricing" }) as HTMLDialogElement).open).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(card);
  expect((screen.getByRole("dialog", { name: "Edit pricing" }) as HTMLDialogElement).open).toBe(true);
  expect(screen.queryByRole("columnheader", { name: "Actions" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
});
it("displays courts in location order even when persisted IDs are ordered differently", () => {
  const reordered = { ...rule, court_ids: [courts[1].id, courts[0].id], weekdays: [...rule.weekdays] };
  render(<PricingRules location={location} courts={[...courts]} rules={[reordered]} />);
  expect(screen.getByRole("cell", { name: "Court 1, Court 2" })).toBeTruthy();
});
it("location changes navigate immediately and a single location keeps the shared selector", async () => {
  const second = { ...location, id: "c7000000-0000-4000-8000-000000000012", name: "West Club", currency: "RON" as const };
  listAdminLocations.mockResolvedValue([location, second]); listAdminPricingRules.mockResolvedValue([]); listAdminCourts.mockResolvedValue([]);
  const view = render(await AdminPricingPage({ searchParams: Promise.resolve({ location: second.id }) }));
  expect(listAdminPricingRules).toHaveBeenCalledWith(second.id);
  expect(screen.queryByRole("button", { name: "View pricing" })).toBeNull();
  const toolbar = screen.getByLabelText("Location").closest("label")?.parentElement;
  expect(screen.getByText(/Currency: RON/).parentElement?.parentElement).toBe(toolbar);
  expect(screen.getByRole("button", { name: "Add rule" }).parentElement?.parentElement).toBe(toolbar);
  fireEvent.change(screen.getByLabelText("Location"), { target: { value: location.id } });
  expect(push).toHaveBeenCalledExactlyOnceWith(`/admin/pricing?location=${location.id}`);
  view.unmount();
  listAdminLocations.mockResolvedValue([location]);
  render(await AdminPricingPage({ searchParams: Promise.resolve({ location: second.id }) }));
  expect((screen.getByLabelText("Location") as HTMLSelectElement).value).toBe(location.id);
  expect(screen.getByRole("option", { name: /Central Club/ })).toBeTruthy();
  expect(screen.getByText(/Currency: EUR/)).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Central Club" })).toBeNull();
});
it("keeps the location selector when the URL names an unknown location", async () => {
  const second = { ...location, id: "c7000000-0000-4000-8000-000000000012", name: "West Club" };
  listAdminLocations.mockResolvedValue([location, second]);
  render(await AdminPricingPage({ searchParams: Promise.resolve({ location: "c7000000-0000-4000-8000-000000000099" }) }));
  expect(screen.getByText("Select an existing location.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Location"), { target: { value: location.id } });
  expect(push).toHaveBeenCalledExactlyOnceWith(`/admin/pricing?location=${location.id}`);
});
