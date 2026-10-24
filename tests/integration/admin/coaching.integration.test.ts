import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, afterEach, assert, beforeAll, expect, test, vi } from "vitest";
import { getDataSource } from "../../../src/lib/db/data-source";
import * as coachingRepository from "../../../src/lib/db/repositories/coaching.repository";
import {
  deleteCoachingProgram, deleteCoachProfile, loadAdminCoaching, removeClubCoachingPrice, saveClubCoachingPrice, saveClubParticipantPrices, saveCoachingProgram, saveCoachProfile,
  setCoachingProgramStatus, setCoachVisibility,
} from "../../../src/lib/coaching/admin";
import { loadOwnCoachPricing, removeOwnCoachingPrice, saveOwnCoachingPrice } from "../../../src/lib/coaching/coach-pricing";
import { readPublicCoaching } from "../../../src/lib/coaching/public";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";

import { loadCoachesPage } from "@/lib/coaching/admin-lists";

const service = localFixtureClient();
const password = "coaching-integration-password-123";
const userIds: string[] = [];
const locationIds = [randomUUID(), randomUUID()];
const programIds: string[] = [];
const publicClient = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

beforeAll(async () => {
  assert.strictEqual((await service.from("locations").insert([
    { id: locationIds[0], name: "Coaching East", slug: `coaching-east-${locationIds[0]}`, timezone: "UTC", currency: "RON" },
    { id: locationIds[1], name: "Coaching West", slug: `coaching-west-${locationIds[1]}`, timezone: "UTC", currency: "EUR" },
  ])).error, null);
});

afterEach(async () => {
  assert.strictEqual((await service.from("locations").update({ currency: "RON" }).eq("id", locationIds[0])).error, null);
});

async function account(roles: ("admin" | "coach")[] = []) {
  const email = `coaching-${randomUUID()}@example.test`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.strictEqual(error, null); assert.ok(data.user);
  userIds.push(data.user.id);
  for (const role of roles) assert.strictEqual((await service.from("user_roles").insert({ user_id: data.user.id, role_code: role })).error, null);
  const client = publicClient();
  assert.strictEqual((await client.auth.signInWithPassword({ email, password })).error, null);
  return { client, id: data.user.id, email };
}

const programFields = { name: `Integration private ${randomUUID()}`, description: "One player.", program_type: "private", durations: [60, 90],
  min_participants: 1, max_participants: 1, court_rental_included: true, is_active: true };
const coachFields = (overrides: Record<string, unknown> = {}) => ({ display_name: "Integration Coach", bio: "Bio.", qualifications: "Level 1",
  specialties: ["Serve"], languages: ["English"], location_ids: [locationIds[0]], program_ids: programIds, is_public: false, ...overrides });

afterAll(async () => {
  const database = await getDataSource();
  try {
    await database.query("DELETE FROM public.coaching_prices WHERE program_id = ANY($1::uuid[])", [programIds]);
    await database.query("DELETE FROM public.coaching_participant_prices WHERE program_id = ANY($1::uuid[])", [programIds]);
    await database.query("DELETE FROM public.coach_availability_exceptions WHERE coach_user_id = ANY($1::uuid[])", [userIds]);
    await database.query("DELETE FROM public.coach_weekly_availability WHERE coach_user_id = ANY($1::uuid[])", [userIds]);
    await database.query("DELETE FROM public.coach_profiles WHERE user_id = ANY($1::uuid[])", [userIds]);
    await database.query("DELETE FROM public.coaching_programs WHERE id = ANY($1::uuid[])", [programIds]);
    await database.query("DELETE FROM public.locations WHERE id = ANY($1::uuid[])", [locationIds]);
    await database.query("DELETE FROM public.player_profiles WHERE user_id = ANY($1::uuid[])", [userIds]);
    await cleanupAuthFixtures(service, userIds);
  } finally {
    await database.destroy();
  }
});

