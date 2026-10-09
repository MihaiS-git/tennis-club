import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DataSource, QueryRunner } from "typeorm";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { z } from "zod";

import { LocationEntity } from "@/lib/db/entities/location.entity";
import { CourtEntity } from "@/lib/db/entities/court.entity";
import { getDataSource } from "@/lib/db/data-source";
import { lockConfigurationForWrite, lockLocations } from "@/lib/db/repositories/clubs.repository";
import { saveAdminCourt } from "@/lib/admin/courts";
import { saveAdminCourtCoverage } from "@/lib/admin/court-coverage";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

let database: DataSource;
let admin: SupabaseClient;
let service: SupabaseClient;
const userIds: string[] = [];
const locationIds = [randomUUID(), randomUUID()].sort();
const courtIds = [randomUUID(), randomUUID()];

beforeAll(async () => {
  const url = process.env.DATABASE_URL!;
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(url).hostname);
  // Separate blocker, observer, contenders, and application transaction connections.
  vi.stubEnv("DATABASE_URL", url);
  vi.stubEnv("DATABASE_POOL_MAX", "6");
  database = await getDataSource();
  service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const email = `configuration-lock-${randomUUID()}@example.test`;
  const password = "configuration-lock-password-123";
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error).toBeNull();
  if (!created.data.user) throw new Error("Missing test actor.");
  userIds.push(created.data.user.id);
  expect((await service.from("user_roles").insert({ user_id: userIds[0], role_code: "admin" })).error).toBeNull();
  admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  expect((await admin.auth.signInWithPassword({ email, password })).error).toBeNull();
  expect((await service.from("locations").insert(locationIds.map((id) => ({
    id, name: "Lock fixture", slug: `lock-${id}`, timezone: "UTC",
  })))).error).toBeNull();
  expect((await service.from("courts").insert(courtIds.map((id, index) => ({
    id, location_id: locationIds[index], name: `Lock court ${index}`, slug: `lock-${id}`,
    surface: "clay", environment: "outdoor",
  })))).error).toBeNull();
});

afterAll(async () => {
  try {
    if (service) {
      expect((await service.from("court_coverage_periods").delete().in("court_id", courtIds)).error).toBeNull();
      expect((await service.from("courts").delete().in("id", courtIds)).error).toBeNull();
      expect((await service.from("locations").delete().in("id", locationIds)).error).toBeNull();
      await cleanupAuthFixtures(service, userIds);
    }
  } finally {
    if (database?.isInitialized) await database.destroy();
    vi.unstubAllEnvs();
  }
});

async function pid(runner: QueryRunner) {
  const rows: unknown = await runner.query("SELECT pg_backend_pid() AS pid");
  return z.array(z.object({ pid: z.number().int() })).length(1).parse(rows)[0].pid;
}

// Correctness is established by PostgreSQL's actual wait-for graph, not elapsed
// time. The deadline only fails a test whose expected blocking never occurs.
async function waitForBlock(observer: QueryRunner, blocker: number) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows: unknown = await observer.query(
      "SELECT pid, query FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))",
      [blocker],
    );
    const blocked = z.array(z.object({ pid: z.number().int(), query: z.string() })).parse(rows);
    if (blocked.length) return blocked;
  }
  throw new Error("Expected PostgreSQL lock wait was not observed.");
}

async function withParentProbe(work: (blocker: QueryRunner, observer: QueryRunner) => Promise<void>, locationId = locationIds[0]) {
  const blocker = database.createQueryRunner();
  const observer = database.createQueryRunner();
  await blocker.connect(); await observer.connect();
  try {
    await blocker.startTransaction();
    // Intentional test probe: retain only a parent lock, allowing a writer to
    // acquire the global lock and demonstrate that it also waits for the parent.
    await lockLocations(blocker.manager, [locationId]);
    await work(blocker, observer);
  } finally {
    if (blocker.isTransactionActive) await blocker.rollbackTransaction();
    await blocker.release(); await observer.release();
  }
}

const fields = (locationId: string, name: string) => ({
  location_id: locationId, name, surface: "clay", environment: "outdoor",
  has_lighting: false, is_active: true,
});

test("same-location writers serialize behind global then aggregate locks", async () => {
  const first = database.createQueryRunner();
  const second = database.createQueryRunner();
  const observer = database.createQueryRunner();
  await first.connect(); await second.connect(); await observer.connect();
  let pending: Promise<void> | undefined;
  try {
    await first.startTransaction(); await second.startTransaction();
    await lockConfigurationForWrite(first.manager);
    await lockLocations(first.manager, [locationIds[0]]);
    const secondPid = await pid(second);
    pending = lockConfigurationForWrite(second.manager);
    const blocked = await waitForBlock(observer, await pid(first));
    expect(blocked.some((row) => row.pid === secondPid)).toBe(true);
    expect(blocked[0].query).toContain("pg_advisory_xact_lock");
    await first.manager.getRepository(LocationEntity).update(locationIds[0], { name: "First configuration writer" });
    await first.commitTransaction();
    await pending;
    await lockLocations(second.manager, [locationIds[0]]);
    await second.manager.getRepository(CourtEntity).update(courtIds[0], { hasLighting: true });
    await second.commitTransaction();
  } finally {
    if (first.isTransactionActive) await first.rollbackTransaction();
    if (pending) await Promise.allSettled([pending]);
    if (second.isTransactionActive) await second.rollbackTransaction();
    await first.release(); await second.release(); await observer.release();
  }
});

