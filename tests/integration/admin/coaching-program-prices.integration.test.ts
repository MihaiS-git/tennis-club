import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, assert, expect, test, vi } from "vitest";
import { getDataSource } from "../../../src/lib/db/data-source";
import * as coachingRepository from "../../../src/lib/db/repositories/coaching.repository";
import { saveClubCoachingPrice, saveClubParticipantPrices, saveCoachingProgram, saveCoachProfile } from "../../../src/lib/coaching/admin";
import { loadOwnCoachPricing, removeOwnCoachingPrice, saveOwnCoachingPrice } from "../../../src/lib/coaching/coach-pricing";
import { readPublicCoaching } from "../../../src/lib/coaching/public";
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
    await database.query("DELETE FROM public.coaching_prices WHERE program_id = ANY($1::uuid[])", [programIds]);
    await database.query("DELETE FROM public.coaching_participant_prices WHERE program_id = ANY($1::uuid[])", [programIds]);
    await database.query("DELETE FROM public.coach_profiles WHERE user_id = ANY($1::uuid[])", [userIds]);
    await database.query("DELETE FROM public.coaching_programs WHERE id = ANY($1::uuid[])", [programIds]);
    await database.query("DELETE FROM public.locations WHERE id = ANY($1::uuid[])", [locationIds]);
    await cleanupAuthFixtures(service, userIds);
  } finally {
    await database.destroy();
  }
});

