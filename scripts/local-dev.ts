// Shared guard for development initialization; never imported by application code.
import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

function localSupabaseUrl(value: string | undefined, environment: string | undefined) {
  const allowed = ["http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321"];
  const origin = value?.replace(/\/$/, "");
  if (environment === "production" || !origin || !allowed.includes(origin)) {
    throw new Error("Development initialization requires local Supabase on port 54321 and non-production mode.");
  }
  return origin === "http://localhost:54321" ? "http://127.0.0.1:54321" : origin;
}

export function assertLocalDatabase() {
  localSupabaseUrl(process.env.SUPABASE_URL, process.env.NODE_ENV);
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.port !== "54322" || url.pathname !== "/postgres" || url.username !== "postgres"
    || url.search || url.hash) {
    throw new Error("Development initialization requires the local postgres database on port 54322.");
  }
  // Pin the connection to loopback; do not allow driver query-string overrides.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  process.env.DATABASE_URL = url.href;
}

export function localStatus() {
  try {
    return z.object({ API_URL: z.string().url(), DB_URL: z.string().url(), SERVICE_ROLE_KEY: z.string().min(1) })
      .parse(JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      })));
  } catch {
    throw new Error("Cannot read local Supabase status. Start this project's local Supabase stack.");
  }
}

// Creates missing confirmed local Auth accounts through the Auth Admin API; the
// provisioning hook creates their application rows. Existing accounts, including
// their passwords, are never updated.
export async function ensureLocalAuthAccounts(service: SupabaseClient, emails: readonly string[], password: string) {
  const existing = new Set<string>();
  for (let page = 1; ; page += 1) {
    const result = await service.auth.admin.listUsers({ page, perPage: 1000 });
    if (result.error) throw new Error("Unable to list local Auth accounts.");
    for (const user of result.data.users) {
      if (user.email) existing.add(user.email.toLowerCase());
    }
    if (result.data.users.length < 1000) break;
  }
  let created = 0;
  let reused = 0;
  for (const email of emails) {
    if (existing.has(email.toLowerCase())) {
      reused += 1;
      continue;
    }
    const result = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (result.error || !result.data.user) {
      throw new Error(`Unable to create ${email}. Earlier fixtures may already exist; rerunning skips them.`);
    }
    created += 1;
  }
  return { created, reused };
}

export function localAuthClient() {
  assertLocalDatabase();
  const url = localSupabaseUrl(process.env.SUPABASE_URL, process.env.NODE_ENV);
  const key = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY?.trim() || localStatus().SERVICE_ROLE_KEY;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: "error" }) },
  });
}
