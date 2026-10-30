import "server-only";
import { readClubTimezoneError } from "@/lib/club/timezone-policy";

import { z } from "zod";
import { localStartInstant } from "@/lib/courts/local-time";
import type { EntityManager } from "typeorm";

import { requireActiveAdmin } from "@/lib/admin/authorization";
import { getDataSource } from "@/lib/db/data-source";
import type { CoachingProgramEntity } from "@/lib/db/entities/coaching-program.entity";
import type { LocationEntity } from "@/lib/db/entities/location.entity";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { lockActiveAdminAccount, lockReservationActorFacts } from "@/lib/db/repositories/accounts.repository";
import { listLocationsWithCoachAvailability } from "@/lib/db/repositories/coach-availability.repository";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import * as coaching from "@/lib/db/repositories/coaching.repository";
import { inTransaction, readIndependently } from "@/lib/db/transaction";
import { logger } from "@/lib/logger";
import type { LocationCurrency } from "@/lib/pricing/money";
import { createClient } from "@/lib/supabase/server";
import {
  coachingFieldErrors, coachingProgramMutationSchema, coachingParticipantRange, coachingProgramStatusSchema,
  coachProfileMutationSchema, coachVisibilitySchema, isOnlineCoachingProgramType, type CoachingMutationResult, type CoachingProgramType,
} from "./validation";

type Client = Awaited<ReturnType<typeof createClient>>;

export type AdminCoachingProgram = {
  id: string; name: string; description: string; program_type: CoachingProgramType; durations: number[];
  min_participants: number | null; max_participants: number | null; court_rental_included: boolean; is_active: boolean;
};
export type AdminCoach = {
  user_id: string; display_name: string; bio: string; qualifications: string; specialties: string[]; languages: string[];
  is_public: boolean; email: string; location_ids: string[]; program_ids: string[];
  // Public visibility also requires an active account holding the coach role.
  ineligibility: "suspended" | "no-coach-role" | null;
};
export type AdminCoachAccount = { id: string; email: string; suggested_name: string | null };
export type AdminCoachingLocation = { id: string; name: string; currency: LocationCurrency; is_active: boolean };
// Club-wide lesson price/person: a club default (coach null) or a coach's own override, per
// program duration, participant count and currency.
export type AdminCoachingPrice = {
  id: string; program_id: string; duration_minutes: number; participant_count: number; coach_user_id: string | null;
  amount_minor: number; currency: LocationCurrency;
};
// A pricing currency: one used by a current location, or one that still holds prices.
export type AdminCoachingCurrency = { currency: LocationCurrency; location_names: string[] };
export type AdminCoaching = {
  programs: AdminCoachingProgram[]; coaches: AdminCoach[]; coachAccounts: AdminCoachAccount[];
  locations: AdminCoachingLocation[]; prices: AdminCoachingPrice[];
};

export function adminCoachingProgram(program: Pick<CoachingProgramEntity, "id" | "name" | "description" | "programType"
  | "minParticipants" | "maxParticipants" | "courtRentalIncluded" | "isActive"> & { durations: number[] }): AdminCoachingProgram {
  return { id: program.id, name: program.name, description: program.description, program_type: program.programType,
    durations: program.durations, min_participants: program.minParticipants, max_participants: program.maxParticipants,
    court_rental_included: program.courtRentalIncluded, is_active: program.isActive };
}

export function adminCoachingLocation(location: Pick<LocationEntity, "id" | "name" | "currency" | "isActive">): AdminCoachingLocation {
  return { id: location.id, name: location.name, currency: location.currency, is_active: location.isActive };
}

export function adminCoachingPrice(price: coaching.CoachingPriceKey & { id: string; amountMinor: number }): AdminCoachingPrice {
  return { id: price.id, program_id: price.programId, duration_minutes: price.durationMinutes, participant_count: price.participantCount,
    coach_user_id: price.coachUserId, amount_minor: price.amountMinor, currency: price.currency };
}

