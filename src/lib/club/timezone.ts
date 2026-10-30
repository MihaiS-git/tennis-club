// Compare timezone identities, never offsets (which change with DST).
export function canonicalTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en", { timeZone: timezone }).resolvedOptions().timeZone;
}

type LocationTimezone = { id: string; name: string; timezone: string };

export function clubTimezoneError(locations: readonly LocationTimezone[]): string | null {
  const identities = new Set(locations.map((location) => {
    try { return canonicalTimezone(location.timezone); } catch { return null; }
  }));
  if (!identities.has(null) && identities.size <= 1) return null;
  const details = [...locations].sort((a, b) => a.id.localeCompare(b.id))
    .map((location) => `${location.name} (${location.id}): ${location.timezone}`).join("; ");
  return `All operational club locations must use the same IANA timezone. Incompatible locations: ${details}. Ask an administrator to reconcile location timezones before scheduling. Existing bookings must keep their original times.`;
}
