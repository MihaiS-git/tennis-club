import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assert, expect, test } from "vitest";
import { localFixtureClient, cleanupAuthFixtures } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";
import { loadProfile, savePersonalInformation, saveTennisProfile } from "../../../src/lib/profile/profile";
import { getDataSource } from "../../../src/lib/db/data-source";
import { updatePersonalInformation } from "../../../src/lib/db/repositories/users.repository";
import { upsertEditableTennisInformation } from "../../../src/lib/db/repositories/player-profiles.repository";
import { personalInformationSchema, tennisProfileSchema } from "../../../src/lib/profile/validation";

const service = localFixtureClient();
const readiness = await service.from("users").select("first_name").limit(1);
const playerReadiness = await service.from("player_profiles").select("user_id").limit(1);
for (const error of [readiness.error, playerReadiness.error]) {
  if (error) {
    throw new Error(`Profile schema inspection failed (${error.code}).`);
  }
}
// Missing profile schema is a validation failure, never a skipped Profile test.
test(
  "profile application authorization and denied browser grants (requires the profile schema)", async () => {
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
      expect(await loadProfile(owner.client, owner.id)).toEqual({
        personal: Object.fromEntries(Object.keys(personal).map((key) => [key, null])), player: null,
      });
      expect((await service.from("player_profiles").select("user_id").eq("user_id", owner.id)).data).toEqual([]);
      const accountBefore = await service.from("users").select("*").eq("id", owner.id).single();
      expect(accountBefore.error).toBeNull();
      const rolesBefore = await service.from("user_roles").select("*").eq("user_id", owner.id);
      expect(await savePersonalInformation({ ...personal, first_name: " Ana ", last_name: " Player ", phone: " 123 ", date_of_birth: "1990-04-23", address_line1: " Street 1 ", address_line2: " ", city: " Bucharest ", postal_code: " 123456 ", country_code: " ro " }, owner.client)).toEqual({ success: "Personal information saved." });
      const accountAfter = await service.from("users").select("*").eq("id", owner.id).single();
      expect(accountAfter.error).toBeNull();
      expect(accountAfter.data).toEqual({
        ...accountBefore.data, first_name: "Ana", last_name: "Player", phone: "123", date_of_birth: "1990-04-23",
        address_line1: "Street 1", address_line2: null, city: "Bucharest", postal_code: "123456", country_code: "RO",
        updated_at: expect.any(String),
      });
      expect(Date.parse(accountAfter.data!.updated_at)).toBeGreaterThan(Date.parse(accountBefore.data!.updated_at));
      expect((await service.from("user_roles").select("*").eq("user_id", owner.id)).data).toEqual(rolesBefore.data);
      expect(await loadProfile(owner.client, owner.id)).toMatchObject({
        personal: { first_name: "Ana", phone: "123", date_of_birth: "1990-04-23", country_code: "RO" }, player: null,
      });
      expect((await service.from("users").select("first_name, phone, country_code").eq("id", owner.id).single()).data).toEqual({ first_name: "Ana", phone: "123", country_code: "RO" });
      expect((await other.client.from("users").select("first_name, phone").eq("id", owner.id)).error?.code).toBe("42501");
      expect((await other.client.from("users").update({ first_name: "spoof" }).eq("id", owner.id).select("id")).error?.code).toBe("42501");
      expect((await service.from("player_profiles").select("user_id").eq("user_id", owner.id)).data).toEqual([]);
      expect(await savePersonalInformation({ ...personal, country_code: "ZZ" }, owner.client)).toHaveProperty("fieldErrors.country_code");
      expect(await saveTennisProfile({ ...tennis, sportya_level: "5.5" }, owner.client)).toHaveProperty("fieldErrors.sportya_level");
      expect(await saveTennisProfile({ ...tennis, display_name: "Ana", sportya_level: "6" }, owner.client)).toHaveProperty("success");
      const loaded = await loadProfile(owner.client, owner.id);
      expect(loaded?.player).toMatchObject({ display_name: "Ana", sportya_level: "6", avatar_path: null, rating: null });
      assert.ok(loaded?.player);
      expect(loaded.player.updated_at).toBe(new Date(loaded.player.updated_at).toISOString());
      expect(await loadProfile(owner.client, randomUUID())).toBeNull();
      expect(await savePersonalInformation({ ...personal, first_name: "Changed" }, owner.client)).toHaveProperty("success");
      expect((await service.from("player_profiles").select("display_name, sportya_level").eq("user_id", owner.id).single()).data)
        .toEqual({ display_name: "Ana", sportya_level: "6" });
      expect((await service.from("player_profiles").update({ rating: 1450, avatar_path: `${owner.id}/avatar.webp` }).eq("user_id", owner.id)).error).toBeNull();
      const playerBefore = await service.from("player_profiles").select("*").eq("user_id", owner.id).single();
      expect(playerBefore.error).toBeNull();
      expect(await saveTennisProfile({ ...tennis, bio: " Clay player ", handedness: "left", backhand: "two_handed", preferred_game: "both", preferred_surface: "clay" }, owner.client)).toEqual({ success: "Tennis profile saved." });
      const playerAfter = await service.from("player_profiles").select("*").eq("user_id", owner.id).single();
      expect(playerAfter.error).toBeNull();
      expect(playerAfter.data).toEqual({
        ...playerBefore.data, display_name: null, sportya_level: null, bio: "Clay player", handedness: "left",
        backhand: "two_handed", preferred_game: "both", preferred_surface: "clay", updated_at: expect.any(String),
      });
      expect(Date.parse(playerAfter.data!.updated_at)).toBeGreaterThan(Date.parse(playerBefore.data!.updated_at));
      expect((await other.client.from("player_profiles").select("user_id, bio").eq("user_id", owner.id)).error?.code).toBe("42501");
      const anonymous = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!);
      expect((await anonymous.from("player_profiles").select("user_id")).error?.code).toBe("42501");
      expect((await owner.client.from("player_profiles").update({ rating: 2000 }).eq("user_id", owner.id)).error?.code).toBe("42501");
      expect((await other.client.from("player_profiles").insert({ user_id: owner.id, display_name: "spoof" })).error).not.toBeNull();
      expect((await other.client.from("player_profiles").update({ bio: "spoof" }).eq("user_id", owner.id).select("user_id")).error?.code).toBe("42501");
      expect((await owner.client.from("users").update({ email: "spoof@example.test" }).eq("id", owner.id)).error?.code).toBe("42501");
      const emptyOwner = await fixture();
      expect(await saveTennisProfile(tennis, emptyOwner.client)).toEqual({ success: "Tennis profile saved." });
      expect((await service.from("player_profiles").select("*").eq("user_id", emptyOwner.id)).data).toEqual([
        expect.objectContaining({ user_id: emptyOwner.id, display_name: null, bio: null, rating: null, avatar_path: null }),
      ]);
      const anonymousSave = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!);
      expect(await savePersonalInformation(personal, anonymousSave)).toEqual({ formError: "Profile changes require an active account." });
      expect(await saveTennisProfile(tennis, anonymousSave)).toEqual({ formError: "Profile changes require an active account." });
      expect((await service.from("users").update({ status: "suspended" }).eq("id", other.id)).error).toBeNull();
      expect((await other.client.from("player_profiles").select("user_id")).error?.code).toBe("42501");
      expect(await saveTennisProfile(tennis, other.client)).toHaveProperty("formError");
      expect(await savePersonalInformation(personal, other.client)).toEqual({ formError: "Profile changes require an active account." });
      const { manager } = await getDataSource();
      const personalFields = {
        firstName: "Forbidden", lastName: null, phone: null, dateOfBirth: null,
        addressLine1: null, addressLine2: null, city: null, postalCode: null, countryCode: null,
      };
      const tennisFields = { displayName: "Forbidden", sportyaLevel: null, handedness: null, backhand: null,
        preferredGame: null, preferredSurface: null, bio: null };
      // Repository fences remain authoritative even after an earlier active-account read.
      const suspendedBefore = await service.from("users").select("*").eq("id", other.id).single();
      expect(await updatePersonalInformation(manager, other.id, personalFields)).toBe(false);
      expect(await upsertEditableTennisInformation(manager, other.id, tennisFields)).toBe(false);
      expect((await service.from("users").select("*").eq("id", other.id).single()).data).toEqual(suspendedBefore.data);
      expect((await service.from("player_profiles").select("*").eq("user_id", other.id)).data).toEqual([]);
      expect((await service.from("users").update({ status: "suspended" }).eq("id", owner.id)).error).toBeNull();
      expect(await upsertEditableTennisInformation(manager, owner.id, tennisFields)).toBe(false);
      expect(await saveTennisProfile(tennis, owner.client)).toEqual({ formError: "Profile changes require an active account." });
      expect((await service.from("player_profiles").select("*").eq("user_id", owner.id).single()).data).toEqual(playerAfter.data);
    } finally {
      for (const id of ids) expect((await service.from("player_profiles").delete().eq("user_id", id)).error).toBeNull();
      await cleanupAuthFixtures(service, ids);
    }
  },
);


