import { expect, test, vi } from "vitest";
import { addDays, createLocalStartInstantResolver, localMinute, localStartInstant, localToday } from "@/lib/courts/local-time";

// Pre-E3-F converter: differential coverage for the formatter change, including
// all half-hour slots on transition days and the surrounding dates.
function previousStartInstant(zone: string, date: string, minute: number) {
  const wall = Date.parse(`${date}T00:00:00Z`) + minute * 60000;
  const timestamp = (at: Date) => Date.parse(`${localToday(zone, at)}T00:00:00Z`) + localMinute(zone, at) * 60000;
  const candidates = [-1, 0, 1].map(day => {
    const probe = new Date(wall + day * 86400000);
    return wall - (timestamp(probe) - probe.getTime());
  });
  const exact = candidates.filter(value => timestamp(new Date(value)) === wall);
  return new Date(Math.max(...(exact.length ? exact : candidates))).toISOString();
}

test.each([
  ["Europe/Bucharest", "2026-03-29"], ["Europe/Bucharest", "2026-10-25"],
  ["America/New_York", "2026-03-08"], ["America/New_York", "2026-11-01"],
  ["Australia/Lord_Howe", "2026-04-05"], ["Australia/Lord_Howe", "2026-10-04"],
  ["Pacific/Apia", "2011-12-30"], ["Asia/Kathmandu", "2026-01-01"],
])("matches the previous conversion around %s %s", (zone, date) => {
  const resolve = createLocalStartInstantResolver();
  for (const day of [-1, 0, 1]) for (let minute = 0; minute <= 1440; minute += 30) {
    const playingDate = addDays(date, day);
    expect(resolve(zone, playingDate, minute)).toBe(previousStartInstant(zone, playingDate, minute));
  }
});

test("reuses only request-local formatters while resolving each date's offsets independently", () => {
  const constructor = vi.spyOn(Intl, "DateTimeFormat");
  try {
    const resolve = createLocalStartInstantResolver();
    const cases: [string, string, number, string][] = [
      ["Europe/Bucharest", "2026-10-25", 180, "2026-10-25T01:00:00.000Z"],
      ["Europe/Bucharest", "2026-03-29", 210, "2026-03-29T01:30:00.000Z"],
      ["Europe/Bucharest", "2026-10-03", 1440, "2026-10-03T21:00:00.000Z"],
      ["America/New_York", "2026-11-01", 90, "2026-11-01T06:30:00.000Z"],
      ["America/New_York", "2026-03-08", 150, "2026-03-08T07:30:00.000Z"],
      ["Asia/Kathmandu", "2026-10-03", 0, "2026-10-02T18:15:00.000Z"],
      ["Australia/Lord_Howe", "2026-04-05", 105, "2026-04-04T15:15:00.000Z"],
      ["Australia/Lord_Howe", "2026-10-04", 135, "2026-10-03T15:45:00.000Z"],
      ["Pacific/Apia", "2011-12-30", 720, "2011-12-30T22:00:00.000Z"],
      ["UTC", "2026-12-31", 1440, "2027-01-01T00:00:00.000Z"],
      ["Europe/Bucharest", "2026-01-01", 0, "2025-12-31T22:00:00.000Z"],
    ];
    for (const [zone, date, minute, expected] of cases) expect(resolve(zone, date, minute)).toBe(expected);
    for (const [zone, date, minute, expected] of cases) expect(resolve(zone, date, minute)).toBe(expected);
    expect(constructor).toHaveBeenCalledTimes(6);
    expect(createLocalStartInstantResolver()("UTC", "2026-12-31", 1440)).toBe("2027-01-01T00:00:00.000Z");
    expect(constructor).toHaveBeenCalledTimes(7);
    for (const [zone, date, minute, expected] of cases) expect(localStartInstant(zone, date, minute)).toBe(expected);
  } finally { constructor.mockRestore(); }
});

test("adds calendar days to a date across month, leap-year and DST boundaries", () => {
  expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
  expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
  expect(addDays("2026-12-31", 0)).toBe("2026-12-31");
});
