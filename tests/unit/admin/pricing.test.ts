import { beforeEach, expect, it, vi } from "vitest";
const { requireActiveAdmin, createClient } = vi.hoisted(() => ({ requireActiveAdmin: vi.fn(), createClient: vi.fn() }));
vi.mock("../../../src/lib/admin/authorization", () => ({ requireActiveAdmin }));
vi.mock("../../../src/lib/supabase/server", () => ({ createClient }));
vi.mock("../../../src/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
import { listAdminPricingRules, saveAdminPricingRule, removeAdminPricingRule } from "../../../src/lib/admin/pricing";
const location_id = "c7000000-0000-4000-8000-000000000011";
const court1 = "c7000000-0000-4000-8000-000000000031";
const court2 = "c7000000-0000-4000-8000-000000000032";
const ruleSet = "c7000000-0000-4000-8000-000000000041";
const input = { location_id, court_ids: [court1, court2], court_state: "covered", weekdays: [0, 1, 2, 3, 4], starts_at: "07:00", ends_at: "16:00", starts_on: "", ends_on: "", price_per_hour: "12.50" };
const hours = { id: ruleSet, location_id, weekday: 0, opens_at_minute: 420, closes_at_minute: 1440, created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z" };
const hoursQuery = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), then: vi.fn() };
const courtsQuery = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), then: vi.fn() };
const rulesQuery = { select: vi.fn(), eq: vi.fn(), then: vi.fn() };
const client = { from: vi.fn((table: string) => table === "location_opening_hours" ? hoursQuery : table === "courts" ? courtsQuery : rulesQuery), rpc: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks(); createClient.mockResolvedValue(client); requireActiveAdmin.mockResolvedValue({ userId: "admin" });
  for (const query of [hoursQuery, courtsQuery]) { query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.in.mockReturnValue(query); }
  rulesQuery.select.mockReturnValue(rulesQuery); rulesQuery.eq.mockReturnValue(rulesQuery);
  hoursQuery.then.mockImplementation((resolve) => resolve({ data: input.weekdays.map((weekday) => ({ ...hours, weekday })), error: null }));
  courtsQuery.then.mockImplementation((resolve) => resolve({ data: [court1, court2].map((id) => ({ id, location_id, environment: "outdoor" })), error: null }));
  rulesQuery.then.mockImplementation((resolve) => resolve({ data: [], error: null }));
  client.rpc.mockResolvedValue({ data: ruleSet, error: null });
});
it.each([undefined, ruleSet])("submits all selected courts/days through one atomic RPC (id=%s)", async (id) => {
  expect(await saveAdminPricingRule({ ...input, rule_set_id: id })).toEqual({ ok: true, id: ruleSet });
  expect(client.rpc).toHaveBeenCalledExactlyOnceWith("save_pricing_rule_set", expect.objectContaining({
    p_rule_set_id: id ?? null, p_location_id: location_id, p_court_ids: [court1, court2], p_weekdays: [0, 1, 2, 3, 4],
    p_court_state: "covered", p_starts_at_minute: 420, p_ends_at_minute: 960, p_price_per_hour_minor: 1250,
  }));
});
it("removes the whole set through one RPC", async () => {
  expect(await removeAdminPricingRule({ rule_set_id: ruleSet, location_id })).toEqual({ ok: true, id: ruleSet });
  expect(client.rpc).toHaveBeenCalledExactlyOnceWith("remove_pricing_rule_set", { p_rule_set_id: ruleSet, p_location_id: location_id });
  expect(client.from).not.toHaveBeenCalled();
});
it.each([() => saveAdminPricingRule(input), () => removeAdminPricingRule({ rule_set_id: ruleSet, location_id }), () => listAdminPricingRules(location_id)])("authorizes before database access", async (operation) => {
  requireActiveAdmin.mockRejectedValueOnce(new Error("denied")); await expect(operation()).rejects.toThrow("denied");
  expect(client.from).not.toHaveBeenCalled(); expect(client.rpc).not.toHaveBeenCalled();
});
it("rejects mass assignment and empty selections before reading", async () => {
  for (const changes of [{ surface: "clay" }, { court_ids: [] }, { weekdays: [] }])
    expect(await saveAdminPricingRule({ ...input, ...changes })).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(client.from).not.toHaveBeenCalled();
});
it("checks all courts belong to the location and share a state", async () => {
  courtsQuery.then.mockImplementationOnce((resolve) => resolve({ data: [{ id: court1, location_id, environment: "outdoor" }], error: null }));
  expect(await saveAdminPricingRule(input)).toMatchObject({ ok: false, fieldErrors: { court_ids: expect.any(String) } });
  courtsQuery.then.mockImplementationOnce((resolve) => resolve({ data: [court1, court2].map((id) => ({ id, location_id, environment: "indoor" })), error: null }));
  expect(await saveAdminPricingRule(input)).toMatchObject({ ok: false, fieldErrors: { court_state: expect.any(String) } });
  expect(client.rpc).not.toHaveBeenCalled();
});
it("rejects any day outside opening hours before mutation, including edits", async () => {
  hoursQuery.then.mockImplementation((resolve) => resolve({ data: input.weekdays.filter((day) => day !== 3).map((weekday) => ({ ...hours, weekday })), error: null }));
  expect(await saveAdminPricingRule({ ...input, rule_set_id: ruleSet })).toMatchObject({ ok: false, fieldErrors: { ends_at: expect.stringContaining("Thursday") } });
  expect(client.rpc).not.toHaveBeenCalled();
});
it.each([["23P01", "overlap"], ["23505", "overlap"], ["23503", "not-found"]])("maps %s safely", async (code, reason) => {
  client.rpc.mockResolvedValueOnce({ data: null, error: { code, message: "secret" } });
  expect(await saveAdminPricingRule(input)).toEqual({ ok: false, reason });
});
it("handles vanished rule sets and hides unknown database errors", async () => {
  client.rpc.mockResolvedValueOnce({ data: null, error: null });
  expect(await saveAdminPricingRule({ ...input, rule_set_id: ruleSet })).toEqual({ ok: false, reason: "not-found" });
  client.rpc.mockResolvedValueOnce({ data: null, error: { code: "unknown" } });
  await expect(saveAdminPricingRule(input)).rejects.toThrow("Unable to change pricing rules.");
});
