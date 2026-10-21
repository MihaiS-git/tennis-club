import { randomUUID } from "node:crypto";
import { afterAll, assert, expect, test } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { listPriceGroupsPage, listProgramsPage } from "@/lib/db/repositories/coaching-lists.repository";
import { priceFiltersSchema, programFiltersSchema } from "@/lib/coaching/admin-filters";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";

const service = localFixtureClient();
const users: string[] = [];
afterAll(async () => { await cleanupAuthFixtures(service, users); await (await getDataSource()).destroy(); });

test("program and grouped price queries filter, sort, count and paginate without duplicating coach scopes", async () => {
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
      "INSERT INTO public.locations(id,name,slug,timezone,currency) VALUES($1,$2,$3,'UTC','RON')", [location, `${prefix} location ${i}`, location]);
    for (const [i, program] of programs.entries()) {
      await runner.query(`INSERT INTO public.coaching_programs(id,name,description,program_type,court_rental_included,is_active)
        VALUES($1,$2,'',$3,true,$4)`, [program, `${prefix} ${String(i).padStart(2, "0")}`, i % 2 ? "group" : "private", i % 3 !== 0]);
      await runner.query("INSERT INTO public.coaching_program_durations(program_id,duration_minutes) VALUES($1,60),($1,90)", [program]);
      await runner.query(`INSERT INTO public.coaching_prices(program_id,duration_minutes,location_id,amount_minor,currency)
        VALUES($1,60,$2,$3,'RON')`, [program, locations[0], (i + 1) * 100]);
    }
    for (const [i, user] of users.entries()) {
      await runner.query("INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages,is_public) VALUES($1,$2,'','','{}','{}',false)", [user, `${prefix} coach ${i}`]);
      await runner.query("INSERT INTO public.coach_locations(coach_user_id,location_id) VALUES($1,$2)", [user, locations[0]]);
      for (const program of programs) {
        await runner.query("INSERT INTO public.coach_programs(coach_user_id,program_id) VALUES($1,$2)", [user, program]);
        await runner.query(`INSERT INTO public.coaching_prices(program_id,duration_minutes,location_id,coach_user_id,amount_minor,currency)
          VALUES($1,60,$2,$3,$4,'RON')`, [program, locations[0], user, i ? 20000 : 10000]);
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
    const prices = (input: Record<string, unknown>) => listPriceGroupsPage(runner.manager, priceFiltersSchema.parse(input));
    const groups = await prices({ search: prefix, location: locations[0], duration: "60" });
    expect(groups).toMatchObject({ total: 23, totalPages: 2 });
    expect(groups.groups.map(g => g.program_id)).toEqual(programs.slice(0, 20));
    expect(new Set(groups.groups.map(g => JSON.stringify(g))).size).toBe(20);
    expect(groups.prices).toHaveLength(60); // club + two coaches, not three group rows
    expect((await prices({ search: prefix, location: locations[0], duration: "60", page: "2" })).groups.map(g => g.program_id)).toEqual(programs.slice(20));
    for (const scope of ["club", "coach"]) expect((await prices({ search: prefix, location: locations[0], duration: "60", program: programs[0], scope })).total).toBe(1);
    expect((await prices({ search: `${prefix} coach`, scope: "club" })).total).toBe(0);
    const coachEmail = (await service.auth.admin.getUserById(users[0])).data.user?.email;
    assert.ok(coachEmail);
    expect((await prices({ search: coachEmail, scope: "coach", location: locations[0], duration: "60", program: programs[0], coach: users[0] })).total).toBe(1);
    expect((await prices({ search: coachEmail, location: locations[1] })).total).toBe(0);
    expect((await prices({ search: prefix, location: locations[0], duration: "60", scope: "club", sort: "amount", dir: "desc" })).groups[0].program_id).toBe(programs[22]);
    expect((await prices({ search: prefix, location: locations[0], duration: "60", scope: "club", sort: "amount", dir: "asc" })).groups[0].program_id).toBe(programs[0]);
    expect((await prices({ search: prefix, program: programs[0], sort: "duration", dir: "desc" })).groups[0].duration_minutes).toBe(90);
    const [lastLocation] = await runner.query("SELECT id FROM public.locations WHERE archived_at IS NULL ORDER BY name DESC,id LIMIT 1");
    expect((await prices({ search: prefix, program: programs[0], sort: "location", dir: "desc" })).groups[0].location_id).toBe(lastLocation.id);
    expect((await prices({ search: prefix, location: locations[0], duration: "90", scope: "coach" })).total).toBe(0);
    expect((await prices({ search: prefix, location: locations[1], scope: "club" })).total).toBe(0);
    expect((await prices({ search: "No such program or coach" })).total).toBe(0);
    // Combined search, filter and sort apply to every matching group before pagination.
    // Without a location filter every unarchived location offers a group per program,
    // so expectations come from an independent read of the locations, not just this fixture's two.
    const eligible = (await runner.query("SELECT id FROM public.locations WHERE archived_at IS NULL") as { id: string }[]).map(l => l.id);
    expect(eligible).toEqual(expect.arrayContaining(locations));
    const unpriced = eligible.filter(id => id !== locations[0]).sort();
    const total = programs.length * eligible.length, totalPages = Math.ceil(total / 20);
    const sorted = { search: prefix, duration: "60", sort: "amount", dir: "desc" };
    const pages = [];
    for (let page = 1; page <= totalPages; page++) pages.push(await prices({ ...sorted, page: String(page) }));
    expect(pages.map(p => [p.total, p.page, p.totalPages, p.groups.length]))
      .toEqual(pages.map((_, i) => [total, i + 1, totalPages, Math.min(20, total - i * 20)]));
    const all = pages.flatMap(p => p.groups);
    const keys = all.map(g => `${g.program_id}:${g.location_id}:${g.duration_minutes}`);
    expect(new Set(keys).size).toBe(total);
    expect(new Set(keys)).toEqual(new Set(programs.flatMap(p => eligible.map(l => `${p}:${l}:60`))));
    // Lowest matching amount per group, descending, unset groups (every other location) last by program and location.
    expect(all.slice(0, 23).map(g => [g.program_id, g.location_id])).toEqual([...programs].reverse().map(p => [p, locations[0]]));
    expect(all.slice(23).map(g => [g.program_id, g.location_id])).toEqual([...programs].sort().flatMap(p => unpriced.map(l => [p, l])));
    // Club plus both coaches price each priced group; unset groups carry none.
    const listed = pages.flatMap(p => p.prices);
    expect(listed).toHaveLength(23 * 3);
    expect(listed.every(price => price.locationId === locations[0] && price.durationMinutes === 60 && programs.some(id => id === price.programId))).toBe(true);
    for (const page of ["0", "-1", "bad", "2.5"]) expect((await prices({ ...sorted, page })).page).toBe(1);
    expect((await prices({ ...sorted, page: "999" })).groups).toEqual(pages.at(-1)?.groups);
  } finally {
    await runner.rollbackTransaction(); await runner.release();
  }
});
