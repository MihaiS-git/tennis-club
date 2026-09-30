// Run only against the standard local Supabase database; never accepts a remote DB URL.
import { execFileSync } from "node:child_process";
import { localSupabaseUrl } from "./seed-dev-users.ts";

localSupabaseUrl(process.env.SUPABASE_URL, process.env.NODE_ENV);
execFileSync("psql", [
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  "-v", "ON_ERROR_STOP=1",
  "-f", "scripts/reconcile-local-db.sql",
], { stdio: "inherit" });
