export function localToday(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function localMinute(timeZone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

export function localStartInstant(timeZone: string, date: string, minute: number): string {
  return resolveLocalStartInstant(localTimestampFormatter(timeZone), date, minute);
}

function localTimestampFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
}

// Scope this resolver to one operation/request. Reuse formatters, never offsets
// or converted dates: each probe must still observe its own historical/DST rules.
export function createLocalStartInstantResolver() {
  const formatters = new Map<string, Intl.DateTimeFormat>();
  return (timeZone: string, date: string, minute: number): string => {
    let formatter = formatters.get(timeZone);
    if (!formatter) {
      formatter = localTimestampFormatter(timeZone);
      formatters.set(timeZone, formatter);
    }
    return resolveLocalStartInstant(formatter, date, minute);
  };
}

function resolveLocalStartInstant(formatter: Intl.DateTimeFormat, date: string, minute: number): string {
  const wallTime = Date.parse(`${date}T00:00:00Z`) + minute * 60_000;
  const localTimestamp = (at: Date) => {
    const parts = formatter.formatToParts(at);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
    return Date.parse(`${value("year")}-${value("month")}-${value("day")}T00:00:00Z`)
      + (Number(value("hour")) * 60 + Number(value("minute"))) * 60_000;
  };
  const candidates = [-1, 0, 1].map((day) => {
    const probe = new Date(wallTime + day * 86_400_000);
    return wallTime - (localTimestamp(probe) - probe.getTime());
  });
  const exact = candidates.filter((candidate) => localTimestamp(new Date(candidate)) === wallTime);
  // Match PostgreSQL's later instant for a repeated local time, and its
  // pre-transition offset for a local time skipped by a forward clock change.
  return new Date(Math.max(...(exact.length ? exact : candidates))).toISOString();
}

// Calendar arithmetic on a YYYY-MM-DD date, independent of any time zone.
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
