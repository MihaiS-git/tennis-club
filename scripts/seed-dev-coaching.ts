// Development coaching fixtures only. Never imported by application code and never
// run by deployment: execute explicitly with `npm run db:dev:seed:coaching`.
// Seed-owned records are the fixed-ID programs below and the demo coach accounts;
// existing records are reused and never updated, so Admin edits survive reruns.
import { pathToFileURL } from "node:url";
import type { EntityManager } from "typeorm";
import { coachingProgramFieldsSchema, coachProfileFieldsSchema, type CoachingProgramType } from "../src/lib/coaching/validation.ts";
import { getDataSource } from "../src/lib/db/data-source.ts";
import { CoachingPriceEntity } from "../src/lib/db/entities/coaching-price.entity.ts";
import { CoachingProgramEntity } from "../src/lib/db/entities/coaching-program.entity.ts";
import { UserEntity } from "../src/lib/db/entities/user.entity.ts";
import { UserRoleEntity } from "../src/lib/db/entities/user-role.entity.ts";
import { lockReservationActorFacts } from "../src/lib/db/repositories/accounts.repository.ts";
import * as clubs from "../src/lib/db/repositories/clubs.repository.ts";
import * as coaching from "../src/lib/db/repositories/coaching.repository.ts";
import { assertLocalDatabase, ensureLocalAuthAccounts, localAuthClient } from "./local-dev.ts";

export const DEMO_COACH_PASSWORD = "StrongPassword123!";

// Amounts are in RON minor units and are only written for RON locations; the
// stored currency always comes from the location itself.
const SEED_CURRENCY = "RON";

type ProgramFixture = {
  id: string; name: string; description: string; type: CoachingProgramType; durations: number[];
  min: number | null; max: number | null; courtIncluded: boolean;
  // Club price per duration at the first location; other locations use 90%, rounded to 10 RON.
  clubPrices: Record<number, number>;
};

export const demoPrograms: ProgramFixture[] = [
  { id: "c0ac0000-0000-4000-8000-000000000001", name: "Private coaching", type: "private", durations: [60, 90], min: 1, max: 1, courtIncluded: true,
    description: "One-to-one lessons built around your game: technique, tactics and match play at your own pace. The court is included in the lesson price.",
    clubPrices: { 60: 20000, 90: 28000 } },
  { id: "c0ac0000-0000-4000-8000-000000000002", name: "Semi-private coaching", type: "semi_private", durations: [60, 90], min: 2, max: 2, courtIncluded: false,
    description: "Two players of a similar level share the coach and the drills. The price is per lesson for the pair; the court is rented separately.",
    clubPrices: { 60: 26000, 90: 36000 } },
  { id: "c0ac0000-0000-4000-8000-000000000003", name: "Group coaching", type: "group", durations: [90], min: 3, max: 6, courtIncluded: true,
    description: "Small adult groups grouped by level, with structured drills and supervised points. The price is per player per session.",
    clubPrices: { 90: 9000 } },
  { id: "c0ac0000-0000-4000-8000-000000000004", name: "Junior coaching", type: "junior", durations: [45, 60], min: 4, max: 8, courtIncluded: true,
    description: "Sessions for players aged 6 to 16, focused on coordination, footwork and enjoying the game. The price is per child per session.",
    clubPrices: { 45: 6000, 60: 7500 } },
];

type CoachFixture = {
  email: string; displayName: string; bio: string; qualifications: string; specialties: string[]; languages: string[];
  programIds: string[];
  // Indexes into the current club locations, wrapped to the number that exist.
  locations: number[];
  overrides: { programId: string; durationMinutes: number; location: number; amountMinor: number }[];
};

const [privateId, semiPrivateId, groupId, juniorId] = demoPrograms.map((program) => program.id);

