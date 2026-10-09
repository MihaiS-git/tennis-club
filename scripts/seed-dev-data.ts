// Deterministic local fixtures. Existing rows are reused and never reset.
import { getDataSource } from "../src/lib/db/data-source.ts";
import { LocationEntity } from "../src/lib/db/entities/location.entity.ts";
import { CourtEntity } from "../src/lib/db/entities/court.entity.ts";
import { LocationOpeningHoursEntity } from "../src/lib/db/entities/location-opening-hours.entity.ts";
import { CourtCoveragePeriodEntity } from "../src/lib/db/entities/court-coverage-period.entity.ts";
import { PricingRuleSetEntity } from "../src/lib/db/entities/pricing-rule-set.entity.ts";
import { LocationPricingRuleEntity } from "../src/lib/db/entities/location-pricing-rule.entity.ts";
import { publicationReadiness, publicationToday } from "../src/lib/locations/publication.ts";
import { assertLocalDatabase } from "./local-dev.ts";
import type { EntityManager } from "typeorm";

const locations: { slug: string; name: string; address_line1: string; city: string; postal_code: string; country_code: string; timezone: string; currency: string; is_active: boolean; display_order: number }[] = [
  { slug: "dev-central-club", name: "Central Club", address_line1: "Strada George Enescu 18", city: "București", postal_code: "010306", country_code: "RO", timezone: "Europe/Bucharest", currency: "RON", is_active: true, display_order: 1 },
  { slug: "dev-riverside-club", name: "Riverside Club", address_line1: "Splaiul Independenței 202", city: "București", postal_code: "060022", country_code: "RO", timezone: "Europe/Bucharest", currency: "RON", is_active: true, display_order: 2 },
];

const courts: { location: string; slug: string; name: string; surface: CourtEntity["surface"]; environment: CourtEntity["environment"]; has_lighting: boolean; is_active: boolean }[] = [
  { location: "dev-central-club", slug: "court-1", name: "Court 1", surface: "clay", environment: "outdoor", has_lighting: true, is_active: true },
  { location: "dev-central-club", slug: "court-2", name: "Court 2", surface: "clay", environment: "outdoor", has_lighting: true, is_active: true },
  { location: "dev-central-club", slug: "court-3", name: "Court 3", surface: "clay", environment: "outdoor", has_lighting: false, is_active: true },
  { location: "dev-central-club", slug: "indoor-1", name: "Indoor 1", surface: "hard", environment: "indoor", has_lighting: true, is_active: true },
  { location: "dev-riverside-club", slug: "court-1", name: "Court 1", surface: "clay", environment: "outdoor", has_lighting: false, is_active: true },
  { location: "dev-riverside-club", slug: "court-2", name: "Court 2", surface: "hard", environment: "outdoor", has_lighting: true, is_active: false },
];

function matching<T extends object>(row: T, fixture: Partial<T>) {
  return Object.entries(fixture).every(([key, value]) => Reflect.get(row, key) === value);
}

function requiredId(ids: Map<string, string>, key: string) {
  const id = ids.get(key);
  if (!id) throw new Error(`Missing fixture ${key}.`);
  return id;
}

