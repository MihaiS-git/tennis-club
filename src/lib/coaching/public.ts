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
import { coachingProgramTypes, type CoachingProgramType } from "./validation";

type PublicCoachingPrice = {
  locationId: string; locationName: string; durationMinutes: number; amountMinor: number; currency: LocationCurrency;
};
export type PublicCoachingProgram = {
  id: string; name: string; description: string; type: CoachingProgramType; durations: number[];
  minParticipants: number | null; maxParticipants: number | null; courtRentalIncluded: boolean;
  // Club rates at publicly visible locations, in each location's current currency.
  prices: PublicCoachingPrice[];
};
type PublicCoachRate = PublicCoachingPrice & { programId: string; programName: string; courtRentalIncluded: boolean };
export type PublicCoach = {
  id: string; displayName: string; bio: string; qualifications: string; specialties: string[]; languages: string[];
  locations: { id: string; name: string }[];
  programs: { id: string; name: string }[];
  // Only rates the Admin set for this coach; other lessons use the club rate.
  rates: PublicCoachRate[];
};
export type PublicCoaching = { programs: PublicCoachingProgram[]; coaches: PublicCoach[] };

type VisibleLocation = Pick<PublicLocation, "id" | "name" | "currency">;

function priceRecords(facts: PublicCoachingFacts): CoachingPriceRecord[] {
  return facts.prices.flatMap((price) => {
    const currency = z.enum(locationCurrencies).safeParse(price.currency);
    return currency.success ? [{
      programId: price.program_id, durationMinutes: price.duration_minutes, locationId: price.location_id,
      coachUserId: price.coach_user_id, amountMinor: price.amount_minor, currency: currency.data,
    }] : [];
  });
}

// Pure projection of the public facts onto the publicly visible locations.
export function projectPublicCoaching(facts: PublicCoachingFacts, visibleLocations: readonly VisibleLocation[]): PublicCoaching {
  const locations = new Map(visibleLocations.map((location) => [location.id.toLowerCase(), location]));
  const prices = priceRecords(facts);
  const programs = facts.programs.flatMap((program) => {
    const type = z.enum(coachingProgramTypes).safeParse(program.program_type);
    if (!type.success) return [];
    return [{
      id: program.id, name: program.name, description: program.description, type: type.data, durations: program.durations,
      minParticipants: program.min_participants, maxParticipants: program.max_participants, courtRentalIncluded: program.court_rental_included,
      prices: [...locations.values()].flatMap((location) => program.durations.flatMap((durationMinutes) => {
        const resolved = resolveCoachingPrice(prices, { programId: program.id, durationMinutes, locationId: location.id, locationCurrency: location.currency });
        return resolved ? [{ locationId: location.id, locationName: location.name, durationMinutes, amountMinor: resolved.amountMinor, currency: resolved.currency }] : [];
      })),
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
      rates: coachPrograms.flatMap((program) => coachLocations.flatMap((location) => program.durations.flatMap((durationMinutes) => {
        const resolved = resolveCoachingPrice(prices, { programId: program.id, durationMinutes, locationId: location.id,
          locationCurrency: location.currency, coachUserId: coach.user_id });
        return resolved?.source === "coach" ? [{ programId: program.id, programName: program.name, courtRentalIncluded: program.courtRentalIncluded,
          locationId: location.id, locationName: location.name, durationMinutes, amountMinor: resolved.amountMinor, currency: resolved.currency }] : [];
      }))),
    };
  });
  return { programs, coaches };
}

export type PublicCoachLesson = {
  locationId: string; locationName: string; programId: string; programName: string; durationMinutes: number;
  // The coach's override, otherwise the club price, otherwise null (not published).
  price: ResolvedCoachingPrice | null;
};
export type PublicCoachProfile = Omit<PublicCoach, "programs" | "rates"> & {
  programs: Omit<PublicCoachingProgram, "prices">[];
  // Every program duration the coach offers at each of their public locations.
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
  const currencies = new Map(visibleLocations.map((location) => [location.id.toLowerCase(), location.currency]));
  const prices = priceRecords(facts);
  const lessons = coach.locations.flatMap((location) => {
    const locationCurrency = currencies.get(location.id.toLowerCase());
    if (!locationCurrency) return [];
    return programs.flatMap((program) => program.durations.map((durationMinutes) => ({
      locationId: location.id, locationName: location.name, programId: program.id, programName: program.name, durationMinutes,
      price: resolveCoachingPrice(prices, { programId: program.id, durationMinutes, locationId: location.id, locationCurrency, coachUserId: coach.id }),
    })));
  });
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
