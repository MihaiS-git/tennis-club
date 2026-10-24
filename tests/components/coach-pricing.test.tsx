// @vitest-environment jsdom
import { expectToast } from "../helpers/notifications";
import { installDialogMock } from "../helpers/dialog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CoachPricingRow } from "@/lib/coaching/coach-pricing";

const actions = vi.hoisted(() => ({ saveOwnCoachingPriceAction: vi.fn(), removeOwnCoachingPriceAction: vi.fn() }));
const clubActions = vi.hoisted(() => ({ saveClubCoachingPriceAction: vi.fn(), removeClubCoachingPriceAction: vi.fn() }));
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/coach/pricing" }));
vi.mock("@/app/coach/pricing/actions", () => actions);
vi.mock("@/app/admin/coaching/actions", () => clubActions);

import { CoachPricingTable } from "@/app/coach/pricing/pricing-table";

const programId = "a1000000-0000-4000-8000-000000000001";
const row = (overrides: Partial<CoachPricingRow>): CoachPricingRow => ({ program_id: programId, program_name: "Private lesson", program_active: true,
  duration_minutes: 60, currency: "RON", club_amount_minor: null, coach_amount_minor: null, effective: null, ...overrides });
const target = { program_id: programId, duration_minutes: 60, currency: "RON" };

beforeEach(() => {
  vi.clearAllMocks();
  installDialogMock();
});
afterEach(cleanup);

function renderRows(rows: CoachPricingRow[]) {
  render(<CoachPricingTable view={{ currencies: [{ currency: "RON", location_names: ["East Club", "North Club"] }, { currency: "EUR", location_names: [] }], rows, clubPricedPrograms: [] }} />);
  return screen.getByRole("table", { name: "My coaching prices" });
}

it("shows the club price, the coach's own price and the effective booking price per currency", () => {
  const table = renderRows([
    row({ club_amount_minor: 12000, effective: { amountMinor: 12000, currency: "RON", source: "club" } }),
    row({ duration_minutes: 90, club_amount_minor: 12000, coach_amount_minor: 15000, effective: { amountMinor: 15000, currency: "RON", source: "coach" } }),
    row({ currency: "EUR" }),
  ]);
  const [, clubOnly, override, unpriced] = within(table).getAllByRole("row");
  expect(clubOnly.textContent).toContain("East Club, North Club");
  expect(within(clubOnly).getAllByText(/120\.00/)).toHaveLength(2);
  expect(within(clubOnly).getByText("Club price")).toBeTruthy();
  expect((within(clubOnly).getByLabelText("My price for Private lesson, 60 min, RON") as HTMLInputElement).placeholder).toBe("Club price");
  expect((within(override).getByLabelText("My price for Private lesson, 90 min, RON") as HTMLInputElement).value).toBe("150.00");
  expect(within(override).getByText("My price")).toBeTruthy();
  // Neither price: shown unconfigured, never a made-up amount.
  expect(unpriced.textContent).toContain("No active location");
  expect(within(unpriced).getAllByText("Not set")).toHaveLength(1);
  expect(within(unpriced).getByText("Not configured")).toBeTruthy();
});

it("saves the coach's own price without naming a coach and keeps the value after an error", async () => {
  actions.saveOwnCoachingPriceAction.mockResolvedValueOnce({ ok: false, reason: "not-offered" }).mockResolvedValueOnce({ ok: true, id: "price-1" });
  renderRows([row({})]);
  const input = screen.getByLabelText("My price for Private lesson, 60 min, RON") as HTMLInputElement;
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  fireEvent.change(input, { target: { value: "0" } });
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "150" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(/must offer this program/)).toBeTruthy();
  expect(input.value).toBe("150");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(actions.saveOwnCoachingPriceAction).toHaveBeenLastCalledWith({ ...target, amount: "150" }));
  await expectToast("Price saved.", "success");
  expect(router.refresh).toHaveBeenCalled();
  expect(clubActions.saveClubCoachingPriceAction).not.toHaveBeenCalled();
});

it("removes the coach's own price without a confirmation dialog", async () => {
  actions.removeOwnCoachingPriceAction.mockResolvedValue({ ok: true, id: "price-1" });
  renderRows([row({ club_amount_minor: 12000, coach_amount_minor: 15000, effective: { amountMinor: 15000, currency: "RON", source: "coach" } })]);
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(actions.removeOwnCoachingPriceAction).toHaveBeenCalledWith(target));
  await expectToast("Price removed.", "success");
  expect((screen.getByLabelText("My price for Private lesson, 60 min, RON") as HTMLInputElement).value).toBe("");
  expect(clubActions.removeClubCoachingPriceAction).not.toHaveBeenCalled();
});
