// Development fixtures only. Never imported by application code.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const DEV_USER_PASSWORD = "Local-Tennis-Dev-2026!";

export function localSupabaseUrl(value: string | undefined, environment: string | undefined) {
  // Exact origins avoid alternate ports, URL credentials, paths, and disguised hosts.
  const allowed = ["http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321"];
  const origin = value?.replace(/\/$/, "");
  if (environment === "production" || !origin || !allowed.includes(origin)) {
    throw new Error("User seeding requires development mode and local Supabase on port 54321.");
  }
  // Pin localhost to the loopback address rather than depending on DNS.
  return origin === "http://localhost:54321" ? "http://127.0.0.1:54321" : origin;
}

export const devUsers = Array.from({ length: 60 }, (_, index) => {
  const number = index + 1;
  const roles = number % 20 === 0 ? ["admin", "coach"]
    : number % 10 === 0 ? ["admin"]
    : number % 5 === 0 ? ["coach"] : [];
  return {
    email: `dev-user-${String(number).padStart(3, "0")}@example.test`,
    roles,
    status: number % 7 === 0 ? "suspended" : "active",
  };
});

function localServiceRoleKey() {
  if (process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
  }
  try {
    return z.object({ SERVICE_ROLE_KEY: z.string().min(1) }).parse(
      JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8" })),
    ).SERVICE_ROLE_KEY;
  } catch {
    throw new Error("Unable to read local Supabase credentials. Start local Supabase or set LOCAL_SUPABASE_SERVICE_ROLE_KEY.");
  }
}

export async function seedDevUsers(service: SupabaseClient) {
  // Read Auth once (paginated), including accounts without an application row.
  const existing = new Set<string>();
  for (let page = 1; ; page += 1) {
    const result = await service.auth.admin.listUsers({ page, perPage: 1000 });
    if (result.error) throw new Error("Unable to list local Auth accounts.");
    for (const user of result.data.users) {
      if (user.email) existing.add(user.email.toLowerCase());
    }
    if (result.data.users.length < 1000) break;
  }

  const created: { id: string; status: string }[] = [];
  let reused = 0;
  for (const fixture of devUsers) {
    if (existing.has(fixture.email)) {
      // Existing accounts are never updated, even if their fixture data differs.
      reused += 1;
      continue;
    }
    const result = await service.auth.admin.createUser({
      email: fixture.email,
      password: DEV_USER_PASSWORD,
      email_confirm: true,
    });
    if (result.error || !result.data.user) {
      throw new Error(`Unable to create ${fixture.email}. Earlier fixtures may already exist; rerunning skips them.`);
    }
    const id = result.data.user.id;
    created.push({ id, status: fixture.status });
    const additionalRoles = fixture.roles;
    if (additionalRoles.length) {
      const roles = await service.from("user_roles").insert(
        additionalRoles.map((role_code) => ({ user_id: id, role_code })),
      );
      if (roles.error) throw new Error(`Unable to assign fixture roles to ${fixture.email}.`);
    }
  }

  // Establish all seeded administrators before suspending any newly created user.
  const suspendedIds = created.filter((user) => user.status === "suspended").map((user) => user.id);
  if (suspendedIds.length) {
    const result = await service.from("users").update({ status: "suspended" }).in("id", suspendedIds);
    if (result.error) throw new Error("Unable to suspend the newly created development fixtures.");
  }

  const result = await service.from("users")
    .select("email, status, user_roles!user_roles_user_id_fkey(role_code)")
    .in("email", devUsers.map((user) => user.email));
  if (result.error) throw new Error("Unable to verify development fixtures.");
  const parsed = z.array(z.object({
    email: z.string(),
    status: z.enum(["active", "suspended"]),
    user_roles: z.array(z.object({ role_code: z.enum(["coach", "admin"]) })),
  })).safeParse(result.data);
  if (!parsed.success || parsed.data.length !== 60) throw new Error("Expected exactly 60 provisioned development accounts.");
  for (const fixture of devUsers) {
    const row = parsed.data.find((user) => user.email === fixture.email);
    const roles = row?.user_roles.map((role) => role.role_code).sort().join(",");
    if (!row || row.status !== fixture.status || roles !== fixture.roles.join(",")) {
      throw new Error(`Fixture verification failed for ${fixture.email}. Existing accounts were preserved; inspect its status/roles manually.`);
    }
  }
  console.log(JSON.stringify({
    created: created.length, reused, verified: parsed.data.length,
    roles: { noRoles: 48, coach: 6, admin: 3, coachAdmin: 3 },
    status: { active: 52, suspended: 8 },
  }, null, 2));
}

async function main() {
  const url = localSupabaseUrl(process.env.SUPABASE_URL, process.env.NODE_ENV);
  const service = createClient(url, localServiceRoleKey(), {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    // Never follow an HTTP redirect to another origin with the privileged credential.
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: "error" }) },
  });
  await seedDevUsers(service);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Development user seeding failed.");
    process.exitCode = 1;
  });
}
