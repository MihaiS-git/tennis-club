import sharp from "sharp";
import { beforeEach, expect, it, vi } from "vitest";

const { readCurrentAccount, result, persist, rpc, upload, download, remove } = vi.hoisted(() => ({
  readCurrentAccount: vi.fn(), result: vi.fn(), persist: vi.fn(), rpc: vi.fn(), upload: vi.fn(), download: vi.fn(), remove: vi.fn(),
}));
vi.mock("../../../src/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("../../../src/lib/supabase/server", () => ({ createClient: async () => {
  const query = { select: () => query, eq: () => query, maybeSingle: result };
  return { rpc, from: () => query, storage: { from: () => ({ upload, download, remove }) } };
} }));
import { changeAvatar, readPlayerAvatar } from "../../../src/lib/profile/avatar";

const pngBytes = await sharp({ create: { width: 24, height: 12, channels: 3, background: "red" } }).png().toBuffer();
const png = () => new File([new Uint8Array(pngBytes)], "../victim/avatar.webp", { type: "image/png" });
const originalBytes = await sharp(pngBytes).webp().toBuffer();
const original = new Blob([new Uint8Array(originalBytes)], { type: "image/webp" });
beforeEach(() => {
  vi.resetAllMocks();
  readCurrentAccount.mockResolvedValue({ state: "active", userId: "owner", email: "owner@example.test", roles: [] });
  result.mockResolvedValue({ data: { user_id: "owner", avatar_path: null }, error: null });
  persist.mockResolvedValue({ data: true, error: null });
  rpc.mockImplementation((name, args) => name === "persist_avatar_path" ? persist(args) : Promise.resolve({ data: true, error: null }));
  upload.mockResolvedValue({ error: null }); remove.mockResolvedValue({ error: null });
  download.mockResolvedValue({ data: original, error: null });
});
it("uploads to a server-derived owner path and persists only that path", async () => {
  expect(await changeAvatar(png())).toEqual({ success: "Avatar saved." });
  expect(upload).toHaveBeenCalledWith("owner/avatar.webp", expect.any(Uint8Array), expect.objectContaining({ contentType: "image/webp", upsert: true }));
  expect(persist).toHaveBeenCalledExactlyOnceWith({ p_token: expect.any(String), p_path: "owner/avatar.webp" });
  const stored = upload.mock.calls[0][1];
  expect(await sharp(stored).metadata()).toMatchObject({ format: "webp", width: 24, height: 12 });
});

it.each(["unauthenticated", "suspended", "missing-profile", "load-error"])("rejects %s mutations before profile or Storage access", async (state) => {
  readCurrentAccount.mockResolvedValue({ state });
  expect(await changeAvatar(png())).toHaveProperty("formError");
  expect(await changeAvatar(null)).toHaveProperty("formError");
  expect(result).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
});

it("attempts restoration when a DB request throws after replacement", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.webp" }, error: null });
  persist.mockRejectedValueOnce(new Error("database unavailable"));
  expect(await changeAvatar(png())).toHaveProperty("formError");
  expect(upload).toHaveBeenLastCalledWith("owner/avatar.webp", original, expect.objectContaining({ contentType: "image/webp", upsert: true }));
});

it("returns a controlled error when restoring a replacement fails", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.webp" }, error: null });
  persist.mockResolvedValueOnce({ data: false, error: { code: "failure" } });
  upload.mockResolvedValueOnce({ error: null }).mockRejectedValueOnce(new Error("restore unavailable"));
  expect(await changeAvatar(png())).toHaveProperty("formError");
  expect(upload).toHaveBeenCalledTimes(2);
});

it.each(["upload", "backup", "remove"])("returns a controlled error for a thrown Storage %s failure", async (stage) => {
  if (stage === "upload") upload.mockRejectedValueOnce(new Error("unavailable"));
  else {
    result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.webp" }, error: null });
    if (stage === "backup") download.mockRejectedValueOnce(new Error("unavailable"));
    else remove.mockRejectedValueOnce(new Error("unavailable"));
  }
  expect(await changeAvatar(stage === "remove" ? null : png())).toHaveProperty("formError");
  expect(persist).not.toHaveBeenCalled();
});

