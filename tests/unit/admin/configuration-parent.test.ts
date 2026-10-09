import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(), transaction: vi.fn(), revision: vi.fn(), locations: vi.fn(), court: vi.fn(),
  actor: vi.fn(), coverage: vi.fn(), pricing: vi.fn(), update: vi.fn(), insertCoverage: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.auth }));
vi.mock("@/lib/db/transaction", () => ({ inTransaction: mocks.transaction }));
vi.mock("@/lib/db/repositories/accounts.repository", () => ({ lockActiveAdminAccount: mocks.actor }));
vi.mock("@/lib/db/repositories/clubs.repository", () => ({
  lockConfigurationForWrite: mocks.revision, lockLocations: mocks.locations,
  findCourtConfiguration: mocks.court, listCourtCoverage: mocks.coverage,
  updateCourt: mocks.update, insertCourtCoverage: mocks.insertCoverage,
}));
vi.mock("@/lib/db/repositories/pricing.repository", () => ({ listLocationPricingRules: mocks.pricing }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
import { saveAdminCourt } from "@/lib/admin/courts";
import { saveAdminCourtCoverage } from "@/lib/admin/court-coverage";
const courtId = "c7000000-0000-4000-8000-000000000031";
const oldId = "c7000000-0000-4000-8000-000000000011";
const newId = "c7000000-0000-4000-8000-000000000012";
const facts = { id: courtId, locationId: newId, environment: "outdoor" };
const saveCourt = () => saveAdminCourt({ id: courtId, fields: { location_id: newId, name: "Court",
  surface: "clay", environment: "outdoor", has_lighting: false, is_active: true } });
const saveCoverage = () => saveAdminCourtCoverage({ court_id: courtId,
  dates: { starts_on: "2099-01-01", ends_on: "2099-01-31" } });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ userId: "admin" });
  mocks.transaction.mockImplementation((work: (manager: object) => Promise<unknown>) => work({}));
  mocks.actor.mockResolvedValue(true); mocks.locations.mockResolvedValue([{ id: newId }, { id: oldId }]);
  mocks.court.mockResolvedValue(facts); mocks.coverage.mockResolvedValue([]); mocks.pricing.mockResolvedValue([]);
  mocks.update.mockResolvedValue(courtId); mocks.insertCoverage.mockResolvedValue(courtId);
});
test.each([saveCourt, saveCoverage])("restarts the transaction when parent discovery changed", async (save) => {
  mocks.court.mockResolvedValueOnce({ ...facts, locationId: oldId });
  expect(await save()).toEqual({ ok: true, id: courtId });
  expect(mocks.transaction).toHaveBeenCalledTimes(2);
  expect(mocks.revision).toHaveBeenCalledTimes(2);
  expect(mocks.locations.mock.calls[1][1]).toEqual([newId, ...(save === saveCourt ? [newId] : [])]);
  expect(mocks.update.mock.calls.length + mocks.insertCoverage.mock.calls.length).toBe(1);
  expect(mocks.court.mock.invocationCallOrder[1]).toBeGreaterThan(mocks.locations.mock.invocationCallOrder[0]);
});
test.each([saveCourt, saveCoverage])("bounds parent retries at three fresh transactions", async (save) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    mocks.court.mockResolvedValueOnce({ ...facts, locationId: oldId }).mockResolvedValueOnce(facts);
  }
  await expect(save()).rejects.toThrow();
  expect(mocks.transaction).toHaveBeenCalledTimes(3);
  expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.insertCoverage).not.toHaveBeenCalled();
});
