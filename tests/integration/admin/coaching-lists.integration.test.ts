import { randomUUID } from "node:crypto";
import { afterAll, assert, expect, test } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { listProgramsPage } from "@/lib/db/repositories/coaching-lists.repository";
import { programFiltersSchema } from "@/lib/coaching/admin-filters";
import { listCoachingPrices } from "@/lib/db/repositories/coaching.repository";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";

const service = localFixtureClient();
const users: string[] = [];
afterAll(async () => { await cleanupAuthFixtures(service, users); await (await getDataSource()).destroy(); });

test("program queries filter, sort, count and paginate; coach override reads are scoped to listed coaches", async () => {
  for (let i = 0; i < 2; i++) {
    const result = await service.auth.admin.createUser({ email: `price-list-${randomUUID()}@example.test`, password: "price-list-password-123", email_confirm: true });
    assert.ok(result.data.user); users.push(result.data.user.id);
  }
  const database = await getDataSource();
  const runner = database.createQueryRunner();
  await runner.connect(); await runner.startTransaction();
  try {
    const prefix = `List ${randomUUID()}`;
    const locations = [randomUUID(), randomUUID()];
    const programs = Array.from({ length: 23 }, () => randomUUID());
    for (const [i, location] of locations.entries()) await runner.query(
      "INSERT INTO public.locations(id,name,slug,timezone,currency) VALUES($1,$2,$3,'UTC',$4)", [location, `${prefix} location ${i}`, location, i ? "EUR" : "RON"]);
    // Each program is for one player count (Private 1, Semi-private 2) and priced for that count.
    const players = (i: number) => i % 2 ? 2 : 1;
    for (const [i, program] of programs.entries()) {
      await runner.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,court_rental_included,is_active,min_participants,max_participants)
        VALUES($1,$2,'',$3,true,$4,$5,$5)`, [program, `${prefix} ${String(i).padStart(2, "0")}`, i % 2 ? "semi_private" : "private", i % 3 !== 0, players(i)]);
      await runner.query("INSERT INTO public.coaching_program_durations(program_id,duration_minutes) VALUES($1,60),($1,90)", [program]);
      await runner.query(`INSERT INTO public.coaching_prices(program_id,duration_minutes,participant_count,amount_minor,currency)
        VALUES($1,60,$2,$3,'RON')`, [program, players(i), (i + 1) * 100]);
    }
    for (const [i, user] of users.entries()) {
      await runner.query("INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages,is_public) VALUES($1,$2,'','','{}','{}',false)", [user, `${prefix} coach ${i}`]);
      await runner.query("INSERT INTO public.coach_locations(coach_user_id,location_id) VALUES($1,$2)", [user, locations[0]]);
      for (const [p, program] of programs.entries()) {
        await runner.query("INSERT INTO public.coach_programs(coach_user_id,program_id) VALUES($1,$2)", [user, program]);
        await runner.query(`INSERT INTO public.coaching_prices(program_id,duration_minutes,participant_count,coach_user_id,amount_minor,currency)
          VALUES($1,60,$2,$3,$4,'RON')`, [program, players(p), user, i ? 20000 : 10000]);
      }
    }
    const list = (input: unknown) => listProgramsPage(runner.manager, programFiltersSchema.parse(input));
    const first = await list({ search: prefix });
    expect(first).toMatchObject({ total: 23, page: 1, totalPages: 2 });
    expect(first.programs.map(p => p.id)).toEqual(programs.slice(0, 20));
    const last = await list({ search: prefix, page: "999" });
    expect(last.page).toBe(2); expect(last.programs.map(p => p.id)).toEqual(programs.slice(20));
    expect((await list({ search: `${prefix} 0`, type: "private", status: "active" })).programs.map(p => p.id)).toEqual([programs[2], programs[4], programs[8]]);
    expect((await list({ search: prefix, sort: "name", dir: "desc" })).programs[0].id).toBe(programs[22]);
    for (const sort of ["type", "status"]) {
      const asc = await list({ search: prefix, sort, dir: "asc" });
      const desc = await list({ search: prefix, sort, dir: "desc" });
      expect(sort === "type" ? asc.programs[0].programType : asc.programs[0].isActive)
        .not.toEqual(sort === "type" ? desc.programs[0].programType : desc.programs[0].isActive);
    }
    // The Coaches page reads only the listed coaches' own overrides, never club prices.
    const overrides = await listCoachingPrices(runner.manager, { coachUserIds: [users[0].toUpperCase()] });
    expect(overrides).toHaveLength(programs.length);
    expect(overrides.every(price => price.coachUserId === users[0] && price.amountMinor === 10000)).toBe(true);
    expect(await listCoachingPrices(runner.manager, { coachUserIds: [randomUUID()] })).toEqual([]);
  } finally {
    await runner.rollbackTransaction(); await runner.release();
  }
});
