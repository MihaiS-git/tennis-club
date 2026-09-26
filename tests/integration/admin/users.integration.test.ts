import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { assert, expect, test, vi } from "vitest";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { ensureIntegrationAdminAnchor } from "../admin-anchor";

vi.mock("server-only", () => ({}));

import { listAdminUsers } from "../../../src/lib/admin/users";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
if (!supabaseUrl || !publishableKey) {
  throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required.");
}

function localServiceRoleKey(): string {
  if (process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY) {
    return process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
  }
  const status = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
  });
  return z.object({ SERVICE_ROLE_KEY: z.string().min(1) }).parse(JSON.parse(status))
    .SERVICE_ROLE_KEY;
}

function client(key = publishableKey) {
  return createClient(supabaseUrl, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    db: { schema: "public" },
  });
}

test("admin user listing is authorized, ordered, bounded, and includes roles", async () => {
  const service = client(localServiceRoleKey());
  await ensureIntegrationAdminAnchor(service);
  const createdIds: string[] = [];
  const runId = randomUUID();
  const password = "admin-users-password-123";

  async function createUser(label: string) {
    const email = `admin-users-${runId}-${label}@example.test`;
    const result = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    assert.strictEqual(result.error, null);
    assert.ok(result.data.user);
    createdIds.push(result.data.user.id);
    return { id: result.data.user.id, email };
  }

  async function signIn(email: string) {
    const user = client();
    const result = await user.auth.signInWithPassword({ email, password });
    assert.strictEqual(result.error, null);
    return user;
  }

  try {
    const admin = await createUser("admin");
    const adminRole = await service.from("user_roles").insert({
      user_id: admin.id,
      role_code: "admin",
    });
    assert.strictEqual(adminRole.error, null);

    const oldest = await createUser("oldest");
    for (let index = 0; index < 29; index += 1) {
      await createUser(`filler-${String(index).padStart(2, "0")}`);
    }

    const coachOnly = await createUser("solo-coach");
    assert.strictEqual((await service.from("user_roles").insert({ user_id: coachOnly.id, role_code: "coach" })).error, null);
    const member = await createUser("member");
    const coach = await createUser("coach");
    const coachRole = await service.from("user_roles").insert({
      user_id: coach.id,
      role_code: "coach",
    });
    assert.strictEqual(coachRole.error, null);

    const suspendedAdmin = await createUser("suspended-admin");
    const suspendedRole = await service.from("user_roles").insert({
      user_id: suspendedAdmin.id,
      role_code: "admin",
    });
    assert.strictEqual(suspendedRole.error, null);
    const suspension = await service.from("users").update({ status: "suspended" })
      .eq("id", suspendedAdmin.id);
    assert.strictEqual(suspension.error, null);

    // Give fixture users identical creation times to exercise the UUID tiebreaker.
    const tie = await service.from("users").update({ created_at: "2020-01-01T00:00:00Z" }).in("id", createdIds);
    assert.strictEqual(tie.error, null);
    const additionalAdmin = await service.from("user_roles").insert({ user_id: coach.id, role_code: "admin" });
    assert.strictEqual(additionalAdmin.error, null);

    const adminSession = await signIn(admin.email);
    const allCount = await service.from("users").select("id", { count: "exact", head: true });
    assert.strictEqual(allCount.error, null);
    const defaultResult = await listAdminUsers({}, adminSession);
    expect(defaultResult.users).toHaveLength(20);
    expect(defaultResult.pageSize).toBe(20);
    expect(defaultResult.total).toBe(allCount.count);

    const search = `admin-users-${runId}`;
    const first = await listAdminUsers({ search }, adminSession);
    const second = await listAdminUsers({ search, page: 2 }, adminSession);
    expect(first.total).toBe(createdIds.length);
    expect(first.totalPages).toBe(2);
    expect(first.users).toHaveLength(20);
    expect(second.users).toHaveLength(createdIds.length - 20);
    expect(second.page).toBe(2);
    expect([...first.users, ...second.users].map((row) => row.id)).toEqual([...createdIds].sort().reverse());
    const rows = [...first.users, ...second.users];
    for (const row of rows) {
      expect(Number.isNaN(Date.parse(row.updated_at))).toBe(false);
    }
    expect(rows.find((row) => row.id === member.id)?.roles).toEqual([]);
    expect(rows.find((row) => row.id === coach.id)?.roles).toEqual(["admin", "coach"]);
    expect(rows.find((row) => row.id === suspendedAdmin.id)?.status).toBe("suspended");
    expect(rows.some((row) => row.id === oldest.id)).toBe(true);

    const trimmed = await listAdminUsers({ search: `  ${search.toUpperCase()}  ` }, adminSession);
    expect(trimmed).toEqual(first);
    const partial = await listAdminUsers({ search: `${runId}-coach@` }, adminSession);
    expect(partial.users.map((row) => row.id)).toEqual([coach.id]);
    const active = await listAdminUsers({ search, status: "active" }, adminSession);
    expect(active.total).toBe(createdIds.length - 1);
    expect(active.users.every((row) => row.status === "active")).toBe(true);
    const suspended = await listAdminUsers({ search, status: "suspended" }, adminSession);
    expect(suspended.users.map((row) => row.id)).toEqual([suspendedAdmin.id]);
    const coaches = await listAdminUsers({ search, role: "coach" }, adminSession);
    expect(coaches.total).toBe(2);
    expect(coaches.users.find((row) => row.id === coach.id)?.roles).toEqual(["admin", "coach"]);
    const admins = await listAdminUsers({ search, role: "admin" }, adminSession);
    expect(admins.total).toBe(3);
    expect(admins.users.every((row) => row.roles.includes("admin"))).toBe(true);
    const combined = await listAdminUsers({ search, status: "suspended", role: "admin" }, adminSession);
    expect(combined.total).toBe(1);
    expect(combined.users[0].id).toBe(suspendedAdmin.id);
    for (const page of [0, -1, 1.5, Number.NaN]) {
      expect(await listAdminUsers({ search, page }, adminSession)).toEqual(first);
    }
    expect(await listAdminUsers({ search, page: 9999 }, adminSession)).toEqual(second);
    expect(await listAdminUsers({ search: "   " }, adminSession)).toEqual(defaultResult);
    const empty = await listAdminUsers({ search: "no-such-email-" + runId }, adminSession);
    expect(empty).toEqual({ users: [], total: 0, totalPages: 0, page: 1, pageSize: 20 });
    // Search terms are filter values, never fragments of PostgREST boolean syntax.
    expect((await listAdminUsers({ search: `${runId}%,status.eq.active` }, adminSession)).total).toBe(0);
    expect((await listAdminUsers({ search: `%${runId}` }, adminSession)).total).toBe(0);
    expect((await listAdminUsers({ search: `_${runId}` }, adminSession)).total).toBe(0);
    expect((await listAdminUsers({ search: `*${runId}` }, adminSession)).total).toBe(0);
    expect((await listAdminUsers({ search: member.email }, adminSession)).users.map((row) => row.id)).toEqual([member.id]);
    expect((await listAdminUsers({ search: member.id }, adminSession)).total).toBe(0);

    // Compare complete multi-page results against independent fixture expectations.
    // Vary chronology to exercise joined ordering beyond the shared-time tie test.
    assert.strictEqual((await service.from("users").update({ created_at: "2019-01-01T00:00:00Z" }).eq("id", oldest.id)).error, null);
    const expectedRows = rows.map((row) => row.id === oldest.id ? { ...row, created_at: "2019-01-01T00:00:00Z" } : row);
    const roleKey = (roles: string[]) => (roles.includes("admin") ? 2 : 0) + (roles.includes("coach") ? 1 : 0);
    expect(new Set(expectedRows.map((row) => roleKey(row.roles)))).toEqual(new Set([0, 1, 2, 3]));
    for (const sort of ["email", "status", "joined", "roles"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const expected = [...expectedRows].sort((a, b) => {
          const key = (row: typeof a) => sort === "roles" ? roleKey(row.roles) : sort === "joined" ? Date.parse(row.created_at) : row[sort];
          const ak = key(a), bk = key(b);
          const comparison = ak < bk ? -1 : ak > bk ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
          return dir === "asc" ? comparison : -comparison;
        });
        const firstSorted = await listAdminUsers({ search, sort, dir }, adminSession);
        const secondSorted = await listAdminUsers({ search, sort, dir, page: 2 }, adminSession);
        expect(firstSorted.total).toBe(createdIds.length);
        expect(firstSorted.users.map((row) => row.id)).toEqual(expected.slice(0, 20).map((row) => row.id));
        expect(secondSorted.users.map((row) => row.id)).toEqual(expected.slice(20).map((row) => row.id));
        expect(await listAdminUsers({ search, sort, dir, page: 9999 }, adminSession)).toEqual(secondSorted);
        const combinedSorted = await listAdminUsers({ search, status: "active", sort, dir, page: 2 }, adminSession);
        const activeExpected = expected.filter((row) => row.status === "active");
        expect(combinedSorted.total).toBe(activeExpected.length);
        expect(combinedSorted.users.map((row) => row.id)).toEqual(activeExpected.slice(20).map((row) => row.id));
        const roleSorted = await listAdminUsers({ search, role: "coach", sort, dir }, adminSession);
        expect(roleSorted.total).toBe(2);
        expect(roleSorted.users.map((row) => row.id)).toEqual(expected.filter((row) => row.roles.includes("coach")).map((row) => row.id));
        expect(roleSorted.users.find((row) => row.id === coach.id)?.roles).toEqual(["admin", "coach"]);
      }
    }

    const memberSession = await signIn(member.email);
    await expect(listAdminUsers({}, memberSession)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    await expect(listAdminUsers({ sort: "roles" }, memberSession)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    const visibleKeys = await memberSession.from("user_role_sort_keys").select("id, role_sort_key");
    expect(visibleKeys.error).toBeNull();
    expect(visibleKeys.data).toEqual([{ id: member.id, role_sort_key: 0 }]);

    const suspendedSession = await signIn(suspendedAdmin.email);
    await expect(listAdminUsers({}, suspendedSession)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  } finally {
    for (const id of createdIds.reverse()) {
      const roles = await service.from("user_roles").delete().eq("user_id", id);
      assert.strictEqual(roles.error, null);
      const account = await service.from("users").delete().eq("id", id);
      assert.strictEqual(account.error, null);
      const result = await service.auth.admin.deleteUser(id);
      assert.strictEqual(result.error, null);
    }
  }
}, 180_000);
