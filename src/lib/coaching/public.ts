import "server-only";

import { z } from "zod";

import { locationCurrencies } from "@/lib/admin/locations-validation";
import type { PublicLocation } from "@/lib/courts/public";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { readPublicCoachingFacts, type PublicCoachingFacts } from "@/lib/db/repositories/coaching.repository";
import { logger } from "@/lib/logger";
import type { LocationCurrency } from "@/lib/pricing/money";
import { resolveCoachingPrice, type CoachingPriceRecord, type ResolvedCoachingPrice } from "./pricing";
import {
  coachingParticipantRange, coachingProgramTypes, hasParticipantRates, isCoachingDuration, isPermittedParticipantCount, type CoachingProgramType,
} from "./validation";

// Club-wide prices: one per program duration and currency, never per location.
type PublicCoachingPrice = { durationMinutes: number; amountMinor: number; currency: LocationCurrency };
// A Group/Junior club rate per person per 60 minutes; informational, never a checkout price.
type PublicParticipantPrice = { participantCount: number; amountMinor: number; currency: LocationCurrency };
export type PublicCoachingProgram = {
  id: string; name: string; description: string; type: CoachingProgramType; durations: number[];
  minParticipants: number | null; maxParticipants: number | null; courtRentalIncluded: boolean;
  // Private/Semi-private club session rates in the currencies of publicly visible locations.
  prices: PublicCoachingPrice[];
  // Group/Junior club rates within the current participant range, in the same currencies.
  participantPrices: PublicParticipantPrice[];
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

type VisibleLocation = Pick<PublicLocation, "id" | "name" | "currency">;

function priceRecords(facts: PublicCoachingFacts): CoachingPriceRecord[] {
  return facts.prices.flatMap((price) => {
    const currency = z.enum(locationCurrencies).safeParse(price.currency);
    return currency.success ? [{
      programId: price.program_id, durationMinutes: price.duration_minutes,
      coachUserId: price.coach_user_id, amountMinor: price.amount_minor, currency: currency.data,
    }] : [];
  });
}

// Club rates only, for counts inside the program's current range; stored rates outside it
// are configuration history, not current rates. Nothing is filled in for missing counts.
function participantPrices(facts: PublicCoachingFacts, program: PublicCoachingFacts["programs"][number], currencies: readonly LocationCurrency[]) {
  const range = coachingParticipantRange({ minParticipants: program.min_participants, maxParticipants: program.max_participants });
  if (!range) return [];
  return facts.participant_prices.flatMap((price) => {
    const currency = z.enum(locationCurrencies).safeParse(price.currency);
    return price.program_id === program.id && currency.success && currencies.includes(currency.data)
      && isPermittedParticipantCount(range, price.participant_count)
      ? [{ participantCount: price.participant_count, amountMinor: price.amount_minor, currency: currency.data }] : [];
  }).sort((a, b) => a.currency.localeCompare(b.currency) || a.participantCount - b.participantCount);
}

// A lesson is charged in its location's currency, so prices are shown in those currencies only.
function currenciesOf(locations: readonly Pick<VisibleLocation, "currency">[]) {
  return [...new Set(locations.map((location) => location.currency))].sort();
}

// Pure projection of the public facts onto the publicly visible locations.
export function projectPublicCoaching(facts: PublicCoachingFacts, visibleLocations: readonly VisibleLocation[]): PublicCoaching {
  const locations = new Map(visibleLocations.map((location) => [location.id.toLowerCase(), location]));
  const currencies = currenciesOf(visibleLocations);
  const prices = priceRecords(facts);
  const programs = facts.programs.flatMap((program) => {
    const type = z.enum(coachingProgramTypes).safeParse(program.program_type);
    if (!type.success) return [];
    const durations = program.durations.filter(isCoachingDuration);
    // Group/Junior programs publish only club rates per player count; duration prices and
    // any obsolete coach overrides stored for them are never used.
    const participantRated = hasParticipantRates(type.data);
    return [{
      id: program.id, name: program.name, description: program.description, type: type.data, durations,
      minParticipants: program.min_participants, maxParticipants: program.max_participants, courtRentalIncluded: program.court_rental_included,
      prices: participantRated ? [] : currencies.flatMap((currency) => durations.flatMap((durationMinutes) => {
        const resolved = resolveCoachingPrice(prices, { programId: program.id, durationMinutes, currency });
        return resolved ? [{ durationMinutes, amountMinor: resolved.amountMinor, currency: resolved.currency }] : [];
      })),
      participantPrices: participantRated ? participantPrices(facts, program, currencies) : [],
    }];
  });
  const programById = new Map(programs.map((program) => [program.id, program]));
  const coaches = facts.coaches.map((coach) => {
    const coachLocations = coach.location_ids.flatMap((id) => locations.get(id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    const coachPrograms = coach.program_ids.flatMap((id) => programById.get(id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    return {
      id: coach.user_id, displayName: coach.display_name, bio: coach.bio, qualifications: coach.qualifications,
      specialties: coach.specialties, languages: coach.languages,
      locations: coachLocations.map(({ id, name }) => ({ id, name })),
      programs: coachPrograms.map(({ id, name }) => ({ id, name })),
      rates: coachPrograms.filter((program) => !hasParticipantRates(program.type)).flatMap((program) => currenciesOf(coachLocations).flatMap((currency) => program.durations.flatMap((durationMinutes) => {
        const resolved = resolveCoachingPrice(prices, { programId: program.id, durationMinutes, currency, coachUserId: coach.user_id });
        return resolved?.source === "coach" ? [{ programId: program.id, programName: program.name, courtRentalIncluded: program.courtRentalIncluded,
          durationMinutes, amountMinor: resolved.amountMinor, currency: resolved.currency }] : [];
      }))),
    };
  });
  return { programs, coaches };
}

export type PublicCoachLesson = {
  programId: string; programName: string; durationMinutes: number; currency: LocationCurrency;
  // The coach's override, otherwise the club price, otherwise null (not published).
  price: ResolvedCoachingPrice | null;
};
export type PublicCoachProfile = Omit<PublicCoach, "programs" | "rates"> & {
  programs: Omit<PublicCoachingProgram, "prices" | "participantPrices">[];
  // Every program duration the coach offers, in each currency of their public locations.
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
  // Group/Junior programs have no coach lesson prices; their club rates are on /coaching.
  const lessons = currencies.flatMap((currency) => programs.filter((program) => !hasParticipantRates(program.type))
    .flatMap((program) => program.durations.map((durationMinutes) => ({
    programId: program.id, programName: program.name, durationMinutes, currency,
    price: resolveCoachingPrice(prices, { programId: program.id, durationMinutes, currency, coachUserId: coach.id }),
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
  try {
    const facts = await readPublicCoachingFacts((await getDataSource()).manager);
    return projectPublicCoaching(facts, visibleLocations);
  } catch (error: unknown) {
    logger.error({ event: "coaching.public_read_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to load coaching");
    throw new Error("Unable to load coaching.");
  }
}
