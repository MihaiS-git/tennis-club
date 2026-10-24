import "server-only";

import type { EntityManager } from "typeorm";

import { normalizeDatabaseError } from "@/lib/db/errors";
import { lockReservationActorFacts } from "@/lib/db/repositories/accounts.repository";
import { listCoachAvailabilityLocations } from "@/lib/db/repositories/coach-availability.repository";
import * as clubs from "@/lib/db/repositories/clubs.repository";
import * as coaching from "@/lib/db/repositories/coaching.repository";
import { inReadSnapshot, inTransaction, readIndependently } from "@/lib/db/transaction";
import { logger } from "@/lib/logger";
import type { LocationCurrency } from "@/lib/pricing/money";
import { createClient } from "@/lib/supabase/server";
import { adminCoachingCurrencies, coachIneligibility, type AdminCoachingCurrency } from "./admin";
import { requireActiveCoach } from "./authorization";
import { resolveCoachingPrice, type ResolvedCoachingPrice } from "./pricing";
import {
  coachingFieldErrors, coachingPriceMutationSchema, coachingPriceRemovalSchema, isOnlineCoachingProgramType, type CoachingMutationResult,
} from "./validation";

type Client = Awaited<ReturnType<typeof createClient>>;

// One assigned program duration in one pricing currency, for the signed-in coach.
export type CoachPricingRow = {
  program_id: string; program_name: string; program_active: boolean; duration_minutes: number; currency: LocationCurrency;
  club_amount_minor: number | null; coach_amount_minor: number | null; effective: ResolvedCoachingPrice | null;
};
// Assigned Group/Junior programs are listed by name only: their rates belong to the club.
export type CoachPricingView = { currencies: AdminCoachingCurrency[]; rows: CoachPricingRow[]; clubPricedPrograms: { id: string; name: string }[] };

// Pricing currencies are those of the coach's active assigned locations; locations sharing
// a currency share its prices. A currency still holding this coach's own override stays
// listed (without locations) so the override can be removed.
async function readOwnPricing(manager: EntityManager, coachUserId: string): Promise<CoachPricingView | null> {
  const profile = await coaching.findCoachProfile(manager, coachUserId);
  if (!profile) return null;
  const [assignedIds, locations, allPrograms] = await readIndependently(manager, [
    () => coaching.listCoachProgramIds(manager, profile.userId), () => listCoachAvailabilityLocations(manager, profile.locationIds),
    () => coaching.listCoachingPrograms(manager),
  ]);
  // Only Private/Semi-private programs have coach overrides; obsolete Group/Junior overrides are not shown.
  const assigned = allPrograms.filter((program) => assignedIds.includes(program.id));
  const programs = assigned.filter((program) => isOnlineCoachingProgramType(program.programType));
  const programIds = programs.map((program) => program.id);
  const prices = programIds.length ? (await coaching.listCoachingPrices(manager, { programIds }))
    .filter((price) => price.coachUserId === null || price.coachUserId === profile.userId) : [];
  const currencies = adminCoachingCurrencies(locations.filter((location) => location.isActive && location.archivedAt === null),
    prices.filter((price) => price.coachUserId !== null));
  const amount = (price: { amountMinor: number } | undefined) => price?.amountMinor ?? null;
  const rows = programs.flatMap((program) => program.durations.flatMap((duration) =>
    currencies.map(({ currency }): CoachPricingRow => {
      const matching = prices.filter((price) => price.programId === program.id && price.durationMinutes === duration && price.currency === currency);
      return {
        program_id: program.id, program_name: program.name, program_active: program.isActive, duration_minutes: duration, currency,
        club_amount_minor: amount(matching.find((price) => price.coachUserId === null)),
        coach_amount_minor: amount(matching.find((price) => price.coachUserId !== null)),
        effective: resolveCoachingPrice(matching, { programId: program.id, durationMinutes: duration, currency, coachUserId: profile.userId }),
      };
    })));
  const clubPricedPrograms = assigned.filter((program) => !isOnlineCoachingProgramType(program.programType))
    .map((program) => ({ id: program.id, name: program.name }));
  return { currencies, rows, clubPricedPrograms };
}