test.each(["court", "coverage"] as const)("%s application mutation participates in the parent location lock", async (kind) => {
  await withParentProbe(async (blocker, observer) => {
    const operation = kind === "court"
      ? saveAdminCourt({ id: courtIds[0], fields: fields(locationIds[0], "Changed") }, admin)
      : saveAdminCourtCoverage({ court_id: courtIds[0], dates: { starts_on: "2099-01-01", ends_on: "2099-01-02" } }, admin);
    try {
      const blocked = await waitForBlock(observer, await pid(blocker));
      expect(blocked[0].query).toContain("locations");
      // The wait graph proves the lock; pg_stat_activity may truncate long SQL.
    } finally {
      await blocker.commitTransaction();
    }
    expect(await operation).toMatchObject({ ok: true });
  });
});

test.each(["court", "coverage"] as const)("authenticated PostgREST %s writes are denied", async (kind) => {
  const result = kind === "court"
    ? await admin.from("courts").update({ name: "Denied" }).eq("id", courtIds[0]).select("id")
    : await admin.from("court_coverage_periods").insert({
      court_id: courtIds[0], starts_on: "2099-02-01", ends_on: "2099-02-02",
    }).select("id");
  expect(result.error?.code).toBe("42501");
});

test("multi-location locks use ascending UUID order even when submitted in reverse, with duplicates", async () => {
  const first = database.createQueryRunner();
  const second = database.createQueryRunner();
  const observer = database.createQueryRunner();
  await first.connect(); await second.connect(); await observer.connect();
  let pending: ReturnType<typeof lockLocations> | undefined;
  try {
    await first.startTransaction(); await second.startTransaction();
    // Test aggregate ordering directly, independently of global serialization.
    const held = await lockLocations(first.manager, [locationIds[1], locationIds[0], locationIds[1]]);
    expect(held.map((row) => row.id)).toEqual(locationIds);
    pending = lockLocations(second.manager, [locationIds[0], locationIds[1]]);
    const blocked = await waitForBlock(observer, await pid(first));
    expect(blocked[0].query).toContain("locations");
    await first.commitTransaction();
    expect((await pending).map((row) => row.id)).toEqual(locationIds);
    await second.commitTransaction();
  } finally {
    if (first.isTransactionActive) await first.rollbackTransaction();
    if (pending) await Promise.allSettled([pending]);
    if (second.isTransactionActive) await second.rollbackTransaction();
    await first.release(); await second.release(); await observer.release();
  }
});

test.each(["old", "new"] as const)("court move waits for the authoritative %s location", async (parent) => {
  expect((await service.from("courts").update({ location_id: locationIds[0] }).eq("id", courtIds[0])).error).toBeNull();
  await withParentProbe(async (blocker, observer) => {
    const operation = saveAdminCourt({ id: courtIds[0], fields: fields(locationIds[1], "Move parent probe") }, admin);
    try {
      expect((await waitForBlock(observer, await pid(blocker)))[0].query).toContain("locations");
    } finally {
      await blocker.commitTransaction();
    }
    expect(await operation).toEqual({ ok: true, id: courtIds[0] });
  }, parent === "old" ? locationIds[0] : locationIds[1]);
});

test("opposing court moves preserve both authoritative parents without deadlock", async () => {
  for (const [index, id] of courtIds.entries()) {
    expect((await service.from("courts").update({ location_id: locationIds[index] }).eq("id", id)).error).toBeNull();
  }
  const results = await Promise.all([
    saveAdminCourt({ id: courtIds[0], fields: fields(locationIds[1], "Moved one") }, admin),
    saveAdminCourt({ id: courtIds[1], fields: fields(locationIds[0], "Moved two") }, admin),
  ]);
  expect(results).toEqual([{ ok: true, id: courtIds[0] }, { ok: true, id: courtIds[1] }]);
  const rows = await service.from("courts").select("id,location_id").in("id", courtIds);
  expect(rows.error).toBeNull();
  expect(rows.data?.find((row) => row.id === courtIds[0])?.location_id).toBe(locationIds[1]);
  expect(rows.data?.find((row) => row.id === courtIds[1])?.location_id).toBe(locationIds[0]);
});
