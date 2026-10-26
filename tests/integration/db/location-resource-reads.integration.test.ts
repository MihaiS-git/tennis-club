import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";

import { getDataSource } from "@/lib/db/data-source";
import { LocationEntity } from "@/lib/db/entities/location.entity";
import { CourtEntity } from "@/lib/db/entities/court.entity";
import { CourtCoveragePeriodEntity } from "@/lib/db/entities/court-coverage-period.entity";
import { listAdminCourts, listCourtCoverage } from "@/lib/db/repositories/clubs.repository";

test("location resource queries exclude other locations while preserving inactive courts, coverage and order", async () => {
  const source = await getDataSource();
  const runner = source.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const manager = runner.manager;
    const locationId = randomUUID(), otherLocationId = randomUUID();
    await manager.insert(LocationEntity, [
      { id: locationId, name: "Inactive fixture", slug: `p6-${locationId}`, timezone: "UTC", isActive: false },
      { id: otherLocationId, name: "Other fixture", slug: `p6-${otherLocationId}`, timezone: "UTC" },
    ]);
    const courtIds = [randomUUID(), randomUUID(), randomUUID()].sort();
    const otherCourtId = randomUUID();
    await manager.insert(CourtEntity, [...courtIds.map((id, index) => ({
      id, locationId, name: index === 2 ? "Zeta" : "Alpha", slug: `p6-${id}`,
      surface: "clay" as const, environment: "outdoor" as const, isActive: index !== 1,
    })), { id: otherCourtId, locationId: otherLocationId, name: "Other court", slug: `p6-${otherCourtId}`,
      surface: "clay", environment: "outdoor" }]);
    const periodIds = [randomUUID(), randomUUID(), randomUUID()].sort();
    await manager.insert(CourtCoveragePeriodEntity, [
      { id: periodIds[2], courtId: courtIds[0], startsOn: "2099-01-01", endsOn: "2099-01-31" },
      { id: periodIds[1], courtId: courtIds[1], startsOn: "2025-01-01", endsOn: "2025-01-31" },
      { id: periodIds[0], courtId: courtIds[0], startsOn: "2025-01-01", endsOn: "2025-01-31" },
      { id: randomUUID(), courtId: otherCourtId, startsOn: "2025-01-01", endsOn: "2025-01-31" },
    ]);

    const courts = await listAdminCourts(manager, locationId);
    expect(courts.map(({ id }) => id)).toEqual(courtIds);
    expect(courts.every((court) => court.locationId === locationId)).toBe(true);
    expect(courts[1].isActive).toBe(false);
    expect((await listCourtCoverage(manager, undefined, locationId)).map(({ id }) => id)).toEqual(periodIds);
    expect((await listAdminCourts(manager, otherLocationId)).map(({ id }) => id)).toEqual([otherCourtId]);
    expect((await listCourtCoverage(manager, otherCourtId))).toHaveLength(1);
    expect(await listCourtCoverage(manager, otherCourtId, locationId)).toEqual([]);

    // Archiving does not silently hide Admin configuration records.
    await manager.update(LocationEntity, locationId, { archivedAt: new Date() });
    expect((await listAdminCourts(manager, locationId)).map(({ id }) => id)).toEqual(courtIds);
    expect((await listCourtCoverage(manager, undefined, locationId)).map(({ id }) => id)).toEqual(periodIds);
    expect(await listAdminCourts(manager, randomUUID())).toEqual([]);
    expect(await listCourtCoverage(manager, undefined, randomUUID())).toEqual([]);
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
    await source.destroy();
  }
});
