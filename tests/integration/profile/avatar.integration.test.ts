import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, vi } from "vitest";
import { localFixtureClient, cleanupAuthFixtures } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";
import { tennisProfileSchema } from "../../../src/lib/profile/validation";

// Substitute only the request-cookie client factory. Auth, application checks,
// the GET handler, database queries, and Storage requests all run for real.
const { request } = vi.hoisted(() => {
  const request: { client?: SupabaseClient } = {};
  return { request };
});
vi.mock("../../../src/lib/supabase/server", () => ({ createClient: async () => {
  if (!request.client) throw new Error("Missing test request session");
  return request.client;
} }));
import { changeAvatar, AVATAR_BUCKET } from "../../../src/lib/profile/avatar";
import { saveTennisProfile } from "../../../src/lib/profile/profile";
import { GET } from "../../../src/app/profile/avatar/route";

const pngBytes = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XQAAAAASUVORK5CYII=", "base64"));
const webpBytes = new Uint8Array(Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"));
const png = () => new File([pngBytes], "untrusted-name.png", { type: "image/png" });

test.each(["access/input rejection", "authenticated retrieval", "Storage lifecycle"])("real avatar %s", async (scenario) => {
  const service = localFixtureClient();
  await ensureIntegrationAdminAnchor(service);
  const ids: string[] = [];
  const password = "avatar-integration-password";
  const userClient = () => createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  async function fixture() {
    const email = `avatar-${randomUUID()}@example.test`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    if (!created.data.user) throw new Error("Missing avatar fixture");
    const id = created.data.user.id; ids.push(id);
    const client = userClient();
    expect((await client.auth.signInWithPassword({ email, password })).error).toBeNull();
    return { client, id };
  }
  try {
    const owner = await fixture();
    const other = await fixture();
    request.client = owner.client;
    const tennis = Object.fromEntries(Object.keys(tennisProfileSchema.shape).map((key) => [key, ""]));
    expect(await saveTennisProfile({ ...tennis, display_name: "Avatar test" })).toHaveProperty("success");
    const path = async () => {
      const result = await owner.client.from("player_profiles").select("avatar_path").eq("user_id", owner.id).single();
      expect(result.error).toBeNull(); return result.data?.avatar_path;
    };
    const objects = async () => {
      const result = await service.storage.from(AVATAR_BUCKET).list(owner.id);
      expect(result.error).toBeNull(); return result.data?.map((object) => object.name).sort();
    };

    if (scenario === "authenticated retrieval") {
      // Seed a real object without using the application's replacement workflow.
      // Keep retrieval assertions separate from profile mutation assertions.
      const avatarPath = `${owner.id}/avatar.png`;
      expect((await service.storage.from(AVATAR_BUCKET).upload(avatarPath, pngBytes, { contentType: "image/png", upsert: false })).error).toBeNull();
      expect((await service.from("player_profiles").update({ avatar_path: avatarPath }).eq("user_id", owner.id)).error).toBeNull();
      let response = await GET();
      expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngBytes);
      request.client = userClient(); expect((await GET()).status).toBe(401);
      expect((await service.from("users").update({ status: "suspended" }).eq("id", owner.id)).error).toBeNull();
      request.client = owner.client; response = await GET(); expect(response.status).toBe(403);
      return;
    }

    if (scenario === "access/input rejection") {
      for (const file of [
        new File(["GIF89a"], "bad.gif", { type: "image/gif" }),
        new File(["not PNG"], "forged.png", { type: "image/png" }),
        new File([new Uint8Array(5 * 1024 * 1024 + 1)], "oversize.png", { type: "image/png" }),
      ]) expect(await changeAvatar(file)).toHaveProperty("fieldErrors.avatar");
      expect((await GET()).status).toBe(404);
      request.client = other.client;
      expect((await GET()).status).toBe(404);
      expect(await changeAvatar(png())).toHaveProperty("formError");
      request.client = userClient();
      expect((await GET()).status).toBe(401);
      expect(await changeAvatar(png())).toHaveProperty("formError");
      expect(await changeAvatar(null)).toHaveProperty("formError");
      expect((await service.from("users").update({ status: "suspended" }).eq("id", owner.id)).error).toBeNull();
      request.client = owner.client;
      expect((await GET()).status).toBe(403);
      expect(await changeAvatar(png())).toHaveProperty("formError");
      expect(await changeAvatar(null)).toHaveProperty("formError");
      expect((await service.from("users").update({ status: "active" }).eq("id", owner.id)).error).toBeNull();
      expect(await path()).toBeNull(); expect(await objects()).toEqual([]);
      return;
    }

    expect(await changeAvatar(png())).toEqual({ success: "Avatar saved." });
    expect(await path()).toBe(`${owner.id}/avatar.png`); expect(await objects()).toEqual(["avatar.png"]);
    let response = await GET();
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngBytes);
    expect(await changeAvatar(png())).toHaveProperty("success");
    expect(await objects()).toEqual(["avatar.png"]);

    expect(await changeAvatar(new File([webpBytes], "avatar.webp", { type: "image/webp" }))).toHaveProperty("success");
    expect(await path()).toBe(`${owner.id}/avatar.webp`); expect(await objects()).toEqual(["avatar.webp"]);
    response = await GET(); expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(webpBytes);

    request.client = other.client;
    expect((await GET()).status).toBe(404);
    expect(await changeAvatar(png())).toHaveProperty("formError");
    expect(await objects()).toEqual(["avatar.webp"]);
    request.client = userClient();
    expect((await GET()).status).toBe(401);
    expect(await changeAvatar(png())).toHaveProperty("formError");
    expect(await changeAvatar(null)).toHaveProperty("formError");

    expect((await service.from("users").update({ status: "suspended" }).eq("id", owner.id)).error).toBeNull();
    request.client = owner.client;
    expect((await GET()).status).toBe(403);
    expect(await changeAvatar(png())).toHaveProperty("formError");
    expect(await changeAvatar(null)).toHaveProperty("formError");
    expect(await objects()).toEqual(["avatar.webp"]);

    expect((await service.from("users").update({ status: "active" }).eq("id", owner.id)).error).toBeNull();
    expect(await changeAvatar(null)).toEqual({ success: "Avatar removed." });
    expect(await path()).toBeNull(); expect(await objects()).toEqual([]);
    expect((await GET()).status).toBe(404);
  } finally {
    request.client = undefined;
    for (const id of ids) {
      expect((await service.storage.from(AVATAR_BUCKET).remove([`${id}/avatar.jpg`, `${id}/avatar.png`, `${id}/avatar.webp`])).error).toBeNull();
      expect((await service.from("player_profiles").delete().eq("user_id", id)).error).toBeNull();
    }
    await cleanupAuthFixtures(service, ids);
  }
});
