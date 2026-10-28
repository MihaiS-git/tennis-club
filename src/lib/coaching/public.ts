import "server-only";

import { z } from "zod";

import { locationCurrencies } from "@/lib/admin/locations-validation";
import type { PublicLocation } from "@/lib/courts/public";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { readPublicCoachingFacts, type PublicCoachingFacts } from "@/lib/db/repositories/coaching.repository";
import { logger } from "@/lib/logger";
import type { LocationCurrency } from "@/lib/pricing/money";
import {
  lowestPricesByCurrency, resolveCoachingPrice, type CoachingFromPrice, type CoachingPriceRecord, type ResolvedCoachingPrice,
} from "./pricing";
import {
  coachingParticipantCounts, coachingParticipantRange, coachingProgramTypes, isOnlineCoachingProgramType, isCoachingDuration, type CoachingProgramType,
} from "./validation";

// Club-wide lesson prices/person: one per program duration, participant count and currency, never per location.
type PublicCoachingPrice = { durationMinutes: number; participantCount: number; amountMinor: number; currency: LocationCurrency };
export type PublicCoachingProgram = {
  id: string; name: string; description: string; type: CoachingProgramType; durations: number[];
  minParticipants: number | null; maxParticipants: number | null; courtRentalIncluded: boolean;
  // Club lesson prices/person for the current range and durations, in the currencies of publicly
  // visible locations. Group/Junior prices are informational; those sessions are not booked online.
  prices: PublicCoachingPrice[];
  // The lowest currently applicable lesson price/person per currency (see fromPrices).
  fromPrices: CoachingFromPrice[];
};
type PublicCoachRate = PublicCoachingPrice & { programId: string; programName: string; courtRentalIncluded: boolean };
export type PublicCoach = {
  id: string; displayName: string; bio: string; qualifications: string; specialties: string[]; languages: string[];
  locations: { id: string; name: string }[];
  programs: { id: string; name: string }[];
  // Only the coach's own rates, in the currencies of their public locations; other lessons use the club rate.
  rates: PublicCoachRate[];
};
export type PublicCoaching = { programs: PublicCoachingProgram[]; coaches: PublicCoach[] };

// The projection supplies only club prices for current durations/counts and public
// location currencies. One is sufficient; coach overrides cannot publish a program.
export function hasPublishedClubPrice(program: Pick<PublicCoachingProgram, "prices">, currency?: LocationCurrency) {
  return program.prices.some((price) => currency === undefined || price.currency === currency);
}

type VisibleLocation = Pick<PublicLocation, "id" | "name" | "currency">;
type FactsProgram = PublicCoachingFacts["programs"][number];

function priceRecords(facts: PublicCoachingFacts): CoachingPriceRecord[] {
  return facts.prices.flatMap((price) => {
    const currency = z.enum(locationCurrencies).safeParse(price.currency);
    return currency.success ? [{
      programId: price.program_id, durationMinutes: price.duration_minutes, participantCount: price.participant_count,
      coachUserId: price.coach_user_id, amountMinor: price.amount_minor, currency: currency.data,
    }] : [];
  });
}

const rangeOf = (program: FactsProgram) =>
  coachingParticipantRange({ minParticipants: program.min_participants, maxParticipants: program.max_participants });

// Every lesson a program currently offers: each canonical duration × each count of its current
// range. A program without a valid range offers none; nothing is inferred for missing counts.
function lessonGrid(program: FactsProgram) {
  const counts = coachingParticipantCounts(rangeOf(program));
  return program.durations.filter(isCoachingDuration).flatMap((durationMinutes) => counts.map((participantCount) => ({ durationMinutes, participantCount })));
}

// A lesson is charged in its location's currency, so prices are shown in those currencies only.
function currenciesOf(locations: readonly Pick<VisibleLocation, "currency">[]) {
  return [...new Set(locations.map((location) => location.currency))].sort();
}

