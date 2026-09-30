// Deterministic local fixtures. Existing rows are reused and never reset.
import type { SupabaseClient } from "@supabase/supabase-js";

const locations: { slug: string; name: string; address_line1: string; city: string; postal_code: string; country_code: string; timezone: string; currency: string; is_active: boolean; display_order: number }[] = [
  { slug: "dev-central-club", name: "Central Club", address_line1: "Strada George Enescu 18", city: "București", postal_code: "010306", country_code: "RO", timezone: "Europe/Bucharest", currency: "RON", is_active: true, display_order: 1 },
  { slug: "dev-riverside-club", name: "Riverside Club", address_line1: "Splaiul Independenței 202", city: "București", postal_code: "060022", country_code: "RO", timezone: "Europe/Bucharest", currency: "RON", is_active: true, display_order: 2 },
];

const courts: { location: string; slug: string; name: string; surface: string; environment: string; has_lighting: boolean; is_active: boolean }[] = [
  { location: "dev-central-club", slug: "court-1", name: "Court 1", surface: "clay", environment: "outdoor", has_lighting: true, is_active: true },
  { location: "dev-central-club", slug: "court-2", name: "Court 2", surface: "clay", environment: "outdoor", has_lighting: true, is_active: true },
  { location: "dev-central-club", slug: "court-3", name: "Court 3", surface: "clay", environment: "outdoor", has_lighting: false, is_active: true },
  { location: "dev-central-club", slug: "indoor-1", name: "Indoor 1", surface: "hard", environment: "indoor", has_lighting: true, is_active: true },
  { location: "dev-riverside-club", slug: "court-1", name: "Court 1", surface: "clay", environment: "outdoor", has_lighting: false, is_active: true },
  { location: "dev-riverside-club", slug: "court-2", name: "Court 2", surface: "hard", environment: "outdoor", has_lighting: true, is_active: false },
];

function matching(row: Record<string, unknown>, fixture: Record<string, unknown>) {
  return Object.entries(fixture).every(([key, value]) => row[key] === value);
}

export async function seedDevData(service: SupabaseClient) {
  const locationIds = new Map<string, string>();
  for (const fixture of locations) {
    const found = await service.from("locations").select("*").eq("slug", fixture.slug).maybeSingle();
    if (found.error) throw new Error(`Unable to read location ${fixture.slug}.`);
    let row = found.data;
    if (!row) {
      const inserted = await service.from("locations").insert(fixture).select("*").single();
      if (inserted.error) throw new Error(`Unable to create location ${fixture.slug}.`);
      row = inserted.data;
    }
    if (!row || !matching(row, fixture)) throw new Error(`Existing location ${fixture.slug} differs from its fixture.`);
    locationIds.set(fixture.slug, row.id);
  }

  const hours: { location_id: string; weekday: number; opens_at_minute: number; closes_at_minute: number }[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    hours.push({ location_id: locationIds.get("dev-central-club")!, weekday, opens_at_minute: 420, closes_at_minute: 1320 });
    const riverside = locationIds.get("dev-riverside-club")!;
    if (weekday < 5) {
      hours.push({ location_id: riverside, weekday, opens_at_minute: 480, closes_at_minute: 720 });
      hours.push({ location_id: riverside, weekday, opens_at_minute: 840, closes_at_minute: 1260 });
    } else {
      hours.push({ location_id: riverside, weekday, opens_at_minute: 480, closes_at_minute: 1200 });
    }
  }
  for (const fixture of hours) {
    const found = await service.from("location_opening_hours")
      .select("id").match(fixture).limit(1);
    if (found.error) throw new Error("Unable to read development opening hours.");
    if (found.data.length === 0) {
      const inserted = await service.from("location_opening_hours").insert(fixture);
      if (inserted.error) throw new Error("Unable to create development opening hours; inspect existing intervals for overlap.");
    }
  }

  const courtIds = new Map<string, string>();
  for (const { location, ...court } of courts) {
    const location_id = locationIds.get(location)!;
    const fixture = { ...court, location_id };
    const found = await service.from("courts").select("*").eq("location_id", location_id).eq("slug", court.slug).maybeSingle();
    if (found.error) throw new Error(`Unable to read court ${location}/${court.slug}.`);
    let row = found.data;
    if (!row) {
      const inserted = await service.from("courts").insert(fixture).select("*").single();
      if (inserted.error) throw new Error(`Unable to create court ${location}/${court.slug}.`);
      row = inserted.data;
    }
    if (!row || !matching(row, fixture)) throw new Error(`Existing court ${location}/${court.slug} differs from its fixture.`);
    courtIds.set(`${location}/${court.slug}`, row.id);
  }

  const coverage = {
    court_id: courtIds.get("dev-central-club/court-1")!,
    starts_on: "2026-10-01",
    ends_on: "2027-03-31",
  };
  const found = await service.from("court_coverage_periods").select("id").match(coverage).limit(1);
  if (found.error) throw new Error("Unable to read development coverage.");
  if (found.data.length === 0) {
    const inserted = await service.from("court_coverage_periods").insert(coverage);
    if (inserted.error) throw new Error("Unable to create development coverage; inspect existing periods for overlap.");
  }

  console.log(JSON.stringify({ locations: locations.length, courts: courts.length, openingHours: hours.length, coveragePeriods: 1 }));
}
