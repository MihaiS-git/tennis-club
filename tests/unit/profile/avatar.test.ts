import sharp from "sharp";
import { beforeEach, expect, it, vi } from "vitest";

const { readCurrentAccount, result, update, upload, download, remove } = vi.hoisted(() => ({
  readCurrentAccount: vi.fn(), result: vi.fn(), update: vi.fn(), upload: vi.fn(), download: vi.fn(), remove: vi.fn(),
}));
vi.mock("../../../src/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("../../../src/lib/supabase/server", () => ({ createClient: async () => {
  const query = { select: () => query, eq: () => query, update, maybeSingle: result };
  update.mockReturnValue(query);
  return { from: () => query, storage: { from: () => ({ upload, download, remove }) } };
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
  upload.mockResolvedValue({ error: null }); remove.mockResolvedValue({ error: null });
  download.mockResolvedValue({ data: original, error: null });
});
it("uploads to a server-derived owner path and persists only that path", async () => {
  expect(await changeAvatar(png())).toEqual({ success: "Avatar saved." });
  expect(upload).toHaveBeenCalledWith("owner/avatar.webp", expect.any(Uint8Array), expect.objectContaining({ contentType: "image/webp", upsert: true }));
  expect(update).toHaveBeenCalledExactlyOnceWith({ avatar_path: "owner/avatar.webp", updated_at: expect.any(String) });
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
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.webp" }, error: null }).mockRejectedValueOnce(new Error("database unavailable"));
  expect(await changeAvatar(png())).toHaveProperty("formError");
  expect(upload).toHaveBeenLastCalledWith("owner/avatar.webp", original, expect.objectContaining({ contentType: "image/webp", upsert: true }));
});

it("returns a controlled error when restoring a replacement fails", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.webp" }, error: null }).mockResolvedValueOnce({ data: null, error: { code: "failure" } });
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
  expect(update).not.toHaveBeenCalled();
});

it("does not clear the DB path when Storage removal returns an error", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.webp" }, error: null });
  remove.mockResolvedValueOnce({ error: { message: "unavailable" } });
  expect(await changeAvatar(null)).toHaveProperty("formError");
  expect(update).not.toHaveBeenCalled();
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
  expect(remove).toHaveBeenCalledWith(["owner/avatar.webp"]); expect(update).toHaveBeenCalledWith({ avatar_path: null, updated_at: expect.any(String) });
});
it("cleans a newly uploaded object after a database failure", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: null }, error: null }).mockResolvedValueOnce({ data: null, error: { code: "failure" } });
  expect(await changeAvatar(png())).toHaveProperty("formError"); expect(remove).toHaveBeenCalledWith(["owner/avatar.webp"]);
});
it("restores an overwritten object after a database failure", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.webp" }, error: null }).mockResolvedValueOnce({ data: null, error: { code: "failure" } });
  expect(await changeAvatar(png())).toHaveProperty("formError");
  expect(upload).toHaveBeenLastCalledWith("owner/avatar.webp", original, expect.objectContaining({ upsert: true }));
});
it("restores a removed object when clearing the path fails", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.webp" }, error: null }).mockResolvedValueOnce({ data: null, error: { code: "failure" } });
  expect(await changeAvatar(null)).toHaveProperty("formError"); expect(upload).toHaveBeenCalledWith("owner/avatar.webp", original, expect.any(Object));
});
it("does not change the database on a Storage upload failure", async () => {
  upload.mockResolvedValue({ error: { message: "failure" } });
  expect(await changeAvatar(png())).toHaveProperty("formError"); expect(update).not.toHaveBeenCalled();
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
it("sets the avatar update timestamp from the server clock", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
  try {
    expect(await changeAvatar(png())).toHaveProperty("success");
    expect(update).toHaveBeenCalledWith({ avatar_path: "owner/avatar.webp", updated_at: "2026-09-28T12:00:00.000Z" });
  } finally { vi.useRealTimers(); }
});
it("rejects another owner's stored path before Storage access", async () => {
  result.mockResolvedValue({ data: { avatar_path: "victim/avatar.webp" }, error: null });
  expect(await changeAvatar(png())).toHaveProperty("formError");
  expect(await changeAvatar(null)).toHaveProperty("formError");
  expect(await readPlayerAvatar()).toEqual({ kind: "not-found" });
  expect(download).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
});