export function adminCoachingCurrencies(locations: readonly Pick<AdminCoachingLocation, "name" | "currency">[],
  prices: readonly Pick<AdminCoachingPrice, "currency">[]): AdminCoachingCurrency[] {
  const currencies = [...new Set([...locations, ...prices].map((item) => item.currency))].sort();
  return currencies.map((currency) => ({ currency,
    location_names: locations.filter((location) => location.currency === currency).map((location) => location.name) }));
}

export function coachIneligibility(facts: { status: "active" | "suspended"; roles: readonly string[] } | null): AdminCoach["ineligibility"] {
  if (!facts || facts.status !== "active") return "suspended";
  return facts.roles.includes("coach") ? null : "no-coach-role";
}

export async function loadAdminCoaching(supabase?: Client): Promise<AdminCoaching> {
  await requireActiveAdmin(supabase ?? await createClient());
  return readAdminCoaching((await getDataSource()).manager);
}

// Internal projection for already-authorized management reads.
async function readAdminCoaching(manager: EntityManager): Promise<AdminCoaching> {
  try {
    const [programs, coaches, coachAccounts, locations, prices] = await readIndependently(manager, [
      () => coaching.listCoachingPrograms(manager), () => coaching.listCoachProfiles(manager),
      () => coaching.listCoachAccountsWithoutProfile(manager), () => clubs.listAdminLocations(manager, "current"),
      () => coaching.listCoachingPrices(manager),
    ]);
    return {
      programs: programs.map(adminCoachingProgram),
      coaches: coaches.map((coach) => ({
        user_id: coach.user_id, display_name: coach.display_name, bio: coach.bio, qualifications: coach.qualifications,
        specialties: coach.specialties, languages: coach.languages, is_public: coach.is_public, email: coach.email,
        location_ids: coach.location_ids, program_ids: coach.program_ids,
        ineligibility: coachIneligibility({ status: coach.account_status, roles: coach.has_coach_role ? ["coach"] : [] }),
      })),
      coachAccounts,
      locations: locations.map(adminCoachingLocation),
      prices: prices.map(adminCoachingPrice),
    };
  } catch (error) {
    const failure = normalizeDatabaseError(error);
    logger.error({ event: "admin.coaching_list_failed", kind: failure.kind, code: failure.sqlState }, "Failed to load coaching");
    throw new Error("Unable to load coaching.");
  }
}

async function mutate(event: string, actorId: string, work: (manager: EntityManager) => Promise<CoachingMutationResult>) {
  let result: CoachingMutationResult;
  try {
    result = await inTransaction(async (manager) => work(manager));
  } catch (error) {
    const failure = normalizeDatabaseError(error);
    // Structural constraints remain authoritative behind the TypeScript checks.
    if (failure.sqlState === "23505") return { ok: false, reason: "already-exists" } as const;
    if (failure.sqlState === "23503") {
      if (failure.constraint?.startsWith("coaching_prices_")) return { ok: false, reason: "has-prices" } as const;
      if (failure.constraint?.startsWith("coach_weekly_availability_") || failure.constraint?.startsWith("coach_availability_exceptions_")) {
        return { ok: false, reason: "has-availability" } as const;
      }
      return { ok: false, reason: "not-found" } as const;
    }
    logger.error({ event: `${event}_failed`, actorId, kind: failure.kind, code: failure.sqlState }, "Failed to save coaching");
    throw new Error("Unable to save coaching.");
  }
  if (result.ok) logger.info({ event, actorId, id: result.id }, "Coaching saved");
  return result;
}

async function requireAdminFence(manager: EntityManager, actorId: string) {
  if (!await lockActiveAdminAccount(manager, actorId)) throw new Error("Administrator required");
}

