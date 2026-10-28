import "server-only";

import { requireActiveAdmin } from "@/lib/admin/authorization";
import { listCoachingPrices, listCoachingPrograms } from "@/lib/db/repositories/coaching.repository";
import { listAdminLocations } from "@/lib/db/repositories/clubs.repository";
import { inReadSnapshot, readIndependently } from "@/lib/db/transaction";
import { listCoachesPage, listProgramsPage } from "@/lib/db/repositories/coaching-lists.repository";
import {
  adminCoachingCurrencies, adminCoachingLocation, adminCoachingPrice, adminCoachingProgram, type AdminCoach,
} from "./admin";
import { coachFiltersSchema, programFiltersSchema } from "./admin-filters";

export async function loadProgramsPage(input: unknown, supabase?: Parameters<typeof requireActiveAdmin>[0]) {
  await requireActiveAdmin(supabase);
  const filters = programFiltersSchema.parse(input);
  // The Program dialog edits club prices in every pricing currency; coach prices are
  // included only so a configuration change can state what it deletes.
  const { result, locations, prices } = await inReadSnapshot(async manager => {
    const result = await listProgramsPage(manager, filters);
    const programIds = result.programs.map(program => program.id);
    const [locations, prices] = await readIndependently(manager, [
      () => listAdminLocations(manager, "current"),
      () => programIds.length ? listCoachingPrices(manager, { programIds }) : Promise.resolve([]),
    ]);
    return { result, locations, prices };
  });
  const programs = result.programs.map(adminCoachingProgram);
  const adminLocations = locations.map(adminCoachingLocation);
  const adminPrices = prices.map(adminCoachingPrice);
  return { ...result, programs, filters, prices: adminPrices, currencies: adminCoachingCurrencies(adminLocations, adminPrices) };
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
    // The Coach dialog shows each listed coach's own price overrides read-only; coaches manage them.
    const coachUserIds = result.coaches.map(coach => coach.user_id);
    const [programs, locations, prices] = await readIndependently(manager, [
      () => listCoachingPrograms(manager), () => listAdminLocations(manager, "current"),
      () => coachUserIds.length ? listCoachingPrices(manager, { coachUserIds }) : Promise.resolve([]),
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
      programs: programs.map(adminCoachingProgram),
      locations: locations.map(adminCoachingLocation),
      prices: prices.map(adminCoachingPrice),
    };
  });
}
