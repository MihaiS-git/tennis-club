import { beforeEach, expect, it, vi } from "vitest";
const { requireActiveAdmin, createClient } = vi.hoisted(() => ({ requireActiveAdmin: vi.fn(), createClient: vi.fn() }));
vi.mock("../../../src/lib/admin/authorization", () => ({ requireActiveAdmin }));
vi.mock("../../../src/lib/supabase/server", () => ({ createClient }));
vi.mock("../../../src/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
import { saveAdminPricingRule } from "../../../src/lib/admin/pricing";
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
it("maps a database hours race to an actionable pricing error", async () => {
  client.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "pricing_outside_opening_hours" } });
  expect(await saveAdminPricingRule(input)).toEqual({ ok: false, reason: "invalid-input",
    fieldErrors: { ends_at: "Opening hours changed. Choose a time within the current schedule and try again." } });
});
