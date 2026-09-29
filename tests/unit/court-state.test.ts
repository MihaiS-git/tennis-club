import { expect, it } from "vitest";
import { getCourtStateForDate } from "../../src/lib/courts/state";
const periods = [{ starts_on: "2026-10-15", ends_on: "2027-04-15" }];
it.each([
  ["2026-10-14", "outdoor"], ["2026-10-15", "covered"],
  ["2027-01-01", "covered"], ["2027-04-15", "covered"], ["2027-04-16", "outdoor"],
])("resolves %s as %s", (date, state) => {
  expect(getCourtStateForDate("outdoor", periods, date)).toBe(state);
});
it("returns indoor and handles outdoor courts without periods", () => {
  expect(getCourtStateForDate("indoor", [], "2026-12-01")).toBe("indoor");
  expect(getCourtStateForDate("outdoor", [], "2026-12-01")).toBe("outdoor");
});
it("rejects invalid calendar dates and reversed periods", () => {
  expect(() => getCourtStateForDate("outdoor", periods, "2026-02-30")).toThrow();
  expect(() => getCourtStateForDate("outdoor", [{ starts_on: "2027-01-01", ends_on: "2026-01-01" }], "2026-12-01")).toThrow();
});
