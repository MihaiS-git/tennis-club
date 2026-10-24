import "server-only";

import { requireActiveAdmin } from "@/lib/admin/authorization";
import { listCoachingPrices, listCoachingPrograms } from "@/lib/db/repositories/coaching.repository";
import { listAdminLocations } from "@/lib/db/repositories/clubs.repository";
import { inReadSnapshot, readIndependently } from "@/lib/db/transaction";
import { listCoachesPage, listPriceGroupsPage, listProgramsPage } from "@/lib/db/repositories/coaching-lists.repository";
import {
  adminCoachingCurrencies, adminCoachingPrice, adminParticipantPrice, readAdminCoaching, type AdminCoach, type AdminCoachingLocation, type AdminCoachingProgram,
} from "./admin";
import { coachFiltersSchema, priceFiltersSchema, programFiltersSchema } from "./admin-filters";
import { participantRateProgramTypes } from "./validation";

export async function loadProgramsPage(input: unknown, supabase?: Parameters<typeof requireActiveAdmin>[0]) {
  await requireActiveAdmin(supabase);
  const filters = programFiltersSchema.parse(input);
  // The Program dialog edits club prices in every pricing currency; coach prices are
  // included only so removing a duration can state what it deletes.
  const { result, locations, prices } = await inReadSnapshot(async manager => {
    const result = await listProgramsPage(manager, filters);
    const [locations, prices] = await readIndependently(manager, [
      () => listAdminLocations(manager, "current"),
      () => result.programs.length ? listCoachingPrices(manager, { programIds: result.programs.map(program => program.id) }) : Promise.resolve([]),
    ]);
    return { result, locations, prices };
  });
  const programs: AdminCoachingProgram[] = result.programs.map(program => ({
    id: program.id, name: program.name, description: program.description, program_type: program.programType,
    durations: program.durations, min_participants: program.minParticipants, max_participants: program.maxParticipants,
    court_rental_included: program.courtRentalIncluded, is_active: program.isActive,
  }));
  const adminLocations = locations.map((location): AdminCoachingLocation => ({ id: location.id, name: location.name, currency: location.currency, is_active: location.isActive }));
  const adminPrices = prices.map(adminCoachingPrice);
  return { ...result, programs, filters, prices: adminPrices, currencies: adminCoachingCurrencies(adminLocations, adminPrices) };
}

export async function loadPricesPage(input: unknown, supabase?: Parameters<typeof requireActiveAdmin>[0]) {
  await requireActiveAdmin(supabase);
  const filters = priceFiltersSchema.parse(input);
  return inReadSnapshot(async manager => {
    const data = await readAdminCoaching(manager, false);
    const result = await listPriceGroupsPage(manager, filters, participantRateProgramTypes);
    const prices = result.prices.map(adminCoachingPrice);
    const participantPrices = result.participantPrices.map(adminParticipantPrice);
    return { ...data, ...result, filters, prices, participantPrices,
      currencies: adminCoachingCurrencies(data.locations, [...prices, ...participantPrices]) };
  });
}

export type AdminCoachListItem = {
  user_id: string; name: string; email: string; account_status: "active" | "suspended";
  profile_status: "configured" | "not-configured" | "archived";
  profile: AdminCoach | null;
};

export async function loadCoachesPage(input: unknown, supabase?: Parameters<typeof requireActiveAdmin>[0]) {
  await requireActiveAdmin(supabase);
  const filters = coachFiltersSchema.parse(input);
  return inReadSnapshot(async manager => {
    const result = await listCoachesPage(manager, filters);
    const [programs, locations] = await readIndependently(manager, [
      () => listCoachingPrograms(manager), () => listAdminLocations(manager, "current"),
    ]);
    const coaches: AdminCoachListItem[] = result.coaches.map(row => ({
      user_id: row.user_id, name: row.name, email: row.email, account_status: row.account_status, profile_status: row.profile_status,
      profile: row.profile_status === "not-configured" ? null : {
        user_id: row.user_id, email: row.email, display_name: row.display_name ?? "", bio: row.bio ?? "",
        qualifications: row.qualifications ?? "", specialties: row.specialties ?? [], languages: row.languages ?? [],
        is_public: row.is_public ?? false, location_ids: row.location_ids, program_ids: row.program_ids,
        ineligibility: row.account_status === "suspended" ? "suspended" : null,
      },
    }));
    return { ...result, coaches, filters,
      programs: programs.map(program => ({ id: program.id, name: program.name, description: program.description,
        program_type: program.programType, durations: program.durations, min_participants: program.minParticipants,
        max_participants: program.maxParticipants, court_rental_included: program.courtRentalIncluded, is_active: program.isActive })),
      locations: locations.map(location => ({ id: location.id, name: location.name, currency: location.currency, is_active: location.isActive })),
    };
  });
}
