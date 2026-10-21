import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, assert, expect, test, vi } from "vitest";
import { getDataSource } from "../../../src/lib/db/data-source";
import * as coachingRepository from "../../../src/lib/db/repositories/coaching.repository";
import { saveCoachingPrice, saveCoachingProgram, saveCoachProfile } from "../../../src/lib/coaching/admin";
import { resolveCoachingPrice } from "../../../src/lib/coaching/pricing";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

import { loadPricesPage, loadProgramsPage } from "@/lib/coaching/admin-lists";

const service = localFixtureClient();
const password = "program-prices-password-123";
const userIds: string[] = [];
const locationIds: string[] = [randomUUID(), randomUUID(), randomUUID()];
const programIds: string[] = [];
const publicClient = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

async function account(roles: ("admin" | "coach")[] = []) {
  const email = `program-prices-${randomUUID()}@example.test`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.strictEqual(error, null); assert.ok(data.user);
  userIds.push(data.user.id);
  for (const role of roles) assert.strictEqual((await service.from("user_roles").insert({ user_id: data.user.id, role_code: role })).error, null);
  const client = publicClient();
  assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
  return { client, id: data.user.id };
}

afterAll(async () => {
  const database = await getDataSource();
  try {
    await database.query("DELETE FROM public.coaching_prices WHERE program_id = ANY($1::uuid[]) OR location_id = ANY($2::uuid[])", [programIds, locationIds]);
    await database.query("DELETE FROM public.coach_profiles WHERE user_id = ANY($1::uuid[])", [userIds]);
    await database.query("DELETE FROM public.coaching_programs WHERE id = ANY($1::uuid[])", [programIds]);
    await database.query("DELETE FROM public.locations WHERE id = ANY($1::uuid[])", [locationIds]);
    await cleanupAuthFixtures(service, userIds);
  } finally {
    await database.destroy();
  }
});

