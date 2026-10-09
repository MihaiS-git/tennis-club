// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { savePricingRuleAction, removePricingRuleAction, listAdminLocations, listAdminPricingRules, listAdminCourts, listAdminLocationOpeningHours, push } = vi.hoisted(() => ({
  savePricingRuleAction: vi.fn(), removePricingRuleAction: vi.fn(), listAdminLocations: vi.fn(), listAdminPricingRules: vi.fn(), listAdminCourts: vi.fn(), listAdminLocationOpeningHours: vi.fn(), push: vi.fn(),
}));
vi.mock("../../src/app/admin/pricing/actions", () => ({ savePricingRuleAction, removePricingRuleAction }));
vi.mock("../../src/lib/admin/locations", () => ({ listAdminLocations }));
vi.mock("../../src/lib/admin/pricing", () => ({ listAdminPricingRules }));
vi.mock("../../src/lib/admin/courts", () => ({ listAdminCourts }));
vi.mock("../../src/lib/admin/opening-hours", () => ({ listAdminLocationOpeningHours }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
import { PricingRules } from "../../src/app/admin/pricing/pricing-rules";
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
const openingHours = Array.from({ length: 7 }, (_, weekday) => ({
  id: `c7000000-0000-4000-8000-00000000005${weekday}`, location_id: location.id, weekday,
  opens_at_minute: 420, closes_at_minute: 1440,
  created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z",
}));
beforeEach(() => { vi.resetAllMocks(); savePricingRuleAction.mockResolvedValue({ ok: true, id: rule.rule_set_id }); removePricingRuleAction.mockResolvedValue({ ok: true, id: rule.rule_set_id });
  listAdminLocationOpeningHours.mockResolvedValue(openingHours);
  installDialogMock();
});
afterEach(cleanup);

it("shows an actionable error for an out-of-hours create rule and enables Save after correction", () => {
  render(<PricingRules openingHours={openingHours} location={location} courts={[...courts]} rules={[]} />);
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
  render(<PricingRules openingHours={openingHours} location={location} courts={[...courts]} rules={[]} />);
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
});
it("cancels pricing removal and keeps a failed removal open with its error", async () => {
  removePricingRuleAction.mockResolvedValue({ ok: false, reason: "not-found" });
  render(<PricingRules openingHours={openingHours} location={location} courts={[...courts]} rules={[{ ...rule, court_ids: [...rule.court_ids], weekdays: [...rule.weekdays] }]} />);
  fireEvent.click(screen.getByRole("row", { name: /Edit pricing rule/ }));
  fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
  const confirmation = screen.getByRole("dialog", { name: "Remove pricing rule?" });
  expect(within(confirmation).getByText(/Court 1, Court 2 on Mon–Fri/)).toBeTruthy();
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  expect(removePricingRuleAction).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Edit pricing" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Remove pricing rule?" })).getByRole("button", { name: "Remove rule" }));
  await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Remove pricing rule?" })).getByRole("alert").textContent).toContain("no longer exists"));
});
