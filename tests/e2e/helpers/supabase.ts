import { execFileSync } from "node:child_process";
import { z } from "zod";

const localStatusSchema = z.object({ SERVICE_ROLE_KEY: z.string().min(1) });

export function localServiceRoleKey(): string {
  const configured = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
  if (configured) return configured;

  let status: string;
  try {
    // Capture routine status diagnostics; thrown CLI errors can contain credentials.
    status = execFileSync("supabase", ["status", "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Unable to run supabase status for E2E setup. Start local Supabase or set LOCAL_SUPABASE_SERVICE_ROLE_KEY.");
  }

  try {
    return localStatusSchema.parse(JSON.parse(status)).SERVICE_ROLE_KEY;
  } catch {
    throw new Error("Invalid local Supabase status for E2E setup. Expected JSON with a non-empty SERVICE_ROLE_KEY.");
  }
}