async function seedConfiguration(manager: EntityManager) {
  // Use the same configuration fence and location-first ordering as runtime writes.
  await manager.query("SELECT pg_advisory_xact_lock(1791462257, 1)");
  const locationIds = new Map<string, string>();
  for (const fixture of locations) {
    const values = {
      slug: fixture.slug, name: fixture.name, addressLine1: fixture.address_line1,
      city: fixture.city, postalCode: fixture.postal_code, countryCode: fixture.country_code,
      timezone: fixture.timezone, currency: "RON" as const, isActive: fixture.is_active,
      displayOrder: fixture.display_order, allowPayAtClub: true,
      customerCancellationNoticeMinutes: 1440,
    };
    let row = await manager.findOneBy(LocationEntity, { slug: fixture.slug });
    if (!row) row = await manager.save(LocationEntity, values);
    if (!matching(row, values) || row.archivedAt !== null) throw new Error(`Location ${fixture.slug} differs from its fixture.`);
    locationIds.set(fixture.slug, row.id);
  }
  for (const id of [...locationIds.values()].sort()) {
    await manager.findOneOrFail(LocationEntity, { where: { id }, lock: { mode: "pessimistic_write" } });
  }

  const hours: Partial<LocationOpeningHoursEntity>[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    hours.push({ locationId: requiredId(locationIds, "dev-central-club"), weekday, opensAtMinute: 420, closesAtMinute: 1320 });
    const locationId = requiredId(locationIds, "dev-riverside-club");
    if (weekday < 5) {
      hours.push({ locationId, weekday, opensAtMinute: 480, closesAtMinute: 720 });
      hours.push({ locationId, weekday, opensAtMinute: 840, closesAtMinute: 1260 });
    } else hours.push({ locationId, weekday, opensAtMinute: 480, closesAtMinute: 1200 });
  }
  for (const fixture of hours) {
    if (!await manager.findOneBy(LocationOpeningHoursEntity, fixture)) await manager.save(LocationOpeningHoursEntity, fixture);
  }

  const courtIds = new Map<string, string>();
  for (const fixture of courts) {
    const values = {
      locationId: requiredId(locationIds, fixture.location), slug: fixture.slug, name: fixture.name,
      surface: fixture.surface, environment: fixture.environment, hasLighting: fixture.has_lighting,
      isActive: fixture.is_active,
    };
    let row = await manager.findOneBy(CourtEntity, { locationId: values.locationId, slug: values.slug });
    if (!row) row = await manager.save(CourtEntity, values);
    if (!matching(row, values)) throw new Error(`Court ${fixture.location}/${fixture.slug} differs from its fixture.`);
    courtIds.set(`${fixture.location}/${fixture.slug}`, row.id);
  }
  const coverage = { courtId: requiredId(courtIds, "dev-central-club/court-1"), startsOn: "2026-10-01", endsOn: "2027-03-31" };
  if (!await manager.findOneBy(CourtCoveragePeriodEntity, coverage)) await manager.save(CourtCoveragePeriodEntity, coverage);

  // One logical definition per location/state/opening interval, expanded by court/day.
  // Stable IDs make reruns and interrupted seed recovery unambiguous.
  const definitions = [
    { location: "dev-central-club", state: "outdoor" as const, start: 420, end: 1320, days: [0,1,2,3,4,5,6], price: 5000 },
    { location: "dev-central-club", state: "covered" as const, start: 420, end: 1320, days: [0,1,2,3,4,5,6], price: 7000 },
    { location: "dev-central-club", state: "indoor" as const, start: 420, end: 1320, days: [0,1,2,3,4,5,6], price: 8000 },
    { location: "dev-riverside-club", state: "outdoor" as const, start: 480, end: 720, days: [0,1,2,3,4], price: 5000 },
    { location: "dev-riverside-club", state: "outdoor" as const, start: 840, end: 1260, days: [0,1,2,3,4], price: 5000 },
    { location: "dev-riverside-club", state: "outdoor" as const, start: 480, end: 1200, days: [5,6], price: 5000 },
  ];
  let pricingRows = 0;
  for (const [index, definition] of definitions.entries()) {
    const locationId = requiredId(locationIds, definition.location);
    const ruleSetId = `de000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const ruleSet = await manager.findOneBy(PricingRuleSetEntity, { id: ruleSetId });
    if (ruleSet && ruleSet.locationId !== locationId) throw new Error("Seed pricing definition belongs to a different location.");
    if (!ruleSet) await manager.save(PricingRuleSetEntity, { id: ruleSetId, locationId });
    const selected = courts.filter((court) => court.location === definition.location
      && (definition.state === "indoor" ? court.environment === "indoor" : court.environment === "outdoor"));
    for (const court of selected) for (const weekday of definition.days) {
      const values = {
        locationId, ruleSetId, courtId: requiredId(courtIds, `${court.location}/${court.slug}`),
        courtState: definition.state, weekday, startsAtMinute: definition.start, endsAtMinute: definition.end,
        startsOn: null, endsOn: null, pricePerHourMinor: definition.price,
      };
      const row = await manager.findOneBy(LocationPricingRuleEntity, { ruleSetId, courtId: values.courtId, weekday });
      if (row && !matching(row, values)) throw new Error("Seed pricing differs from its fixture.");
      if (!row) await manager.save(LocationPricingRuleEntity, values);
      pricingRows += 1;
    }
  }
  for (const id of locationIds.values()) {
    const row = await manager.findOneByOrFail(LocationEntity, { id });
    const activeCourts = await manager.findBy(CourtEntity, { locationId: id, isActive: true });
    const publicationCourts = [];
    for (const court of activeCourts) {
      const rules = await manager.findBy(LocationPricingRuleEntity, { courtId: court.id });
      publicationCourts.push({ ...court, location_pricing_rules: rules
        .map((rule) => ({ court_state: rule.courtState, ends_on: rule.endsOn })) });
    }
    const configuration = {
      ...row, is_active: row.isActive, is_public: row.isPublic, archived_at: null,
      location_opening_hours: await manager.findBy(LocationOpeningHoursEntity, { locationId: id }),
      courts: publicationCourts,
    };
    const missing = publicationReadiness(configuration, publicationToday(row.timezone));
    if (missing.length) throw new Error(`Seed location is not ready: ${missing.join(", ")}.`);
    if (!row.isPublic) await manager.update(LocationEntity, { id }, { isPublic: true, updatedAt: new Date() });
  }
  return { locations: locations.length, courts: courts.length, openingHours: hours.length, coveragePeriods: 1,
    pricingDefinitions: definitions.length, pricingRows, publicLocations: 2 };
}

export async function seedDevData() {
  assertLocalDatabase();
  const database = await getDataSource();
  console.log(JSON.stringify(await database.transaction("READ COMMITTED", seedConfiguration)));
}