test("concurrent first tennis saves atomically produce one valid profile", async () => {
  await ensureIntegrationAdminAnchor(service);
  const email = `profile-concurrent-${randomUUID()}@example.test`;
  const password = "profile-integration-password";
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error).toBeNull();
  assert.ok(created.data.user);
  const id = created.data.user.id;
  try {
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    const empty = Object.fromEntries(Object.keys(tennisProfileSchema.shape).map((key) => [key, ""]));
    const payloads = [
      { ...empty, display_name: "First", bio: "First payload" },
      { ...empty, display_name: "Second", bio: "Second payload" },
    ];
    expect(await Promise.all(payloads.map((payload) => saveTennisProfile(payload, client))))
      .toEqual([{ success: "Tennis profile saved." }, { success: "Tennis profile saved." }]);
    const rows = await service.from("player_profiles").select("*").eq("user_id", id);
    expect(rows.error).toBeNull();
    expect(rows.data).toHaveLength(1);
    expect(rows.data![0]).toMatchObject({ user_id: id, rating: null, avatar_path: null });
    expect(payloads.map(({ display_name, bio }) => ({ display_name, bio })))
      .toContainEqual({ display_name: rows.data![0].display_name, bio: rows.data![0].bio });
  } finally {
    expect((await service.from("player_profiles").delete().eq("user_id", id)).error).toBeNull();
    await cleanupAuthFixtures(service, [id]);
  }
});