test("the Program form saves club-wide default prices with the program atomically, on the same records as Prices", async () => {
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
    await expect(saveCoachingProgram({ fields, club_prices: [{ currency: "RON", duration_minutes: 60, amount: "180" }] }, session)).rejects.toThrow();
  }
  // Invalid amounts, unselected durations, removals on creation, unsupported currencies and location keys save nothing.
  expect(await saveCoachingProgram({ fields, club_prices: [{ currency: "RON", duration_minutes: 60, amount: "0" }] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { "club_prices.0": expect.any(String) } });
  expect(await saveCoachingProgram({ fields, club_prices: [
    { currency: "RON", duration_minutes: 60, amount: "180" }, { currency: "RON", duration_minutes: 120, amount: "320" },
  ] }, admin.client)).toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { "club_prices.1": "Select this duration before setting its price." } });
  expect(await saveCoachingProgram({ fields, removed_club_prices: [{ currency: "RON", duration_minutes: 60 }] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await saveCoachingProgram({ fields, club_prices: [{ currency: "XYZ", duration_minutes: 60, amount: "180" }] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await saveCoachingProgram({ fields, club_prices: [{ location_id: locationIds[0], currency: "RON", duration_minutes: 60, amount: "180" }] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await programCount()).toBe(0);

  // A failure after the program insert rolls back the program, its durations and earlier prices.
  const upsert = coachingRepository.upsertCoachingPrice;
  const fault = vi.spyOn(coachingRepository, "upsertCoachingPrice").mockImplementation(async (...args) => {
    if (args[1].currency === "EUR") throw new Error("Injected price failure");
    return upsert(...args);
  });
  await expect(saveCoachingProgram({ fields, club_prices: [
    { currency: "RON", duration_minutes: 60, amount: "180" }, { currency: "EUR", duration_minutes: 60, amount: "40" },
  ] }, admin.client)).rejects.toThrow("Unable to save coaching");
  fault.mockRestore();
  expect(await programCount()).toBe(0);

  // Creation persists the program, its durations and the submitted club-wide prices per currency.
  const created = await saveCoachingProgram({ fields, club_prices: [
    { currency: "RON", duration_minutes: 60, amount: "180" }, { currency: "RON", duration_minutes: 90, amount: "250.50" },
    { currency: "EUR", duration_minutes: 60, amount: "40" },
  ] }, admin.client);
  assert.ok(created.ok); programIds.push(created.id);
  const prices = async () => (await coachingRepository.listCoachingPrices(db.manager, { programId: created.id }))
    .map((price) => ({ duration: price.durationMinutes, coach: price.coachUserId, amount: price.amountMinor, currency: price.currency }));
  expect(await prices()).toEqual(expect.arrayContaining([
    { duration: 60, coach: null, amount: 18000, currency: "RON" }, { duration: 90, coach: null, amount: 25050, currency: "RON" },
    { duration: 60, coach: null, amount: 4000, currency: "EUR" },
  ]));
  expect(await prices()).toHaveLength(3);

  // A coach's own override is preserved by Program saves and still takes precedence.
  expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: { display_name: `${name} coach`, bio: "", qualifications: "", specialties: [],
    languages: [], location_ids: [locationIds[0]], program_ids: [created.id], is_public: false } }, admin.client)).toMatchObject({ ok: true });
  expect(await saveOwnCoachingPrice({ program_id: created.id, duration_minutes: 60, currency: "RON", amount: "200" }, coach.client))
    .toMatchObject({ ok: true });

  // Editing changes a price, removes one explicitly, adds a duration with a price and leaves the rest unchanged.
  const edited = await saveCoachingProgram({ id: created.id, fields: { ...fields, durations: [60, 90, 120] },
    club_prices: [{ currency: "RON", duration_minutes: 60, amount: "185" }, { currency: "EUR", duration_minutes: 120, amount: "70" }],
    removed_club_prices: [{ currency: "RON", duration_minutes: 90 }] }, admin.client);
  expect(edited).toEqual({ ok: true, id: created.id });
  expect(await prices()).toEqual(expect.arrayContaining([
    { duration: 60, coach: null, amount: 18500, currency: "RON" }, { duration: 60, coach: coach.id, amount: 20000, currency: "RON" },
    { duration: 60, coach: null, amount: 4000, currency: "EUR" }, { duration: 120, coach: null, amount: 7000, currency: "EUR" },
  ]));
  expect(await prices()).toHaveLength(4);
  const rows = await coachingRepository.listCoachingPrices(db.manager, { programId: created.id });
  const key = { programId: created.id, durationMinutes: 60, currency: "RON" as const };
  expect(resolveCoachingPrice(rows, { ...key, coachUserId: coach.id })).toMatchObject({ amountMinor: 20000, source: "coach" });
  expect(resolveCoachingPrice(rows, { ...key, coachUserId: randomUUID() })).toMatchObject({ amountMinor: 18500, source: "club" });

  // A failed edit leaves program details, durations and prices unchanged.
  const before = await prices();
  const editFault = vi.spyOn(coachingRepository, "upsertCoachingPrice").mockRejectedValueOnce(new Error("Injected price failure"));
  await expect(saveCoachingProgram({ id: created.id, fields: { ...fields, name: `${name} renamed`, durations: [60] },
    club_prices: [{ currency: "RON", duration_minutes: 60, amount: "1" }] }, admin.client)).rejects.toThrow("Unable to save coaching");
  editFault.mockRestore();
  expect(await prices()).toEqual(before);
  expect((await coachingRepository.listCoachingPrograms(db.manager)).find((program) => program.id === created.id))
    .toMatchObject({ name, durations: [60, 90, 120] });

  // Removing an already removed price is a no-op; removing a duration still deletes its prices (existing rule).
  expect(await saveCoachingProgram({ id: created.id, fields: { ...fields, durations: [60, 90] },
    removed_club_prices: [{ currency: "RON", duration_minutes: 90 }] }, admin.client)).toEqual({ ok: true, id: created.id });
  expect((await prices()).filter((price) => price.duration === 120)).toEqual([]);

  // Programs and Prices pages read the same coaching_prices records; archived locations name no currency.
  const programsPage = await loadProgramsPage({ search: name }, admin.client);
  const currency = (code: string) => programsPage.currencies.find((item) => item.currency === code);
  expect(currency("RON")?.location_names).toContain(`${name} Central`);
  expect(currency("RON")?.location_names).not.toContain(`${name} Archived`);
  expect(currency("EUR")?.location_names).toContain(`${name} Riverside`);
  expect(programsPage.prices.filter((price) => price.coach_user_id === null).map((price) => price.amount_minor).sort()).toEqual([18500, 4000].sort());
  const pricesPage = await loadPricesPage({ search: name, currency: "RON", duration: "60", scope: "club" }, admin.client);
  expect(pricesPage.total).toBe(1);
  expect(pricesPage.prices.find((price) => price.coach_user_id === null)?.amount_minor).toBe(18500);
}, 60000);

test("Group and Junior club rates are Admin-only per player count, validated on the server and never coach-priced", async () => {
  await ensureIntegrationAdminAnchor(service);
  const name = `Group rates ${randomUUID()}`;
  const location = randomUUID(); locationIds.push(location);
  assert.strictEqual((await service.from("locations").insert(
    { id: location, name: `${name} Court`, slug: `gr-${location}`, timezone: "UTC", currency: "RON" })).error, null);
  const admin = await account(["admin"]);
  const coach = await account(["coach"]);
  const db = await getDataSource();
  const fields = { name, description: "Drills for 3–5 players.", program_type: "group", durations: [60, 90], min_participants: 3, max_participants: 5,
    court_rental_included: false, is_active: true };
  // Group programs take no per-duration club prices.
  expect(await saveCoachingProgram({ fields, club_prices: [{ currency: "RON", duration_minutes: 60, amount: "100" }] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  const created = await saveCoachingProgram({ fields }, admin.client);
  assert.ok(created.ok); programIds.push(created.id);
  const privateProgram = await saveCoachingProgram({ fields: { ...fields, name: `${name} private`, program_type: "private", min_participants: 1, max_participants: 1 } }, admin.client);
  assert.ok(privateProgram.ok); programIds.push(privateProgram.id);
  const rates = async () => (await coachingRepository.listParticipantPrices(db.manager, { programIds: [created.id] }))
    .map((price) => [price.participantCount, price.amountMinor, price.currency]).sort();
  const save = (change: Record<string, unknown>, session = admin.client) =>
    saveClubParticipantPrices({ program_id: created.id, currency: "RON", prices: [], removed: [], ...change }, session);

  // Only Admins may set rates; missing rates stay missing.
  for (const session of [coach.client, publicClient()]) await expect(save({ prices: [{ participant_count: 3, amount: "60" }] }, session)).rejects.toThrow();
  expect(await rates()).toEqual([]);

  // Create rates for different player counts.
  expect(await save({ prices: [{ participant_count: 3, amount: "60" }, { participant_count: 5, amount: "45.50" }] })).toEqual({ ok: true, id: created.id });
  expect(await rates()).toEqual([[3, 6000, "RON"], [5, 4550, "RON"]]);
  // Edit one, add one and remove one together.
  expect(await save({ prices: [{ participant_count: 3, amount: "65" }, { participant_count: 4, amount: "50" }], removed: [5] })).toEqual({ ok: true, id: created.id });
  expect(await rates()).toEqual([[3, 6500, "RON"], [4, 5000, "RON"]]);

  // Invalid amounts, counts outside the range, unused currencies, other program types and duration prices change nothing.
  for (const amount of ["0", "-5", "1.234", "x"])
    expect(await save({ prices: [{ participant_count: 3, amount }] })).toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { "prices.0": expect.any(String) } });
  for (const participant_count of [2, 6])
    expect(await save({ prices: [{ participant_count: 4, amount: "55" }, { participant_count, amount: "55" }] }))
      .toEqual({ ok: false, reason: "invalid-input", fieldErrors: { "prices.1": "Use a player count from 3 to 5." } });
  const used = (await db.query("SELECT DISTINCT currency FROM public.locations WHERE archived_at IS NULL") as { currency: string }[]).map((row) => row.currency);
  const unused = ["EUR", "USD", "GBP", "RON", "CHF"].find((currency) => !used.includes(currency));
  if (unused) expect(await save({ currency: unused, prices: [{ participant_count: 3, amount: "10" }] })).toEqual({ ok: false, reason: "invalid-currency" });
  expect(await save({ currency: "JPY", prices: [{ participant_count: 3, amount: "10" }] })).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await saveClubParticipantPrices({ program_id: privateProgram.id, currency: "RON", prices: [{ participant_count: 1, amount: "10" }], removed: [] }, admin.client))
    .toEqual({ ok: false, reason: "invalid-program" });
  expect(await saveClubCoachingPrice({ program_id: created.id, duration_minutes: 60, currency: "RON", amount: "100" }, admin.client))
    .toEqual({ ok: false, reason: "club-priced" });
  expect(await rates()).toEqual([[3, 6500, "RON"], [4, 5000, "RON"]]);

  // Coaches cannot override Group/Junior rates, and the program is absent from their pricing view.
  expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: { display_name: `${name} coach`, bio: "", qualifications: "", specialties: [],
    languages: [], location_ids: [location], program_ids: [created.id, privateProgram.id], is_public: true } }, admin.client)).toMatchObject({ ok: true });
  expect(await saveOwnCoachingPrice({ program_id: created.id, duration_minutes: 60, currency: "RON", amount: "30" }, coach.client))
    .toEqual({ ok: false, reason: "club-priced" });
  expect(await saveOwnCoachingPrice({ program_id: privateProgram.id, duration_minutes: 60, currency: "RON", amount: "150" }, coach.client)).toMatchObject({ ok: true });
  const view = await loadOwnCoachPricing(coach.client);
  expect(view?.rows.some((row) => row.program_id === created.id)).toBe(false);
  expect(view?.rows.some((row) => row.program_id === privateProgram.id)).toBe(true);
  expect(view?.clubPricedPrograms).toEqual([{ id: created.id, name }]);

  // An obsolete override written before the rules is ignored publicly but kept, and its coach may still remove it.
  await db.query(`INSERT INTO public.coaching_prices(program_id,duration_minutes,coach_user_id,amount_minor,currency)
    VALUES($1,60,$2,1000,'RON')`, [created.id, coach.id]);
  // A narrowed range keeps out-of-range rates stored but unpublished.
  expect(await saveCoachingProgram({ id: created.id, fields: { ...fields, max_participants: 3 } }, admin.client)).toEqual({ ok: true, id: created.id });
  expect(await rates()).toEqual([[3, 6500, "RON"], [4, 5000, "RON"]]);
  const visible = [{ id: location, name: `${name} Court`, currency: "RON" as const }];
  const published = await readPublicCoaching(visible);
  expect(published.programs.find((program) => program.id === created.id)).toMatchObject({
    type: "group", minParticipants: 3, maxParticipants: 3, prices: [], participantPrices: [{ participantCount: 3, amountMinor: 6500, currency: "RON" }],
  });
  const publicCoach = published.coaches.find((item) => item.id === coach.id);
  expect(publicCoach?.rates.map((rate) => rate.programId)).toEqual([privateProgram.id]);
  expect(await removeOwnCoachingPrice({ program_id: created.id, duration_minutes: 60, currency: "RON" }, coach.client)).toMatchObject({ ok: true });
  // The out-of-range rate is removed only explicitly.
  expect(await save({ removed: [4] })).toEqual({ ok: true, id: created.id });
  expect(await rates()).toEqual([[3, 6500, "RON"]]);

  // The Prices page lists the program once per currency with its stored rates, never coach targets.
  const page = await loadPricesPage({ search: name, currency: "RON", program: created.id }, admin.client);
  expect(page.total).toBe(1);
  expect(page.participantPrices.map((price) => [price.participant_count, price.amount_minor])).toEqual([[3, 6500]]);
  expect(page.prices).toEqual([]);
}, 60000);
