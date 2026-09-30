export function timezoneUtcOffset(zone: string, at: Date): string {
  const offset = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(at).find((part) => part.type === "timeZoneName")?.value;
  if (!offset?.startsWith("GMT")) throw new Error("Unable to display timezone offset.");
  return offset === "GMT" ? "UTC+00:00" : `UTC${offset.slice(3)}`;
}

export function timezoneDisplayLabel(zone: string, at: Date): string {
  return `${timezoneUtcOffset(zone, at)} · ${zone}`;
}
