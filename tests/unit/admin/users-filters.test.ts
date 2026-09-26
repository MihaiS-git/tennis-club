import { expect, it } from "vitest";

import { adminUserFiltersSchema } from "../../../src/lib/admin/users-filters";

it.each([undefined, "", "0", "-1", "1.5", "abc", "Infinity", "1e2", [], ["2"], 0, -2, 1.5, Number.NaN, Number.MAX_VALUE])(
  "normalizes invalid/missing page %s to one",
  (page) => expect(adminUserFiltersSchema.parse({ page }).page).toBe(1),
);

it.each([1, 2, "2", "002", "9999999"])("accepts positive integer page %s", (page) => {
  expect(adminUserFiltersSchema.parse({ page }).page).toBe(Number(page));
});

it("trims search and discards invalid filters and repeated query params", () => {
  expect(adminUserFiltersSchema.parse({ search: "  Smith  ", role: "owner", status: ["active"] }))
    .toEqual({ search: "Smith", role: undefined, status: undefined, page: 1, sort: "joined", dir: "desc" });
  expect(adminUserFiltersSchema.parse({ search: "   " }).search).toBeUndefined();
  expect(adminUserFiltersSchema.parse({ search: ["one", "two"] }).search).toBeUndefined();
});

it("defaults sorting to newest joined first", () => {
  expect(adminUserFiltersSchema.parse({})).toMatchObject({ sort: "joined", dir: "desc" });
});
it.each(["email", "status", "roles", "joined"])("accepts sort %s", (sort) => {
  expect(adminUserFiltersSchema.parse({ sort }).sort).toBe(sort);
});
it.each(["asc", "desc"])("accepts direction %s", (dir) => {
  expect(adminUserFiltersSchema.parse({ dir }).dir).toBe(dir);
});
it.each(["invalid", "", ["email"], ["asc", "desc"], null])("normalizes invalid/repeated sort and dir %s", (value) => {
  expect(adminUserFiltersSchema.parse({ sort: value, dir: value })).toMatchObject({ sort: "joined", dir: "desc" });
});

it("accepts only elevated role filters and normalizes member to no filter", () => {
  expect(adminUserFiltersSchema.parse({ role: "member" }).role).toBeUndefined();
  for (const role of ["coach", "admin"]) {
    expect(adminUserFiltersSchema.parse({ role }).role).toBe(role);
  }
});
