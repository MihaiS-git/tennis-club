import { DataSource } from "typeorm";
import { expect, test } from "vitest";

import { CourtCoveragePeriodEntity } from "@/lib/db/entities/court-coverage-period.entity";
import { CourtEntity } from "@/lib/db/entities/court.entity";
import { LocationOpeningHoursEntity } from "@/lib/db/entities/location-opening-hours.entity";
import { LocationPricingRuleEntity } from "@/lib/db/entities/location-pricing-rule.entity";
import { LocationEntity } from "@/lib/db/entities/location.entity";
import { PricingRuleSetEntity } from "@/lib/db/entities/pricing-rule-set.entity";
import { insertCourtCoverage, insertOpeningHours } from "@/lib/db/repositories/clubs.repository";
import { insertPricingRules } from "@/lib/db/repositories/pricing.repository";

class MetadataDataSource extends DataSource {
  async loadMetadata() {
    await this.buildMetadatas();
  }
}

const entities = [LocationEntity, CourtEntity, CourtCoveragePeriodEntity,
  LocationOpeningHoursEntity, PricingRuleSetEntity, LocationPricingRuleEntity];

async function loadMetadata() {
  const source = new MetadataDataSource({
    type: "postgres", entities, synchronize: false, migrationsRun: false, installExtensions: false,
  });
  await source.loadMetadata();
  expect(source.isInitialized).toBe(false);
  return source;
}

test("existing scalar repository inserts reuse FK columns and omit obsolete generated columns", async () => {
  const source = await loadMetadata();
  const queries: { sql: string; parameters: unknown[] }[] = [];
  // Capture real repository SQL through an in-memory query runner; never initialize a connection.
  const runner = source.createQueryRunner();
  runner.query = async (sql: string, parameters?: unknown[]) => {
    queries.push({ sql, parameters: parameters ?? [] });
    return { records: [], raw: [{ id: "00000000-0000-4000-8000-000000000001" }], affected: 1 };
  };
  const manager = source.createEntityManager(runner);
  const courtId = "00000000-0000-4000-8000-000000000002";
  const locationId = "00000000-0000-4000-8000-000000000003";
  const ruleSetId = "00000000-0000-4000-8000-000000000004";
  const updatedAt = new Date("2026-10-08T00:00:00Z");
  await insertCourtCoverage(manager, courtId, { startsOn: "2026-11-01", endsOn: "2026-11-30" }, updatedAt);
  await insertOpeningHours(manager, [{ locationId, weekday: 1, opensAtMinute: 480, closesAtMinute: 1320 }]);
  await insertPricingRules(manager, [{ locationId, ruleSetId, courtId, courtState: "covered", weekday: 1,
    startsAtMinute: 480, endsAtMinute: 1320, startsOn: null, endsOn: null, pricePerHourMinor: 2500, updatedAt }]);
  expect(queries).toHaveLength(3);
  expect(queries[0].parameters).toEqual([courtId, "2026-11-01", "2026-11-30", updatedAt]);
  expect(queries[1].parameters).toEqual([locationId, 1, 480, 1320]);
  expect(queries[2].parameters).toEqual([locationId, ruleSetId, courtId, "covered", 1, 480, 1320, null, null, 2500, updatedAt]);
  for (const { sql } of queries) {
    expect(sql).not.toContain('"court_environment"');
    const insertColumns = sql.match(/INSERT INTO .*?\((.*?)\) VALUES/)?.[1].split(", ");
    expect(insertColumns).toBeDefined();
    expect(new Set(insertColumns).size).toBe(insertColumns?.length);
  }
  expect(source.isInitialized).toBe(false);
});
