import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, expect, test, vi } from "vitest";
import { localFixtureClient, cleanupAuthFixtures } from "../auth-fixtures";
import { ensureIntegrationAdminAnchor } from "../admin-anchor";
import { tennisProfileSchema } from "../../../src/lib/profile/validation";

// Substitute the request-cookie client factory. Auth, application checks,
// GET handlers and repositories run for real; selected failures are injected.
const { request } = vi.hoisted(() => {
  const request: { client?: SupabaseClient; pauseAfterUpload?: () => Promise<void>; failDelete?: boolean; deleteAttempts?: number } = {};
  return { request };
});
vi.mock("../../../src/lib/supabase/server", () => ({ createClient: async (fetchOverride?: typeof fetch) => {
  if (!request.client) throw new Error("Missing test request session");
  if (!fetchOverride) return request.client;
  const session = await request.client.auth.getSession();
  if (session.error) throw session.error;
  const pause = request.pauseAfterUpload;
  const failDelete = request.failDelete;
  const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      if (init?.method === "DELETE" && String(input).includes("/storage/v1/object/profile-avatars")) {
        request.deleteAttempts = (request.deleteAttempts ?? 0) + 1;
        if (failDelete) return new Response(JSON.stringify({ message: "Injected Storage failure" }), { status: 503 });
      }
      const response = await fetchOverride(input, init);
      if (pause && init?.method === "POST" && String(input).includes("/storage/v1/object/profile-avatars/")) await pause();
      return response;
    } },
  });
  if (session.data.session) {
    const { access_token, refresh_token } = session.data.session;
    expect((await client.auth.setSession({ access_token, refresh_token })).error).toBeNull();
  }
  return client;
} }));
import { changeAvatar, AVATAR_BUCKET } from "../../../src/lib/profile/avatar";
import { saveTennisProfile } from "../../../src/lib/profile/profile";
import { GET } from "../../../src/app/profile/avatar/route";
import { GET as adminGET } from "../../../src/app/admin/users/[userId]/avatar/route";
import { getDataSource } from "../../../src/lib/db/data-source";
import { readNavigationProfile } from "../../../src/lib/profile/navigation";

const source = () => sharp({ create: { width: 1024, height: 512, channels: 3, background: "red" } });
const pngBytes = new Uint8Array(await source().png().toBuffer());
const webpBytes = new Uint8Array(await source().webp().toBuffer());
const jpegBytes = new Uint8Array(await source().jpeg().toBuffer());
const png = () => new File([pngBytes], "../../victim/avatar.jpg", { type: "image/png" });

beforeAll(async () => { await ensureIntegrationAdminAnchor(localFixtureClient()); });