async function persistClubPrices(manager: EntityManager, programId: string,
  prices: NonNullable<z.output<typeof coachingProgramMutationSchema>["club_prices"]>,
  removed: NonNullable<z.output<typeof coachingProgramMutationSchema>["removed_club_prices"]>) {
  const now = new Date();
  const key = (price: typeof removed[number]) => ({ programId, durationMinutes: price.duration_minutes,
    participantCount: price.participant_count, currency: price.currency });
  await coaching.deleteClubCoachingPrices(manager, removed.map(key));
  await coaching.upsertClubCoachingPrices(manager, prices.map((price) => ({ ...key(price), amountMinor: price.amount })), now);
}

export async function saveCoachingProgram(input: unknown, supabase?: Client): Promise<CoachingMutationResult> {
  const actor = await requireActiveAdmin(supabase ?? await createClient());
  const parsed = coachingProgramMutationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input", fieldErrors: coachingFieldErrors(parsed.error.issues) };
  const { id, fields } = parsed.data;
  const values: coaching.CoachingProgramValues = {
    name: fields.name, description: fields.description, programType: fields.program_type,
    minParticipants: fields.min_participants, maxParticipants: fields.max_participants,
    courtRentalIncluded: fields.court_rental_included, isActive: fields.is_active,
  };
  const clubPrices = parsed.data.club_prices ?? [];
  const removedPrices = parsed.data.removed_club_prices ?? [];
  // Permitted price scopes are program policy, decided here rather than in SQL.
  const scope: coaching.ProgramPriceScope = { coachOverrides: isOnlineCoachingProgramType(fields.program_type), durations: fields.durations,
    range: coachingParticipantRange({ minParticipants: fields.min_participants, maxParticipants: fields.max_participants }) };
  return mutate(id ? "admin.coaching_program_updated" : "admin.coaching_program_created", actor.userId, async (manager) => {
    // Configuration fence → Admin fence → program.
    await clubs.lockConfigurationForWrite(manager);
    await requireAdminFence(manager, actor.userId);
    // New or changed club prices need a currency charged by a current location; prices in a
    // currency no location uses any more can still be removed. The fence keeps locations stable.
    if (clubPrices.length) {
      const charged = new Set((await clubs.listAdminLocations(manager, "current")).map((location) => location.currency));
      if (clubPrices.some((price) => !charged.has(price.currency))) return { ok: false, reason: "invalid-currency" };
    }
    if (!id) {
      const created = await coaching.insertCoachingProgram(manager, values, new Date());
      await coaching.addCoachingProgramDurations(manager, created, fields.durations);
      await persistClubPrices(manager, created, clubPrices, removedPrices);
      return { ok: true, id: created };
    }
    // Coach price saves hold the program FOR SHARE, so no price outside the saved configuration
    // can be written between this reconciliation and commit.
    const program = await coaching.lockCoachingProgram(manager, id, "pessimistic_write");
    if (!program) return { ok: false, reason: "not-found" };
    const removed = program.durations.filter((minutes) => !fields.durations.includes(minutes));
    const added = fields.durations.filter((minutes) => !program.durations.includes(minutes));
    // Removed durations, counts outside the new range and coach overrides a Group/Junior type
    // forbids are current configuration only; booking contracts keep their snapshots.
    await coaching.deleteObsoleteProgramPrices(manager, program.id, scope);
    await coaching.updateCoachingProgram(manager, program.id, values, new Date());
    await coaching.removeCoachingProgramDurations(manager, program.id, removed);
    await coaching.addCoachingProgramDurations(manager, program.id, added);
    // A removal already applied by the reconciliation or another Admin is a no-op.
    await persistClubPrices(manager, program.id, clubPrices, removedPrices);
    return { ok: true, id: program.id };
  });
}

