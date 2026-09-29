import { beforeEach, expect, it, vi } from "vitest";
import { generateLocationSlug, locationFieldsSchema } from "../../../src/lib/admin/locations-validation";

const { requireActiveAdmin, createClient, logger } = vi.hoisted(() => ({
  requireActiveAdmin: vi.fn(), createClient: vi.fn(), logger: { error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../../src/lib/admin/authorization", () => ({ requireActiveAdmin }));
vi.mock("../../../src/lib/supabase/server", () => ({ createClient }));
vi.mock("../../../src/lib/logger", () => ({ logger }));

import { listAdminLocations, saveAdminLocation } from "../../../src/lib/admin/locations";

const id = "a1000000-0000-4000-8000-000000000001";
const fields = { name: " Central Club ", address_line1: "", address_line2: "", city: "Cluj", postal_code: "",
  country_code: "RO", timezone: "Europe/Bucharest", currency: "EUR", is_active: true, display_order: 0 };
const query = { insert: vi.fn(), update: vi.fn(), eq: vi.fn(), select: vi.fn(), maybeSingle: vi.fn(), order: vi.fn() };
const client = { from: vi.fn(() => query) };

beforeEach(() => {
  vi.clearAllMocks();
  createClient.mockResolvedValue(client);
  requireActiveAdmin.mockResolvedValue({ userId: "admin" });
  for (const key of ["insert", "update", "eq", "select", "order"] as const) query[key].mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: { id }, error: null });
});

it("creates a location with a generated slug, normalized input and application timestamp", async () => {
  await expect(saveAdminLocation({ fields })).resolves.toEqual({ ok: true, id });
  expect(requireActiveAdmin).toHaveBeenCalledWith(client);
  const payload = query.insert.mock.calls[0][0];
  expect(payload).toMatchObject({ name: "Central Club", slug: "central-club", currency: "EUR", address_line1: null });
  expect(Number.isNaN(Date.parse(payload.updated_at))).toBe(false);
  expect(payload).not.toHaveProperty("created_at");
});

it.each([false, true])("edits and sets active=%s, preserving the existing slug", async (is_active) => {
  const now = new Date("2026-09-29T12:00:00.000Z");
  vi.useFakeTimers(); vi.setSystemTime(now);
  try {
    await expect(saveAdminLocation({ id, fields: { ...fields, name: "Renamed", currency: "RON", is_active, display_order: 3 } }))
      .resolves.toEqual({ ok: true, id });
    expect(query.update).toHaveBeenCalledWith(expect.objectContaining({ name: "Renamed", currency: "RON", is_active, display_order: 3, updated_at: now.toISOString() }));
    expect(query.update.mock.calls[0][0]).not.toHaveProperty("slug");
    expect(query.eq).toHaveBeenCalledWith("id", id);
    expect(query.insert).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("denies unauthorized mutations before any database write", async () => {
  requireActiveAdmin.mockRejectedValue(new Error("notFound"));
  await expect(saveAdminLocation({ fields })).rejects.toThrow("notFound");
  expect(client.from).not.toHaveBeenCalled();
});

it.each([
  { ...fields, currency: "CAD" }, { ...fields, timezone: "+02:00" }, { ...fields, timezone: "PST" },
  { ...fields, timezone: "Europe/Nowhere" }, { ...fields, country_code: "XX" },
  { ...fields, display_order: 1.5 }, { ...fields, display_order: 2147483648 },
  { ...fields, slug: "spoof" }, { ...fields, updated_at: "2000-01-01" },
])("rejects invalid fields and system-controlled fields", async (invalid) => {
  expect(await saveAdminLocation({ fields: invalid })).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(client.from).not.toHaveBeenCalled();
});

it("reports duplicate generated slugs as a domain error", async () => {
  query.maybeSingle.mockResolvedValue({ data: null, error: { code: "23505" } });
  await expect(saveAdminLocation({ fields })).resolves.toEqual({ ok: false, reason: "duplicate-slug" });
});

it("reports a missing edited location", async () => {
  query.maybeSingle.mockResolvedValue({ data: null, error: null });
  await expect(saveAdminLocation({ id, fields })).resolves.toEqual({ ok: false, reason: "not-found" });
});

it("does not expose internal database errors", async () => {
  query.maybeSingle.mockResolvedValue({ data: null, error: { code: "XX", message: "private database detail" } });
  await expect(saveAdminLocation({ fields })).rejects.toThrow("Unable to save location.");
  expect(logger.error.mock.calls[0][0]).not.toHaveProperty("message");
});

it.each(["EUR", "USD", "GBP", "RON", "CHF"])("accepts %s", (currency) => {
  expect(locationFieldsSchema.safeParse({ ...fields, currency }).success).toBe(true);
});

it("accepts UTC and IANA aliases", () => {
  for (const timezone of ["UTC", "America/New_York", "Europe/London", "Asia/Kolkata"]) {
    expect(locationFieldsSchema.safeParse({ ...fields, timezone }).success).toBe(true);
  }
});

it("normalizes accents and punctuation without adding a slug framework", () => {
  expect(generateLocationSlug("  Clüb Ștefan — North! ")).toBe("club-stefan-north");
  expect(generateLocationSlug("Court 123")).toBe("court-123");
});

it("rejects names that cannot generate a nonempty slug only on creation", async () => {
  expect(await saveAdminLocation({ fields: { ...fields, name: "🎾" } })).toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { name: expect.any(String) } });
  expect(query.insert).not.toHaveBeenCalled();
  expect(await saveAdminLocation({ id, fields: { ...fields, name: "🎾" } })).toEqual({ ok: true, id });
});

it("lists inactive records too, with admin authorization and stable ordering", async () => {
  const location = { ...fields, id, slug: "central", address_line1: null, address_line2: null, postal_code: null,
    is_active: false, created_at: "2026-09-29T10:00:00Z", updated_at: "2026-09-29T10:00:00Z" };
  query.order.mockReturnValueOnce(query).mockReturnValueOnce(query).mockResolvedValueOnce({ data: [location], error: null });
  await expect(listAdminLocations()).resolves.toEqual([location]);
  expect(requireActiveAdmin).toHaveBeenCalledWith(client);
  expect(query.order.mock.calls).toEqual([["display_order"], ["name"], ["id"]]);
  expect(query.eq).not.toHaveBeenCalled();
});
