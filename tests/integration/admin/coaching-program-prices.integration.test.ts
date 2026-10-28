import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, assert, expect, test, vi } from "vitest";
import { getDataSource } from "../../../src/lib/db/data-source";
import * as coachingRepository from "../../../src/lib/db/repositories/coaching.repository";
import { saveCoachingProgram, saveCoachProfile } from "../../../src/lib/coaching/admin";
import { loadOwnCoachPricing, saveOwnCoachingPrice } from "../../../src/lib/coaching/coach-pricing";
import { readPublicCoaching } from "../../../src/lib/coaching/public";
import { resolveCoachingPrice } from "../../../src/lib/coaching/pricing";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

import { loadProgramsPage } from "@/lib/coaching/admin-lists";

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
    await database.query("DELETE FROM public.coach_profiles WHERE user_id = ANY($1::uuid[])", [userIds]);
    await database.query("DELETE FROM public.coaching_programs WHERE id = ANY($1::uuid[])", [programIds]);
    await database.query("DELETE FROM public.locations WHERE id = ANY($1::uuid[])", [locationIds]);
    await cleanupAuthFixtures(service, userIds);
  } finally {
    await database.destroy();
  }
});

const lesson = (currency: string, duration_minutes: number, participant_count: number, amount: string) =>
  ({ currency, duration_minutes, participant_count, amount });

test("Private lesson prices/person retain explicit independent Club and Coach amounts through the actual lists and public projection", async () => {
  await ensureIntegrationAdminAnchor(service);
  const admin = await account(["admin"]), coach = await account(["coach"]);
  const db = await getDataSource();
  const name = `Private price ${randomUUID()}`;
  const location = randomUUID(); locationIds.push(location);
  expect((await service.from("locations").insert({ id: location, name, slug: location, timezone: "UTC", currency: "RON" })).error).toBeNull();
  const fields = { name, description: "", program_type: "private", durations: [60],
    min_participants: 1, max_participants: 2, court_rental_included: true, is_active: true };
  const created = await saveCoachingProgram({ fields, club_prices: [lesson("RON", 60, 1, "90"), lesson("RON", 60, 2, "90")] }, admin.client);
  assert.ok(created.ok); programIds.push(created.id);
  expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: { display_name: name, bio: "", qualifications: "",
    specialties: [], languages: [], is_public: true, location_ids: [location], program_ids: [created.id] } }, admin.client)).toMatchObject({ ok: true });
  expect(await saveOwnCoachingPrice({ program_id: created.id, duration_minutes: 60, participant_count: 2, currency: "RON", amount: "80" }, coach.client)).toMatchObject({ ok: true });
  expect(await saveCoachingProgram({ id: created.id, fields, club_prices: [lesson("RON", 60, 1, "95")] }, admin.client)).toMatchObject({ ok: true });
  const programs = await loadProgramsPage({ search: name }, admin.client);
  expect(programs.programs).toEqual([expect.objectContaining({ id: created.id, program_type: "private" })]);
  expect(programs.programs[0]).not.toHaveProperty("pricing_unit");
  expect(programs.prices.filter(price => price.coach_user_id === null).map(price => [price.participant_count, price.amount_minor])).toEqual([[1, 9500], [2, 9000]]);
  const own = await loadOwnCoachPricing(coach.client);
  expect(own?.rows.map(row => [row.participant_count, row.effective?.amountMinor])).toEqual([[1, 9500], [2, 8000]]);
  const published = await readPublicCoaching([{ id: location, name, currency: "RON" }]);
  expect(published.programs.find(program => program.id === created.id)).toMatchObject({ type: "private", fromPrices: [{ currency: "RON", amountMinor: 8000 }] });
  // Changing one price leaves every other configured price unchanged.
  expect(await saveCoachingProgram({ id: created.id, fields, club_prices: [lesson("RON", 60, 1, "130")] }, admin.client)).toMatchObject({ ok: true });
  const stored = await coachingRepository.listCoachingPrices(db.manager, { programId: created.id });
  expect(stored.map(price => [price.participantCount, price.coachUserId, price.amountMinor]).sort((a, b) => Number(a[0]) - Number(b[0]) || Number(Boolean(a[1])) - Number(Boolean(b[1]))))
    .toEqual([[1, null, 13000], [2, null, 9000], [2, coach.id, 8000]]);
  // Group and Junior programs are club-priced: reclassifying removes coach prices and denies new ones.
  expect(await saveCoachingProgram({ id: created.id, fields: { ...fields, program_type: "group" } }, admin.client)).toMatchObject({ ok: true });
  expect((await coachingRepository.listCoachingPrices(db.manager, { programId: created.id })).map(price => [price.participantCount, price.coachUserId, price.amountMinor])
    .sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([[1, null, 13000], [2, null, 9000]]);
  expect(await saveOwnCoachingPrice({ program_id: created.id, duration_minutes: 60, participant_count: 1, currency: "RON", amount: "120" }, coach.client)).toMatchObject({ ok: false, reason: "club-priced" });
  expect((await loadProgramsPage({ search: name }, admin.client)).prices.some(price => price.coach_user_id !== null)).toBe(false);
});

