import { assert } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const anchorEmail = "integration-admin-anchor@example.test";

// Call only with the local privileged integration-test client. This account
// survives individual fixture cleanup and is never seeded in migrations.
export async function ensureIntegrationAdminAnchor(service: SupabaseClient) {
  const host = new URL(process.env.SUPABASE_URL ?? "").hostname;
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(host),
    "The integration admin anchor requires a local Supabase database.",
  );
  const profile = await service.from("users").select("id")
    .eq("email", anchorEmail).maybeSingle();
  assert.strictEqual(profile.error, null);
  let id: string | undefined = profile.data?.id;
  if (!id) {
    // Also recover an Auth account left behind by interrupted fixture setup.
    for (let page = 1; ; page += 1) {
      const result = await service.auth.admin.listUsers({ page, perPage: 1000 });
      assert.strictEqual(result.error, null);
      id = result.data.users.find((user) => user.email === anchorEmail)?.id;
      if (id || result.data.users.length < 1000) break;
    }
    if (!id) {
      const result = await service.auth.admin.createUser({
        email: anchorEmail,
        email_confirm: true,
      });
      assert.strictEqual(result.error, null);
      assert.ok(result.data.user);
      id = result.data.user.id;
    }
  }
  const account = await service.from("users").upsert({
    id, email: anchorEmail, status: "active",
  });
  assert.strictEqual(account.error, null);
  const role = await service.from("user_roles").upsert({
    user_id: id, role_code: "admin",
  }, { onConflict: "user_id,role_code", ignoreDuplicates: true });
  assert.strictEqual(role.error, null);
  return id;
}