export async function setCoachingProgramStatus(input: unknown, supabase?: Client): Promise<CoachingMutationResult> {
  const actor = await requireActiveAdmin(supabase ?? await createClient());
  const parsed = coachingProgramStatusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input", fieldErrors: coachingFieldErrors(parsed.error.issues) };
  return mutate("admin.coaching_program_status_changed", actor.userId, async (manager) => {
    await requireAdminFence(manager, actor.userId);
    const program = await coaching.lockCoachingProgram(manager, parsed.data.id, "pessimistic_write");
    if (!program) return { ok: false, reason: "not-found" };
    // Activation makes the program bookable online; stored limits are never filled in.
    if (parsed.data.is_active && !program.isActive && !coachingParticipantRange(program)) return { ok: false, reason: "participants-required" };
    if (program.isActive !== parsed.data.is_active) {
      await coaching.updateCoachingProgram(manager, program.id, { isActive: parsed.data.is_active }, new Date());
    }
    return { ok: true, id: program.id };
  });
}

export async function saveCoachProfile(input: unknown, supabase?: Client): Promise<CoachingMutationResult> {
  const actor = await requireActiveAdmin(supabase ?? await createClient());
  const parsed = coachProfileMutationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input", fieldErrors: coachingFieldErrors(parsed.error.issues) };
  const { user_id: userId, create, fields } = parsed.data;
  const locationIds = fields.location_ids.map((id) => id.toLowerCase());
  const programIds = fields.program_ids.map((id) => id.toLowerCase());
  const values: coaching.CoachProfileValues = {
    displayName: fields.display_name, bio: fields.bio, qualifications: fields.qualifications,
    specialties: fields.specialties, languages: fields.languages, isPublic: fields.is_public,
  };
  return mutate(create ? "admin.coach_profile_created" : "admin.coach_profile_updated", actor.userId, async (manager) => {
    // Configuration fence → profile → ordered locations → actor → coach account → programs.
    // Coach price saves take profile → account → program, all shared, so no cycle forms.
    await clubs.lockConfigurationForRead(manager);
    const profile = create ? null : await coaching.lockCoachProfile(manager, userId, "pessimistic_write");
    if (!create && !profile) return { ok: false, reason: "not-found" };
    const locations = await clubs.lockLocationsForRead(manager, [...locationIds, ...profile?.locationIds ?? []]);
    await requireAdminFence(manager, actor.userId);
    const account = await lockReservationActorFacts(manager, userId);
    const eligibility = coachIneligibility(account);
    // Private configuration is allowed for suspended coaches; publishing still
    // requires an active account. Creation always requires the authoritative role.
    if (create && !account?.roles.includes("coach")) return { ok: false, reason: "not-eligible" };
    if (fields.is_public && eligibility) return { ok: false, reason: "not-eligible" };
    const retainedLocations = new Set(profile?.locationIds ?? []);
    for (const location of locations.filter((location) => locationIds.includes(location.id) && !retainedLocations.has(location.id))) {
      const timezoneError = await readClubTimezoneError(manager, location);
      if (timezoneError) return { ok: false, reason: "invalid-input", fieldErrors: { location_ids: timezoneError } };
    }
    // New assignments need a current location; existing ones may be kept after archiving.
    if (locationIds.some((id) => !retainedLocations.has(id)
      && !locations.some((location) => location.id === id && location.archivedAt === null))) return { ok: false, reason: "invalid-location" };
    const programs = await coaching.lockCoachingProgramsForRead(manager, programIds);
    if (programs.length !== programIds.length) return { ok: false, reason: "invalid-program" };
    const removedLocations = (profile?.locationIds ?? []).filter((id) => !locationIds.includes(id));
    const removedPrograms = (profile?.programIds ?? []).filter((id) => !programIds.includes(id));
    // Availability references an assignment; it must be removed first, like prices.
    if (profile && removedLocations.length
      && (await listLocationsWithCoachAvailability(manager, profile.userId, removedLocations)).length) return { ok: false, reason: "has-availability" };
    const coachUserId = profile?.userId ?? userId.toLowerCase();
    if (profile) await coaching.updateCoachProfile(manager, coachUserId, values, new Date());
    else await coaching.insertCoachProfile(manager, coachUserId, values, new Date());
    await coaching.changeCoachLocations(manager, coachUserId,
      locationIds.filter((id) => !retainedLocations.has(id)), removedLocations);
    // A coach's overrides reference the programs they offer, not their locations: removing
    // an assignment deletes that coach's overrides for it, in this transaction.
    await coaching.deleteCoachProgramPrices(manager, coachUserId, removedPrograms);
    await coaching.changeCoachPrograms(manager, coachUserId,
      programIds.filter((id) => !(profile?.programIds ?? []).includes(id)), removedPrograms);
    return { ok: true, id: coachUserId };
  });
}

