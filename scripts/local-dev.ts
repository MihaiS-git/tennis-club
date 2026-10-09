// Shared guard for development initialization; never imported by application code.
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
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

export function localAuthClient() {
  assertLocalDatabase();
  const url = localSupabaseUrl(process.env.SUPABASE_URL, process.env.NODE_ENV);
  const key = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY?.trim() || localStatus().SERVICE_ROLE_KEY;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { fetch: (input, init) => fetch(input, { ...init, redirect: "error" }) },
  });
}
