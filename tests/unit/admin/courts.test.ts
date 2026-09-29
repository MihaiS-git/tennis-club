import { beforeEach, expect, it, vi } from "vitest";
import { courtFieldsSchema, generateCourtSlug } from "../../../src/lib/admin/courts-validation";

const { requireActiveAdmin, createClient, logger } = vi.hoisted(() => ({
  requireActiveAdmin: vi.fn(), createClient: vi.fn(), logger: { error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../../src/lib/admin/authorization", () => ({ requireActiveAdmin }));
vi.mock("../../../src/lib/supabase/server", () => ({ createClient }));
vi.mock("../../../src/lib/logger", () => ({ logger }));
import { listAdminCourts, saveAdminCourt } from "../../../src/lib/admin/courts";

const id = "c3000000-0000-4000-8000-000000000001";
const location_id = "c3000000-0000-4000-8000-000000000002";
const fields = { location_id, name: " Court One ", surface: "clay", environment: "outdoor",
  has_lighting: false, is_active: true, display_order: 0 };
const query = { insert: vi.fn(), update: vi.fn(), eq: vi.fn(), select: vi.fn(), maybeSingle: vi.fn(), order: vi.fn() };
const client = { from: vi.fn(() => query) };
beforeEach(() => {
  vi.clearAllMocks();
  createClient.mockResolvedValue(client);
  requireActiveAdmin.mockResolvedValue({ userId: "admin" });
  for (const key of ["insert", "update", "eq", "select", "order"] as const) query[key].mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: { id }, error: null });
});

it("creates a court with the location, generated slug and explicit application timestamp", async () => {
  expect(await saveAdminCourt({ fields })).toEqual({ ok: true, id });
  expect(requireActiveAdmin).toHaveBeenCalledWith(client);
  const payload = query.insert.mock.calls[0][0];
  expect(payload).toMatchObject({ location_id, name: "Court One", slug: "court-one" });
  expect(Number.isNaN(Date.parse(payload.updated_at))).toBe(false);
  expect(payload).not.toHaveProperty("created_at");
});
it.each([false, true])("edits, moves and sets active=%s without changing the slug", async (is_active) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-29T18:00:00Z"));
  try {
    const nextLocation = "c3000000-0000-4000-8000-000000000003";
    expect(await saveAdminCourt({ id, fields: { ...fields, name: "Renamed", location_id: nextLocation, is_active, display_order: 8, has_lighting: true } }))
      .toEqual({ ok: true, id });
    expect(query.update).toHaveBeenCalledWith({ ...fields, name: "Renamed", location_id: nextLocation, is_active, display_order: 8, has_lighting: true, updated_at: "2026-09-29T18:00:00.000Z" });
    expect(query.update.mock.calls[0][0]).not.toHaveProperty("slug");
    expect(query.eq).toHaveBeenCalledWith("id", id);
  } finally { vi.useRealTimers(); }
});
it("denies unauthorized callers before querying courts", async () => {
  requireActiveAdmin.mockRejectedValue(new Error("notFound"));
  await expect(saveAdminCourt({ fields })).rejects.toThrow("notFound");
  await expect(listAdminCourts()).rejects.toThrow("notFound");
  expect(client.from).not.toHaveBeenCalled();
});
it.each([
  { ...fields, surface: "sand" }, { ...fields, environment: "covered" }, { ...fields, location_id: "bad" },
  { ...fields, is_active: "true" }, { ...fields, has_lighting: null }, { ...fields, name: " " },
  { ...fields, display_order: 1.5 }, { ...fields, display_order: 2147483648 },
  { ...fields, slug: "spoof" }, { ...fields, updated_at: "2000-01-01" },
  { ...fields, supports_balloon: true }, { ...fields, balloon_installed: true },
])("rejects invalid, obsolete and system-managed inputs", async (invalid) => {
  expect(await saveAdminCourt({ fields: invalid })).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(client.from).not.toHaveBeenCalled();
});
it.each(["clay", "hard", "grass", "carpet"])("accepts surface %s", (surface) => {
  expect(courtFieldsSchema.safeParse({ ...fields, surface }).success).toBe(true);
});
it.each(["outdoor", "indoor"])("accepts environment %s", (environment) => {
  expect(courtFieldsSchema.safeParse({ ...fields, environment }).success).toBe(true);
});
it.each([undefined, id])("handles duplicate slug on creation or a move (id=%s)", async (courtId) => {
  query.maybeSingle.mockResolvedValue({ data: null, error: { code: "23505" } });
  expect(await saveAdminCourt({ id: courtId, fields })).toEqual({ ok: false, reason: "duplicate-slug" });
});
it("reports a nonexistent location without exposing database details", async () => {
  query.maybeSingle.mockResolvedValue({ data: null, error: { code: "23503", message: "Internal details" } });
  expect(await saveAdminCourt({ fields })).toEqual({ ok: false, reason: "invalid-location" });
});
it("reports a missing court", async () => {
  query.maybeSingle.mockResolvedValue({ data: null, error: null });
  expect(await saveAdminCourt({ id, fields })).toEqual({ ok: false, reason: "not-found" });
});
it("uses a safe error for unexpected persistence errors", async () => {
  query.maybeSingle.mockResolvedValue({ data: null, error: { code: "XX", message: "Internal detail" } });
  await expect(saveAdminCourt({ fields })).rejects.toThrow("Unable to save court.");
  expect(logger.error.mock.calls[0][0]).not.toHaveProperty("message");
});
it("generates slugs using the established accent and punctuation normalization", async () => {
  expect(generateCourtSlug("  Cöurt Ștefan — 2! ")).toBe("court-stefan-2");
  expect(await saveAdminCourt({ fields: { ...fields, name: "🎾" } })).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(query.insert).not.toHaveBeenCalled();
  expect(await saveAdminCourt({ id, fields: { ...fields, name: "🎾" } })).toEqual({ ok: true, id });
});
it("lists inactive courts without filtering location or status and orders consistently", async () => {
  const court = { ...fields, id, slug: "court-one", is_active: false, created_at: "2026-09-29T10:00:00Z", updated_at: "2026-09-29T10:00:00Z" };
  query.order.mockReturnValueOnce(query).mockReturnValueOnce(query).mockResolvedValueOnce({ data: [court], error: null });
  expect(await listAdminCourts()).toEqual([court]);
  expect(requireActiveAdmin).toHaveBeenCalledWith(client);
  expect(query.order.mock.calls).toEqual([["display_order"], ["name"], ["id"]]);
  expect(query.eq).not.toHaveBeenCalled();
});