test("coaching administration enforces Admin authorization, coach eligibility, constraints and price resolution", async () => {
  await ensureIntegrationAdminAnchor(service);
  const admin = await account(["admin"]);
  const coach = await account(["coach"]);
  const adminCoach = await account(["admin", "coach"]);
  const member = await account();
  const suspendedCoach = await account(["coach"]);
  assert.strictEqual((await service.from("users").update({ status: "suspended" }).eq("id", suspendedCoach.id)).error, null);
  const database = await getDataSource();

  const programsBeforeAuthorization = await database.query("SELECT 1 FROM public.coaching_programs WHERE name=$1", [programFields.name]);
  // Authorization: non-Admins are rejected before any write.
  for (const session of [member.client, coach.client, publicClient()]) {
    await expect(loadAdminCoaching(session)).rejects.toThrow();
    await expect(loadCoachesPage({}, session)).rejects.toThrow();
    await expect(saveCoachingProgram({ fields: programFields }, session)).rejects.toThrow();
    await expect(saveCoachProfile({ user_id: coach.id, create: true, fields: coachFields() }, session)).rejects.toThrow();
    await expect(saveClubCoachingPrice({}, session)).rejects.toThrow();
  }
  expect(await database.query("SELECT 1 FROM public.coaching_programs WHERE name=$1", [programFields.name])).toEqual(programsBeforeAuthorization);

  // Programs: create, edit (durations and fields), deactivate.
  const created = await saveCoachingProgram({ fields: programFields }, admin.client);
  assert.ok(created.ok); programIds.push(created.id);
  expect(await saveCoachingProgram({ fields: { ...programFields, min_participants: 3, max_participants: 2 } }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { max_participants: expect.any(String) } });
  // Active programs are bookable online and need both explicit limits.
  expect(await saveCoachingProgram({ fields: { ...programFields, min_participants: null } }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { min_participants: "Enter the minimum players for an active program." } });
  expect(await saveCoachingProgram({ id: created.id, fields: { ...programFields, max_participants: null } }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input", fieldErrors: { max_participants: "Enter the maximum players for an active program." } });
  expect(await saveCoachingProgram({ id: created.id, fields: { ...programFields, name: "Integration private coaching", durations: [60, 90, 120] } }, admin.client))
    .toEqual({ ok: true, id: created.id });
  expect(await saveCoachingProgram({ id: randomUUID(), fields: programFields }, admin.client)).toEqual({ ok: false, reason: "not-found" });
  let state = await loadAdminCoaching(admin.client);
  expect(state.programs.find((program) => program.id === created.id))
    .toMatchObject({ name: "Integration private coaching", durations: [60, 90, 120], court_rental_included: true, is_active: true });

  // Coach eligibility: an active account with the coach role (other roles allowed).
  expect(state.coachAccounts.map((item) => item.id)).toEqual(expect.arrayContaining([coach.id, adminCoach.id]));
  expect(state.coachAccounts.map((item) => item.id)).not.toContain(member.id);
  expect(state.coachAccounts.map((item) => item.id)).not.toContain(suspendedCoach.id);
  for (const ineligible of [member.id, randomUUID()]) {
    expect(await saveCoachProfile({ user_id: ineligible, create: true, fields: coachFields() }, admin.client)).toEqual({ ok: false, reason: "not-eligible" });
  }
  expect(await saveCoachProfile({ user_id: suspendedCoach.id, create: true, fields: coachFields({ is_public: true }) }, admin.client))
    .toEqual({ ok: false, reason: "not-eligible" });
  expect(await saveCoachProfile({ user_id: suspendedCoach.id, create: true, fields: coachFields() }, admin.client))
    .toEqual({ ok: true, id: suspendedCoach.id });
  expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: coachFields({ location_ids: [randomUUID()] }) }, admin.client))
    .toEqual({ ok: false, reason: "invalid-location" });
  expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: coachFields({ program_ids: [randomUUID()] }) }, admin.client))
    .toEqual({ ok: false, reason: "invalid-program" });
  const beforeConfiguration = await loadCoachesPage({ search: coach.email }, admin.client);
  expect(beforeConfiguration).toMatchObject({ total: 1, coaches: [{ user_id: coach.id, profile: null, profile_status: "not-configured" }] });
  expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: coachFields() }, admin.client)).toEqual({ ok: true, id: coach.id });
  expect(await loadCoachesPage({ search: coach.email }, admin.client))
    .toMatchObject({ total: 1, coaches: [{ user_id: coach.id, profile_status: "configured", profile: { display_name: "Integration Coach" } }] });
  const allCoaches = await loadCoachesPage({}, admin.client);
  const roleCount = await database.query("SELECT count(*)::int AS total FROM public.users u WHERE EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id=u.id AND r.role_code='coach')");
  expect(allCoaches.total).toBe(roleCount[0].total);

  expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: coachFields() }, admin.client)).toEqual({ ok: false, reason: "already-exists" });
  expect(await saveCoachProfile({ user_id: adminCoach.id, create: true, fields: coachFields({ display_name: "Second Coach", program_ids: [], is_public: true }) }, admin.client))
    .toEqual({ ok: true, id: adminCoach.id });

  // Editing every public profile field and both assignment sets.
  expect(await saveCoachProfile({ user_id: coach.id, create: false, fields: coachFields({ display_name: "Ana Integration",
    bio: "New bio.", qualifications: "Level 3", specialties: ["Footwork", "Juniors"], languages: ["Romanian", "English"],
    location_ids: [locationIds[0], locationIds[1]] }) }, admin.client)).toEqual({ ok: true, id: coach.id });
  state = await loadAdminCoaching(admin.client);
  expect(state.coaches.find((item) => item.user_id === coach.id)).toMatchObject({ display_name: "Ana Integration", bio: "New bio.",
    qualifications: "Level 3", specialties: ["Footwork", "Juniors"], languages: ["Romanian", "English"], email: coach.email,
    location_ids: [...locationIds].sort(), program_ids: [created.id], is_public: false, ineligibility: null });
  expect(await saveCoachProfile({ user_id: randomUUID(), create: false, fields: coachFields() }, admin.client)).toEqual({ ok: false, reason: "not-found" });

  // Pricing: the Admin sets the club default, the coach their own override, per program duration and currency.
  const key = { program_id: created.id, duration_minutes: 60, currency: "RON" };
  expect(await saveClubCoachingPrice({ ...key, amount: "120" }, admin.client)).toMatchObject({ ok: true });
  expect(await saveClubCoachingPrice({ ...key, amount: "125.50" }, admin.client)).toMatchObject({ ok: true });
  expect(await saveOwnCoachingPrice({ ...key, amount: "150" }, coach.client)).toMatchObject({ ok: true });
  expect(await saveClubCoachingPrice({ ...key, duration_minutes: 45, amount: "10" }, admin.client)).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await saveClubCoachingPrice({ ...key, currency: "XYZ", amount: "10" }, admin.client)).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await saveClubCoachingPrice({ ...key, location_id: locationIds[0], amount: "10" }, admin.client)).toMatchObject({ ok: false, reason: "invalid-input" });
  // adminCoach does not offer the program, so an override is rejected in TypeScript and by the composite FK.
  expect(await saveOwnCoachingPrice({ ...key, amount: "99" }, adminCoach.client)).toEqual({ ok: false, reason: "not-offered" });
  await expect(database.query(`INSERT INTO public.coaching_prices(program_id,duration_minutes,coach_user_id,amount_minor,currency)
    VALUES ($1,60,$2,9900,'RON')`, [created.id, adminCoach.id])).rejects.toMatchObject({ driverError: { code: "23503" } });
  await expect(database.query(`INSERT INTO public.coaching_prices(program_id,duration_minutes,amount_minor,currency)
    VALUES ($1,60,1,'RON')`, [created.id])).rejects.toMatchObject({ driverError: { code: "23505" } });
  await expect(database.query(`INSERT INTO public.coaching_prices(program_id,duration_minutes,coach_user_id,amount_minor,currency)
    VALUES ($1,60,$2,1,'RON')`, [created.id, coach.id])).rejects.toMatchObject({ driverError: { code: "23505" } });
  const stored = await database.query(`SELECT coach_user_id,amount_minor,currency FROM public.coaching_prices WHERE program_id=$1 ORDER BY coach_user_id NULLS FIRST`, [created.id]);
  expect(stored).toEqual([{ coach_user_id: null, amount_minor: 12550, currency: "RON" }, { coach_user_id: coach.id, amount_minor: 15000, currency: "RON" }]);

  // Location edits keep the profile and prices saved above.
  const anaProfile = { display_name: "Ana Integration", bio: "New bio.", qualifications: "Level 3",
    specialties: ["Footwork", "Juniors"], languages: ["Romanian", "English"] };
  expect(await saveCoachProfile({ user_id: coach.id, create: false, fields: coachFields({ ...anaProfile, location_ids: [locationIds[1]] }) }, admin.client)).toEqual({ ok: true, id: coach.id });
  expect(await saveCoachProfile({ user_id: coach.id, create: false, fields: coachFields({ ...anaProfile, location_ids: locationIds }) }, admin.client)).toEqual({ ok: true, id: coach.id });
  expect(await saveCoachingProgram({ id: created.id, fields: { ...programFields, durations: [60] } }, admin.client)).toEqual({ ok: true, id: created.id });

  // Public visibility and resolution.
  const visible = [{ id: locationIds[0], name: "Coaching East", currency: "RON" as const }];
  const ours = async () => {
    const result = await readPublicCoaching(visible);
    return { programs: result.programs.filter((program) => programIds.includes(program.id)), coaches: result.coaches.filter((item) => userIds.includes(item.id)) };
  };
  let published = await ours();
  expect(published.programs[0].prices).toEqual([{ durationMinutes: 60, amountMinor: 12550, currency: "RON" }]);
  expect(published.coaches.map((item) => item.displayName)).toEqual(["Second Coach"]);
  expect(await setCoachVisibility({ user_id: coach.id, is_public: true }, admin.client)).toEqual({ ok: true, id: coach.id });
  expect(await setCoachVisibility({ user_id: suspendedCoach.id, is_public: true }, admin.client)).toEqual({ ok: false, reason: "not-eligible" });
  // A suspended account is hidden publicly and cannot be made public again.
  expect(await setCoachVisibility({ user_id: adminCoach.id, is_public: false }, admin.client)).toEqual({ ok: true, id: adminCoach.id });
  assert.strictEqual((await service.from("users").update({ status: "suspended" }).eq("id", adminCoach.id)).error, null);
  expect(await setCoachVisibility({ user_id: adminCoach.id, is_public: true }, admin.client)).toEqual({ ok: false, reason: "not-eligible" });
  expect((await loadAdminCoaching(admin.client)).coaches.find((item) => item.user_id === adminCoach.id)?.ineligibility).toBe("suspended");
  await expect(loadCoachesPage({}, adminCoach.client)).rejects.toThrow();
  assert.strictEqual((await service.from("users").update({ status: "active" }).eq("id", adminCoach.id)).error, null);
  expect(await setCoachVisibility({ user_id: adminCoach.id, is_public: true }, admin.client)).toEqual({ ok: true, id: adminCoach.id });
  published = await ours();
  const ana = published.coaches.find((item) => item.id === coach.id);
  expect(ana).toMatchObject({ displayName: "Ana Integration", locations: [{ id: locationIds[0], name: "Coaching East" }],
    rates: [{ programId: created.id, durationMinutes: 60, amountMinor: 15000, currency: "RON" }] });
  expect(JSON.stringify(published)).not.toContain(coach.email);

  // Losing the coach role hides the coach publicly and blocks re-publication.
  assert.strictEqual((await service.from("user_roles").delete().eq("user_id", coach.id).eq("role_code", "coach")).error, null);
  expect((await ours()).coaches.map((item) => item.id)).not.toContain(coach.id);
  state = await loadAdminCoaching(admin.client);
  expect(state.coaches.find((item) => item.user_id === coach.id)?.ineligibility).toBe("no-coach-role");
  expect(await saveCoachProfile({ user_id: coach.id, create: false, fields: coachFields({ location_ids: locationIds, is_public: true }) }, admin.client))
    .toEqual({ ok: false, reason: "not-eligible" });
  assert.strictEqual((await service.from("user_roles").insert({ user_id: coach.id, role_code: "coach" })).error, null);

  // Currency change: the amount is never re-denominated or converted.
  assert.strictEqual((await service.from("locations").update({ currency: "EUR" }).eq("id", locationIds[0])).error, null);
  state = await loadAdminCoaching(admin.client);
  expect(state.prices.filter((price) => price.program_id === created.id).map((price) => price.currency)).toEqual(["RON", "RON"]);
  const afterChange = (await readPublicCoaching([{ ...visible[0], currency: "EUR" }])).programs.find((program) => program.id === created.id);
  expect(afterChange?.prices).toEqual([]);
  expect(await saveClubCoachingPrice({ ...key, currency: "EUR", amount: "30" }, admin.client)).toMatchObject({ ok: true });
  expect((await database.query("SELECT currency,amount_minor FROM public.coaching_prices WHERE program_id=$1 AND coach_user_id IS NULL ORDER BY currency", [created.id])))
    .toEqual([{ currency: "EUR", amount_minor: 3000 }, { currency: "RON", amount_minor: 12550 }]);

  // Removal and deactivation: the coach removes their own override; the club operation cannot address it.
  expect(await removeClubCoachingPrice({ ...key, coach_user_id: coach.id }, admin.client)).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await removeOwnCoachingPrice(key, coach.client)).toMatchObject({ ok: true });
  expect(await removeOwnCoachingPrice(key, coach.client)).toEqual({ ok: false, reason: "not-found" });
  expect(await removeClubCoachingPrice({ ...key, currency: "EUR" }, admin.client)).toMatchObject({ ok: true });
  expect(await setCoachingProgramStatus({ id: created.id, is_active: false }, admin.client)).toEqual({ ok: true, id: created.id });
  expect((await ours()).programs).toEqual([]);
  // A stored incomplete configuration is kept as is and cannot be activated until an Admin completes it.
  await database.query("UPDATE public.coaching_programs SET max_participants=NULL WHERE id=$1", [created.id]);
  expect(await setCoachingProgramStatus({ id: created.id, is_active: true }, admin.client)).toEqual({ ok: false, reason: "participants-required" });
  expect(await database.query("SELECT is_active,min_participants,max_participants FROM public.coaching_programs WHERE id=$1", [created.id]))
    .toEqual([{ is_active: false, min_participants: 1, max_participants: null }]);
  expect(await setCoachingProgramStatus({ id: created.id, is_active: false }, admin.client)).toEqual({ ok: true, id: created.id });
  await database.query("UPDATE public.coaching_programs SET max_participants=1 WHERE id=$1", [created.id]);
  expect((await ours()).coaches.find((item) => item.id === coach.id)?.programs).toEqual([]);

  // Browser roles have no direct access to coaching tables.
  for (const session of [member.client, admin.client, publicClient()]) {
    for (const table of ["coaching_programs", "coaching_prices", "coach_profiles", "coach_locations", "coach_programs", "coaching_program_durations"]) {
      expect((await session.from(table).select("*").limit(1)).error?.code).toBe("42501");
    }
    expect((await session.from("coaching_prices").insert({ program_id: created.id, duration_minutes: 60, amount_minor: 1, currency: "EUR" })).error?.code).toBe("42501");
  }
}, 60000);

