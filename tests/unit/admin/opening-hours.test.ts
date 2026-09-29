import { beforeEach, expect, it, vi } from "vitest";
const { requireActiveAdmin, createClient } = vi.hoisted(() => ({ requireActiveAdmin: vi.fn(), createClient: vi.fn() }));
vi.mock("../../../src/lib/admin/authorization", () => ({ requireActiveAdmin }));
vi.mock("../../../src/lib/supabase/server", () => ({ createClient }));
vi.mock("../../../src/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
import { listAdminOpeningHours, saveAdminOpeningHours, removeAdminOpeningHours } from "../../../src/lib/admin/opening-hours";
const location_id = "c6000000-0000-4000-8000-000000000011";
const id = "c6000000-0000-4000-8000-000000000021";
const input = { location_id, weekday: 0, opens_at: "07:00", closes_at: "24:00" };
const query = { select: vi.fn(), eq: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), maybeSingle: vi.fn(), order: vi.fn() };
const client = { from: vi.fn(() => query) };
beforeEach(() => {
  vi.resetAllMocks(); createClient.mockResolvedValue(client); requireActiveAdmin.mockResolvedValue({ userId: "admin" });
  for (const key of ["select", "eq", "insert", "update", "delete", "order"] as const) query[key].mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: { id }, error: null });
});
it.each([undefined, id])("creates/edits with explicit minutes and application timestamp (id=%s)", async (intervalId) => {
  expect(await saveAdminOpeningHours({ ...input, id: intervalId })).toEqual({ ok: true, id });
  expect(requireActiveAdmin).toHaveBeenCalledWith(client);
  const values = (intervalId ? query.update : query.insert).mock.calls[0][0];
  expect(values).toMatchObject({ weekday: 0, opens_at_minute: 420, closes_at_minute: 1440 });
  expect(Number.isNaN(Date.parse(values.updated_at))).toBe(false);
  expect(values).not.toHaveProperty("created_at");
  if (intervalId) { expect(query.eq.mock.calls).toEqual([["id", id], ["location_id", location_id]]); expect(values).not.toHaveProperty("location_id"); }
  else expect(values.location_id).toBe(location_id);
});
it("removes only the identified location interval", async () => {
  expect(await removeAdminOpeningHours({ location_id, id })).toEqual({ ok: true, id });
  expect(query.delete).toHaveBeenCalledOnce(); expect(query.eq.mock.calls).toEqual([["id", id], ["location_id", location_id]]);
});
it.each([() => saveAdminOpeningHours({}), () => removeAdminOpeningHours({}), () => listAdminOpeningHours()])("authorizes before database access", async (operation) => {
  requireActiveAdmin.mockRejectedValue(new Error("denied"));
  await expect(operation()).rejects.toThrow("denied"); expect(client.from).not.toHaveBeenCalled();
});
it("rejects invalid input and mass assignment before querying", async () => {
  for (const changes of [{ closes_at: "invalid" }, { opens_at: "24:00" }, { weekday: 7 }, { created_at: "spoof" }]) {
    expect(await saveAdminOpeningHours({ ...input, ...changes })).toMatchObject({ ok: false, reason: "invalid-input" });
  }
  expect(await removeAdminOpeningHours({ location_id, id, weekday: 1 })).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(client.from).not.toHaveBeenCalled();
});
it.each([["23P01", "overlap"], ["23503", "not-found"]])("maps %s to safe %s error", async (code, reason) => {
  query.maybeSingle.mockResolvedValue({ data: null, error: { code, message: "internal details" } });
  expect(await saveAdminOpeningHours(input)).toEqual({ ok: false, reason });
});
it("handles missing rows and hides unexpected database errors", async () => {
  query.maybeSingle.mockResolvedValue({ data: null, error: null });
  expect(await saveAdminOpeningHours({ ...input, id })).toEqual({ ok: false, reason: "not-found" });
  query.maybeSingle.mockResolvedValue({ data: null, error: { code: "XX", message: "private" } });
  await expect(saveAdminOpeningHours(input)).rejects.toThrow("Unable to change opening hours.");
});
it("reads validated rows in deterministic order without inventing defaults", async () => {
  query.order.mockReturnValueOnce(query).mockReturnValueOnce(query).mockReturnValueOnce(query).mockResolvedValueOnce({ data: [], error: null });
  expect(await listAdminOpeningHours()).toEqual([]);
  expect(query.order.mock.calls).toEqual([["location_id"], ["weekday"], ["opens_at_minute"], ["id"]]);
});