test("the Program form saves club-wide prices per participant count with the program atomically", async () => {
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
  const fields = { name, description: "", program_type: "semi_private", durations: [60, 90], min_participants: 2, max_participants: 4,
    court_rental_included: true, is_active: true };
  const programCount = async () => (await db.query("SELECT count(*)::int AS n FROM public.coaching_programs WHERE name=$1", [name]))[0].n;

  // Only Admins may save programs with prices.
  for (const session of [coach.client, publicClient()]) {
    await expect(saveCoachingProgram({ fields, club_prices: [lesson("RON", 60, 2, "180")] }, session)).rejects.toThrow();
  }
  // Invalid amounts, unselected durations, counts outside the range, removals on creation, unsupported currencies and location keys save nothing.
  expect(await saveCoachingProgram({ fields, club_prices: [lesson("RON", 60, 2, "0")] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { "club_prices.0": expect.any(String) } });
  expect(await saveCoachingProgram({ fields, club_prices: [lesson("RON", 60, 2, "180"), lesson("RON", 120, 2, "320")] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { "club_prices.1": "Select this duration before setting its price." } });
  expect(await saveCoachingProgram({ fields, club_prices: [lesson("RON", 60, 2, "180"), lesson("RON", 60, 5, "320")] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { "club_prices.1": "Use a player count from 2 to 4." } });
  expect(await saveCoachingProgram({ fields, removed_club_prices: [{ currency: "RON", duration_minutes: 60, participant_count: 2 }] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await saveCoachingProgram({ fields, club_prices: [lesson("XYZ", 60, 2, "180")] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await saveCoachingProgram({ fields, club_prices: [{ location_id: locationIds[0], ...lesson("RON", 60, 2, "180") }] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await programCount()).toBe(0);

  // A failure after the program insert rolls back the program, its durations and earlier prices.
  const upsert = coachingRepository.upsertClubCoachingPrices;
  const fault = vi.spyOn(coachingRepository, "upsertClubCoachingPrices").mockImplementation(async (...args) => {
    await upsert(...args);
    throw new Error("Injected price failure");
  });
  await expect(saveCoachingProgram({ fields, club_prices: [lesson("RON", 60, 2, "180"), lesson("EUR", 60, 2, "40")] }, admin.client))
    .rejects.toThrow("Unable to save coaching");
  fault.mockRestore();
  expect(await programCount()).toBe(0);

  // Creation persists an independent price per duration, participant count and currency; 4 players stays unconfigured.
  const created = await saveCoachingProgram({ fields, club_prices: [
    lesson("RON", 60, 2, "150"), lesson("RON", 60, 3, "210"), lesson("RON", 90, 2, "220"), lesson("EUR", 60, 2, "30"),
  ] }, admin.client);
  assert.ok(created.ok); programIds.push(created.id);
  const prices = async () => (await coachingRepository.listCoachingPrices(db.manager, { programId: created.id }))
    .map((price) => [price.currency, price.durationMinutes, price.participantCount, price.coachUserId ? "coach" : "club", price.amountMinor]).sort();
  expect(await prices()).toEqual([["EUR", 60, 2, "club", 3000], ["RON", 60, 2, "club", 15000], ["RON", 60, 3, "club", 21000], ["RON", 90, 2, "club", 22000]]);
  const rows = async () => coachingRepository.listCoachingPrices(db.manager, { programId: created.id });
  const at = (participantCount: number, coachUserId: string | null = null, durationMinutes = 60) =>
    ({ programId: created.id, durationMinutes, participantCount, currency: "RON" as const, coachUserId });
  expect(resolveCoachingPrice(await rows(), at(4))).toBeNull();

  // A coach's own override is per participant count, preserved by Program saves and takes precedence for that count only.
  expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: { display_name: `${name} coach`, bio: "", qualifications: "", specialties: [],
    languages: [], location_ids: [locationIds[0]], program_ids: [created.id], is_public: true } }, admin.client)).toMatchObject({ ok: true });
  for (const [participant_count, amount] of [[3, "190"], [4, "260"]] as const) {
    expect(await saveOwnCoachingPrice({ program_id: created.id, duration_minutes: 60, participant_count, currency: "RON", amount }, coach.client))
      .toMatchObject({ ok: true });
  }
  expect(await saveOwnCoachingPrice({ program_id: created.id, duration_minutes: 60, participant_count: 5, currency: "RON", amount: "300" }, coach.client))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  expect(resolveCoachingPrice(await rows(), at(2, coach.id))).toMatchObject({ amountMinor: 15000, source: "club" });
  expect(resolveCoachingPrice(await rows(), at(3, coach.id))).toMatchObject({ amountMinor: 19000, source: "coach" });
  expect(resolveCoachingPrice(await rows(), at(4, coach.id))).toMatchObject({ amountMinor: 26000, source: "coach" });
  expect(resolveCoachingPrice(await rows(), at(4, randomUUID()))).toBeNull();

  // Editing changes a price, removes one explicitly and adds a duration with a price, leaving the rest unchanged.
  const edited = await saveCoachingProgram({ id: created.id, fields: { ...fields, durations: [60, 90, 120] },
    club_prices: [lesson("RON", 60, 2, "155"), lesson("EUR", 120, 4, "70")],
    removed_club_prices: [{ currency: "RON", duration_minutes: 90, participant_count: 2 }] }, admin.client);
  expect(edited).toEqual({ ok: true, id: created.id });
  expect(await prices()).toEqual([["EUR", 120, 4, "club", 7000], ["EUR", 60, 2, "club", 3000], ["RON", 60, 2, "club", 15500],
    ["RON", 60, 3, "club", 21000], ["RON", 60, 3, "coach", 19000], ["RON", 60, 4, "coach", 26000]]);

  // Batch deletion uses exact keys across currencies/durations and cannot touch coach overrides.
  const beforeBatch = await prices();
  const retainedIds = (await rows()).map((price) => price.id).sort();
  const obsolete = [
    { currency: "EUR", duration_minutes: 90, participant_count: 3 },
    { currency: "RON", duration_minutes: 120, participant_count: 3 },
  ];
  expect(await saveCoachingProgram({ id: created.id, fields: { ...fields, durations: [60, 90, 120] },
    club_prices: obsolete.map((price) => ({ ...price, amount: "77" })) }, admin.client)).toMatchObject({ ok: true });
  const queries = vi.spyOn(db.logger, "logQuery");
  expect(await saveCoachingProgram({ id: created.id, fields: { ...fields, durations: [60, 90, 120] },
    removed_club_prices: obsolete,
    club_prices: [lesson("RON", 60, 2, "155"), lesson("RON", 60, 3, "210")] }, admin.client)).toMatchObject({ ok: true });
  const priceWrites = queries.mock.calls.map(([query]) => query)
    .filter((query) => /^(INSERT INTO|DELETE FROM).*"coaching_prices"/.test(query));
  queries.mockRestore();
  // One existing reconciliation DELETE, one explicit batch DELETE and one batch upsert.
  expect(priceWrites.filter((query) => query.startsWith("DELETE FROM"))).toHaveLength(2);
  expect(priceWrites.filter((query) => query.startsWith("INSERT INTO"))).toHaveLength(1);
  expect(await prices()).toEqual(beforeBatch);
  expect((await rows()).map((price) => price.id).sort()).toEqual(retainedIds);

  // A failed edit, including its reconciliation, leaves program details, durations and prices unchanged.
  const before = await prices();
  const editFault = vi.spyOn(coachingRepository, "upsertClubCoachingPrices").mockRejectedValueOnce(new Error("Injected price failure"));
  await expect(saveCoachingProgram({ id: created.id, fields: { ...fields, name: `${name} renamed`, durations: [60], max_participants: 2 },
    club_prices: [lesson("RON", 60, 2, "1")] }, admin.client)).rejects.toThrow("Unable to save coaching");
  editFault.mockRestore();
  expect(await prices()).toEqual(before);
  expect((await coachingRepository.listCoachingPrograms(db.manager)).find((program) => program.id === created.id))
    .toMatchObject({ name, durations: [60, 90, 120], minParticipants: 2, maxParticipants: 4 });

  // The Programs page reads the coaching_prices records; archived locations name no currency.
  const programsPage = await loadProgramsPage({ search: name }, admin.client);
  const currency = (code: string) => programsPage.currencies.find((item) => item.currency === code);
  expect(currency("RON")?.location_names).toContain(`${name} Central`);
  expect(currency("RON")?.location_names).not.toContain(`${name} Archived`);
  expect(currency("EUR")?.location_names).toContain(`${name} Riverside`);
  expect(programsPage.prices.filter((price) => price.coach_user_id === null).map((price) => [price.currency, price.duration_minutes, price.participant_count]).sort())
    .toEqual([["EUR", 120, 4], ["EUR", 60, 2], ["RON", 60, 2], ["RON", 60, 3]]);

  // Saving the program again sets one count's price and removes another; 4 players gets its own price.
  const current = { ...fields, durations: [60, 90, 120] };
  expect(await saveCoachingProgram({ id: created.id, fields: current, club_prices: [lesson("RON", 60, 4, "280")],
    removed_club_prices: [{ currency: "RON", duration_minutes: 60, participant_count: 3 }] }, admin.client)).toEqual({ ok: true, id: created.id });
  expect(await saveCoachingProgram({ id: created.id, fields: current, club_prices: [lesson("RON", 60, 5, "280")] }, admin.client))
    .toEqual({ ok: false, reason: "invalid-input", fieldErrors: { "club_prices.0": "Use a player count from 2 to 4." } });
  // Every price names one of the program's explicit durations.
  expect(await saveCoachingProgram({ id: created.id, fields: current, club_prices: [{ ...lesson("RON", 60, 2, "50"), duration_minutes: null }] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await saveCoachingProgram({ id: created.id, fields: current, club_prices: [lesson("RON", 90, 2, "50")] }, admin.client)).toEqual({ ok: true, id: created.id });
  expect((await prices()).filter(([code, , , scope]) => code === "RON" && scope === "club")).toEqual([
    ["RON", 60, 2, "club", 15500], ["RON", 60, 4, "club", 28000], ["RON", 90, 2, "club", 5000]]);
  // The coach's own 3-player override is unaffected by club price changes.
  expect(resolveCoachingPrice(await rows(), at(3, coach.id))).toMatchObject({ amountMinor: 19000, source: "coach" });
  expect(resolveCoachingPrice(await rows(), at(3))).toBeNull();
}, 60000);

test("changing the player range, durations or program type deletes inapplicable club and coach prices transactionally and never restores them", async () => {
  await ensureIntegrationAdminAnchor(service);
  const name = `Reconcile ${randomUUID()}`;
  const location = randomUUID(); locationIds.push(location);
  assert.strictEqual((await service.from("locations").insert(
    { id: location, name: `${name} Court`, slug: `rc-${location}`, timezone: "UTC", currency: "RON" })).error, null);
  const admin = await account(["admin"]);
  const coach = await account(["coach"]);
  const db = await getDataSource();
  const fields = { name, description: "", program_type: "semi_private", durations: [60, 90], min_participants: 2, max_participants: 4,
    court_rental_included: true, is_active: true };
  const created = await saveCoachingProgram({ fields, club_prices: [
    lesson("RON", 60, 2, "150"), lesson("RON", 60, 3, "210"), lesson("RON", 60, 4, "260"), lesson("RON", 90, 2, "220"), lesson("RON", 90, 4, "360"),
  ] }, admin.client);
  assert.ok(created.ok); programIds.push(created.id);
  expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: { display_name: `${name} coach`, bio: "", qualifications: "", specialties: [],
    languages: [], location_ids: [location], program_ids: [created.id], is_public: true } }, admin.client)).toMatchObject({ ok: true });
  for (const [duration_minutes, participant_count, amount] of [[60, 2, "140"], [60, 4, "250"], [90, 4, "350"]] as const) {
    expect(await saveOwnCoachingPrice({ program_id: created.id, duration_minutes, participant_count, currency: "RON", amount }, coach.client)).toMatchObject({ ok: true });
  }
  const prices = async () => (await coachingRepository.listCoachingPrices(db.manager, { programId: created.id }))
    .map((price) => `${price.durationMinutes}:${price.participantCount}:${price.coachUserId ? "coach" : "club"}:${price.amountMinor}`).sort();
  expect(await prices()).toEqual(["60:2:club:15000", "60:2:coach:14000", "60:3:club:21000", "60:4:club:26000", "60:4:coach:25000",
    "90:2:club:22000", "90:4:club:36000", "90:4:coach:35000"]);

  // A failure while saving the narrowed program rolls back its price deletions too.
  const updateFault = vi.spyOn(coachingRepository, "updateCoachingProgram").mockRejectedValueOnce(new Error("Injected update failure"));
  await expect(saveCoachingProgram({ id: created.id, fields: { ...fields, max_participants: 3 } }, admin.client)).rejects.toThrow("Unable to save coaching");
  updateFault.mockRestore();
  expect(await prices()).toHaveLength(8);

  // Narrowing 2–4 to 2–3 deletes every 4-player price, club and coach, for every duration; others are unchanged.
  expect(await saveCoachingProgram({ id: created.id, fields: { ...fields, max_participants: 3 } }, admin.client)).toEqual({ ok: true, id: created.id });
  expect(await prices()).toEqual(["60:2:club:15000", "60:2:coach:14000", "60:3:club:21000", "90:2:club:22000"]);
  // Expanding to 2–5 adds unconfigured counts; the deleted 4-player prices are not restored.
  expect(await saveCoachingProgram({ id: created.id, fields: { ...fields, max_participants: 5 } }, admin.client)).toEqual({ ok: true, id: created.id });
  expect(await prices()).toEqual(["60:2:club:15000", "60:2:coach:14000", "60:3:club:21000", "90:2:club:22000"]);
  const rows = await coachingRepository.listCoachingPrices(db.manager, { programId: created.id });
  for (const participantCount of [4, 5]) {
    expect(resolveCoachingPrice(rows, { programId: created.id, durationMinutes: 60, participantCount, currency: "RON", coachUserId: coach.id })).toBeNull();
  }
  // Raising the minimum deletes the counts below it.
  expect(await saveCoachingProgram({ id: created.id, fields: { ...fields, min_participants: 3, max_participants: 5 } }, admin.client)).toEqual({ ok: true, id: created.id });
  expect(await prices()).toEqual(["60:3:club:21000"]);
  // Removing a duration deletes its prices; reselecting it later does not restore them.
  expect(await saveCoachingProgram({ id: created.id, fields: { ...fields, min_participants: 2, max_participants: 4 },
    club_prices: [lesson("RON", 90, 3, "300")] }, admin.client)).toEqual({ ok: true, id: created.id });
  expect(await saveCoachingProgram({ id: created.id, fields: { ...fields, durations: [60] } }, admin.client)).toEqual({ ok: true, id: created.id });
  expect(await prices()).toEqual(["60:3:club:21000"]);
  expect(await saveCoachingProgram({ id: created.id, fields }, admin.client)).toEqual({ ok: true, id: created.id });
  expect(await prices()).toEqual(["60:3:club:21000"]);

  // Changing the type to Group keeps the club lesson prices/person (same meaning) and deletes coach prices.
  expect(await saveOwnCoachingPrice({ program_id: created.id, duration_minutes: 60, participant_count: 2, currency: "RON", amount: "140" }, coach.client)).toMatchObject({ ok: true });
  const group = { ...fields, program_type: "group", court_rental_included: false };
  expect(await saveCoachingProgram({ id: created.id, fields: group, club_prices: [lesson("RON", 120, 2, "90")] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await prices()).toEqual(["60:2:coach:14000", "60:3:club:21000"]);
  expect(await saveCoachingProgram({ id: created.id, fields: group, club_prices: [lesson("RON", 60, 2, "90"), lesson("RON", 90, 4, "60")] }, admin.client))
    .toEqual({ ok: true, id: created.id });
  expect(await prices()).toEqual(["60:2:club:9000", "60:3:club:21000", "90:4:club:6000"]);
  // Narrowing a Group range deletes its out-of-range prices.
  expect(await saveCoachingProgram({ id: created.id, fields: { ...group, max_participants: 3 } }, admin.client)).toEqual({ ok: true, id: created.id });
  expect(await prices()).toEqual(["60:2:club:9000", "60:3:club:21000"]);
  // Back to Semi-private: the same prices still mean the lesson price/person and are kept unchanged.
  expect(await saveCoachingProgram({ id: created.id, fields }, admin.client)).toEqual({ ok: true, id: created.id });
  expect(await prices()).toEqual(["60:2:club:9000", "60:3:club:21000"]);
  // An inactive program without a range keeps no prices.
  expect(await saveCoachingProgram({ id: created.id, fields: { ...fields, is_active: false, min_participants: null, max_participants: null },
    club_prices: [lesson("RON", 60, 2, "150")] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { "club_prices.0": "Set the minimum and maximum players before setting prices." } });
}, 60000);

test("Group and Junior club lesson prices/person are Admin-only per duration and player count, validated on the server and never coach-priced", async () => {
  await ensureIntegrationAdminAnchor(service);
  const name = `Group prices ${randomUUID()}`;
  const location = randomUUID(); locationIds.push(location);
  assert.strictEqual((await service.from("locations").insert(
    { id: location, name: `${name} Court`, slug: `gr-${location}`, timezone: "UTC", currency: "RON" })).error, null);
  const admin = await account(["admin"]);
  const coach = await account(["coach"]);
  const db = await getDataSource();
  const fields = { name, description: "Drills for 3–5 players.", program_type: "group", durations: [60, 90], min_participants: 3, max_participants: 5,
    court_rental_included: false, is_active: true };
  // Group prices are tied to one of the program's explicit durations.
  expect(await saveCoachingProgram({ fields, club_prices: [lesson("RON", 120, 3, "100")] }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  const created = await saveCoachingProgram({ fields }, admin.client);
  assert.ok(created.ok); programIds.push(created.id);
  const privateProgram = await saveCoachingProgram({ fields: { ...fields, name: `${name} private`, program_type: "private", min_participants: 1, max_participants: 1 } }, admin.client);
  assert.ok(privateProgram.ok); programIds.push(privateProgram.id);
  // The 60-minute club lesson prices/person of the Group program.
  const rates = async () => (await coachingRepository.listCoachingPrices(db.manager, { programId: created.id }))
    .filter((price) => price.durationMinutes === 60).map((price) => [price.participantCount, price.amountMinor, price.currency]).sort();
  // Club prices of one duration and currency by player count, saved with the unchanged program as the Program dialog does.
  type Change = { currency?: string; duration_minutes?: number | null; prices?: { participant_count: number; amount: string }[]; removed?: number[] };
  const save = ({ currency = "RON", duration_minutes = 60, prices = [], removed = [] }: Change, session = admin.client) =>
    saveCoachingProgram({ id: created.id, fields,
      ...prices.length > 0 && { club_prices: prices.map(price => ({ currency, duration_minutes, ...price })) },
      ...removed.length > 0 && { removed_club_prices: removed.map(participant_count => ({ currency, duration_minutes, participant_count })) } }, session);

  // Only Admins may set prices; missing prices stay missing.
  for (const session of [coach.client, publicClient()]) await expect(save({ prices: [{ participant_count: 3, amount: "60" }] }, session)).rejects.toThrow();
  expect(await rates()).toEqual([]);

  // Create prices for different player counts.
  expect(await save({ prices: [{ participant_count: 3, amount: "60" }, { participant_count: 5, amount: "45.50" }] })).toEqual({ ok: true, id: created.id });
  expect(await rates()).toEqual([[3, 6000, "RON"], [5, 4550, "RON"]]);
  // Edit one, add one and remove one together.
  expect(await save({ prices: [{ participant_count: 3, amount: "65" }, { participant_count: 4, amount: "50" }], removed: [5] })).toEqual({ ok: true, id: created.id });
  expect(await rates()).toEqual([[3, 6500, "RON"], [4, 5000, "RON"]]);

  // A failure after a batch upsert rolls back both the batch and multiple preceding removals.
  const clubUpsert = coachingRepository.upsertClubCoachingPrices;
  const rateFault = vi.spyOn(coachingRepository, "upsertClubCoachingPrices").mockImplementationOnce(async (...args) => {
    await clubUpsert(...args);
    throw new Error("Injected rate failure");
  });
  await expect(save({ prices: [{ participant_count: 5, amount: "80" }], removed: [3, 4] })).rejects.toThrow("Unable to save coaching");
  rateFault.mockRestore();
  expect(await rates()).toEqual([[3, 6500, "RON"], [4, 5000, "RON"]]);
  expect(await save({ removed: [3, 4] })).toMatchObject({ ok: true });
  expect(await rates()).toEqual([]);
  expect(await save({ prices: [{ participant_count: 3, amount: "65" }, { participant_count: 4, amount: "50" }] })).toMatchObject({ ok: true });

  // Invalid amounts, counts outside the range, unused currencies and durations the program does not offer change nothing.
  for (const amount of ["0", "-5", "1.234", "x"])
    expect(await save({ prices: [{ participant_count: 3, amount }] })).toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { "club_prices.0": expect.any(String) } });
  for (const participant_count of [2, 6])
    expect(await save({ prices: [{ participant_count: 4, amount: "55" }, { participant_count, amount: "55" }] }))
      .toEqual({ ok: false, reason: "invalid-input", fieldErrors: { "club_prices.1": "Use a player count from 3 to 5." } });
  const used = (await db.query("SELECT DISTINCT currency FROM public.locations WHERE archived_at IS NULL") as { currency: string }[]).map((row) => row.currency);
  const unused = ["EUR", "USD", "GBP", "RON", "CHF"].find((currency) => !used.includes(currency));
  assert.ok(unused);
  expect(await save({ currency: unused, prices: [{ participant_count: 3, amount: "10" }] })).toEqual({ ok: false, reason: "invalid-currency" });
  expect(await save({ currency: "JPY", prices: [{ participant_count: 3, amount: "10" }] })).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await save({ duration_minutes: null, prices: [{ participant_count: 3, amount: "100" }] })).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await save({ duration_minutes: 120, prices: [{ participant_count: 3, amount: "100" }] }))
    .toEqual({ ok: false, reason: "invalid-input", fieldErrors: { "club_prices.0": "Select this duration before setting its price." } });
  // A price saved earlier in a currency no current location charges stays listed and can be removed, but not changed.
  await db.query(`INSERT INTO public.coaching_prices(program_id,duration_minutes,participant_count,amount_minor,currency) VALUES($1,60,5,7000,$2)`, [created.id, unused]);
  const listed = (await loadProgramsPage({ search: name }, admin.client));
  expect(listed.currencies.find((item) => item.currency === unused)).toEqual({ currency: unused, location_names: [] });
  expect(listed.prices.some((price) => price.program_id === created.id && price.currency === unused)).toBe(true);
  expect(await save({ currency: unused, prices: [{ participant_count: 5, amount: "75" }] })).toEqual({ ok: false, reason: "invalid-currency" });
  expect(await save({ currency: unused, removed: [5] })).toEqual({ ok: true, id: created.id });
  expect(await rates()).toEqual([[3, 6500, "RON"], [4, 5000, "RON"]]);

  // Coaches cannot override Group/Junior prices, and the program is absent from their pricing view.
  expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: { display_name: `${name} coach`, bio: "", qualifications: "", specialties: [],
    languages: [], location_ids: [location], program_ids: [created.id, privateProgram.id], is_public: true } }, admin.client)).toMatchObject({ ok: true });
  expect(await saveOwnCoachingPrice({ program_id: created.id, duration_minutes: 60, participant_count: 3, currency: "RON", amount: "30" }, coach.client))
    .toEqual({ ok: false, reason: "club-priced" });
  expect(await saveOwnCoachingPrice({ program_id: privateProgram.id, duration_minutes: 60, participant_count: 1, currency: "RON", amount: "150" }, coach.client)).toMatchObject({ ok: true });
  const view = await loadOwnCoachPricing(coach.client);
  expect(view?.rows.some((row) => row.program_id === created.id)).toBe(false);
  expect(view?.rows.filter((row) => row.program_id === privateProgram.id).map((row) => [row.duration_minutes, row.participant_count])).toEqual([[60, 1], [90, 1]]);
  expect(view?.clubPricedPrograms).toEqual([{ id: created.id, name }]);

  // A lesson price stored for a Group program (written outside the application) is never published,
  // and the next program save deletes it.
  await db.query(`INSERT INTO public.coaching_prices(program_id,duration_minutes,participant_count,coach_user_id,amount_minor,currency)
    VALUES($1,60,3,$2,1000,'RON')`, [created.id, coach.id]);
  const visible = [{ id: location, name: `${name} Court`, currency: "RON" as const }];
  const published = await readPublicCoaching(visible);
  expect(published.programs.find((program) => program.id === created.id)).toMatchObject({ type: "group",
    prices: [{ durationMinutes: 60, participantCount: 3, amountMinor: 6500, currency: "RON" }, { durationMinutes: 60, participantCount: 4, amountMinor: 5000, currency: "RON" }],
    fromPrices: [{ currency: "RON", amountMinor: 5000 }] });
  // A coach override alone cannot publish the unpriced Private program.
  expect(published.programs.some((program) => program.id === privateProgram.id)).toBe(false);
  expect(published.coaches.find((item) => item.id === coach.id)).toMatchObject({
    programs: [{ id: created.id, name }], rates: [],
  });
  // Once the Club publishes a price, the Private override appears; the stored
  // Group override remains excluded from coach rates.
  expect(await saveCoachingProgram({ id: privateProgram.id,
    fields: { ...fields, name: `${name} private`, program_type: "private", min_participants: 1, max_participants: 1 },
    club_prices: [lesson("RON", 60, 1, "100")] }, admin.client)).toEqual({ ok: true, id: privateProgram.id });
  expect((await readPublicCoaching(visible)).coaches.find((item) => item.id === coach.id)?.rates)
    .toMatchObject([{ programId: privateProgram.id, amountMinor: 15000, currency: "RON" }]);
  expect(await saveCoachingProgram({ id: created.id, fields: { ...fields, max_participants: 3 } }, admin.client)).toEqual({ ok: true, id: created.id });
  expect((await coachingRepository.listCoachingPrices(db.manager, { programId: created.id })).some((price) => price.coachUserId !== null)).toBe(false);
  // The narrowed range deleted the 4-player price; the public From price follows.
  expect(await rates()).toEqual([[3, 6500, "RON"]]);
  expect((await readPublicCoaching(visible)).programs.find((program) => program.id === created.id)?.fromPrices).toEqual([{ currency: "RON", amountMinor: 6500 }]);

  // The Programs page lists the program's club prices, never coach targets.
  const page = await loadProgramsPage({ search: name }, admin.client);
  expect(page.prices.filter((price) => price.program_id === created.id).map((price) => [price.duration_minutes, price.participant_count, price.amount_minor, price.coach_user_id]))
    .toEqual([[60, 3, 6500, null]]);
}, 60000);

test("the public From price is the lowest applicable configured price per currency, read from the database", async () => {
  await ensureIntegrationAdminAnchor(service);
  const name = `From prices ${randomUUID()}`;
  const [ronLocation, eurLocation] = [randomUUID(), randomUUID()]; locationIds.push(ronLocation, eurLocation);
  assert.strictEqual((await service.from("locations").insert([
    { id: ronLocation, name: `${name} RON`, slug: `fp-ron-${ronLocation}`, timezone: "UTC", currency: "RON" },
    { id: eurLocation, name: `${name} EUR`, slug: `fp-eur-${eurLocation}`, timezone: "UTC", currency: "EUR" },
  ])).error, null);
  const admin = await account(["admin"]);
  const coach = await account(["coach"]);
  const fields = { name, description: "", program_type: "semi_private", durations: [60, 90], min_participants: 2, max_participants: 4,
    court_rental_included: true, is_active: true };
  const created = await saveCoachingProgram({ fields, club_prices: [
    lesson("RON", 60, 2, "150"), lesson("RON", 60, 3, "210"), lesson("RON", 90, 2, "220"), lesson("EUR", 60, 3, "35"),
  ] }, admin.client);
  assert.ok(created.ok); programIds.push(created.id);
  const visible = [{ id: ronLocation, name: `${name} RON`, currency: "RON" as const }, { id: eurLocation, name: `${name} EUR`, currency: "EUR" as const }];
  const from = async () => (await readPublicCoaching(visible)).programs.find((program) => program.id === created.id)?.fromPrices;
  // No eligible coach yet: the published club prices.
  expect(await from()).toEqual([{ currency: "EUR", amountMinor: 3500 }, { currency: "RON", amountMinor: 15000 }]);
  // A public coach at the RON location with a lower 3-player override lowers the RON From price only.
  expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: { display_name: `${name} coach`, bio: "", qualifications: "", specialties: [],
    languages: [], location_ids: [ronLocation], program_ids: [created.id], is_public: true } }, admin.client)).toMatchObject({ ok: true });
  expect(await saveOwnCoachingPrice({ program_id: created.id, duration_minutes: 60, participant_count: 3, currency: "RON", amount: "120" }, coach.client)).toMatchObject({ ok: true });
  expect(await from()).toEqual([{ currency: "EUR", amountMinor: 3500 }, { currency: "RON", amountMinor: 12000 }]);
  // Narrowing the range removes the override and the From price follows the database.
  expect(await saveCoachingProgram({ id: created.id, fields: { ...fields, max_participants: 2 } }, admin.client)).toEqual({ ok: true, id: created.id });
  expect(await from()).toEqual([{ currency: "RON", amountMinor: 15000 }]);
}, 60000);