test("coach pricing view resolves per active-location currency; assignment removal deletes only that coach's program overrides", async () => {
  const db = await getDataSource();
  const admin = await account(["admin"]), coach = await account(["coach"]), other = await account(["coach"]);
  const kept = await saveCoachingProgram({ fields: { ...programFields, name: "Pricing kept" } }, admin.client);
  const removed = await saveCoachingProgram({ fields: { ...programFields, name: "Pricing removed" } }, admin.client);
  assert.ok(kept.ok && removed.ok); programIds.push(kept.id, removed.id);
  const inactiveId = randomUUID();
  assert.strictEqual((await service.from("locations").insert({ id: inactiveId, name: "Pricing inactive", slug: `pricing-inactive-${inactiveId}`,
    timezone: "UTC", currency: "GBP", is_active: false })).error, null);
  try {
    // The inactive GBP location contributes no pricing currency.
    expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: coachFields({ location_ids: [...locationIds, inactiveId],
      program_ids: [kept.id, removed.id] }) }, admin.client)).toMatchObject({ ok: true });
    expect(await saveCoachProfile({ user_id: other.id, create: true, fields: coachFields({ program_ids: [removed.id] }) }, admin.client)).toMatchObject({ ok: true });
    const key = (programId: string, currency = "RON") => ({ program_id: programId, duration_minutes: 60, currency });
    expect(await saveClubCoachingPrice({ ...key(removed.id), amount: "100" }, admin.client)).toMatchObject({ ok: true });
    expect(await saveClubCoachingPrice({ ...key(kept.id), amount: "100" }, admin.client)).toMatchObject({ ok: true });
    for (const amount of ["140", "150"]) expect(await saveOwnCoachingPrice({ ...key(kept.id), amount }, coach.client)).toMatchObject({ ok: true });
    expect(await saveOwnCoachingPrice({ ...key(removed.id), amount: "130" }, coach.client)).toMatchObject({ ok: true });
    expect(await saveOwnCoachingPrice({ ...key(removed.id, "EUR"), amount: "30" }, coach.client)).toMatchObject({ ok: true });
    expect(await saveOwnCoachingPrice({ ...key(removed.id), amount: "90" }, other.client)).toMatchObject({ ok: true });
    // Without a club default, the coach's own price is still allowed.
    expect(await saveOwnCoachingPrice({ ...key(kept.id, "EUR"), duration_minutes: 90, amount: "45" }, coach.client)).toMatchObject({ ok: true });

    const view = await loadOwnCoachPricing(coach.client);
    assert.ok(view);
    expect(view.currencies).toEqual([{ currency: "EUR", location_names: ["Coaching West"] }, { currency: "RON", location_names: ["Coaching East"] }]);
    const cell = (programId: string, duration: number, currency: string) => view.rows.find((row) => row.program_id === programId
      && row.duration_minutes === duration && row.currency === currency);
    expect(view.rows).toHaveLength(8);
    expect(cell(kept.id, 60, "RON")).toMatchObject({ club_amount_minor: 10000, coach_amount_minor: 15000, effective: { amountMinor: 15000, source: "coach" } });
    expect(cell(kept.id, 90, "RON")).toMatchObject({ club_amount_minor: null, coach_amount_minor: null, effective: null });
    expect(cell(kept.id, 90, "EUR")).toMatchObject({ club_amount_minor: null, coach_amount_minor: 4500, effective: { amountMinor: 4500, source: "coach" } });
    // The other coach's override is never shown or used for this coach.
    expect((await loadOwnCoachPricing(other.client))?.rows.find((row) => row.program_id === removed.id && row.duration_minutes === 60 && row.currency === "RON"))
      .toMatchObject({ club_amount_minor: 10000, coach_amount_minor: 9000, effective: { amountMinor: 9000, source: "coach" } });
    expect(await removeOwnCoachingPrice(key(kept.id), coach.client)).toMatchObject({ ok: true });
    expect((await loadOwnCoachPricing(coach.client))?.rows.find((row) => row.program_id === kept.id && row.duration_minutes === 60 && row.currency === "RON"))
      .toMatchObject({ coach_amount_minor: null, effective: { amountMinor: 10000, source: "club" } });
    expect(await saveOwnCoachingPrice({ ...key(kept.id), amount: "150" }, coach.client)).toMatchObject({ ok: true });

    const prices = () => db.query(`SELECT program_id,duration_minutes,currency,coach_user_id,amount_minor FROM public.coaching_prices
      WHERE program_id = ANY($1::uuid[]) ORDER BY program_id,duration_minutes,currency,coach_user_id NULLS FIRST`, [[kept.id, removed.id]]);
    const before = await prices();
    // Location assignment changes keep every price.
    expect(await saveCoachProfile({ user_id: coach.id, create: false, fields: coachFields({ location_ids: [locationIds[1]],
      program_ids: [kept.id, removed.id] }) }, admin.client)).toMatchObject({ ok: true });
    expect(await prices()).toEqual(before);
    // A failure after the cleanup rolls back the overrides and the assignment together.
    const fault = vi.spyOn(coachingRepository, "changeCoachPrograms").mockRejectedValueOnce(new Error("Injected assignment failure"));
    await expect(saveCoachProfile({ user_id: coach.id, create: false, fields: coachFields({ location_ids: [locationIds[1]], program_ids: [kept.id] }) }, admin.client))
      .rejects.toThrow("Unable to save coaching");
    fault.mockRestore();
    expect(await prices()).toEqual(before);
    expect(await saveCoachProfile({ user_id: coach.id, create: false, fields: coachFields({ location_ids: [locationIds[1]], program_ids: [kept.id] }) }, admin.client))
      .toEqual({ ok: true, id: coach.id });
    expect(await prices()).toEqual(before.filter((price: { program_id: string; coach_user_id: string | null }) =>
      price.program_id !== removed.id || price.coach_user_id !== coach.id));
    expect(await db.query("SELECT program_id FROM public.coach_programs WHERE coach_user_id=$1", [coach.id])).toEqual([{ program_id: kept.id }]);
    expect(await db.query("SELECT program_id FROM public.coach_programs WHERE coach_user_id=$1", [other.id])).toEqual([{ program_id: removed.id }]);
    // The Admin still cannot address the coach's remaining override.
    expect(await removeClubCoachingPrice({ ...key(kept.id), coach_user_id: coach.id }, admin.client)).toMatchObject({ ok: false, reason: "invalid-input" });
  } finally {
    await db.query("DELETE FROM public.coach_locations WHERE location_id=$1", [inactiveId]);
    await db.query("DELETE FROM public.locations WHERE id=$1", [inactiveId]);
  }
});

