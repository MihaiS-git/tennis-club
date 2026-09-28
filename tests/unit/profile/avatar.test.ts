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

const png = () => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "ignored.png", { type: "image/png" });
const original = new Blob([new Uint8Array([255, 216, 255])], { type: "image/jpeg" });
beforeEach(() => {
  vi.resetAllMocks();
  readCurrentAccount.mockResolvedValue({ state: "active", userId: "owner", email: "owner@example.test", roles: [] });
  result.mockResolvedValue({ data: { user_id: "owner", avatar_path: null }, error: null });
  upload.mockResolvedValue({ error: null }); remove.mockResolvedValue({ error: null });
  download.mockResolvedValue({ data: original, error: null });
});
it("uploads to a server-derived owner path and persists only that path", async () => {
  expect(await changeAvatar(png())).toEqual({ success: "Avatar saved." });
  expect(upload).toHaveBeenCalledWith("owner/avatar.png", expect.any(Uint8Array), expect.objectContaining({ contentType: "image/png", upsert: true }));
  expect(update).toHaveBeenCalledExactlyOnceWith({ avatar_path: "owner/avatar.png", updated_at: expect.any(String) });
});
it("does not create a player profile through an avatar upload", async () => {
  result.mockResolvedValueOnce({ data: null, error: null });
  expect(await changeAvatar(png())).toHaveProperty("formError"); expect(upload).not.toHaveBeenCalled();
});
it("replaces another extension and removes the old object", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.jpg" }, error: null });
  expect(await changeAvatar(png())).toHaveProperty("success"); expect(remove).toHaveBeenCalledWith(["owner/avatar.jpg"]);
});
it("removes an avatar and clears its stored path", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.jpg" }, error: null });
  expect(await changeAvatar(null)).toEqual({ success: "Avatar removed." });
  expect(remove).toHaveBeenCalledWith(["owner/avatar.jpg"]); expect(update).toHaveBeenCalledWith({ avatar_path: null, updated_at: expect.any(String) });
});
it("cleans a newly uploaded object after a database failure", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: null }, error: null }).mockResolvedValueOnce({ data: null, error: { code: "failure" } });
  expect(await changeAvatar(png())).toHaveProperty("formError"); expect(remove).toHaveBeenCalledWith(["owner/avatar.png"]);
});
it("restores an overwritten object after a database failure", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.png" }, error: null }).mockResolvedValueOnce({ data: null, error: { code: "failure" } });
  expect(await changeAvatar(png())).toHaveProperty("formError");
  expect(upload).toHaveBeenLastCalledWith("owner/avatar.png", original, expect.objectContaining({ upsert: true }));
});
it("restores a removed object when clearing the path fails", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.jpg" }, error: null }).mockResolvedValueOnce({ data: null, error: { code: "failure" } });
  expect(await changeAvatar(null)).toHaveProperty("formError"); expect(upload).toHaveBeenCalledWith("owner/avatar.jpg", original, expect.any(Object));
});
it("reverts the database path when deleting the replaced object fails", async () => {
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.jpg" }, error: null });
  remove.mockResolvedValueOnce({ error: { message: "failure" } });
  expect(await changeAvatar(png())).toHaveProperty("formError");
  expect(update).toHaveBeenLastCalledWith({ avatar_path: "owner/avatar.jpg", updated_at: expect.any(String) }); expect(remove).toHaveBeenLastCalledWith(["owner/avatar.png"]);
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
  result.mockResolvedValueOnce({ data: { avatar_path: "owner/avatar.jpg" }, error: null });
  expect(await readPlayerAvatar()).toEqual({ kind: "image", file: original });
  expect(download).toHaveBeenCalledExactlyOnceWith("owner/avatar.jpg");
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
    expect(update).toHaveBeenCalledWith({ avatar_path: "owner/avatar.png", updated_at: "2026-09-28T12:00:00.000Z" });
  } finally { vi.useRealTimers(); }
});
it("rejects another owner's stored path before Storage access", async () => {
  result.mockResolvedValue({ data: { avatar_path: "victim/avatar.png" }, error: null });
  expect(await changeAvatar(png())).toHaveProperty("formError");
  expect(await changeAvatar(null)).toHaveProperty("formError");
  expect(await readPlayerAvatar()).toEqual({ kind: "not-found" });
  expect(download).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
});
