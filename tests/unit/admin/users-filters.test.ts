import { expect, it } from "vitest";

import { adminUserFiltersSchema } from "../../../src/lib/admin/users-filters";

it.each([undefined, "0", "-1", "1.5", "abc", ["2"]])(
  "normalizes invalid/missing page %s to one",
  (page) => expect(adminUserFiltersSchema.parse({ page }).page).toBe(1),
);

it.each([1, "002", "9999999"])("accepts positive integer page %s", (page) => {
  expect(adminUserFiltersSchema.parse({ page }).page).toBe(Number(page));
});

it("trims search and discards invalid filters and repeated query params", () => {
  expect(adminUserFiltersSchema.parse({ search: "  Smith  ", role: "owner", status: ["active"] }))
    .toEqual({ search: "Smith", role: undefined, status: undefined, page: 1, sort: "joined", dir: "desc" });
  expect(adminUserFiltersSchema.parse({ search: "   " }).search).toBeUndefined();
  expect(adminUserFiltersSchema.parse({ search: ["one", "two"] }).search).toBeUndefined();
});

it.each(["invalid", "", ["email"], ["asc", "desc"], null])("normalizes invalid/repeated sort and dir %s", (value) => {
  expect(adminUserFiltersSchema.parse({ sort: value, dir: value })).toMatchObject({ sort: "joined", dir: "desc" });
});

