import { beforeEach, expect, it, vi } from "vitest";
const { requireActiveAdmin, createClient } = vi.hoisted(() => ({ requireActiveAdmin: vi.fn(), createClient: vi.fn() }));
vi.mock("../../../src/lib/admin/authorization", () => ({ requireActiveAdmin }));
vi.mock("../../../src/lib/supabase/server", () => ({ createClient }));
vi.mock("../../../src/lib/logger", () => ({ logger: { error: vi.fn() } }));
import { listAdminCourtCoverage, saveAdminCourtCoverage, removeAdminCourtCoverage } from "../../../src/lib/admin/court-coverage";
const court_id = "c5000000-0000-4000-8000-000000000001";
const id = "c5000000-0000-4000-8000-000000000002";
const dates = { starts_on: "2026-10-15", ends_on: "2027-04-15" };
const query = { select: vi.fn(), eq: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), maybeSingle: vi.fn(), order: vi.fn() };
const client = { from: vi.fn(() => query) };
beforeEach(() => {
  vi.clearAllMocks(); createClient.mockResolvedValue(client); requireActiveAdmin.mockResolvedValue({ userId: "admin" });
  for (const key of ["select", "eq", "insert", "update", "delete", "order"] as const) query[key].mockReturnValue(query);
  query.maybeSingle.mockResolvedValueOnce({ data: { environment: "outdoor" }, error: null }).mockResolvedValue({ data: { id }, error: null });
});
it.each([undefined, id])("creates/edits coverage with explicit editable fields (id=%s)", async (periodId) => {
  expect(await saveAdminCourtCoverage({ court_id, id: periodId, dates })).toEqual({ ok: true, id });
  expect(requireActiveAdmin).toHaveBeenCalledWith(client);
  const values = (periodId ? query.update : query.insert).mock.calls[0][0];
  expect(values).toMatchObject(dates); expect(Number.isNaN(Date.parse(values.updated_at))).toBe(false);
  expect(values).not.toHaveProperty("created_at");
  if (periodId) expect(query.eq).toHaveBeenCalledWith("court_id", court_id);
});
it("removes only the identified court interval", async () => {
  expect(await removeAdminCourtCoverage({ court_id, id })).toEqual({ ok: true, id });
  expect(query.delete).toHaveBeenCalledOnce(); expect(query.eq).toHaveBeenCalledWith("court_id", court_id);
});
it.each([saveAdminCourtCoverage, removeAdminCourtCoverage])("authorizes before database access", async (mutate) => {
  requireActiveAdmin.mockRejectedValue(new Error("denied"));
  await expect(mutate({ court_id, id, dates })).rejects.toThrow("denied");
  await expect(listAdminCourtCoverage()).rejects.toThrow("denied"); expect(client.from).not.toHaveBeenCalled();
});
it.each([saveAdminCourtCoverage, removeAdminCourtCoverage])("rejects indoor mutations", async (mutate) => {
  query.maybeSingle.mockReset().mockResolvedValue({ data: { environment: "indoor" }, error: null });
  expect(await mutate(mutate === saveAdminCourtCoverage ? { court_id, id, dates } : { court_id, id })).toEqual({ ok: false, reason: "outdoor-only" });
  expect(query.insert).not.toHaveBeenCalled(); expect(query.update).not.toHaveBeenCalled(); expect(query.delete).not.toHaveBeenCalled();
});
it.each([
  { starts_on: "2027-04-16", ends_on: "2027-04-15" },
  { starts_on: "2026-02-30", ends_on: "2027-04-15" },
  { ...dates, updated_at: "spoof" },
])("rejects invalid dates and mass assignment", async (invalid) => {
  expect(await saveAdminCourtCoverage({ court_id, dates: invalid })).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(client.from).not.toHaveBeenCalled();
});
it("returns a safe overlap error", async () => {
  query.maybeSingle.mockReset().mockResolvedValueOnce({ data: { environment: "outdoor" }, error: null })
    .mockResolvedValueOnce({ data: null, error: { code: "23P01", message: "internal constraint details" } });
  expect(await saveAdminCourtCoverage({ court_id, dates })).toEqual({ ok: false, reason: "overlap" });
});
it("hides unexpected persistence errors", async () => {
  query.maybeSingle.mockReset().mockResolvedValueOnce({ data: { environment: "outdoor" }, error: null })
    .mockResolvedValueOnce({ data: null, error: { code: "XX", message: "private" } });
  await expect(saveAdminCourtCoverage({ court_id, dates })).rejects.toThrow("Unable to change coverage period.");
});
