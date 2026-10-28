import { expect, it } from "vitest";
import { coachFiltersSchema, coachingListHref, programFiltersSchema } from "@/lib/coaching/admin-filters";

it("normalizes repeated/invalid URL filters and trims search", () => {
  expect(programFiltersSchema.parse({ search: "  Lesson  ", page: ["1", "2"], type: "other", status: ["active"], sort: "bad", dir: "bad" }))
    .toEqual({ search: "Lesson", page: 1, type: undefined, status: undefined, sort: "name", dir: "asc" });
  expect(programFiltersSchema.parse({ search: ["one", "two"], page: "-1" })).toMatchObject({ search: undefined, page: 1 });
});

it("keeps combined filters on pagination and resets page on sort", () => {
  const filters = programFiltersSchema.parse({ search: "a+b", type: "group", status: "inactive", dir: "desc", sort: "type", page: "4" });
  const href = coachingListHref("/admin/coaching/programs", filters, { page: 2 });
  expect(Object.fromEntries(new URL(href, "http://localhost").searchParams)).toEqual({ q: "a+b", type: "group", status: "inactive", page: "2", sort: "type", dir: "desc" });
  expect(coachingListHref("/admin/coaching/programs", filters, { sort: "name", page: 1 })).toContain("page=1");
});

it("normalizes coach parameters and preserves combined list state", () => {
  expect(coachFiltersSchema.parse({ status: ["active"], profile: "bad", visibility: "bad", sort: "bad", page: "0" }))
    .toMatchObject({ status: undefined, profile: undefined, visibility: undefined, sort: "name", page: 1 });
  const filters = coachFiltersSchema.parse({ search: "  Ana  ", status: "suspended", profile: "configured", visibility: "private", sort: "created", dir: "desc", page: "3" });
  expect(Object.fromEntries(new URL(coachingListHref("/admin/coaching/coaches", filters, { page: 2 }), "http://localhost").searchParams))
    .toEqual({ q: "Ana", status: "suspended", profile: "configured", visibility: "private", sort: "created", dir: "desc", page: "2" });
});