export const demoCoaches: CoachFixture[] = [
  { email: "demo-coach-andrei@example.test", displayName: "Andrei Popescu",
    bio: "Andrei played national-level junior and university tennis before turning to coaching fifteen years ago. He works mostly with adult competitors preparing for club leagues and amateur tournaments, building patterns of play that hold up under pressure.\n\nHis lessons are structured but relaxed: a clear plan for the session, plenty of live ball and honest feedback at the end.",
    qualifications: "Romanian Tennis Federation Level 3 coach\nITF Coaching High Performance course",
    specialties: ["Match tactics", "Serve", "Competition preparation"], languages: ["Romanian", "English"],
    programIds: [privateId, semiPrivateId], locations: [0, 1],
    overrides: [
      { programId: privateId, durationMinutes: 60, location: 0, amountMinor: 25000 },
      { programId: privateId, durationMinutes: 90, location: 0, amountMinor: 35000 },
      { programId: privateId, durationMinutes: 60, location: 1, amountMinor: 23000 },
    ] },
  { email: "demo-coach-maria@example.test", displayName: "Maria Ionescu",
    bio: "Maria has run the club’s junior groups for nine seasons. She believes children learn tennis best through games, so her sessions mix coordination work and footwork with plenty of chances to rally and keep score.\n\nShe also leads adult beginner groups for parents who want to join their children on court.",
    qualifications: "Romanian Tennis Federation Level 2 coach\nPlay and Stay / Tennis 10s certified\nFirst aid certificate",
    specialties: ["Junior development", "Beginners", "Footwork"], languages: ["Romanian", "English", "French"],
    programIds: [juniorId, groupId], locations: [0], overrides: [] },
  { email: "demo-coach-daniel@example.test", displayName: "Daniel Stoica",
    bio: "A former club-league captain, Daniel coaches adults who want a more reliable game rather than a new one. He is known for patient technical work on groundstrokes and for groups that leave tired but smiling.",
    qualifications: "Romanian Tennis Federation Level 2 coach\nCertified fitness instructor",
    specialties: ["Groundstrokes", "Fitness", "Adult groups"], languages: ["Romanian", "English"],
    programIds: [privateId, groupId], locations: [1],
    overrides: [{ programId: groupId, durationMinutes: 90, location: 1, amountMinor: 10000 }] },
  { email: "demo-coach-sofia@example.test", displayName: "Sofia Petrescu",
    bio: "Sofia competed on the ITF junior circuit and spent four years playing college tennis in the United States. She coaches juniors moving into competition and adults who enjoy doubles, with a particular eye for net play and positioning.",
    qualifications: "Romanian Tennis Federation Level 3 coach\nPTR Professional",
    specialties: ["Doubles", "Volleys", "Junior competition"], languages: ["Romanian", "English", "Italian"],
    programIds: [privateId, semiPrivateId, juniorId], locations: [0, 1],
    overrides: [{ programId: semiPrivateId, durationMinutes: 60, location: 0, amountMinor: 24000 }] },
];

function clubAmount(program: ProgramFixture, durationMinutes: number, locationIndex: number) {
  const base = program.clubPrices[durationMinutes];
  if (base === undefined) return null;
  return locationIndex === 0 ? base : Math.round(base * 0.9 / 1000) * 1000;
}

const priceKey = (key: coaching.CoachingPriceKey) =>
  [key.programId, key.durationMinutes, key.locationId, key.coachUserId ?? "club"].join("/").toLowerCase();

export type CoachingSeedSummary = {
  locations: { name: string; currency: string; priced: boolean }[];
  programs: { created: number; kept: number };
  coaches: { created: number; kept: number };
  prices: { clubCreated: number; overridesCreated: number; kept: number; skipped: number };
};

