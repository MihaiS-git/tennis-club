import "server-only";

import type { EntityManager } from "typeorm";
import { z } from "zod";
import { PlayerProfileEntity } from "../entities/player-profile.entity";
import { UserEntity } from "../entities/user.entity";

export async function readAvatarOwner(manager: EntityManager, userId: string, lock = false) {
  const owner = await manager.getRepository(UserEntity).findOne({
    where: { id: userId }, select: { status: true },
    ...(lock ? { lock: { mode: "pessimistic_read" as const } } : {}),
  });
  const profile = await manager.getRepository(PlayerProfileEntity).findOne({
    where: { userId }, select: { userId: true, avatarPath: true },
    ...(lock ? { lock: { mode: "pessimistic_write" as const } } : {}),
  });
  return { owner, profile };
}

export async function readAvatarReference(manager: EntityManager, userId: string) {
  return manager.getRepository(PlayerProfileEntity).findOne({
    where: { userId }, select: { userId: true, avatarPath: true },
  });
}

export async function readAvatarMetadata(manager: EntityManager, userId: string) {
  // Preserve PostgreSQL timestamp precision and its JSON representation used by
  // the existing URL version; entity Date hydration would truncate microseconds.
  const rows: unknown = await manager.query(`
    SELECT avatar_path, to_json(updated_at) #>> '{}' AS updated_at
    FROM public.player_profiles WHERE user_id = $1
  `, [userId]);
  return z.object({ avatar_path: z.string().nullable(), updated_at: z.iso.datetime({ offset: true }) })
    .array().max(1).parse(rows)[0] ?? null;
}

export async function writeAvatarPath(manager: EntityManager, userId: string, path: string | null) {
  const result = await manager.getRepository(PlayerProfileEntity).update({ userId }, {
    avatarPath: path, updatedAt: () => "clock_timestamp()",
  });
  return result.affected === 1;
}
