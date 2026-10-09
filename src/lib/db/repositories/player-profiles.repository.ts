import "server-only";

import type { EntityManager } from "typeorm";
import { z } from "zod";

import { PlayerProfileEntity } from "../entities/player-profile.entity";

export type PlayerProfilePersistence = Pick<PlayerProfileEntity,
  "displayName" | "avatarPath" | "sportyaLevel" | "rating" | "handedness" |
  "backhand" | "preferredGame" | "preferredSurface" | "bio" | "updatedAt"
>;

export type EditableTennisInformationPersistenceInput = Pick<PlayerProfileEntity,
  "displayName" | "sportyaLevel" | "handedness" | "backhand" |
  "preferredGame" | "preferredSurface" | "bio"
>;

export async function upsertEditableTennisInformation(
  manager: EntityManager,
  userId: string,
  fields: EditableTennisInformationPersistenceInput,
): Promise<boolean> {
  // Lock the active owner within this statement: suspension cannot commit between
  // the eligibility check and the upsert. FOR SHARE permits concurrent saves but
  // conflicts with status updates (FOR KEY SHARE would not protect status).
  const rows: unknown = await manager.query(`
    WITH active_owner AS (
      SELECT id FROM public.users WHERE id = $1 AND status = 'active' FOR SHARE
    )
    INSERT INTO public.player_profiles (
      user_id, display_name, sportya_level, handedness, backhand,
      preferred_game, preferred_surface, bio
    )
    SELECT id, $2, $3, $4, $5, $6, $7, $8 FROM active_owner
    ON CONFLICT (user_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      sportya_level = EXCLUDED.sportya_level,
      handedness = EXCLUDED.handedness,
      backhand = EXCLUDED.backhand,
      preferred_game = EXCLUDED.preferred_game,
      preferred_surface = EXCLUDED.preferred_surface,
      bio = EXCLUDED.bio,
      updated_at = clock_timestamp()
    RETURNING user_id
  `, [userId, fields.displayName, fields.sportyaLevel, fields.handedness,
    fields.backhand, fields.preferredGame, fields.preferredSurface, fields.bio]);
  return z.object({ user_id: z.uuid() }).array().max(1).parse(rows).length === 1;
}

export async function findPlayerProfileByUserId(
  manager: EntityManager,
  userId: string,
): Promise<PlayerProfilePersistence | null> {
  const profile = await manager.getRepository(PlayerProfileEntity).findOne({
    where: { userId },
    select: {
      displayName: true,
      avatarPath: true,
      sportyaLevel: true,
      rating: true,
      handedness: true,
      backhand: true,
      preferredGame: true,
      preferredSurface: true,
      bio: true,
      updatedAt: true,
    },
  });
  if (!profile) return null;

  return {
    displayName: profile.displayName,
    avatarPath: profile.avatarPath,
    sportyaLevel: profile.sportyaLevel,
    rating: profile.rating,
    handedness: profile.handedness,
    backhand: profile.backhand,
    preferredGame: profile.preferredGame,
    preferredSurface: profile.preferredSurface,
    bio: profile.bio,
    updatedAt: profile.updatedAt,
  };
}