test("the Program form saves club-default prices with the program atomically, on the same records as Prices", async () => {
  await ensureIntegrationAdminAnchor(service);
  const name = `Program prices ${randomUUID()}`;
  assert.strictEqual((await service.from("locations").insert([
    { id: locationIds[0], name: `${name} Central`, slug: `pp-central-${locationIds[0]}`, timezone: "UTC", currency: "RON" },
    { id: locationIds[1], name: `${name} Riverside`, slug: `pp-riverside-${locationIds[1]}`, timezone: "UTC", currency: "EUR" },
    { id: locationIds[2], name: `${name} Archived`, slug: `pp-archived-${locationIds[2]}`, timezone: "UTC", currency: "RON" },
  ])).error, null);
  assert.strictEqual((await service.from("locations").update({ archived_at: new Date().toISOString(), is_active: false }).eq("id", locationIds[2])).error, null);
  const admin = await account(["admin"]);
  const coach = await account(["coach"]);
  const db = await getDataSource();
  const fields = { name, description: "", program_type: "private", durations: [60, 90], min_participants: 1, max_participants: 1,
    court_rental_included: true, is_active: true };
  const programCount = async () => (await db.query("SELECT count(*)::int AS n FROM public.coaching_programs WHERE name=$1", [name]))[0].n;

  // Only Admins may save programs with prices.
  for (const session of [coach.client, publicClient()]) {
    await expect(saveCoachingProgram({ fields, club_prices: [{ location_id: locationIds[0], duration_minutes: 60, amount: "180" }] }, session)).rejects.toThrow();
  }
  // Invalid amounts, unselected durations, removals on creation and archived locations save nothing.
  expect(await saveCoachingProgram({ fields, club_prices: [{ location_id: locationIds[0], duration_minutes: 60, amount: "0" }] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { "club_prices.0": expect.any(String) } });
  expect(await saveCoachingProgram({ fields, club_prices: [
    { location_id: locationIds[0], duration_minutes: 60, amount: "180" }, { location_id: locationIds[0], duration_minutes: 120, amount: "320" },
  ] }, admin.client)).toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { "club_prices.1": "Select this duration before setting its price." } });
  expect(await saveCoachingProgram({ fields, removed_club_prices: [{ location_id: locationIds[0], duration_minutes: 60 }] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await saveCoachingProgram({ fields, club_prices: [{ location_id: locationIds[2], duration_minutes: 60, amount: "180" }] }, admin.client))
    .toEqual({ ok: false, reason: "invalid-location" });
  expect(await saveCoachingProgram({ fields, club_prices: [{ location_id: randomUUID(), duration_minutes: 60, amount: "180" }] }, admin.client))
    .toEqual({ ok: false, reason: "invalid-location" });
  expect(await programCount()).toBe(0);

  // A failure after the program insert rolls back the program, its durations and earlier prices.
  const upsert = coachingRepository.upsertCoachingPrice;
  const fault = vi.spyOn(coachingRepository, "upsertCoachingPrice").mockImplementation(async (...args) => {
    if (args[1].locationId === locationIds[1]) throw new Error("Injected price failure");
    return upsert(...args);
  });
  await expect(saveCoachingProgram({ fields, club_prices: [
    { location_id: locationIds[0], duration_minutes: 60, amount: "180" }, { location_id: locationIds[1], duration_minutes: 60, amount: "40" },
  ] }, admin.client)).rejects.toThrow("Unable to save coaching");
  fault.mockRestore();
  expect(await programCount()).toBe(0);
  expect((await db.query("SELECT count(*)::int AS n FROM public.coaching_prices WHERE location_id = ANY($1::uuid[])", [locationIds]))[0].n).toBe(0);

  // Creation persists the program, its durations and the submitted club prices in each location's currency.
  const created = await saveCoachingProgram({ fields, club_prices: [
    { location_id: locationIds[0], duration_minutes: 60, amount: "180" }, { location_id: locationIds[0], duration_minutes: 90, amount: "250.50" },
    { location_id: locationIds[1], duration_minutes: 60, amount: "40" },
  ] }, admin.client);
  assert.ok(created.ok); programIds.push(created.id);
  const prices = async () => (await coachingRepository.listCoachingPrices(db.manager, { programId: created.id }))
    .map((price) => ({ location: locationIds.indexOf(price.locationId), duration: price.durationMinutes, coach: price.coachUserId, amount: price.amountMinor, currency: price.currency }));
  expect(await prices()).toEqual(expect.arrayContaining([
    { location: 0, duration: 60, coach: null, amount: 18000, currency: "RON" }, { location: 0, duration: 90, coach: null, amount: 25050, currency: "RON" },
    { location: 1, duration: 60, coach: null, amount: 4000, currency: "EUR" },
  ]));
  expect(await prices()).toHaveLength(3);

  // A coach override set under Prices is preserved by Program saves and still takes precedence.
  expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: { display_name: `${name} coach`, bio: "", qualifications: "", specialties: [],
    languages: [], location_ids: [locationIds[0]], program_ids: [created.id], is_public: false } }, admin.client)).toMatchObject({ ok: true });
  expect(await saveCoachingPrice({ program_id: created.id, duration_minutes: 60, location_id: locationIds[0], coach_user_id: coach.id, amount: "200" }, admin.client))
    .toMatchObject({ ok: true });

  // Editing changes a price, removes one explicitly, adds a duration with a price and leaves the rest unchanged.
  const edited = await saveCoachingProgram({ id: created.id, fields: { ...fields, durations: [60, 90, 120] },
    club_prices: [{ location_id: locationIds[0], duration_minutes: 60, amount: "185" }, { location_id: locationIds[1], duration_minutes: 120, amount: "70" }],
    removed_club_prices: [{ location_id: locationIds[0], duration_minutes: 90 }] }, admin.client);
  expect(edited).toEqual({ ok: true, id: created.id });
  expect(await prices()).toEqual(expect.arrayContaining([
    { location: 0, duration: 60, coach: null, amount: 18500, currency: "RON" }, { location: 0, duration: 60, coach: coach.id, amount: 20000, currency: "RON" },
    { location: 1, duration: 60, coach: null, amount: 4000, currency: "EUR" }, { location: 1, duration: 120, coach: null, amount: 7000, currency: "EUR" },
  ]));
  expect(await prices()).toHaveLength(4);
  const rows = await coachingRepository.listCoachingPrices(db.manager, { programId: created.id });
  const key = { programId: created.id, durationMinutes: 60, locationId: locationIds[0], locationCurrency: "RON" as const };
  expect(resolveCoachingPrice(rows, { ...key, coachUserId: coach.id })).toMatchObject({ amountMinor: 20000, source: "coach" });
  expect(resolveCoachingPrice(rows, { ...key, coachUserId: randomUUID() })).toMatchObject({ amountMinor: 18500, source: "club" });

  // A failed edit leaves program details, durations and prices unchanged.
  const before = await prices();
  const editFault = vi.spyOn(coachingRepository, "upsertCoachingPrice").mockRejectedValueOnce(new Error("Injected price failure"));
  await expect(saveCoachingProgram({ id: created.id, fields: { ...fields, name: `${name} renamed`, durations: [60] },
    club_prices: [{ location_id: locationIds[0], duration_minutes: 60, amount: "1" }] }, admin.client)).rejects.toThrow("Unable to save coaching");
  editFault.mockRestore();
  expect(await prices()).toEqual(before);
  expect((await coachingRepository.listCoachingPrograms(db.manager)).find((program) => program.id === created.id))
    .toMatchObject({ name, durations: [60, 90, 120] });

  // Removing an already removed price is a no-op; removing a duration still deletes its prices (existing rule).
  expect(await saveCoachingProgram({ id: created.id, fields: { ...fields, durations: [60, 90] },
    removed_club_prices: [{ location_id: locationIds[0], duration_minutes: 90 }] }, admin.client)).toEqual({ ok: true, id: created.id });
  expect((await prices()).filter((price) => price.duration === 120)).toEqual([]);

  // Programs and Prices pages read the same coaching_prices records.
  const programsPage = await loadProgramsPage({ search: name }, admin.client);
  expect(programsPage.locations.map((location) => location.id)).toEqual(expect.arrayContaining([locationIds[0], locationIds[1]]));
  expect(programsPage.locations.map((location) => location.id)).not.toContain(locationIds[2]);
  expect(programsPage.prices.filter((price) => price.coach_user_id === null).map((price) => price.amount_minor).sort()).toEqual([18500, 4000].sort());
  const pricesPage = await loadPricesPage({ search: name, location: locationIds[0], duration: "60", scope: "club" }, admin.client);
  expect(pricesPage.total).toBe(1);
  expect(pricesPage.prices.find((price) => price.coach_user_id === null)?.amount_minor).toBe(18500);
}, 60000);
