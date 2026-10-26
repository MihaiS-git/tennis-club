import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), source: vi.fn(), courts: vi.fn(), coverage: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.auth }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: mocks.source }));
vi.mock("@/lib/db/repositories/clubs.repository", () => ({
  listAdminCourts: mocks.courts, listCourtCoverage: mocks.coverage,
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { listAdminCourts } from "@/lib/admin/courts";
import { listAdminCourtCoverage } from "@/lib/admin/court-coverage";

const locationId = "c6000000-0000-4000-8000-000000000001";
const courtId = "c6000000-0000-4000-8000-000000000002";
const manager = {};
const now = new Date("2026-10-26T10:00:00Z");
const court = { id: courtId, locationId, name: "Inactive court", slug: "inactive-court",
  surface: "clay", environment: "outdoor", isActive: false, hasLighting: true, createdAt: now, updatedAt: now };
const coverage = { id: "c6000000-0000-4000-8000-000000000003", courtId,
  startsOn: "2025-01-01", endsOn: "2025-01-31", createdAt: now, updatedAt: now };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ userId: "admin" });
  mocks.source.mockResolvedValue({ manager });
  mocks.courts.mockResolvedValue([court]);
  mocks.coverage.mockResolvedValue([coverage]);
});

test("passes the location scope through to persistence and preserves inactive courts and historical coverage", async () => {
  expect(await listAdminCourts(undefined, locationId)).toEqual([{
    id: courtId, location_id: locationId, name: court.name, slug: court.slug,
    surface: court.surface, environment: court.environment, has_lighting: true, is_active: false,
    created_at: now.toISOString(), updated_at: now.toISOString(),
  }]);
  expect(await listAdminCourtCoverage(undefined, locationId)).toEqual([{
    id: coverage.id, court_id: courtId, starts_on: coverage.startsOn, ends_on: coverage.endsOn,
    created_at: now.toISOString(), updated_at: now.toISOString(),
  }]);
  expect(mocks.courts).toHaveBeenCalledExactlyOnceWith(manager, locationId);
  expect(mocks.coverage).toHaveBeenCalledExactlyOnceWith(manager, undefined, locationId);
  expect(mocks.auth.mock.invocationCallOrder[0]).toBeLessThan(mocks.courts.mock.invocationCallOrder[0]);
  expect(mocks.auth.mock.invocationCallOrder[1]).toBeLessThan(mocks.coverage.mock.invocationCallOrder[0]);
});

test.each([listAdminCourts, listAdminCourtCoverage])("requires Admin authorization before reading location resources", async (read) => {
  mocks.auth.mockRejectedValue(new Error("Administrator required"));
  await expect(read(undefined, locationId)).rejects.toThrow("Administrator required");
  expect(mocks.source).not.toHaveBeenCalled();
  expect(mocks.courts).not.toHaveBeenCalled();
  expect(mocks.coverage).not.toHaveBeenCalled();
});

test.each(["", "invalid-location"])("rejects invalid scope %j rather than reading club-wide", async (scope) => {
  await expect(listAdminCourts(undefined, scope)).rejects.toThrow();
  await expect(listAdminCourtCoverage(undefined, scope)).rejects.toThrow();
  expect(mocks.source).not.toHaveBeenCalled();
});

test("preserves unscoped callers and empty states", async () => {
  mocks.courts.mockResolvedValue([]);
  mocks.coverage.mockResolvedValue([]);
  expect(await listAdminCourts()).toEqual([]);
  expect(await listAdminCourtCoverage()).toEqual([]);
  expect(mocks.courts).toHaveBeenCalledWith(manager, undefined);
  expect(mocks.coverage).toHaveBeenCalledWith(manager, undefined, undefined);
});

test("preserves safe resource loading errors", async () => {
  mocks.courts.mockRejectedValue(new Error("private database detail"));
  mocks.coverage.mockRejectedValue(new Error("private database detail"));
  await expect(listAdminCourts(undefined, locationId)).rejects.toThrow(/^Unable to load courts\.$/);
  await expect(listAdminCourtCoverage(undefined, locationId)).rejects.toThrow(/^Unable to load coverage periods\.$/);
});
