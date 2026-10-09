import { expect, it } from "vitest";

import { adminUserFiltersSchema } from "../../../src/lib/admin/users-filters";

it.each(["1.5"])(
  "normalizes invalid/missing page %s to one",
  (page) => expect(adminUserFiltersSchema.parse({ page }).page).toBe(1),
);

it("trims search and discards invalid filters and repeated query params", () => {
  expect(adminUserFiltersSchema.parse({ search: "  Smith  ", role: "owner", status: ["active"] }))
    .toEqual({ search: "Smith", role: undefined, status: undefined, page: 1, sort: "joined", dir: "desc" });
  expect(adminUserFiltersSchema.parse({ search: "   " }).search).toBeUndefined();
  expect(adminUserFiltersSchema.parse({ search: ["one", "two"] }).search).toBeUndefined();
});
