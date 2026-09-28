import { randomUUID } from "node:crypto";
import sharp from "sharp";
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

const source = () => sharp({ create: { width: 1024, height: 512, channels: 3, background: "red" } });
const pngBytes = new Uint8Array(await source().png().toBuffer());
const webpBytes = new Uint8Array(await source().webp().toBuffer());
const jpegBytes = new Uint8Array(await source().jpeg().toBuffer());
const png = () => new File([pngBytes], "../../victim/avatar.jpg", { type: "image/png" });

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
      const avatarPath = `${owner.id}/avatar.webp`;
      expect((await service.storage.from(AVATAR_BUCKET).upload(avatarPath, webpBytes, { contentType: "image/webp", upsert: false })).error).toBeNull();
      expect((await service.from("player_profiles").update({ avatar_path: avatarPath }).eq("user_id", owner.id)).error).toBeNull();
      let response = await GET();
      expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/webp");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(webpBytes);
      request.client = userClient(); expect((await GET()).status).toBe(401);
      expect((await service.from("users").update({ status: "suspended" }).eq("id", owner.id)).error).toBeNull();
      request.client = owner.client; response = await GET(); expect(response.status).toBe(403);
      return;
    }

    if (scenario === "access/input rejection") {
      for (const file of [
        new File(["GIF89a"], "bad.gif", { type: "image/gif" }),
        new File(["not PNG"], "forged.png", { type: "image/png" }),
        new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "truncated.png", { type: "image/png" }),
        new File([pngBytes], "spoof.jpg", { type: "image/jpeg" }),
        new File([], "empty.png", { type: "image/png" }),
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

    for (const [bytes, mime] of [[jpegBytes, "image/jpeg"], [pngBytes, "image/png"], [webpBytes, "image/webp"]] as const) {
      expect(await changeAvatar(new File([bytes], `${other.id}/avatar.exe`, { type: mime }))).toEqual({ success: "Avatar saved." });
      expect(await path()).toBe(`${owner.id}/avatar.webp`);
      expect(await objects()).toEqual(["avatar.webp"]);
      const response = await GET();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const stored = Buffer.from(await response.arrayBuffer());
      expect(stored.equals(Buffer.from(bytes))).toBe(false);
      expect(await sharp(stored).metadata()).toMatchObject({ format: "webp", width: 512, height: 256 });
    }
    const ownerObject = await owner.client.storage.from(AVATAR_BUCKET).download(`${owner.id}/avatar.webp`);
    expect(ownerObject.error).toBeNull();
    const ownerBytes = await ownerObject.data!.arrayBuffer();
    // Storage defense independently rejects another user's canonical target.
    expect((await other.client.storage.from(AVATAR_BUCKET).upload(`${owner.id}/avatar.webp`, webpBytes,
      { contentType: "image/webp", upsert: true })).error).not.toBeNull();
    // Storage independently restricts the declared MIME and canonical name.
    expect((await owner.client.storage.from(AVATAR_BUCKET).upload(`${owner.id}/avatar.png`, pngBytes,
      { contentType: "image/png", upsert: true })).error).not.toBeNull();
    expect((await owner.client.storage.from(AVATAR_BUCKET).upload(`${owner.id}/avatar.webp`, pngBytes,
      { contentType: "image/png", upsert: true })).error).not.toBeNull();

    request.client = other.client;
    expect((await GET()).status).toBe(404);
    expect(await changeAvatar(png())).toHaveProperty("formError");
    expect(await objects()).toEqual(["avatar.webp"]);
    expect(await saveTennisProfile({ ...tennis, display_name: "Other player" })).toHaveProperty("success");
    expect(await changeAvatar(png())).toHaveProperty("success");
    expect(await changeAvatar(null)).toHaveProperty("success");
    expect(await objects()).toEqual(["avatar.webp"]);
    const unchanged = await owner.client.storage.from(AVATAR_BUCKET).download(`${owner.id}/avatar.webp`);
    expect(unchanged.error).toBeNull();
    expect(await unchanged.data!.arrayBuffer()).toEqual(ownerBytes);

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
      expect((await service.storage.from(AVATAR_BUCKET).remove([`${id}/avatar.webp`])).error).toBeNull();
      expect((await service.from("player_profiles").delete().eq("user_id", id)).error).toBeNull();
    }
    await cleanupAuthFixtures(service, ids);
  }
});
