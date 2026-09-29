import { expect, test, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { listActiveLocationsWithCourts } from "../../../src/lib/courts/public";
import { createClient } from "../../../src/lib/supabase/server";

function mockRead(data: unknown, error: { code: string; message: string } | null = null) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    then(resolve: (result: unknown) => unknown) { return Promise.resolve({ data, error }).then(resolve); },
  };
  vi.mocked(createClient).mockResolvedValue({ from: () => query } as unknown as Awaited<ReturnType<typeof createClient>>);
  return query;
}

const location = {
  id: "c1000000-0000-4000-8000-000000000001", name: "Central", slug: "central",
  address_line1: null, address_line2: null, city: null, postal_code: null, country_code: null,
  timezone: "Europe/Bucharest",
};
const court = {
  id: "c2000000-0000-4000-8000-000000000001", name: "Court One", slug: "one",
  surface: "clay", has_lighting: true,
};

test.each([{ environment: "outdoor" }, { environment: "indoor" }])("exposes the public environment: $environment", async (state) => {
  const data = [{ ...location, courts: [{ ...court, ...state }] }];
  const query = mockRead(data);
  expect(await listActiveLocationsWithCourts()).toEqual(data);
  expect(query.select).toHaveBeenCalledWith(expect.stringContaining("environment, has_lighting"));
  expect(query.select.mock.calls[0][0]).not.toMatch(/supports_balloon|balloon_installed/);
});

test.each([
  { environment: "covered" }, { environment: "other" }, { environment: null },
])("rejects invalid public court environment: $environment", async (state) => {
  mockRead([{ ...location, courts: [{ ...court, ...state }] }]);
  await expect(listActiveLocationsWithCourts()).rejects.toThrow("Unable to load courts.");
});

test("does not expose obsolete or admin-only fields even if supplied by an adapter", async () => {
  mockRead([{ ...location, courts: [{ ...court, environment: "outdoor", supports_balloon: true, balloon_installed: true, is_active: true }] }]);
  const [result] = await listActiveLocationsWithCourts();
  expect(result.courts[0]).toEqual({ ...court, environment: "outdoor" });
});

test("keeps explicit active filters, inner court embedding and deterministic ordering", async () => {
  const query = mockRead([]);
  await listActiveLocationsWithCourts();
  expect(query.select.mock.calls[0][0]).toContain("courts!inner(");
  expect(query.eq.mock.calls).toEqual([["is_active", true], ["courts.is_active", true]]);
  expect(query.order.mock.calls).toEqual([
    ["display_order"], ["name"], ["id"],
    ["display_order", { referencedTable: "courts" }], ["name", { referencedTable: "courts" }], ["id", { referencedTable: "courts" }],
  ]);
});

test("uses the existing server client and returns empty public discovery", async () => {
  mockRead([]);
  expect(await listActiveLocationsWithCourts()).toEqual([]);
  expect(createClient).toHaveBeenCalled();
});

test("does not expose raw database errors", async () => {
  mockRead(null, { code: "42501", message: "Internal database detail" });
  await expect(listActiveLocationsWithCourts()).rejects.toThrow("Unable to load courts.");
});

test("rejects invalid database data with a safe error", async () => {
  mockRead([{ id: "invalid" }]);
  await expect(listActiveLocationsWithCourts()).rejects.toThrow("Unable to load courts.");
});