it("does not clear the DB path when Storage removal returns an error", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.webp" }, error: null });
  remove.mockResolvedValueOnce({ error: { message: "unavailable" } });
  expect(await changeAvatar(null)).toHaveProperty("formError");
  expect(persist).not.toHaveBeenCalled();
});
it("does not create a player profile through an avatar upload", async () => {
  result.mockResolvedValueOnce({ data: null, error: null });
  expect(await changeAvatar(png())).toHaveProperty("formError"); expect(upload).not.toHaveBeenCalled();
});
it("replaces the canonical object without deleting it", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.webp" }, error: null });
  expect(await changeAvatar(png())).toHaveProperty("success");
  expect(download).toHaveBeenCalledWith("owner/avatar.webp");
  expect(upload).toHaveBeenCalledExactlyOnceWith("owner/avatar.webp", expect.any(Uint8Array), expect.objectContaining({ upsert: true, contentType: "image/webp" }));
  expect(remove).not.toHaveBeenCalled();
});
it("removes an avatar and clears its stored path", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.webp" }, error: null });
  expect(await changeAvatar(null)).toEqual({ success: "Avatar removed." });
  expect(remove).toHaveBeenCalledWith(["owner/avatar.webp"]); expect(persist).toHaveBeenCalledWith({ p_path: null, p_token: expect.any(String) });
});
it("cleans a newly uploaded object after a database failure", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: null }, error: null });
  persist.mockResolvedValueOnce({ data: false, error: { code: "failure" } });
  expect(await changeAvatar(png())).toHaveProperty("formError"); expect(remove).toHaveBeenCalledWith(["owner/avatar.webp"]);
});
it("restores an overwritten object after a database failure", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.webp" }, error: null });
  persist.mockResolvedValueOnce({ data: false, error: { code: "failure" } });
  expect(await changeAvatar(png())).toHaveProperty("formError");
  expect(upload).toHaveBeenLastCalledWith("owner/avatar.webp", original, expect.objectContaining({ upsert: true }));
});
it("restores a removed object when clearing the path fails", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.webp" }, error: null });
  persist.mockResolvedValueOnce({ data: false, error: { code: "failure" } });
  expect(await changeAvatar(null)).toHaveProperty("formError"); expect(upload).toHaveBeenCalledWith("owner/avatar.webp", original, expect.any(Object));
});
it("does not change the database on a Storage upload failure", async () => {
  upload.mockResolvedValue({ error: { message: "failure" } });
  expect(await changeAvatar(png())).toHaveProperty("formError"); expect(persist).not.toHaveBeenCalled();
});
it("rejects suspended accounts and invalid files before storage changes", async () => {
  readCurrentAccount.mockResolvedValue({ state: "suspended" });
  expect(await changeAvatar(png())).toHaveProperty("formError"); expect(upload).not.toHaveBeenCalled();
  readCurrentAccount.mockResolvedValue({ state: "active", userId: "owner" });
  expect(await changeAvatar(new File(["bad"], "x.png", { type: "image/png" }))).toHaveProperty("fieldErrors.avatar");
  expect(upload).not.toHaveBeenCalled();
});
it("serves only the active session owner's avatar through the server", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.webp" }, error: null });
  expect(await readPlayerAvatar()).toEqual({ kind: "image", file: original });
  expect(download).toHaveBeenCalledExactlyOnceWith("owner/avatar.webp");
});
it("denies avatar reads to anonymous and suspended callers", async () => {
  readCurrentAccount.mockResolvedValue({ state: "unauthenticated" });
  expect(await readPlayerAvatar()).toEqual({ kind: "unauthenticated" });
  readCurrentAccount.mockResolvedValue({ state: "suspended" });
  expect(await readPlayerAvatar()).toEqual({ kind: "forbidden" }); expect(download).not.toHaveBeenCalled();
});
it("holds the same ownership token through persistence and releases it after success", async () => {
  expect(await changeAvatar(png())).toHaveProperty("success");
  const token = rpc.mock.calls[0][1].p_token;
  expect(rpc.mock.calls).toEqual([
    ["acquire_avatar_mutation", { p_token: token }],
    ["persist_avatar_path", { p_token: token, p_path: "owner/avatar.webp" }],
    ["release_avatar_mutation", { p_token: token }],
  ]);
});
it("rejects another owner's stored path before Storage access", async () => {
  result.mockResolvedValue({ data: { avatar_path: "victim/avatar.webp" }, error: null });
  expect(await changeAvatar(png())).toHaveProperty("formError");
  expect(await changeAvatar(null)).toHaveProperty("formError");
  expect(await readPlayerAvatar()).toEqual({ kind: "not-found" });
  expect(download).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
});

