import { randomUUID } from "node:crypto";
import { afterAll, assert, expect, test } from "vitest";
import { DEMO_COACH_PASSWORD, demoCoaches, demoPrograms, seedCoachingData } from "../../scripts/seed-dev-coaching";
import { ensureLocalAuthAccounts } from "../../scripts/local-dev";
import { readPublicCoach } from "../../src/lib/coaching/public";
import { getDataSource } from "../../src/lib/db/data-source";
import { cleanupAuthFixtures, localFixtureClient } from "./auth-fixtures";

const service = localFixtureClient();
const programIds = demoPrograms.map((program) => program.id);
const emails = demoCoaches.map((coach) => coach.email);
const ron = { id: randomUUID(), name: "Seed East", currency: "RON" as const };
const eur = { id: randomUUID(), name: "Seed West", currency: "EUR" as const };
const visible = [ron, eur];

async function coachIds() {
  const rows: { id: string; email: string }[] = await (await getDataSource()).query(
    "SELECT id,email FROM public.users WHERE email = ANY($1::text[])", [emails]);
  return new Map(rows.map((row) => [row.email, row.id]));
}

const seed = async () => (await getDataSource()).transaction("READ COMMITTED", (manager) =>
  seedCoachingData(manager, { locationIds: [ron.id, eur.id] }));

async function counts() {
  const [row]: { programs: number; durations: number; profiles: number; prices: number; duplicates: number }[] = await (await getDataSource()).query(`SELECT
    (SELECT count(*)::int FROM public.coaching_programs WHERE id = ANY($1::uuid[])) AS programs,
    (SELECT count(*)::int FROM public.coaching_program_durations WHERE program_id = ANY($1::uuid[])) AS durations,
    (SELECT count(*)::int FROM public.coach_profiles c JOIN public.users u ON u.id=c.user_id WHERE u.email = ANY($2::text[])) AS profiles,
    (SELECT count(*)::int FROM public.coaching_prices WHERE program_id = ANY($1::uuid[])) AS prices,
    (SELECT count(*)::int FROM (SELECT 1 FROM public.coaching_prices WHERE program_id = ANY($1::uuid[])
      GROUP BY program_id,duration_minutes,location_id,coach_user_id HAVING count(*) > 1) d) AS duplicates`, [programIds, emails]);
  return row;
}

afterAll(async () => {
  const database = await getDataSource();
  try {
    const ids = [...(await coachIds()).values()];
    await database.query("DELETE FROM public.coaching_prices WHERE program_id = ANY($1::uuid[]) OR location_id = ANY($2::uuid[])", [programIds, [ron.id, eur.id]]);
    await database.query("DELETE FROM public.coach_profiles WHERE user_id = ANY($1::uuid[])", [ids]);
    await database.query("DELETE FROM public.coaching_programs WHERE id = ANY($1::uuid[])", [programIds]);
    await database.query("DELETE FROM public.locations WHERE id = ANY($1::uuid[])", [[ron.id, eur.id]]);
    await cleanupAuthFixtures(service, ids);
  } finally {
    await database.destroy();
  }
});

