import { execFileSync } from "node:child_process";
import { assert } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export function localFixtureClient() {
  const url = process.env.SUPABASE_URL ?? "";
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname),
    "Auth fixture cleanup requires local Supabase.");
  const key = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY ?? z.object({
    SERVICE_ROLE_KEY: z.string().min(1),
  }).parse(JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
  }))).SERVICE_ROLE_KEY;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

export async function cleanupAuthFixtures(service: SupabaseClient, ids: string[]) {
  for (const id of [...ids].reverse()) {
    const account = await service.from("users").select("email").eq("id", id).maybeSingle();
    assert.strictEqual(account.error, null);
    assert.notStrictEqual(account.data?.email, "integration-admin-anchor@example.test",
      "The integration admin anchor must survive fixture cleanup.");
    const roles = await service.from("user_roles").delete().eq("user_id", id);
    assert.strictEqual(roles.error, null);
    const user = await service.from("users").delete().eq("id", id);
    assert.strictEqual(user.error, null);
    const auth = await service.auth.admin.deleteUser(id);
    assert.strictEqual(auth.error, null);
  }
}
