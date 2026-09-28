import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "vitest";
import { localFixtureClient, cleanupAuthFixtures } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";
import { savePersonalInformation, saveTennisProfile } from "../../../src/lib/profile/profile";
import { personalInformationSchema, tennisProfileSchema } from "../../../src/lib/profile/validation";

const service = localFixtureClient();
const readiness = await service.from("users").select("first_name").limit(1);
const playerReadiness = await service.from("player_profiles").select("user_id").limit(1);
for (const error of [readiness.error, playerReadiness.error]) {
  if (error) {
    throw new Error(`Profile schema inspection failed (${error.code}).`);
  }
}
// A missing migration is a validation failure, never a skipped Profile test.
test(
  "profile application and RLS boundaries (requires the profile migration history)", async () => {
    await ensureIntegrationAdminAnchor(service);
    const ids: string[] = [];
    const password = "profile-integration-password";
    const personal = Object.fromEntries(Object.keys(personalInformationSchema.shape).map((key) => [key, ""]));
    const tennis = Object.fromEntries(Object.keys(tennisProfileSchema.shape).map((key) => [key, ""]));
    async function fixture() {
      const email = `profile-${randomUUID()}@example.test`;
      const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
      expect(created.error).toBeNull(); if (!created.data.user) throw new Error("Missing fixture user");
      const id = created.data.user.id; ids.push(id);
      const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
      return { client, id };
    }
    try {
      const owner = await fixture(); const other = await fixture();
      expect((await owner.client.from("player_profiles").select("user_id").eq("user_id", owner.id)).data).toEqual([]);
      expect(await savePersonalInformation({ ...personal, first_name: "Ana", phone: "123", country_code: "RO" }, owner.client)).toHaveProperty("success");
      expect((await owner.client.from("users").select("first_name, phone, country_code").eq("id", owner.id).single()).data).toEqual({ first_name: "Ana", phone: "123", country_code: "RO" });
      expect((await other.client.from("users").select("first_name, phone").eq("id", owner.id)).data).toEqual([]);
      expect((await other.client.from("users").update({ first_name: "spoof" }).eq("id", owner.id).select("id")).data).toEqual([]);
      expect((await owner.client.from("player_profiles").select("user_id").eq("user_id", owner.id)).data).toEqual([]);
      expect(await savePersonalInformation({ ...personal, country_code: "ZZ" }, owner.client)).toHaveProperty("fieldErrors.country_code");
      expect(await saveTennisProfile({ ...tennis, sportya_level: "5.5" }, owner.client)).toHaveProperty("fieldErrors.sportya_level");
      expect(await saveTennisProfile({ ...tennis, display_name: "Ana", sportya_level: "6" }, owner.client)).toHaveProperty("success");
      expect(await savePersonalInformation({ ...personal, first_name: "Changed" }, owner.client)).toHaveProperty("success");
      expect((await owner.client.from("player_profiles").select("display_name, sportya_level").eq("user_id", owner.id).single()).data)
        .toEqual({ display_name: "Ana", sportya_level: "6" });
      expect(await saveTennisProfile({ ...tennis, bio: "Clay player" }, owner.client)).toHaveProperty("success");
      expect((await other.client.from("player_profiles").select("user_id, bio").eq("user_id", owner.id)).data).toEqual([{ user_id: owner.id, bio: "Clay player" }]);
      const anonymous = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!);
      expect((await anonymous.from("player_profiles").select("user_id")).error?.code).toBe("42501");
      expect((await owner.client.from("player_profiles").update({ rating: 2000 }).eq("user_id", owner.id)).error?.code).toBe("42501");
      expect((await other.client.from("player_profiles").insert({ user_id: owner.id, display_name: "spoof" })).error).not.toBeNull();
      expect((await other.client.from("player_profiles").update({ bio: "spoof" }).eq("user_id", owner.id).select("user_id")).data).toEqual([]);
      expect((await owner.client.from("users").update({ email: "spoof@example.test" }).eq("id", owner.id)).error?.code).toBe("42501");
      expect((await service.from("users").update({ status: "suspended" }).eq("id", other.id)).error).toBeNull();
      expect((await other.client.from("player_profiles").select("user_id")).data).toEqual([]);
      expect(await saveTennisProfile(tennis, other.client)).toHaveProperty("formError");
      expect(await savePersonalInformation(personal, other.client)).toHaveProperty("formError");
    } finally {
      for (const id of ids) expect((await service.from("player_profiles").delete().eq("user_id", id)).error).toBeNull();
      await cleanupAuthFixtures(service, ids);
    }
  },
);
