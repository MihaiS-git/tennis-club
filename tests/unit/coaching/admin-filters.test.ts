import { expect, it } from "vitest";
import { coachFiltersSchema, coachingListHref, priceFiltersSchema, programFiltersSchema } from "@/lib/coaching/admin-filters";

it("normalizes repeated/invalid URL filters and trims search", () => {
  expect(programFiltersSchema.parse({ search: "  Lesson  ", page: ["1", "2"], type: "other", status: ["active"], sort: "bad", dir: "bad" }))
    .toEqual({ search: "Lesson", page: 1, type: undefined, status: undefined, sort: "name", dir: "asc" });
  expect(priceFiltersSchema.parse({ search: ["one", "two"], currency: "XYZ", program: "bad", coach: "bad", duration: "1.5", page: "-1" }))
    .toMatchObject({ search: undefined, currency: undefined, program: undefined, coach: undefined, duration: undefined, page: 1 });
});

it("keeps combined filters on pagination and resets page on sort", () => {
  const filters = priceFiltersSchema.parse({ search: "a+b@example.test", currency: "EUR", duration: "60", scope: "coach", dir: "desc", sort: "amount", page: "4" });
  const href = coachingListHref("/admin/coaching/prices", filters, { page: 2 });
  expect(Object.fromEntries(new URL(href, "http://localhost").searchParams)).toMatchObject({ q: "a+b@example.test", currency: "EUR", duration: "60", scope: "coach", page: "2", sort: "amount", dir: "desc" });
  expect(coachingListHref("/admin/coaching/prices", filters, { sort: "program", page: 1 })).toContain("page=1");
});

it("ignores a stale coach filter when switching to club-default scope", () => {
  expect(priceFiltersSchema.parse({ scope: "club", coach: "a1000000-0000-4000-8000-000000000001" }).coach).toBeUndefined();
});

it("normalizes coach parameters and preserves combined list state", () => {
  expect(coachFiltersSchema.parse({ status: ["active"], profile: "bad", visibility: "bad", sort: "bad", page: "0" }))
    .toMatchObject({ status: undefined, profile: undefined, visibility: undefined, sort: "name", page: 1 });
  const filters = coachFiltersSchema.parse({ search: "  Ana  ", status: "suspended", profile: "configured", visibility: "private", sort: "created", dir: "desc", page: "3" });
  expect(Object.fromEntries(new URL(coachingListHref("/admin/coaching/coaches", filters, { page: 2 }), "http://localhost").searchParams))
    .toEqual({ q: "Ana", status: "suspended", profile: "configured", visibility: "private", sort: "created", dir: "desc", page: "2" });
});