test("duration edits clean all currencies, overrides and stale currencies atomically; program and coach deletion clean owned configuration", async () => {
  const admin = await account(["admin"]);
  const coach = await account(["coach"]);
  const created = await saveCoachingProgram({ fields: { ...programFields, name: "Lesson cleanup", durations: [60, 90, 120] } }, admin.client);
  assert.ok(created.ok); programIds.push(created.id);
  expect(await saveCoachingProgram({ fields: { ...programFields, program_type: "junior", durations: [45] } }, admin.client))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  const fields = { ...programFields, name: "Lesson cleanup", durations: [60, 90, 120] };
  expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: coachFields({ location_ids: locationIds, program_ids: [created.id] }) }, admin.client)).toMatchObject({ ok: true });
  const db = await getDataSource();
  for (const currency of ["RON", "EUR"]) for (const duration of [60, 90, 120]) {
    const price = { program_id: created.id, duration_minutes: duration, currency, amount: "125" };
    expect(await saveClubCoachingPrice(price, admin.client)).toMatchObject({ ok: true });
    expect(await saveOwnCoachingPrice(price, coach.client)).toMatchObject({ ok: true });
  }
  // A hidden old-currency price must also be removed.
  await db.query("UPDATE public.coaching_prices SET currency='USD' WHERE program_id=$1 AND duration_minutes=120 AND currency='RON'", [created.id]);
  await expect(db.query("INSERT INTO public.coaching_program_durations(program_id,duration_minutes) VALUES($1,45)", [created.id]))
    .rejects.toMatchObject({ driverError: { code: "23514" } });
  const prices = () => coachingRepository.listCoachingPrices(db.manager, { programId: created.id });
  const before = await prices();
  // Fail after price deletion: every deletion and the program update must roll back.
  const fault = vi.spyOn(coachingRepository, "removeCoachingProgramDurations").mockRejectedValueOnce(new Error("Injected duration cleanup failure"));
  await expect(saveCoachingProgram({ id: created.id, fields: { ...fields, durations: [60] } }, admin.client)).rejects.toThrow("Unable to save coaching");
  fault.mockRestore();
  expect(await prices()).toEqual(before);
  expect((await coachingRepository.listCoachingPrograms(db.manager)).find(p => p.id === created.id)?.durations).toEqual([60, 90, 120]);
  expect(await saveCoachingProgram({ id: created.id, fields: { ...fields, durations: [60] } }, admin.client)).toMatchObject({ ok: true });
  expect(await prices()).toEqual(before.filter(p => p.durationMinutes === 60));
  // Retained prices remain in both currencies; removed duration rows are gone.
  expect((await loadAdminCoaching(admin.client)).programs.find(p => p.id === created.id)?.durations).toEqual([60]);
  for (const session of [coach.client, publicClient()]) {
    await expect(deleteCoachingProgram({ id: created.id }, session)).rejects.toThrow();
    await expect(deleteCoachProfile({ user_id: coach.id }, session)).rejects.toThrow();
  }
  await db.query(`INSERT INTO public.coach_weekly_availability(coach_user_id,location_id,weekday,start_minute,end_minute,valid_from) VALUES($1,$2,0,600,660,'2000-01-01')`, [coach.id, locationIds[0]]);
  await db.query(`INSERT INTO public.coach_availability_exceptions(coach_user_id,exception_date,until_date,kind,note) VALUES($1,'2099-01-01','2099-01-01','unavailable','Away')`, [coach.id]);
  await db.query("INSERT INTO public.player_profiles(user_id,display_name) VALUES($1,'Player identity')", [coach.id]);
  const removeCoach = coachingRepository.removeCoachConfiguration;
  const coachFault = vi.spyOn(coachingRepository, "removeCoachConfiguration").mockImplementationOnce(async (...args) => {
    await removeCoach(...args); throw new Error("Injected coach cleanup failure");
  });
  await expect(deleteCoachProfile({ user_id: coach.id }, admin.client)).rejects.toThrow("Unable to save coaching");
  coachFault.mockRestore();
  expect(await db.query("SELECT 1 FROM public.coach_profiles WHERE user_id=$1", [coach.id])).toHaveLength(1);
  expect(await db.query("SELECT 1 FROM public.coach_weekly_availability WHERE coach_user_id=$1", [coach.id])).toHaveLength(1);
  expect(await db.query("SELECT 1 FROM public.coach_availability_exceptions WHERE coach_user_id=$1", [coach.id])).toHaveLength(1);
  expect(await prices()).toHaveLength(4);
  expect(await deleteCoachProfile({ user_id: coach.id }, admin.client)).toEqual({ ok: true, id: coach.id, archived: false });
  for (const table of ["coach_profiles", "coach_locations", "coach_programs", "coaching_prices", "coach_weekly_availability", "coach_availability_exceptions"]) {
    const column = table === "coach_profiles" ? "user_id" : "coach_user_id";
    expect(await db.query(`SELECT 1 FROM public.${table} WHERE ${column}=$1`, [coach.id])).toEqual([]);
  }
  expect((await service.auth.admin.getUserById(coach.id)).data.user?.id).toBe(coach.id);
  expect(await db.query("SELECT role_code FROM public.user_roles WHERE user_id=$1", [coach.id])).toEqual([{ role_code: "coach" }]);
  expect((await db.query("SELECT id FROM public.users WHERE id=$1", [coach.id]))).toHaveLength(1);
  expect(await db.query("SELECT display_name FROM public.player_profiles WHERE user_id=$1", [coach.id])).toEqual([{ display_name: "Player identity" }]);
  // Defaults survive coach removal, then program deletion removes them with its durations and other assignments.
  expect(await prices()).toHaveLength(2);
  const otherCoach = await account(["coach"]);
  expect(await saveCoachProfile({ user_id: otherCoach.id, create: true,
    fields: coachFields({ program_ids: [created.id] }) }, admin.client)).toMatchObject({ ok: true });
  const deleteProgram = coachingRepository.deleteUnusedProgram;
  const programFault = vi.spyOn(coachingRepository, "deleteUnusedProgram").mockImplementationOnce(async (...args) => {
    await deleteProgram(...args); throw new Error("Injected program cleanup failure");
  });
  await expect(deleteCoachingProgram({ id: created.id }, admin.client)).rejects.toThrow("Unable to save coaching");
  programFault.mockRestore();
  expect(await prices()).toHaveLength(2);
  expect((await coachingRepository.listCoachingPrograms(db.manager)).find(p => p.id === created.id)?.durations).toEqual([60]);
  expect(await deleteCoachingProgram({ id: created.id }, admin.client)).toEqual({ ok: true, id: created.id });
  expect(await prices()).toEqual([]);
  expect(await db.query("SELECT 1 FROM public.coach_programs WHERE program_id=$1", [created.id])).toEqual([]);
  expect(await db.query("SELECT 1 FROM public.coach_profiles WHERE user_id=$1", [otherCoach.id])).toHaveLength(1);
  expect((await coachingRepository.listCoachingPrograms(db.manager)).some(p => p.id === created.id)).toBe(false);

  // Deleting an unused Junior program also removes its club rates per player count.
  const junior = await saveCoachingProgram({ fields: { ...programFields, name: "Junior cleanup", program_type: "junior", min_participants: 4, max_participants: 8 } }, admin.client);
  assert.ok(junior.ok); programIds.push(junior.id);
  expect(await saveClubParticipantPrices({ program_id: junior.id, currency: "RON", prices: [{ participant_count: 4, amount: "50" }], removed: [] }, admin.client))
    .toEqual({ ok: true, id: junior.id });
  expect(await coachingRepository.listParticipantPrices(db.manager, { programIds: [junior.id] })).toHaveLength(1);
  expect(await deleteCoachingProgram({ id: junior.id }, admin.client)).toEqual({ ok: true, id: junior.id });
  expect(await coachingRepository.listParticipantPrices(db.manager, { programIds: [junior.id] })).toEqual([]);
});

