import { randomUUID } from "node:crypto";
import { afterAll, assert, expect, test } from "vitest";
import { getDataSource } from "@/lib/db/data-source";
import { listCoachesPage } from "@/lib/db/repositories/coaching-lists.repository";
import { coachFiltersSchema } from "@/lib/coaching/admin-filters";
import { cleanupAuthFixtures, localFixtureClient } from "../auth-fixtures";

const service = localFixtureClient();
const users: string[] = [];
afterAll(async () => {
  const database = await getDataSource();
  try {
    await cleanupAuthFixtures(service, users);
  } finally {
    await database.destroy();
  }
});

test("Coach-role population includes optional/archived profiles and suspended accounts with stable, duplicate-free pages", async () => {
  const prefix = `coach-list-${randomUUID()}`;
  for (let i = 0; i < 24; i++) {
    const result = await service.auth.admin.createUser({ email: `${prefix}-${String(i).padStart(2, "0")}@example.test`,
      password: "coaches-list-password-123", email_confirm: true });
    assert.strictEqual(result.error, null);
    assert.ok(result.data.user); users.push(result.data.user.id);
  }
  const runner = (await getDataSource()).createQueryRunner();
  await runner.connect(); await runner.startTransaction();
  try {
    for (const [i, user] of users.entries()) {
      await runner.query("UPDATE public.users SET first_name=$2,last_name=$3,status=$4,created_at='2026-01-01'::timestamptz + $5 * interval '1 day' WHERE id=$1",
        [user, `First${i}`, `Last${i}`, i % 2 ? "suspended" : "active", i]);
      if (i !== 23) await runner.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'coach')", [user]);
      // A second role must not duplicate the account.
      if (i === 0) await runner.query("INSERT INTO public.user_roles(user_id,role_code) VALUES($1,'admin')", [user]);
      if (i % 3 !== 0) await runner.query(`INSERT INTO public.coach_profiles(user_id,display_name,bio,qualifications,specialties,languages,is_public,archived_at)
        VALUES($1,$2,'','','{}','{}',$3,CASE WHEN $4 THEN now() ELSE NULL END)`, [user, `Display${i}`, i % 3 === 1, i % 3 === 2]);
    }
    const list = (input: Record<string, unknown> = {}) => listCoachesPage(runner.manager, coachFiltersSchema.parse({ search: prefix, ...input }));
    const first = await list({ sort: "email" });
    const second = await list({ sort: "email", page: "2" });
    expect(first).toMatchObject({ total: 23, totalPages: 2, page: 1 });
    expect(first.coaches.map(c => c.user_id)).toEqual(users.slice(0, 20));
    expect(second.coaches.map(c => c.user_id)).toEqual(users.slice(20, 23));
    expect(new Set([...first.coaches, ...second.coaches].map(c => c.user_id)).size).toBe(23);
    expect((await list({ page: "999" })).page).toBe(2);
    expect((await list({ page: "bad" })).page).toBe(1);
    expect((await list({ profile: "not-configured" })).total).toBe(8);
    expect((await list({ profile: "archived" })).total).toBe(7);
    expect((await list({ profile: "configured" })).total).toBe(8);
    expect((await list({ status: "suspended", profile: "configured", visibility: "public" })).coaches.map(c => c.user_id))
      .toEqual([1, 13, 19, 7].map(index => users[index]));
    // Hidden covers private, unconfigured and archived profiles, matching the Visibility column.
    expect((await list({ profile: "not-configured", visibility: "private" })).total).toBe(8);
    expect((await list({ profile: "not-configured", visibility: "public" })).total).toBe(0);
    expect((await list({ status: "active", profile: "archived", visibility: "private" })).total).toBe(4);
    await runner.query("UPDATE public.coach_profiles SET is_public=true WHERE user_id=$1", [users[2]]);
    expect((await list({ profile: "archived", visibility: "public" })).total).toBe(0);
    expect((await list({ visibility: "public" })).total + (await list({ visibility: "private" })).total).toBe(23);
    for (const [search, id] of [["First0", users[0]], ["First3", users[3]], ["Last0", users[0]], ["Display22", users[22]], [`${prefix}-00@`, users[0]]]) {
      expect((await list({ search })).coaches.map(c => c.user_id)).toEqual([id]);
    }
    expect((await list({ search: "DISPLAY22" })).total).toBe(1);
    expect((await list({ search: "%" })).total).toBe(0);
    for (const sort of ["name", "email", "status", "profile", "created"]) {
      const asc = [...(await list({ sort })).coaches, ...(await list({ sort, page: "2" })).coaches];
      const desc = [...(await list({ sort, dir: "desc" })).coaches, ...(await list({ sort, dir: "desc", page: "2" })).coaches];
      const value = (c: typeof asc[number]) => sort === "name" ? c.name.toLowerCase() : sort === "email" ? c.email : sort === "status" ? c.account_status : sort === "profile" ? c.profile_status : users.indexOf(c.user_id);
      for (const [rows, direction] of [[asc, 1], [desc, -1]] as const) for (let i = 1; i < rows.length; i++) {
        const previous = value(rows[i - 1]), current = value(rows[i]);
        expect((previous < current ? -1 : previous > current ? 1 : 0) * direction).toBeLessThanOrEqual(0);
        if (previous === current) expect(rows[i - 1].user_id < rows[i].user_id).toBe(true);
      }
    }
    // Assignment fan-out does not affect the count or page size.
    for (let i = 0; i < 2; i++) {
      const location = randomUUID(), program = randomUUID();
      await runner.query("INSERT INTO public.locations(id,name,slug,timezone,currency) VALUES($1,'List location',$2,'UTC','RON')", [location, location]);
      await runner.query("INSERT INTO public.coaching_programs(id,name,description,program_type,court_rental_included) VALUES($1,'List program','','private',true)", [program]);
      await runner.query("INSERT INTO public.coach_locations(coach_user_id,location_id) VALUES($1,$2)", [users[1], location]);
      await runner.query("INSERT INTO public.coach_programs(coach_user_id,program_id) VALUES($1,$2)", [users[1], program]);
    }
    const assigned = await list({ search: `${prefix}-01@` });
    expect(assigned.total).toBe(1);
    expect(assigned.coaches[0].location_ids).toHaveLength(2);
    expect(assigned.coaches[0].program_ids).toHaveLength(2);
    expect((await list()).total).toBe(23);
  } finally { await runner.rollbackTransaction(); await runner.release(); }
}, 60000);
