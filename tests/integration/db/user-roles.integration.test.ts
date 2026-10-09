import { randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import { assert, expect, test, vi } from "vitest";

import { getDataSource } from "@/lib/db/data-source";
import {
  assignUserRole,
  listUserRoleCodes,
  removeUserRole,
} from "@/lib/db/repositories/user-roles.repository";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";

test("TypeORM role primitives preserve attribution and duplicate metadata", async () => {
  const databaseUrl = process.env.DATABASE_URL!;
  const parsedUrl = new URL(databaseUrl);
  assert.ok(["postgres:", "postgresql:"].includes(parsedUrl.protocol),
    "The role repository test requires a PostgreSQL URL.");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsedUrl.hostname),
    "The role repository test requires local PostgreSQL.");

  const service = localFixtureClient();
  const ids: string[] = [];
  let dataSource: DataSource | undefined;
  vi.stubEnv("DATABASE_URL", databaseUrl);

  async function createUser(label: string) {
    const created = await service.auth.admin.createUser({
      email: `typeorm-role-${label}-${randomUUID()}@example.test`,
      email_confirm: true,
    });
    if (created.data.user) ids.push(created.data.user.id);
    assert.strictEqual(created.error, null);
    assert.ok(created.data.user);
    return created.data.user.id;
  }

  async function readAssignments(userId: string) {
    const result = await service.from("user_roles")
      .select("user_id, role_code, assigned_by, assigned_at")
      .eq("user_id", userId)
      .order("role_code");
    assert.strictEqual(result.error, null);
    assert.ok(result.data);
    return result.data;
  }

  try {
    dataSource = await getDataSource();
    const manager = dataSource.manager;
    const targetId = await createUser("target");
    const actorId = await createUser("actor");
    const secondActorId = await createUser("second-actor");
    // Keep fixture cleanup independent of the database's active Admin population.
    const suspended = await service.from("users").update({ status: "suspended" }).eq("id", targetId);
    assert.strictEqual(suspended.error, null);

    expect(await listUserRoleCodes(manager, targetId)).toEqual([]);

    await assignUserRole(manager, targetId, "coach", actorId);
    const firstRows = await readAssignments(targetId);
    expect(firstRows).toHaveLength(1);
    const first = firstRows[0];
    assert.ok(first);
    expect(first.user_id).toBe(targetId);
    expect(first.role_code).toBe("coach");
    expect(first.assigned_by).toBe(actorId);
    expect(Number.isFinite(Date.parse(first.assigned_at))).toBe(true);

    await assignUserRole(manager, targetId, "coach", secondActorId);
    // Compare PostgreSQL timestamp strings without losing sub-millisecond precision.
    expect(await readAssignments(targetId)).toEqual(firstRows);

    await assignUserRole(manager, targetId, "admin", actorId);
    await assignUserRole(manager, actorId, "coach", secondActorId);
    expect(await listUserRoleCodes(manager, targetId)).toEqual(["admin", "coach"]);
    expect(await listUserRoleCodes(manager, actorId)).toEqual(["coach"]);

    await removeUserRole(manager, targetId, "coach");
    await removeUserRole(manager, targetId, "coach");
    expect(await listUserRoleCodes(manager, targetId)).toEqual(["admin"]);
    expect((await readAssignments(targetId)).some((row) => row.role_code === "coach")).toBe(false);
    expect(await listUserRoleCodes(manager, actorId)).toEqual(["coach"]);

    await expect(assignUserRole(manager, targetId, "missing_role", actorId))
      .rejects.toMatchObject({ driverError: { code: "23503" } });
    expect(await listUserRoleCodes(manager, targetId)).toEqual(["admin"]);
  } finally {
    try {
      await cleanupAuthFixtures(service, ids);
    } finally {
      // Vitest isolates each integration file in a fresh worker; this file owns the pool.
      try {
        if (dataSource?.isInitialized) await dataSource.destroy();
      } finally {
        vi.unstubAllEnvs();
      }
    }
  }
});
