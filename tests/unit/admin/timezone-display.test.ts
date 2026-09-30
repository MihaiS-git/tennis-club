import { expect, it } from "vitest";
import { timezoneDisplayLabel, timezoneUtcOffset } from "../../../src/app/admin/locations/timezone-display";

it("derives Bucharest's current offset from IANA rules across daylight-saving changes", () => {
  const summer = new Date("2026-07-15T12:00:00Z");
  const winter = new Date("2026-01-15T12:00:00Z");
  expect(timezoneUtcOffset("Europe/Bucharest", summer)).toBe("UTC+03:00");
  expect(timezoneUtcOffset("Europe/Bucharest", winter)).toBe("UTC+02:00");
  expect(timezoneDisplayLabel("Europe/Bucharest", summer)).toBe("UTC+03:00 · Europe/Bucharest");
  expect(timezoneDisplayLabel("Europe/Bucharest", winter)).toBe("UTC+02:00 · Europe/Bucharest");
  expect(timezoneUtcOffset("UTC", winter)).toBe("UTC+00:00");
});
