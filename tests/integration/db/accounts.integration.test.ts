import { randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import { assert, test, vi } from "vitest";

import { getDataSource } from "@/lib/db/data-source";
import { findAccountById } from "@/lib/db/repositories/accounts.repository";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";

test("TypeORM reads an Auth-backed account, role assignments, and missing accounts", async () => {
  const databaseUrl = process.env.DATABASE_URL!;
  const parsedUrl = new URL(databaseUrl);
  assert.ok(["postgres:", "postgresql:"].includes(parsedUrl.protocol),
    "The account smoke test requires a PostgreSQL URL.");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsedUrl.hostname),
    "The account smoke test requires local PostgreSQL.");

  const service = localFixtureClient();
  const ids: string[] = [];
  let dataSource: DataSource | undefined;
  vi.stubEnv("DATABASE_URL", databaseUrl);
  try {
    dataSource = await getDataSource();
    const email = `typeorm-account-${randomUUID()}@example.test`;
    const created = await service.auth.admin.createUser({ email, email_confirm: true });
    if (created.data.user) ids.push(created.data.user.id);
    assert.strictEqual(created.error, null);
    assert.ok(created.data.user);
    const userId = created.data.user.id;

    const initial = await findAccountById(dataSource.manager, userId);
    assert.ok(initial);
    assert.strictEqual(initial.user.id, userId);
    assert.strictEqual(initial.user.email, email);
    assert.strictEqual(initial.user.status, "active");
    assert.strictEqual(initial.user.phone, null);
    assert.strictEqual(initial.user.dateOfBirth, null);
    assert.strictEqual(initial.user.countryCode, null);
    for (const timestamp of [initial.user.createdAt, initial.user.updatedAt]) {
      assert.ok(timestamp instanceof Date);
      assert.ok(Number.isFinite(timestamp.getTime()));
    }
    assert.deepStrictEqual(initial.roleCodes, []);

    const personal = await service.from("users")
      .update({ date_of_birth: "1990-04-23", country_code: "RO" }).eq("id", userId);
    assert.strictEqual(personal.error, null);
    const assignment = await service.from("user_roles")
      .insert({ user_id: userId, role_code: "coach" });
    assert.strictEqual(assignment.error, null);

    const assigned = await findAccountById(dataSource.manager, userId);
    assert.ok(assigned);
    assert.deepStrictEqual(assigned.roleCodes, ["coach"]);
    assert.strictEqual(assigned.user.dateOfBirth, "1990-04-23");
    assert.strictEqual(assigned.user.countryCode, "RO");
    assert.strictEqual(await findAccountById(dataSource.manager, randomUUID()), null);
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
