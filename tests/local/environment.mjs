import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const workdir = resolve("tests/local");
const cli = resolve("node_modules/supabase/dist/supabase.js");
const statusSchema = z.object({
  API_URL: z.literal("http://127.0.0.1:55321"),
  DB_URL: z.string().min(1),
  ANON_KEY: z.string().min(1),
  SERVICE_ROLE_KEY: z.string().min(1),
  MAILPIT_URL: z.literal("http://127.0.0.1:55324"),
});

/** @param {string | undefined} value */
function assertDatabase(value) {
  const url = new URL(value ?? "");
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1"
    || url.port !== "55322" || url.pathname !== "/postgres"
    || url.username !== "postgres" || url.search || url.hash) {
    throw new Error("Tests require the isolated PostgreSQL database at 127.0.0.1:55322/postgres.");
  }
}

// Called before any test fixture or database connection; no development fallback.
export function assertTestEnvironment() {
  assertDatabase(process.env.DATABASE_URL);
  if (process.env.LOCAL_SUPABASE_DB_URL !== process.env.DATABASE_URL
    || process.env.SUPABASE_URL !== "http://127.0.0.1:55321"
    || process.env.MAILPIT_URL !== "http://127.0.0.1:55324"
    || process.env.TEST_SUPABASE_PROJECT !== "tennis-club-tests"
    || !process.env.SUPABASE_PUBLISHABLE_KEY || !process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Use the isolated test runner; development and remote Supabase are forbidden.");
  }
}

export function configureTestEnvironment() {
  const config = readFileSync(resolve(workdir, "supabase/config.toml"), "utf8");
  if (!/^project_id = "tennis-club-tests"$/m.test(config)) {
    throw new Error("Unexpected test Supabase project identity.");
  }
  let status;
  try {
    status = statusSchema.parse(JSON.parse(execFileSync(process.execPath,
      [cli, "status", "--workdir", workdir, "-o", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })));
  } catch {
    throw new Error("Cannot verify test Supabase. Run npx supabase start --workdir tests/local, then initialize it as documented in docs/testing.md.");
  }
  assertDatabase(status.DB_URL);
  // Explicit values win over shell settings and Next.js .env.local loading.
  Object.assign(process.env, {
    DATABASE_URL: status.DB_URL,
    LOCAL_SUPABASE_DB_URL: status.DB_URL,
    SUPABASE_URL: status.API_URL,
    SUPABASE_PUBLISHABLE_KEY: status.ANON_KEY,
    LOCAL_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    SUPABASE_SECRET_KEY: "",
    MAILPIT_URL: status.MAILPIT_URL,
    TEST_SUPABASE_PROJECT: "tennis-club-tests",
    APP_URL: "http://localhost:3000",
    PLAYWRIGHT_APP_URL: "http://localhost:3000",
    BREVO_API_KEY: "",
    BOOKING_MAIL_FROM: "",
    STRIPE_SECRET_KEY: "",
    STRIPE_PUBLISHABLE_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    NETOPIA_API_KEY: "",
    NETOPIA_POS_SIGNATURE: "",
    NETOPIA_ENVIRONMENT: "",
    PGOPTIONS: "",
  });
  assertTestEnvironment();
}