// The advertised "From" lesson price/person per currency, never compared across currencies:
// the lowest configured price/person of any current duration and count. For Private/Semi-private
// programs it is the effective price (coach override ?? club default) of every lesson an eligible
// public coach offers in that currency (coach assigned to the program and teaching at a public
// location charging it); in a currency no eligible coach teaches in, and for Group/Junior
// programs, the published club prices are advertised. Unconfigured lessons are skipped.
function fromPrices(program: PublicCoachingProgram, prices: readonly CoachingPriceRecord[], grid: ReturnType<typeof lessonGrid>,
  offeringCoaches: readonly { id: string; currencies: readonly LocationCurrency[] }[], currencies: readonly LocationCurrency[]) {
  return lowestPricesByCurrency(currencies.flatMap((currency) => {
    const coaches = isOnlineCoachingProgramType(program.type) ? offeringCoaches.filter((coach) => coach.currencies.includes(currency)) : [];
    const scopes = coaches.length ? coaches.map((coach) => coach.id) : [null];
    return scopes.flatMap((coachUserId) => grid.flatMap((lesson) =>
      resolveCoachingPrice(prices, { programId: program.id, ...lesson, currency, coachUserId }) ?? []));
  }));
}

// Pure projection of the public facts onto the publicly visible locations.
export function projectPublicCoaching(facts: PublicCoachingFacts, visibleLocations: readonly VisibleLocation[]): PublicCoaching {
  const locations = new Map(visibleLocations.map((location) => [location.id.toLowerCase(), location]));
  const currencies = currenciesOf(visibleLocations);
  const prices = priceRecords(facts);
  const coachLocations = new Map(facts.coaches.map((coach) => [coach.user_id,
    coach.location_ids.flatMap((id) => locations.get(id) ?? []).sort((a, b) => a.name.localeCompare(b.name))]));
  const programs = facts.programs.flatMap((program) => {
    const type = z.enum(coachingProgramTypes).safeParse(program.program_type);
    if (!type.success) return [];
    const durations = program.durations.filter(isCoachingDuration);
    const grid = lessonGrid(program);
    const projected: PublicCoachingProgram = {
      id: program.id, name: program.name, description: program.description, type: type.data, durations,
      minParticipants: program.min_participants, maxParticipants: program.max_participants, courtRentalIncluded: program.court_rental_included,
      prices: currencies.flatMap((currency) => grid.flatMap((lesson) => {
        const resolved = resolveCoachingPrice(prices, { programId: program.id, ...lesson, currency });
        return resolved ? [{ ...lesson, amountMinor: resolved.amountMinor, currency: resolved.currency }] : [];
      })),
      fromPrices: [],
    };
    if (!hasPublishedClubPrice(projected)) return [];
    const offering = facts.coaches.filter((coach) => coach.program_ids.includes(program.id))
      .map((coach) => ({ id: coach.user_id, currencies: currenciesOf(coachLocations.get(coach.user_id) ?? []) }));
    projected.fromPrices = fromPrices(projected, prices, grid, offering, currencies);
    return [projected];
  });
  const programById = new Map(programs.map((program) => [program.id, program]));
  const factsById = new Map(facts.programs.map((program) => [program.id, program]));
  const coaches = facts.coaches.map((coach) => {
    const ownLocations = coachLocations.get(coach.user_id) ?? [];
    const coachPrograms = coach.program_ids.flatMap((id) => programById.get(id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    return {
      id: coach.user_id, displayName: coach.display_name, bio: coach.bio, qualifications: coach.qualifications,
      specialties: coach.specialties, languages: coach.languages,
      locations: ownLocations.map(({ id, name }) => ({ id, name })),
      programs: coachPrograms.map(({ id, name }) => ({ id, name })),
      rates: coachPrograms.filter((program) => isOnlineCoachingProgramType(program.type)).flatMap((program) => currenciesOf(ownLocations).flatMap((currency) =>
        lessonGrid(factsById.get(program.id)!).flatMap((lesson) => {
          const resolved = resolveCoachingPrice(prices, { programId: program.id, ...lesson, currency, coachUserId: coach.user_id });
          return resolved?.source === "coach" ? [{ programId: program.id, programName: program.name, courtRentalIncluded: program.courtRentalIncluded,
            ...lesson, amountMinor: resolved.amountMinor, currency: resolved.currency }] : [];
        }))),
    };
  });
  return { programs, coaches };
}

export type PublicCoachLesson = {
  programId: string; programName: string; durationMinutes: number; participantCount: number; currency: LocationCurrency;
  // The coach's override, otherwise the club price, otherwise null (not published).
  price: ResolvedCoachingPrice | null;
};
export type PublicCoachProfile = Omit<PublicCoach, "programs" | "rates"> & {
  programs: Omit<PublicCoachingProgram, "prices" | "fromPrices">[];
  // Every program duration and participant count the coach offers, in each currency of their public locations.
  lessons: PublicCoachLesson[];
};

// One public coach: the same eligibility, program and location rules as the
// public coaching page, with every lesson priced by resolveCoachingPrice.
export function projectPublicCoachProfile(facts: PublicCoachingFacts, visibleLocations: readonly VisibleLocation[], coachId: string): PublicCoachProfile | null {
  const coaching = projectPublicCoaching(facts, visibleLocations);
  const coach = coaching.coaches.find((candidate) => candidate.id === coachId.toLowerCase());
  if (!coach) return null;
  const programs = coach.programs.flatMap(({ id }) => coaching.programs.find((program) => program.id === id) ?? [])
    .map((program) => ({
      id: program.id, name: program.name, description: program.description, type: program.type, durations: program.durations,
      minParticipants: program.minParticipants, maxParticipants: program.maxParticipants, courtRentalIncluded: program.courtRentalIncluded,
    }));
  const coachLocationIds = new Set(coach.locations.map((location) => location.id.toLowerCase()));
  const currencies = currenciesOf(visibleLocations.filter((location) => coachLocationIds.has(location.id.toLowerCase())));
  const prices = priceRecords(facts);
  const factsById = new Map(facts.programs.map((program) => [program.id, program]));
  // Group/Junior programs have no coach lesson prices; their club prices are on /coaching.
  const lessons = currencies.flatMap((currency) => programs.filter((program) => isOnlineCoachingProgramType(program.type))
    .flatMap((program) => lessonGrid(factsById.get(program.id)!).map((lesson) => ({
      programId: program.id, programName: program.name, ...lesson, currency,
      price: resolveCoachingPrice(prices, { programId: program.id, ...lesson, currency, coachUserId: coach.id }),
    }))));
  return {
    id: coach.id, displayName: coach.displayName, bio: coach.bio, qualifications: coach.qualifications,
    specialties: coach.specialties, languages: coach.languages, locations: coach.locations, programs, lessons,
  };
}

// Unknown, malformed and non-public coach identifiers all resolve to null.
export async function readPublicCoach(coachId: string, visibleLocations: readonly VisibleLocation[]): Promise<PublicCoachProfile | null> {
  const id = z.uuid().safeParse(coachId);
  if (!id.success) return null;
  try {
    const facts = await readPublicCoachingFacts((await getDataSource()).manager);
    return projectPublicCoachProfile(facts, visibleLocations, id.data);
  } catch (error: unknown) {
    logger.error({ event: "coaching.public_coach_read_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load coach");
    throw new Error("Unable to load coach.");
  }
}

export async function readPublicCoaching(visibleLocations: readonly VisibleLocation[]): Promise<PublicCoaching> {
  return (await readPublicCoachingWithFacts(visibleLocations)).coaching;
}

// The projection together with the facts it was built from, so one page render can
// reuse them for advisory lesson availability. Server-only; facts never reach the browser.
export async function readPublicCoachingWithFacts(visibleLocations: readonly VisibleLocation[]): Promise<{ coaching: PublicCoaching; facts: PublicCoachingFacts }> {
  try {
    const facts = await readPublicCoachingFacts((await getDataSource()).manager);
    return { coaching: projectPublicCoaching(facts, visibleLocations), facts };
  } catch (error: unknown) {
    logger.error({ event: "coaching.public_read_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load coaching");
    throw new Error("Unable to load coaching.");
  }
}
