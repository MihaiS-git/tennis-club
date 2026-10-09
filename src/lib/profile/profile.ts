import "server-only";

import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { fieldValidationErrors } from "@/lib/auth/validation";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { findPlayerProfileByUserId, upsertEditableTennisInformation } from "@/lib/db/repositories/player-profiles.repository";
import { findPersonalInformationByUserId, updatePersonalInformation } from "@/lib/db/repositories/users.repository";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { personalInformationSchema, tennisProfileSchema, type ProfileActionState } from "./validation";

export type ProfileClient = Awaited<ReturnType<typeof createClient>>;
const personalRowSchema = z.object({
  first_name: z.string().nullable(), last_name: z.string().nullable(), phone: z.string().nullable(),
  date_of_birth: z.string().nullable(), address_line1: z.string().nullable(), address_line2: z.string().nullable(),
  city: z.string().nullable(), postal_code: z.string().nullable(), country_code: z.string().nullable(),
});
const playerRowSchema = z.object({
  display_name: z.string().nullable(), avatar_path: z.string().nullable(), sportya_level: z.string().nullable(),
  rating: z.number().int().nullable(), handedness: z.enum(["right", "left"]).nullable(),
  backhand: z.enum(["one_handed", "two_handed"]).nullable(), preferred_game: z.enum(["singles", "doubles", "both"]).nullable(),
  preferred_surface: z.enum(["clay", "hard", "grass", "carpet", "any"]).nullable(), bio: z.string().nullable(),
  updated_at: z.iso.datetime({ offset: true }),
});
export type PlayerProfile = z.infer<typeof playerRowSchema>;
export type PersonalProfile = z.infer<typeof personalRowSchema>;

export async function profileContext(suppliedClient?: ProfileClient) {
  const client = suppliedClient ?? await createClient();
  return { client, account: await readCurrentAccount(client) };
}

export async function loadProfile(_client: ProfileClient, userId: string) {
  let personal;
  let player;
  try {
    const { manager } = await getDataSource();
    [personal, player] = await Promise.all([
      findPersonalInformationByUserId(manager, userId),
      findPlayerProfileByUserId(manager, userId),
    ]);
  } catch (error: unknown) {
    const databaseError = normalizeDatabaseError(error);
    logger.error({ event: "profile.load_failed", kind: databaseError.kind, code: databaseError.sqlState }, "Failed to load profile");
    return null;
  }
  if (!personal) {
    logger.error({ event: "profile.load_failed" }, "Failed to load profile");
    return null;
  }
  // Validate before ISO conversion so malformed timestamps retain the invalid-data contract.
  const timestamp = player ? z.date().safeParse(player.updatedAt) : null;
  if (timestamp && !timestamp.success) {
    logger.error({ event: "profile.invalid_data" }, "Invalid profile data");
    return null;
  }
  const parsedPersonal = personalRowSchema.safeParse({
    first_name: personal.firstName, last_name: personal.lastName, phone: personal.phone,
    date_of_birth: personal.dateOfBirth, address_line1: personal.addressLine1,
    address_line2: personal.addressLine2, city: personal.city,
    postal_code: personal.postalCode, country_code: personal.countryCode,
  });
  const parsedPlayer = playerRowSchema.nullable().safeParse(player ? {
    display_name: player.displayName, avatar_path: player.avatarPath, sportya_level: player.sportyaLevel,
    rating: player.rating, handedness: player.handedness, backhand: player.backhand,
    preferred_game: player.preferredGame, preferred_surface: player.preferredSurface, bio: player.bio,
    updated_at: timestamp?.success ? timestamp.data.toISOString() : undefined,
  } : null);
  if (!parsedPersonal.success || !parsedPlayer.success) {
    logger.error({ event: "profile.invalid_data" }, "Invalid profile data");
    return null;
  }
  return { personal: parsedPersonal.data, player: parsedPlayer.data };
}

export async function savePersonalInformation(input: unknown, client?: ProfileClient): Promise<ProfileActionState> {
  const parsed = personalInformationSchema.safeParse(input);
  if (!parsed.success) return { fieldErrors: fieldValidationErrors(parsed.error), formError: "Check your personal information." };
  const context = await profileContext(client);
  if (context.account.state !== "active") return { formError: "Profile changes require an active account." };
  const { first_name, last_name, phone, date_of_birth, address_line1, address_line2, city, postal_code, country_code } = parsed.data;
  try {
    const { manager } = await getDataSource();
    const updated = await updatePersonalInformation(manager, context.account.userId, {
      firstName: first_name, lastName: last_name, phone, dateOfBirth: date_of_birth,
      addressLine1: address_line1, addressLine2: address_line2, city,
      postalCode: postal_code, countryCode: country_code,
    });
    if (!updated) {
      logger.error({ event: "profile.personal_save_failed" }, "Failed to save personal information");
      return { formError: "We couldn't save your personal information. Please try again." };
    }
  } catch (error: unknown) {
    const databaseError = normalizeDatabaseError(error);
    logger.error({ event: "profile.personal_save_failed", kind: databaseError.kind, code: databaseError.sqlState }, "Failed to save personal information");
    return { formError: "We couldn't save your personal information. Please try again." };
  }
  return { success: "Personal information saved." };
}

export async function saveTennisProfile(input: unknown, client?: ProfileClient): Promise<ProfileActionState> {
  const parsed = tennisProfileSchema.safeParse(input);
  if (!parsed.success) return { fieldErrors: fieldValidationErrors(parsed.error), formError: "Check your tennis profile." };
  const context = await profileContext(client);
  if (context.account.state !== "active") return { formError: "Profile changes require an active account." };
  const { display_name, sportya_level, handedness, backhand, preferred_game, preferred_surface, bio } = parsed.data;
  try {
    const { manager } = await getDataSource();
    const saved = await upsertEditableTennisInformation(manager, context.account.userId, {
      displayName: display_name, sportyaLevel: sportya_level, handedness, backhand,
      preferredGame: preferred_game, preferredSurface: preferred_surface, bio,
    });
    if (!saved) return saveFailure();
  } catch (error: unknown) {
    const databaseError = normalizeDatabaseError(error);
    return saveFailure(databaseError.sqlState, databaseError.kind);
  }
  return { success: "Tennis profile saved." };
}

function saveFailure(code?: string, kind?: string): ProfileActionState {
  logger.error({ event: "profile.tennis_save_failed", code, kind }, "Failed to save tennis profile");
  return { formError: "We couldn't save your tennis profile. Please try again." };
}
