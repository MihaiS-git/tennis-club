import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ revalidate: vi.fn(), saveCourt: vi.fn(), saveCoverage: vi.fn(), removeCoverage: vi.fn(), savePricing: vi.fn(), removePricing: vi.fn(), openingHours: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("../../../src/lib/admin/courts", () => ({ saveAdminCourt: mocks.saveCourt }));
vi.mock("../../../src/lib/admin/court-coverage", () => ({ saveAdminCourtCoverage: mocks.saveCoverage, removeAdminCourtCoverage: mocks.removeCoverage }));
vi.mock("../../../src/lib/admin/pricing", () => ({ saveAdminPricingRule: mocks.savePricing, removeAdminPricingRule: mocks.removePricing }));
vi.mock("../../../src/lib/admin/opening-hours", () => ({ mutateAdminOpeningHours: mocks.openingHours }));
import { mutateOpeningHoursAction } from "../../../src/app/admin/locations/opening-hours-actions";
import { saveCourtAction, saveCoverageAction, removeCoverageAction } from "../../../src/app/admin/courts/actions";
import { savePricingRuleAction, removePricingRuleAction } from "../../../src/app/admin/pricing/actions";

beforeEach(() => vi.resetAllMocks());

it.each([
  [saveCourtAction, mocks.saveCourt, ["/courts"]],
  [saveCoverageAction, mocks.saveCoverage, []],
  [removeCoverageAction, mocks.removeCoverage, []],
  [savePricingRuleAction, mocks.savePricing, ["/book", "/courts", "/admin/bookings", "/coach/bookings"]],
  [removePricingRuleAction, mocks.removePricing, ["/book", "/courts", "/admin/bookings", "/coach/bookings"]],
] as const)("refreshes the workspace and affected destinations after a successful resource mutation", async (action, service, paths) => {
  service.mockResolvedValue({ ok: true, id: "resource" });
  expect(await action({ intent: "existing service validates input" })).toEqual({ ok: true, id: "resource" });
  for (const path of paths) expect(mocks.revalidate).toHaveBeenCalledWith(path);
  expect(mocks.revalidate).toHaveBeenCalledTimes(paths.length + 1);
  expect(mocks.revalidate).toHaveBeenCalledWith("/admin/locations", "layout");
});

it.each([
  [saveCoverageAction, mocks.saveCoverage],
  [removeCoverageAction, mocks.removeCoverage],
] as const)("does not refresh or replace drafts after a rejected coverage mutation", async (action, service) => {
  service.mockResolvedValue({ ok: false, reason: "overlap" });
  expect(await action({})).toEqual({ ok: false, reason: "overlap" });
  expect(mocks.revalidate).not.toHaveBeenCalled();
});

it("refreshes pricing, readiness and public discovery only after committed opening-hours changes", async () => {
  mocks.openingHours.mockResolvedValueOnce({ ok: false, reason: "stale" });
  await mutateOpeningHoursAction({});
  expect(mocks.revalidate).not.toHaveBeenCalled();
  mocks.openingHours.mockResolvedValueOnce({ ok: true, intervals: [], pricingAdjusted: true });
  await mutateOpeningHoursAction({});
  expect(mocks.revalidate).toHaveBeenCalledWith("/admin/locations", "layout");
  for (const path of ["/book", "/courts", "/admin/bookings", "/coach/bookings"]) expect(mocks.revalidate).toHaveBeenCalledWith(path);
  expect(mocks.revalidate).toHaveBeenCalledTimes(5);
});
