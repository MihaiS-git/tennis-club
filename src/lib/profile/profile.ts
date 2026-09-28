import "server-only";

import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { fieldValidationErrors } from "@/lib/auth/validation";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { personalInformationSchema, tennisProfileSchema, type ProfileActionState } from "./validation";

export type ProfileClient = Awaited<ReturnType<typeof createClient>>;
export const personalColumns = "first_name, last_name, phone, date_of_birth, address_line1, address_line2, city, postal_code, country_code";
const playerColumns = "display_name, avatar_path, sportya_level, rating, handedness, backhand, preferred_game, preferred_surface, bio, updated_at";
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

export async function loadProfile(client: ProfileClient, userId: string) {
  const [personal, player] = await Promise.all([
    client.from("users").select(personalColumns).eq("id", userId).single(),
    client.from("player_profiles").select(playerColumns).eq("user_id", userId).maybeSingle(),
  ]);
  if (personal.error || player.error) {
    logger.error({ event: "profile.load_failed", code: personal.error?.code ?? player.error?.code }, "Failed to load profile");
    return null;
  }
  const parsedPersonal = personalRowSchema.safeParse(personal.data);
  const parsedPlayer = playerRowSchema.nullable().safeParse(player.data);
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
  const result = await context.client.from("users").update({
    first_name, last_name, phone, date_of_birth, address_line1, address_line2, city, postal_code, country_code,
  }).eq("id", context.account.userId).select("id").maybeSingle();
  if (result.error || !result.data) {
    logger.error({ event: "profile.personal_save_failed", code: result.error?.code }, "Failed to save personal information");
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
  const payload = { display_name, sportya_level, handedness, backhand, preferred_game, preferred_surface, bio };
  const userId = context.account.userId;
  const existing = await context.client.from("player_profiles").select("user_id").eq("user_id", userId).maybeSingle();
  if (existing.error) return saveFailure(existing.error.code);
  // Avoid an upsert that would require UPDATE permission on the immutable user_id.
  const update = () => context.client.from("player_profiles").update({ ...payload, updated_at: new Date().toISOString() })
    .eq("user_id", userId).select("user_id").maybeSingle();
  let result = existing.data ? await update()
    : await context.client.from("player_profiles").insert({ user_id: userId, ...payload }).select("user_id").maybeSingle();
  if (result.error?.code === "23505") result = await update();
  if (result.error || !result.data) return saveFailure(result.error?.code);
  return { success: "Tennis profile saved." };
}

function saveFailure(code?: string): ProfileActionState {
  logger.error({ event: "profile.tennis_save_failed", code }, "Failed to save tennis profile");
  return { formError: "We couldn't save your tennis profile. Please try again." };
}
