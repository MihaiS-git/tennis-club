import { QueryFailedError } from "typeorm";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  requireActiveAdmin: vi.fn(), createClient: vi.fn(), getDataSource: vi.fn(), inTransaction: vi.fn(),
  lockActiveAdminAccount: vi.fn(), lockConfigurationForWrite: vi.fn(), lockLocations: vi.fn(),
  listLocationOpeningHours: vi.fn(), findPricingCourts: vi.fn(), findLocationRuleSet: vi.fn(),
  insertRuleSet: vi.fn(), deleteRuleSetRules: vi.fn(), insertPricingRules: vi.fn(), deleteLocationRuleSet: vi.fn(),
  listLocationPricingRules: vi.fn(), manager: {},
}));
vi.mock("../../../src/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.requireActiveAdmin }));
vi.mock("../../../src/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("../../../src/lib/db/data-source", () => ({ getDataSource: mocks.getDataSource }));
vi.mock("../../../src/lib/db/transaction", () => ({ inTransaction: mocks.inTransaction }));
vi.mock("../../../src/lib/db/repositories/accounts.repository", () => ({ lockActiveAdminAccount: mocks.lockActiveAdminAccount }));
vi.mock("../../../src/lib/db/repositories/clubs.repository", () => ({
  lockConfigurationForWrite: mocks.lockConfigurationForWrite, lockLocations: mocks.lockLocations,
  readOpeningHoursConfigurationTime: async () => new Date("2026-10-10T00:00:00Z"),
  listLocationOpeningHours: mocks.listLocationOpeningHours, listOpeningHoursSchedules: async () => [{ id: ruleSet, startsOn: "0001-01-01", endsOn: null }],
}));
vi.mock("../../../src/lib/db/repositories/pricing.repository", () => ({
  findPricingCourts: mocks.findPricingCourts, findLocationRuleSet: mocks.findLocationRuleSet, insertRuleSet: mocks.insertRuleSet,
  deleteRuleSetRules: mocks.deleteRuleSetRules, insertPricingRules: mocks.insertPricingRules,
  deleteLocationRuleSet: mocks.deleteLocationRuleSet, listLocationPricingRules: mocks.listLocationPricingRules,
}));
vi.mock("../../../src/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
import { saveAdminPricingRule } from "../../../src/lib/admin/pricing";
const location_id = "c7000000-0000-4000-8000-000000000011";
const court1 = "c7000000-0000-4000-8000-000000000031";
const court2 = "c7000000-0000-4000-8000-000000000032";
const ruleSet = "c7000000-0000-4000-8000-000000000041";
const input = { location_id, court_ids: [court1, court2], court_state: "covered", weekdays: [0, 1, 2, 3, 4], starts_at: "07:00", ends_at: "16:00", starts_on: "", ends_on: "", price_per_hour: "12.50" };
const timestamp = new Date("2026-09-29T00:00:00Z");
const hours = { id: ruleSet, locationId: location_id, scheduleId: ruleSet, weekday: 0, opensAtMinute: 420, closesAtMinute: 1440, createdAt: timestamp, updatedAt: timestamp };
const client = { from: vi.fn(), rpc: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks(); mocks.createClient.mockResolvedValue(client); mocks.requireActiveAdmin.mockResolvedValue({ userId: "admin" });
  mocks.getDataSource.mockResolvedValue({ manager: mocks.manager });
  mocks.inTransaction.mockImplementation((work: (manager: object) => Promise<unknown>) => work(mocks.manager));
  mocks.lockLocations.mockResolvedValue([{ id: location_id, timezone: "UTC" }]); mocks.lockActiveAdminAccount.mockResolvedValue(true);
  mocks.listLocationOpeningHours.mockResolvedValue(input.weekdays.map((weekday) => ({ ...hours, weekday })));
  mocks.findPricingCourts.mockResolvedValue([court1, court2].map((id) => ({ id, locationId: location_id, environment: "outdoor" })));
  mocks.findLocationRuleSet.mockResolvedValue(null); mocks.insertRuleSet.mockResolvedValue(ruleSet);
  mocks.listLocationPricingRules.mockResolvedValue([]);
});
it("rejects mass assignment and empty selections before opening a transaction", async () => {
  for (const changes of [{ surface: "clay" }, { court_ids: [] }, { weekdays: [] }])
    expect(await saveAdminPricingRule({ ...input, ...changes })).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(mocks.inTransaction).not.toHaveBeenCalled();
});
it("checks all courts belong to the location and share a state", async () => {
  mocks.findPricingCourts.mockResolvedValueOnce([{ id: court1, locationId: location_id, environment: "outdoor" }]);
  expect(await saveAdminPricingRule(input)).toMatchObject({ ok: false, fieldErrors: { court_ids: expect.any(String) } });
  mocks.findPricingCourts.mockResolvedValueOnce([court1, court2].map((id) => ({ id, locationId: location_id, environment: "indoor" })));
  expect(await saveAdminPricingRule(input)).toMatchObject({ ok: false, fieldErrors: { court_state: expect.any(String) } });
  expect(mocks.insertRuleSet).not.toHaveBeenCalled();
});
it.each(["outdoor", "covered"])("persists independent %s pricing for outdoor courts with the same schedule", async (court_state) => {
  mocks.listLocationPricingRules.mockResolvedValue([{ courtId: court1, courtState: court_state === "outdoor" ? "covered" : "outdoor",
    weekday: 0, startsAtMinute: 420, endsAtMinute: 960, startsOn: null, endsOn: null, ruleSetId: "other-season" }]);
  expect(await saveAdminPricingRule({ ...input, court_state })).toEqual({ ok: true, id: ruleSet });
  expect(mocks.insertPricingRules).toHaveBeenCalledWith(mocks.manager,
    expect.arrayContaining([expect.objectContaining({ courtId: court1, courtState: court_state, pricePerHourMinor: 1250 })]));
  expect(mocks.insertPricingRules.mock.calls[0][1]).toHaveLength(10);
  expect(mocks.deleteRuleSetRules).not.toHaveBeenCalled();
});
it.each(["indoor", "outdoor", "covered"])("keeps indoor courts restricted when saving %s pricing", async (court_state) => {
  mocks.findPricingCourts.mockResolvedValue([court1, court2].map((id) => ({ id, locationId: location_id, environment: "indoor" })));
  const result = await saveAdminPricingRule({ ...input, court_state });
  if (court_state === "indoor") {
    expect(result).toEqual({ ok: true, id: ruleSet });
    expect(mocks.insertPricingRules).toHaveBeenCalledWith(mocks.manager, expect.arrayContaining([expect.objectContaining({ courtState: "indoor" })]));
  } else {
    expect(result).toMatchObject({ ok: false, fieldErrors: { court_state: expect.any(String) } });
    expect(mocks.insertPricingRules).not.toHaveBeenCalled();
  }
});
it.each(["23P01", "23503"])("preserves SQLSTATE %s translation", async (code) => {
  mocks.insertPricingRules.mockRejectedValueOnce(new QueryFailedError("test statement", [], Object.assign(new Error("driver failure"), { code, constraint: "test_constraint" })));
  expect(await saveAdminPricingRule(input)).toEqual({ ok: false, reason: code === "23503" ? "not-found" : "overlap" });
});

it("rejects overlap before creating a parent or deleting replacement children", async () => {
  const existing = { courtId: court1, courtState: "covered", weekday: 0, startsAtMinute: 500,
    endsAtMinute: 600, startsOn: null, endsOn: null, ruleSetId: "another-set" };
  mocks.listLocationPricingRules.mockResolvedValue([existing]);
  expect(await saveAdminPricingRule(input)).toEqual({ ok: false, reason: "overlap" });
  mocks.findLocationRuleSet.mockResolvedValue({ id: ruleSet });
  expect(await saveAdminPricingRule({ ...input, rule_set_id: ruleSet, revision: "[]" })).toEqual({ ok: false, reason: "overlap" });
  expect(mocks.insertRuleSet).not.toHaveBeenCalled();
  expect(mocks.deleteRuleSetRules).not.toHaveBeenCalled();
  expect(mocks.insertPricingRules).not.toHaveBeenCalled();
});
