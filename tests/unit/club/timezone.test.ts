import { expect, test } from "vitest";
import { canonicalTimezone, clubTimezoneError } from "@/lib/club/timezone";
import { createLocalIntervalValidator } from "@/lib/courts/local-time";

test("timezone consensus compares canonical identities, including aliases, without choosing an arbitrary location", () => {
  const first = { id: "a", name: "First", timezone: "US/Eastern" };
  const second = { id: "b", name: "Second", timezone: "America/New_York" };
  expect(canonicalTimezone(first.timezone)).toBe(second.timezone);
  expect(clubTimezoneError([])).toBeNull();
  expect(clubTimezoneError([first, second])).toBeNull();
  // London and UTC share a winter offset, but are different scheduling identities.
  const mixed = [{ ...first, timezone: "Europe/London" }, { ...second, timezone: "UTC" }];
  expect(clubTimezoneError(mixed)).toBe(clubTimezoneError([...mixed].reverse()));
  expect(clubTimezoneError(mixed)).toContain("Europe/London");
  expect(clubTimezoneError([{ ...first, timezone: "Invalid/Zone" }])).toContain("Invalid/Zone");
});

test.each([
  ["2027-03-28", 60, 120, true],
  ["2027-03-28", 120, 180, false],
  ["2027-03-28", 180, 240, false],
  ["2027-03-28", 240, 300, true],
  ["2027-10-31", 60, 120, true],
  ["2027-10-31", 120, 180, false],
  ["2027-10-31", 180, 240, true],
  ["2027-10-31", 240, 300, true],
  ["2027-10-30", 1380, 1440, true],
  ["2027-10-31", 0, 60, true],
])("shared timezone preserves local interval validation for %s %i–%i", (date, start, end, valid) => {
  expect(createLocalIntervalValidator("Europe/Bucharest", date)(start, end)).toBe(valid);
});