it.each(["upload", "remove"])("excludes the opposite mutation while %s Storage work is in flight", async (operation) => {
  let heldToken: string | null = null;
  let dbPath: string | null = operation === "remove" ? "owner/avatar.webp" : null;
  let objectExists = operation === "remove";
  let started: () => void = () => {};
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let resume: () => void = () => {};
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  result.mockImplementation(async () => ({ data: { avatar_path: dbPath }, error: null }));
  rpc.mockImplementation(async (name, args) => {
    if (name === "acquire_avatar_mutation") {
      if (heldToken) return { data: false, error: null };
      heldToken = args.p_token;
    } else if (name === "persist_avatar_path") {
      expect(args.p_token).toBe(heldToken);
      dbPath = args.p_path;
    } else if (name === "release_avatar_mutation" && heldToken === args.p_token) {
      heldToken = null;
    }
    return { data: true, error: null };
  });
  (operation === "upload" ? upload : remove).mockImplementation(async () => {
    objectExists = operation === "upload";
    started(); await paused;
    return { error: null };
  });
  const first = changeAvatar(operation === "upload" ? png() : null);
  await entered;
  expect(await changeAvatar(operation === "upload" ? null : png())).toEqual({
    formError: "An avatar change is already in progress. Please try again shortly.",
  });
  // The conflicting request's release cannot clear the first request's token.
  expect(heldToken).not.toBeNull();
  expect(operation === "upload" ? remove : upload).not.toHaveBeenCalled();
  resume();
  expect(await first).toHaveProperty("success");
  expect(heldToken).toBeNull();
  expect(dbPath).toBe(objectExists ? "owner/avatar.webp" : null);
});

it("keeps exclusion through compensation and releases after compensation fails", async () => {
  result.mockResolvedValue({ data: { avatar_path: "owner/avatar.webp" }, error: null });
  persist.mockResolvedValue({ data: false, error: null });
  let heldToken: string | null = null;
  rpc.mockImplementation(async (name, args) => {
    if (name === "acquire_avatar_mutation") {
      if (heldToken) return { data: false, error: null };
      heldToken = args.p_token;
    } else if (name === "persist_avatar_path") return persist(args);
    else if (name === "release_avatar_mutation" && heldToken === args.p_token) heldToken = null;
    return { data: true, error: null };
  });
  let entered: () => void = () => {};
  const compensating = new Promise<void>((resolve) => { entered = resolve; });
  let resume: () => void = () => {};
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  upload.mockResolvedValueOnce({ error: null }).mockImplementationOnce(async () => {
    entered(); await paused;
    throw new Error("compensation failed");
  });
  const first = changeAvatar(png());
  await compensating;
  expect(await changeAvatar(null)).toHaveProperty("formError", "An avatar change is already in progress. Please try again shortly.");
  expect(remove).not.toHaveBeenCalled(); expect(heldToken).not.toBeNull();
  resume(); expect(await first).toHaveProperty("formError");
  expect(heldToken).toBeNull();
  expect(await changeAvatar(null)).toHaveProperty("formError");
  expect(remove).toHaveBeenCalledOnce();
});

it.each(["load", "upload", "persist", "acquire response"])("releases its own attempted lease after a %s failure", async (stage) => {
  if (stage === "load") result.mockRejectedValueOnce(new Error("load failed"));
  if (stage === "upload") upload.mockRejectedValueOnce(new Error("upload failed"));
  if (stage === "persist") persist.mockRejectedValueOnce(new Error("persist failed"));
  if (stage === "acquire response") rpc.mockRejectedValueOnce(new Error("response lost"));
  expect(await changeAvatar(png())).toHaveProperty("formError");
  expect(rpc).toHaveBeenLastCalledWith("release_avatar_mutation", rpc.mock.calls[0][1]);
  expect(await changeAvatar(png())).toHaveProperty("success");
});
