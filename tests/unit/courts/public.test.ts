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
}

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