test.each(["access/input rejection", "authenticated retrieval", "Storage lifecycle", "rapid operations", "first upload DB failure", "replacement DB failure", "removal Storage failure", "removal DB failure", "canonical path and secure failures"])("real avatar %s", async (scenario) => {
  const service = localFixtureClient();
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
    request.client = owner.client;
    const tennis = Object.fromEntries(Object.keys(tennisProfileSchema.shape).map((key) => [key, ""]));
    expect(await saveTennisProfile({ ...tennis, display_name: "Avatar test" })).toHaveProperty("success");
    const path = async () => {
      const result = await service.from("player_profiles").select("avatar_path").eq("user_id", owner.id).single();
      expect(result.error).toBeNull(); return result.data?.avatar_path;
    };
    const objects = async () => {
      const result = await service.storage.from(AVATAR_BUCKET).list(owner.id);
      expect(result.error).toBeNull(); return result.data?.map((object) => object.name).sort();
    };

    if (scenario === "canonical path and secure failures") {
      const other = await fixture();
      expect((await service.from("player_profiles").update({ avatar_path: `${other.id}/avatar.webp` }).eq("user_id", owner.id)).error).toBeNull();
      expect(await changeAvatar(png())).toHaveProperty("formError");
      expect(await changeAvatar(null)).toHaveProperty("formError");
      expect((await GET()).status).toBe(404);
      expect((await readNavigationProfile()).avatarUrl).toBeNull();
      expect(await objects()).toEqual([]);
      expect((await service.from("player_profiles").update({ avatar_path: `${owner.id}/avatar.webp` }).eq("user_id", owner.id)).error).toBeNull();
      // A valid reference with an unavailable Storage object is a 503.
      expect((await GET()).status).toBe(503);
      return;
    }

    if (scenario === "first upload DB failure" || scenario === "replacement DB failure") {
      if (scenario === "replacement DB failure") expect(await changeAvatar(png())).toHaveProperty("success");
      const priorPath = await path();
      const originalObject = priorPath ? await owner.client.storage.from(AVATAR_BUCKET).download(priorPath) : null;
      const originalBytes = originalObject?.data ? await originalObject.data.arrayBuffer() : null;
      const before = await readNavigationProfile();
      request.pauseAfterUpload = async () => {
        // Inject a transaction failure after real Storage success. Repositories,
        // Auth, owner reads and all Storage operations remain real.
        vi.spyOn(await getDataSource(), "transaction").mockRejectedValueOnce(new Error("Injected database failure"));
      };
      request.deleteAttempts = 0;
      expect(await changeAvatar(new File([jpegBytes], "new.jpg", { type: "image/jpeg" }))).toHaveProperty("formError");
      expect(await path()).toBe(priorPath);
      expect(await readNavigationProfile()).toEqual(before);
      expect(request.deleteAttempts).toBe(scenario === "first upload DB failure" ? 1 : 0);
      expect(await objects()).toEqual(scenario === "first upload DB failure" ? [] : ["avatar.webp"]);
      if (scenario === "replacement DB failure") {
        const stored = await owner.client.storage.from(AVATAR_BUCKET).download(`${owner.id}/avatar.webp`);
        expect(stored.error).toBeNull();
        const newBytes = await stored.data!.arrayBuffer();
        expect(Buffer.from(newBytes).equals(Buffer.from(originalBytes!))).toBe(false);
        const expectedBytes = await sharp(jpegBytes).rotate().resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
        expect(Buffer.from(newBytes)).toEqual(expectedBytes);
      }
      return;
    }

    if (scenario === "removal DB failure") {
      expect(await changeAvatar(png())).toHaveProperty("success");
      request.deleteAttempts = 0;
      vi.spyOn(await getDataSource(), "transaction").mockRejectedValueOnce(new Error("Injected database failure"));
      expect(await changeAvatar(null)).toHaveProperty("formError");
      expect(request.deleteAttempts).toBe(0);
      expect(await path()).toBe(`${owner.id}/avatar.webp`);
      expect(await objects()).toEqual(["avatar.webp"]);
      return;
    }

    if (scenario === "removal Storage failure") {
      expect(await changeAvatar(png())).toHaveProperty("success");
      request.failDelete = true;
      request.deleteAttempts = 0;
      expect(await changeAvatar(null)).toEqual({ success: "Avatar removed." });
      expect(request.deleteAttempts).toBe(1);
      expect(await path()).toBeNull();
      expect(await objects()).toEqual(["avatar.webp"]);
      expect((await GET()).status).toBe(404);
      expect((await readNavigationProfile()).avatarUrl).toBeNull();
      // A repeated no-avatar removal never touches Storage.
      expect(await changeAvatar(null)).toHaveProperty("success");
      expect(request.deleteAttempts).toBe(1);
      return;
    }

    if (scenario === "rapid operations") {
      expect(await changeAvatar(png())).toHaveProperty("success");
      let entered: () => void = () => {};
      const written = new Promise<void>((resolve) => { entered = resolve; });
      let resume: () => void = () => {};
      const paused = new Promise<void>((resolve) => { resume = resolve; });
      request.pauseAfterUpload = async () => { entered(); await paused; };
      const uploading = changeAvatar(png());
      try {
        await written;
        request.pauseAfterUpload = undefined;
        // Independent same-owner replacement is permitted while the first
        // request waits; no distributed lease excludes it.
        expect(await changeAvatar(png())).toHaveProperty("success");
      } finally {
        resume();
        expect(await uploading).toHaveProperty("success");
        request.pauseAfterUpload = undefined;
      }
      expect(await path()).toBe(`${owner.id}/avatar.webp`);
      expect(await changeAvatar(null)).toHaveProperty("success");
      expect(await path()).toBeNull(); expect(await objects()).toEqual([]);
      expect(await changeAvatar(png())).toHaveProperty("success");
      expect(await path()).toBe(`${owner.id}/avatar.webp`);
      expect(await objects()).toEqual(["avatar.webp"]);
      return;
    }

    if (scenario === "authenticated retrieval") {
      const other = await fixture();
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
      const metadata = await service.from("player_profiles").select("updated_at").eq("user_id", owner.id).single();
      expect(metadata.error).toBeNull();
      expect((await readNavigationProfile()).avatarUrl).toBe(`/profile/avatar?v=${encodeURIComponent(metadata.data!.updated_at)}`);
      const params = { params: Promise.resolve({ userId: owner.id }) };
      request.client = other.client;
      expect((await adminGET(new Request("http://localhost"), params)).status).toBe(403);
      expect((await service.from("user_roles").insert({ user_id: other.id, role_code: "coach" })).error).toBeNull();
      expect((await adminGET(new Request("http://localhost"), params)).status).toBe(403);
      expect((await service.from("user_roles").insert({ user_id: other.id, role_code: "admin" })).error).toBeNull();
      expect((await adminGET(new Request("http://localhost"), params)).status).toBe(200);
      expect((await adminGET(new Request("http://localhost"), { params: Promise.resolve({ userId: "invalid" }) })).status).toBe(404);
      request.client = userClient(); expect((await GET()).status).toBe(401);
      expect((await service.from("users").update({ status: "suspended" }).eq("id", owner.id)).error).toBeNull();
      request.client = owner.client; response = await GET(); expect(response.status).toBe(403);
      return;
    }

    if (scenario === "access/input rejection") {
      const other = await fixture();
      for (const file of [
        new File(["GIF89a"], "bad.gif", { type: "image/gif" }),
        new File(["not PNG"], "forged.png", { type: "image/png" }),
        new File([pngBytes], "spoof.jpg", { type: "image/jpeg" }),
        new File([], "empty.png", { type: "image/png" }),
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

    const other = await fixture();
    let previousAvatarUrl: string | null = null;
    for (const [bytes, mime] of [[jpegBytes, "image/jpeg"], [pngBytes, "image/png"], [webpBytes, "image/webp"]] as const) {
      expect(await changeAvatar(new File([bytes], `${other.id}/avatar.exe`, { type: mime }))).toEqual({ success: "Avatar saved." });
      expect(await path()).toBe(`${owner.id}/avatar.webp`);
      expect(await objects()).toEqual(["avatar.webp"]);
      const avatarUrl = (await readNavigationProfile()).avatarUrl;
      expect(avatarUrl).toBeTruthy();
      expect(avatarUrl).not.toBe(previousAvatarUrl);
      previousAvatarUrl = avatarUrl;
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
    vi.restoreAllMocks();
    request.failDelete = undefined;
    request.deleteAttempts = undefined;
    request.client = undefined;
    request.pauseAfterUpload = undefined;
    for (const id of ids) {
      expect((await service.storage.from(AVATAR_BUCKET).remove([`${id}/avatar.webp`])).error).toBeNull();
      expect((await service.from("player_profiles").delete().eq("user_id", id)).error).toBeNull();
    }
    await cleanupAuthFixtures(service, ids);
  }
});
