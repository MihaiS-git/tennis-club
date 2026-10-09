import { assertTestEnvironment } from "../../local/environment.mjs";

export function localServiceRoleKey(): string {
  assertTestEnvironment();
  return process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY!;
}