// Seeds coaching data in the caller's transaction. Locations default to every
// current (non-archived) club location; no location is ever created.
export async function seedCoachingData(manager: EntityManager, options: { locationIds?: readonly string[] } = {}): Promise<CoachingSeedSummary> {
  // Same order as Admin coaching writes: configuration fence → locations → programs → coach facts → profiles.
  await clubs.lockConfigurationForRead(manager);
  const candidates = options.locationIds ?? (await clubs.listAdminLocations(manager, "current")).map((location) => location.id);
  const locked = await clubs.lockLocationsForRead(manager, candidates);
  const locations = candidates.flatMap((id) => locked.find((location) => location.id === id.toLowerCase() && location.archivedAt === null) ?? []);
  if (!locations.length) throw new Error("No current club locations exist. Create a location in Admin before seeding coaching.");
  const locationAt = (index: number) => locations[index % locations.length];

  const programs = { created: 0, kept: 0 };
  const durations = new Map<string, number[]>();
  for (const fixture of demoPrograms) {
    const fields = coachingProgramFieldsSchema.parse({
      name: fixture.name, description: fixture.description, program_type: fixture.type, durations: fixture.durations,
      min_participants: fixture.min, max_participants: fixture.max, court_rental_included: fixture.courtIncluded, is_active: true,
    });
    const inserted = await manager.createQueryBuilder().insert().into(CoachingProgramEntity).values({
      id: fixture.id, name: fields.name, description: fields.description, programType: fields.program_type,
      minParticipants: fields.min_participants, maxParticipants: fields.max_participants,
      courtRentalIncluded: fields.court_rental_included, isActive: fields.is_active, updatedAt: new Date(),
    }).orIgnore().returning("id").execute();
    if ((inserted.raw as unknown[]).length) {
      await coaching.addCoachingProgramDurations(manager, fixture.id, fields.durations);
      programs.created += 1;
    } else programs.kept += 1;
    // Existing programs keep their Admin-edited durations; prices follow them.
    const program = await coaching.lockCoachingProgram(manager, fixture.id, "pessimistic_read");
    if (!program) throw new Error(`Seed program ${fixture.name} is missing.`);
    durations.set(fixture.id, program.durations);
  }

  const coaches = { created: 0, kept: 0 };
  const assignments = new Map<string, { userId: string; locationIds: string[]; programIds: string[] }>();
  for (const fixture of demoCoaches) {
    const account = await manager.findOneBy(UserEntity, { email: fixture.email });
    if (!account) throw new Error(`Expected a provisioned account for ${fixture.email}.`);
    // Repair an interrupted role assignment on a seed-owned account, as the user seed does.
    await manager.createQueryBuilder().insert().into(UserRoleEntity)
      .values({ userId: account.id, roleCode: "coach", assignedAt: new Date(), assignedBy: null }).orIgnore().execute();
    const facts = await lockReservationActorFacts(manager, account.id);
    if (facts?.status !== "active" || !facts.roles.includes("coach")) {
      throw new Error(`${fixture.email} is not an active coach account; inspect it in Admin → Users.`);
    }
    const locationIds = [...new Set(fixture.locations.map((index) => locationAt(index).id))];
    const fields = coachProfileFieldsSchema.parse({
      display_name: fixture.displayName, bio: fixture.bio, qualifications: fixture.qualifications,
      specialties: fixture.specialties, languages: fixture.languages,
      location_ids: locationIds, program_ids: fixture.programIds, is_public: true,
    });
    let profile = await coaching.lockCoachProfile(manager, account.id, "pessimistic_read");
    if (profile) coaches.kept += 1;
    else {
      await coaching.insertCoachProfile(manager, account.id, {
        displayName: fields.display_name, bio: fields.bio, qualifications: fields.qualifications,
        specialties: fields.specialties, languages: fields.languages, isPublic: fields.is_public,
      }, new Date());
      await coaching.changeCoachLocations(manager, account.id, fields.location_ids, []);
      await coaching.changeCoachPrograms(manager, account.id, fields.program_ids, []);
      profile = await coaching.lockCoachProfile(manager, account.id, "pessimistic_read");
      if (!profile) throw new Error(`Seed coach ${fixture.displayName} is missing.`);
      coaches.created += 1;
    }
    assignments.set(fixture.email, { userId: profile.userId, locationIds: profile.locationIds, programIds: profile.programIds });
  }

  const prices = { clubCreated: 0, overridesCreated: 0, kept: 0, skipped: 0 };
  const existing = new Set((await coaching.listCoachingPrices(manager)).map((price) => priceKey(price)));
  const insertPrice = async (key: coaching.CoachingPriceKey, amountMinor: number, currency: CoachingPriceEntity["currency"]) => {
    if (existing.has(priceKey(key))) return false;
    const result = await manager.createQueryBuilder().insert().into(CoachingPriceEntity)
      .values({ ...key, amountMinor, currency, updatedAt: new Date() }).orIgnore().returning("id").execute();
    existing.add(priceKey(key));
    return (result.raw as unknown[]).length > 0;
  };
  for (const [index, location] of locations.entries()) {
    for (const program of demoPrograms) {
      for (const durationMinutes of program.durations) {
        const amount = clubAmount(program, durationMinutes, index);
        if (amount === null) continue;
        if (location.currency !== SEED_CURRENCY || !durations.get(program.id)?.includes(durationMinutes)) { prices.skipped += 1; continue; }
        if (await insertPrice({ programId: program.id, durationMinutes, locationId: location.id, coachUserId: null }, amount, location.currency)) prices.clubCreated += 1;
        else prices.kept += 1;
      }
    }
  }
  for (const fixture of demoCoaches) {
    const assigned = assignments.get(fixture.email);
    if (!assigned) continue;
    const seen = new Set<string>();
    for (const override of fixture.overrides) {
      const location = locationAt(override.location);
      const key = { programId: override.programId, durationMinutes: override.durationMinutes, locationId: location.id, coachUserId: assigned.userId };
      // Wrapped location indexes can repeat when fewer locations exist; keep the first.
      if (seen.has(priceKey(key))) continue;
      seen.add(priceKey(key));
      // Overrides need the coach to still offer the program at the location (composite FKs).
      if (location.currency !== SEED_CURRENCY || !durations.get(override.programId)?.includes(override.durationMinutes)
        || !assigned.locationIds.includes(location.id) || !assigned.programIds.includes(override.programId)) { prices.skipped += 1; continue; }
      if (await insertPrice(key, override.amountMinor, location.currency)) prices.overridesCreated += 1;
      else prices.kept += 1;
    }
  }

  return {
    locations: locations.map((location) => ({ name: location.name, currency: location.currency, priced: location.currency === SEED_CURRENCY })),
    programs, coaches, prices,
  };
}

export async function seedDevCoaching() {
  // Refuse anything but the local development stack before any Auth or database access.
  assertLocalDatabase();
  const service = localAuthClient();
  // Auth provisioning runs before, never inside, the database transaction.
  const accounts = await ensureLocalAuthAccounts(service, demoCoaches.map((coach) => coach.email), DEMO_COACH_PASSWORD);
  const database = await getDataSource();
  try {
    const summary = await database.transaction("READ COMMITTED", (manager) => seedCoachingData(manager));
    console.log(JSON.stringify({ accounts, ...summary }, null, 2));
  } finally {
    await database.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDevCoaching().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Development coaching seeding failed.");
    process.exitCode = 1;
  });
}
