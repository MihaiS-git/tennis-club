import { randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import { assert, expect, test, vi } from "vitest";

import { getDataSource } from "@/lib/db/data-source";
import { findPlayerProfileByUserId } from "@/lib/db/repositories/player-profiles.repository";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";

test("TypeORM reads missing, populated, and nullable player profiles by user UUID", async () => {
  const databaseUrl = process.env.DATABASE_URL!;
  const parsedUrl = new URL(databaseUrl);
  assert.ok(["postgres:", "postgresql:"].includes(parsedUrl.protocol),
    "The player profile repository test requires a PostgreSQL URL.");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsedUrl.hostname),
    "The player profile repository test requires local PostgreSQL.");

  const service = localFixtureClient();
  const ids: string[] = [];
  let dataSource: DataSource | undefined;
  vi.stubEnv("DATABASE_URL", databaseUrl);

  async function createUser() {
    const created = await service.auth.admin.createUser({
      email: `typeorm-player-${randomUUID()}@example.test`,
      email_confirm: true,
    });
    if (created.data.user) ids.push(created.data.user.id);
    assert.strictEqual(created.error, null);
    assert.ok(created.data.user);
    return created.data.user.id;
  }

  try {
    dataSource = await getDataSource();
    const manager = dataSource.manager;
    const firstId = await createUser();
    const secondId = await createUser();
    expect(await findPlayerProfileByUserId(manager, firstId)).toBeNull();

    const updatedAt = "2026-09-28T12:00:00.000Z";
    const inserted = await service.from("player_profiles").insert([
      {
        user_id: firstId,
        display_name: "Local Ace",
        avatar_path: `${firstId}/avatar.webp`,
        // Persistence accepts text independently of the form's individual-level choices.
        sportya_level: "5.5",
        rating: 1450,
        handedness: "left",
        backhand: "two_handed",
        preferred_game: "both",
        preferred_surface: "clay",
        bio: "Clay player",
        updated_at: updatedAt,
      },
      { user_id: secondId, updated_at: updatedAt },
    ]);
    assert.strictEqual(inserted.error, null);

    const profile = await findPlayerProfileByUserId(manager, firstId);
    expect(profile).toEqual({
      displayName: "Local Ace",
      avatarPath: `${firstId}/avatar.webp`,
      sportyaLevel: "5.5",
      rating: 1450,
      handedness: "left",
      backhand: "two_handed",
      preferredGame: "both",
      preferredSurface: "clay",
      bio: "Clay player",
      updatedAt: new Date(updatedAt),
    });
    assert.ok(profile);
    expect(profile.updatedAt).toBeInstanceOf(Date);

    expect(await findPlayerProfileByUserId(manager, secondId)).toEqual({
      displayName: null, avatarPath: null, sportyaLevel: null, rating: null,
      handedness: null, backhand: null, preferredGame: null, preferredSurface: null,
      bio: null, updatedAt: new Date(updatedAt),
    });
    expect(await findPlayerProfileByUserId(manager, randomUUID())).toBeNull();
  } finally {
    try {
      for (const id of ids) {
        const deleted = await service.from("player_profiles").delete().eq("user_id", id);
        assert.strictEqual(deleted.error, null);
      }
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
