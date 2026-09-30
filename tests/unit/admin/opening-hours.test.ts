import { beforeEach, expect, it, vi } from "vitest";
const { requireActiveAdmin, createClient } = vi.hoisted(() => ({ requireActiveAdmin: vi.fn(), createClient: vi.fn() }));
vi.mock("../../../src/lib/admin/authorization", () => ({ requireActiveAdmin }));
vi.mock("../../../src/lib/supabase/server", () => ({ createClient }));
vi.mock("../../../src/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
import { listAdminOpeningHours, mutateAdminOpeningHours } from "../../../src/lib/admin/opening-hours";
const location_id = "c6000000-0000-4000-8000-000000000011";
const input = { location_id, weekdays: [0, 1, 2, 3, 4], replace_ids: [], intervals: [{ opens_at: "07:00", closes_at: "24:00" }] };
const query = { select: vi.fn(), eq: vi.fn(), order: vi.fn() };
const client = { from: vi.fn(() => query), rpc: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks(); createClient.mockResolvedValue(client); requireActiveAdmin.mockResolvedValue({ userId: "admin" });
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
  query.order.mockImplementation((column: string) => column === "id" ? Promise.resolve({ data: [], error: null }) : query);
  client.rpc.mockResolvedValue({ data: { status: "ok" }, error: null });
});

it("passes all selected weekdays in one minute-based RPC and reads the committed result", async () => {
  expect(await mutateAdminOpeningHours(input)).toEqual({ ok: true, intervals: [] });
  expect(client.rpc).toHaveBeenCalledExactlyOnceWith("mutate_location_opening_hours", {
    p_location_id: location_id, p_weekdays: [0, 1, 2, 3, 4], p_replace_ids: [],
    p_opens_at_minutes: [420], p_closes_at_minutes: [1440],
  });
  expect(query.eq).toHaveBeenCalledWith("location_id", location_id);
});

it("sends grouped replace and remove through the same RPC", async () => {
  const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
  await mutateAdminOpeningHours({ ...input, replace_ids: ids, intervals: [{ opens_at: "08:00", closes_at: "22:00" }] });
  expect(client.rpc.mock.calls[0][1].p_replace_ids).toEqual(ids);
  expect(client.rpc.mock.calls[0][1].p_weekdays).toEqual(input.weekdays);
  await mutateAdminOpeningHours({ ...input, replace_ids: ids, intervals: [] });
  expect(client.rpc.mock.calls[1][1]).toMatchObject({ p_weekdays: input.weekdays, p_replace_ids: ids, p_opens_at_minutes: [], p_closes_at_minutes: [] });
});

it("authorizes before database access and rejects invalid input", async () => {
  expect(await mutateAdminOpeningHours({ ...input, weekdays: [0, 0] })).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(client.rpc).not.toHaveBeenCalled();
  requireActiveAdmin.mockRejectedValue(new Error("denied"));
  await expect(mutateAdminOpeningHours(input)).rejects.toThrow("denied");
  await expect(listAdminOpeningHours()).rejects.toThrow("denied");
});

it("returns specific conflict days and hides unexpected database errors", async () => {
  client.rpc.mockResolvedValueOnce({ data: { status: "overlap", weekdays: [1] }, error: null });
  expect(await mutateAdminOpeningHours(input)).toEqual({ ok: false, reason: "overlap", weekdays: [1] });
  client.rpc.mockResolvedValueOnce({ data: null, error: { code: "XX", message: "private" } });
  await expect(mutateAdminOpeningHours(input)).rejects.toThrow("Unable to change opening hours.");
});