test("booking history blocks program deletion and archives coaches without changing historical contracts or accounts", async () => {
  const { buildBookingRevision } = await import("@/lib/bookings/revision");
  const { insertCheckoutBooking } = await import("@/lib/db/repositories/bookings.repository");
  const { insertCustomerReservation } = await import("@/lib/db/repositories/reservations.repository");
  const { cleanupBookingFixtures } = await import("../checkout-fixtures");
  const { readPublicCoach } = await import("@/lib/coaching/public");
  const { createCoachingBooking } = await import("@/lib/coaching/booking");
  const db = await getDataSource();
  const admin = await account(["admin"]), coach = await account(["coach"]);
  const created = await saveCoachingProgram({ fields: programFields }, admin.client);
  assert.ok(created.ok); programIds.push(created.id);
  const courtId = randomUUID(), historicalId = randomUUID(), bookingId = randomUUID(), personalId = randomUUID(), holdId = randomUUID();
  try {
    expect(await saveCoachProfile({ user_id: coach.id, create: true, fields: coachFields({ program_ids: [created.id], is_public: true }) }, admin.client)).toMatchObject({ ok: true });
    await db.query(`INSERT INTO public.courts(id,location_id,name,slug,surface,environment) VALUES($1,$2,'Historical lesson','historical','clay','outdoor')`, [courtId, locationIds[0]]);
    await db.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,coach_user_id,status,hold_expires_at)
      VALUES($1,$2,'2099-01-01',600,660,$3,'held',clock_timestamp()+interval '10 minutes')`, [holdId, courtId, coach.id]);
    expect(await deleteCoachProfile({ user_id: coach.id }, admin.client)).toEqual({ ok: false, reason: "active-lessons" });
    expect(await db.query("SELECT status FROM public.court_reservations WHERE id=$1", [holdId])).toEqual([{ status: "held" }]);
    await db.query("UPDATE public.court_reservations SET status='active',hold_expires_at=NULL WHERE id=$1", [holdId]);
    expect(await deleteCoachProfile({ user_id: coach.id }, admin.client)).toEqual({ ok: false, reason: "active-lessons" });
    await db.query("DELETE FROM public.court_reservations WHERE id=$1", [holdId]);
    const evidence = { version: 1 as const, rounding: "half-hour-sum-round" as const, courtState: "outdoor" as const,
      coaching: { participantCount: 1 as const, programId: created.id, coachUserId: coach.id, locationId: locationIds[0], durationMinutes: 60,
        source: "club" as const, amountMinor: 10000, currency: "RON" as const, courtRentalIncluded: true, courtRentalMinor: 10000, courtAmountMinor: 0 },
      slots: [600, 630].map(minute => ({ minute, ruleId: randomUUID(), ruleSetId: randomUUID(), hourlyMinor: 10000, startsOn: null, endsOn: null })) };
    await db.transaction(async manager => {
      await insertCustomerReservation(manager, { id: historicalId, courtId, date: "2000-01-01", startMinute: 600, endMinute: 660, status: "active", holdExpiresAt: null, coachUserId: coach.id });
      const revision = buildBookingRevision({ locationId: locationIds[0], courtId, locationName: "Historical location", courtName: "Historical lesson", timezone: "UTC",
        bookingDate: "2000-01-01", startMinute: 600, endMinute: 660, customerName: "Historical guest", customerEmail: "history@example.test", customerPhone: "123",
        totalAmountMinor: 10000, currency: "RON", paymentMethod: "online", cancellationNoticeMinutes: 1440, pricingEvidence: evidence,
        coachUserId: coach.id, coachingProgramId: created.id, coachName: "Historical coach", coachingProgramName: "Historical program" },
      { id: randomUUID(), bookingId, kind: "created", operationKey: "created", intentHash: "fixture", bookingState: "confirmed", actorUserId: null,
        actorScope: "guest", recordedAt: new Date(), adjustmentId: null, cancellationCause: null }, null);
      await insertCheckoutBooking(manager, { id: bookingId, reservationId: historicalId, accountUserId: null, status: "confirmed", revision });
    });
    await db.query(`INSERT INTO public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,created_by_user_id,reason)
      VALUES($1,$2,'2099-01-02',600,660,$3,'Personal court booking')`, [personalId, courtId, coach.id]);
    const contract = await db.query("SELECT * FROM public.booking_revisions WHERE booking_id=$1", [bookingId]);
    // Removing the assignment deletes the coach's override but not the booked price snapshot.
    expect(await saveOwnCoachingPrice({ program_id: created.id, duration_minutes: 60, currency: "RON", amount: "200" }, coach.client)).toMatchObject({ ok: true });
    expect(await saveCoachProfile({ user_id: coach.id, create: false, fields: coachFields({ program_ids: [], is_public: true }) }, admin.client)).toEqual({ ok: true, id: coach.id });
    expect(await db.query("SELECT 1 FROM public.coaching_prices WHERE coach_user_id=$1", [coach.id])).toEqual([]);
    expect(await db.query("SELECT * FROM public.booking_revisions WHERE booking_id=$1", [bookingId])).toEqual(contract);
    expect(await deleteCoachingProgram({ id: created.id }, admin.client)).toEqual({ ok: false, reason: "has-bookings" });
    // Configuration edits do not touch historical duration, names or agreed price.
    expect(await saveCoachingProgram({ id: created.id, fields: { ...programFields, durations: [90], name: "Changed program" } }, admin.client)).toMatchObject({ ok: true });
    expect(await deleteCoachProfile({ user_id: coach.id }, admin.client)).toEqual({ ok: true, id: coach.id, archived: true });
    expect(await db.query("SELECT * FROM public.booking_revisions WHERE booking_id=$1", [bookingId])).toEqual(contract);
    expect(await db.query("SELECT status,coach_user_id FROM public.court_reservations WHERE id=$1", [historicalId])).toEqual([{ status: "active", coach_user_id: coach.id }]);
    expect(await db.query("SELECT status FROM public.court_reservations WHERE id=$1", [personalId])).toEqual([{ status: "active" }]);
    expect((await loadAdminCoaching(admin.client)).coaches.some(c => c.user_id === coach.id)).toBe(false);
    expect(await readPublicCoach(coach.id, [{ id: locationIds[0], name: "East", currency: "RON" }])).toBeNull();
    expect(await db.transaction(manager => coachingRepository.lockCoachProfileForBooking(manager, coach.id))).toBeNull();
    expect(await createCoachingBooking({ locationId: locationIds[0], programId: created.id, coachId: coach.id, courtId, date: "2099-01-01", startMinute: 600,
      durationMinutes: 90, participantCount: 1, customerName: "Guest", customerEmail: "guest@example.test", customerPhone: "123", expectedTotalAmountMinor: 10000, expectedCurrency: "RON" }, publicClient()))
      .toMatchObject({ ok: false, reason: "not-offered" });
    expect((await service.auth.admin.getUserById(coach.id)).data.user?.id).toBe(coach.id);
    expect(await db.query("SELECT role_code FROM public.user_roles WHERE user_id=$1", [coach.id])).toEqual([{ role_code: "coach" }]);
  } finally {
    await cleanupBookingFixtures({ courtIds: [courtId] });
    await db.query("DELETE FROM public.court_reservations WHERE court_id=$1", [courtId]);
    await db.query("DELETE FROM public.courts WHERE id=$1", [courtId]);
  }
});