// The signed-in coach's prices; null until an Admin creates their coaching profile.
export async function loadOwnCoachPricing(supabase?: Client): Promise<CoachPricingView | null> {
  const account = await requireActiveCoach(supabase ?? await createClient());
  try {
    return await inReadSnapshot((manager) => readOwnPricing(manager, account.userId));
  } catch (error) {
    const failure = normalizeDatabaseError(error);
    logger.error({ event: "coach.coaching_prices_load_failed", actorId: account.userId, kind: failure.kind, code: failure.sqlState }, "Failed to load coaching prices");
    throw new Error("Unable to load coaching prices.");
  }
}

// The signed-in coach's own override for a program duration in one currency. The
// coach comes from the verified session; the input cannot name another coach.
async function mutateOwnPrice(input: unknown, remove: boolean, supabase?: Client): Promise<CoachingMutationResult> {
  const account = await requireActiveCoach(supabase ?? await createClient());
  const parsed = remove ? coachingPriceRemovalSchema.safeParse(input) : coachingPriceMutationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input", fieldErrors: coachingFieldErrors(parsed.error.issues) };
  const amount: number | null = "amount" in parsed.data && typeof parsed.data.amount === "number" ? parsed.data.amount : null;
  const key: coaching.CoachingPriceKey = {
    programId: parsed.data.program_id.toLowerCase(), durationMinutes: parsed.data.duration_minutes,
    currency: parsed.data.currency, coachUserId: account.userId.toLowerCase(),
  };
  const event = remove ? "coach.coaching_price_removed" : "coach.coaching_price_saved";
  let result: CoachingMutationResult;
  try {
    result = await inTransaction((manager) => applyOwnPrice(manager, key, amount, remove));
  } catch (error) {
    const failure = normalizeDatabaseError(error);
    // coaching_prices_coach_program_fkey: the program assignment was removed concurrently.
    if (failure.sqlState === "23503") return { ok: false, reason: "not-offered" };
    logger.error({ event: `${event}_failed`, actorId: account.userId, kind: failure.kind, code: failure.sqlState }, "Failed to save coaching price");
    throw new Error("Unable to save coaching price.");
  }
  if (result.ok) logger.info({ event, actorId: account.userId, id: result.id }, "Coaching price saved");
  return result;
}

// Configuration fence → coach profile → coach account → program, all shared: the
// order of Admin coach saves, which take the profile FOR UPDATE before programs.
async function applyOwnPrice(manager: EntityManager, key: coaching.CoachingPriceKey, amount: number | null, remove: boolean): Promise<CoachingMutationResult> {
  const coachUserId = key.coachUserId;
  if (!coachUserId) throw new Error("Coach price owner missing");
  await clubs.lockConfigurationForRead(manager);
  const profile = await coaching.lockCoachProfile(manager, coachUserId, "pessimistic_read");
  if (!profile || coachIneligibility(await lockReservationActorFacts(manager, coachUserId))) return { ok: false, reason: "not-eligible" };
  if (remove) {
    const removed = await coaching.deleteCoachingPrice(manager, key);
    return removed ? { ok: true, id: removed } : { ok: false, reason: "not-found" };
  }
  const program = await coaching.lockCoachingProgram(manager, key.programId, "pessimistic_read");
  if (!program || !program.durations.includes(key.durationMinutes)) return { ok: false, reason: "invalid-program" };
  if (!profile.programIds.includes(program.id)) return { ok: false, reason: "not-offered" };
  // Group/Junior rates are club-only; the hidden UI control is not the only guard.
  if (!isOnlineCoachingProgramType(program.programType)) return { ok: false, reason: "club-priced" };
  if (amount === null) throw new Error("Price amount missing");
  return { ok: true, id: await coaching.upsertCoachingPrice(manager, key, amount, new Date()) };
}

export async function saveOwnCoachingPrice(input: unknown, supabase?: Client) {
  return mutateOwnPrice(input, false, supabase);
}

export async function removeOwnCoachingPrice(input: unknown, supabase?: Client) {
  return mutateOwnPrice(input, true, supabase);
}