export async function setCoachVisibility(input: unknown, supabase?: Client): Promise<CoachingMutationResult> {
  const actor = await requireActiveAdmin(supabase ?? await createClient());
  const parsed = coachVisibilitySchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input", fieldErrors: coachingFieldErrors(parsed.error.issues) };
  const { user_id: userId, is_public: isPublic } = parsed.data;
  return mutate("admin.coach_visibility_changed", actor.userId, async (manager) => {
    await requireAdminFence(manager, actor.userId);
    const eligibility = coachIneligibility(await lockReservationActorFacts(manager, userId));
    const profile = await coaching.lockCoachProfile(manager, userId, "pessimistic_write");
    if (!profile) return { ok: false, reason: "not-found" };
    if (isPublic && eligibility) return { ok: false, reason: "not-eligible" };
    if (profile.isPublic !== isPublic) await coaching.updateCoachProfile(manager, profile.userId, { isPublic }, new Date());
    return { ok: true, id: profile.userId };
  });
}

export async function deleteCoachingProgram(input: unknown, supabase?: Client): Promise<CoachingMutationResult> {
  const actor = await requireActiveAdmin(supabase ?? await createClient());
  const parsed = z.strictObject({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input", fieldErrors: coachingFieldErrors(parsed.error.issues) };
  return mutate("admin.coaching_program_deleted", actor.userId, async (manager) => {
    await clubs.lockConfigurationForWrite(manager);
    await requireAdminFence(manager, actor.userId);
    const program = await coaching.lockCoachingProgram(manager, parsed.data.id, "pessimistic_write");
    if (!program) return { ok: false, reason: "not-found" };
    if (await coaching.programHasBookingHistory(manager, program.id)) return { ok: false, reason: "has-bookings" };
    await coaching.deleteUnusedProgram(manager, program.id);
    return { ok: true, id: program.id };
  });
}

export async function deleteCoachProfile(input: unknown, supabase?: Client): Promise<CoachingMutationResult> {
  const actor = await requireActiveAdmin(supabase ?? await createClient());
  const parsed = z.strictObject({ user_id: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input", fieldErrors: coachingFieldErrors(parsed.error.issues) };
  return mutate("admin.coach_profile_removed", actor.userId, async (manager) => {
    // Exclusive configuration fencing prevents new lessons and configuration writes
    // while we inspect references and remove the complete roster configuration.
    await clubs.lockConfigurationForWrite(manager);
    const profile = await coaching.lockCoachProfile(manager, parsed.data.user_id, "pessimistic_write");
    await requireAdminFence(manager, actor.userId);
    if (!profile) return { ok: false, reason: "not-found" };
    const now = new Date();
    if (await coachHasActiveLessons(manager, profile.userId, now)) return { ok: false, reason: "active-lessons" };
    const hasHistory = await coaching.coachHasBookingHistory(manager, profile.userId);
    await coaching.removeCoachConfiguration(manager, profile.userId, hasHistory, now);
    return { ok: true, id: profile.userId, archived: hasHistory };
  });
}

// Pending lesson checkouts and lessons that have not ended still need an operational
// coach. Callers hold locks that keep new lessons for this coach out until commit.
export async function coachHasActiveLessons(manager: EntityManager, coachUserId: string, now = new Date()) {
  return (await coaching.listCoachLiveLessons(manager, coachUserId)).some((row) => row.status === "held"
    || Date.parse(localStartInstant(row.timezone, row.date, row.endMinute)) > now.getTime());
}