test("the development coaching seed is idempotent, preserves edits and only publishes eligible coaches", async () => {
  assert.strictEqual((await service.from("locations").insert([
    { id: ron.id, name: ron.name, slug: `seed-east-${ron.id}`, timezone: "Europe/Bucharest", currency: "RON" },
    { id: eur.id, name: eur.name, slug: `seed-west-${eur.id}`, timezone: "Europe/Bucharest", currency: "EUR" },
  ])).error, null);
  // Accounts come from the supported Auth Admin provisioning; reruns reuse them.
  expect(await ensureLocalAuthAccounts(service, emails, DEMO_COACH_PASSWORD)).toEqual({ created: emails.length, reused: 0 });
  expect(await ensureLocalAuthAccounts(service, emails, DEMO_COACH_PASSWORD)).toEqual({ created: 0, reused: emails.length });
  const ids = await coachIds();
  const roles: { user_id: string }[] = await (await getDataSource()).query(
    "SELECT user_id FROM public.user_roles WHERE role_code='coach' AND user_id = ANY($1::uuid[])", [[...ids.values()]]);
  expect(roles).toHaveLength(0);

  const first = await seed();
  expect(first.programs).toEqual({ created: 4, kept: 0 });
  expect(first.coaches).toEqual({ created: emails.length, kept: 0 });
  expect(first.prices.clubCreated).toBeGreaterThan(0);
  expect(first.prices.overridesCreated).toBeGreaterThan(0);
  // Amounts are RON; the EUR location gets assignments but no prices.
  expect(first.locations).toEqual([{ name: ron.name, currency: "RON", priced: true }, { name: eur.name, currency: "EUR", priced: false }]);
  const afterFirst = await counts();
  expect(afterFirst).toMatchObject({ programs: 4, profiles: emails.length, duplicates: 0 });
  const database = await getDataSource();
  expect(await database.query("SELECT DISTINCT location_id::text, currency FROM public.coaching_prices WHERE program_id = ANY($1::uuid[])", [programIds]))
    .toEqual([{ location_id: ron.id, currency: "RON" }]);
  // Every seeded profile belongs to an active account that now holds the coach role.
  expect(await database.query(`SELECT count(*)::int AS eligible FROM public.coach_profiles c JOIN public.users u ON u.id=c.user_id
    WHERE u.email = ANY($1::text[]) AND u.status='active' AND c.is_public
      AND EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id=u.id AND r.role_code='coach')`, [emails])).toEqual([{ eligible: emails.length }]);

  // Admin edits survive a rerun, which creates nothing new.
  await database.query("UPDATE public.coaching_programs SET name='Renamed by Admin' WHERE id=$1", [programIds[0]]);
  await database.query("UPDATE public.coaching_prices SET amount_minor=12345 WHERE program_id=$1 AND coach_user_id IS NULL AND duration_minutes=60", [programIds[0]]);
  const second = await seed();
  expect(second.programs).toEqual({ created: 0, kept: 4 });
  expect(second.coaches).toEqual({ created: 0, kept: emails.length });
  expect(second.prices).toMatchObject({ clubCreated: 0, overridesCreated: 0, kept: first.prices.clubCreated + first.prices.overridesCreated });
  expect(await counts()).toEqual(afterFirst);
  expect(await database.query("SELECT name FROM public.coaching_programs WHERE id=$1", [programIds[0]])).toEqual([{ name: "Renamed by Admin" }]);

  // The public profile resolves overrides before club defaults, in the location currency.
  const andrei = ids.get("demo-coach-andrei@example.test")!;
  const profile = await readPublicCoach(andrei, visible);
  assert.ok(profile);
  expect(profile.locations.map((location) => location.name)).toEqual([ron.name, eur.name]);
  expect(profile.programs.map((program) => program.name).sort()).toEqual(["Renamed by Admin", "Semi-private coaching"]);
  const lesson = (location: string, program: string, minutes: number) => profile.lessons
    .find((item) => item.locationId === location && item.programId === program && item.durationMinutes === minutes)?.price;
  expect(lesson(ron.id, programIds[0], 60)).toEqual({ amountMinor: 25000, currency: "RON", source: "coach" });
  expect(lesson(ron.id, programIds[1], 60)).toEqual({ amountMinor: 26000, currency: "RON", source: "club" });
  expect(lesson(eur.id, programIds[0], 60)).toBeNull();
  expect(JSON.stringify(profile)).not.toMatch(/@example\.test|email|status|avatar/);
  expect(await readPublicCoach(randomUUID(), visible)).toBeNull();
  expect(await readPublicCoach("not-a-uuid", visible)).toBeNull();

  // Hidden, suspended and role-less coaches are not public.
  const maria = ids.get("demo-coach-maria@example.test")!;
  await database.query("UPDATE public.coach_profiles SET is_public=false WHERE user_id=$1", [maria]);
  expect(await readPublicCoach(maria, visible)).toBeNull();
  await database.query("UPDATE public.coach_profiles SET is_public=true WHERE user_id=$1", [maria]);
  assert.ok(await readPublicCoach(maria, visible));
  assert.strictEqual((await service.from("user_roles").delete().eq("user_id", maria).eq("role_code", "coach")).error, null);
  expect(await readPublicCoach(maria, visible)).toBeNull();
  assert.strictEqual((await service.from("user_roles").insert({ user_id: maria, role_code: "coach" })).error, null);
  assert.strictEqual((await service.from("users").update({ status: "suspended" }).eq("id", maria)).error, null);
  expect(await readPublicCoach(maria, visible)).toBeNull();

  // The seed refuses an ineligible seed account and rolls back without changes.
  await expect(seed()).rejects.toThrow(/demo-coach-maria@example\.test is not an active coach account/);
  expect(await counts()).toEqual(afterFirst);
  assert.strictEqual((await service.from("users").update({ status: "active" }).eq("id", maria)).error, null);
});
