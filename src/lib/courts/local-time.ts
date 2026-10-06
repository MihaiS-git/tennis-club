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
  const wallTime = Date.parse(`${date}T00:00:00Z`) + minute * 60_000;
  const localTimestamp = (at: Date) => Date.parse(`${localToday(timeZone, at)}T00:00:00Z`)
    + localMinute(timeZone, at) * 60_000;
  const candidates = [-1, 0, 1].map((day) => {
    const probe = new Date(wallTime + day * 86_400_000);
    return wallTime - (localTimestamp(probe) - probe.getTime());
  });
  const exact = candidates.filter((candidate) => localTimestamp(new Date(candidate)) === wallTime);
  // Match PostgreSQL's later instant for a repeated local time, and its
  // pre-transition offset for a local time skipped by a forward clock change.
  return new Date(Math.max(...(exact.length ? exact : candidates))).toISOString();
}
