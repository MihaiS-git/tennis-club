import { beforeEach, expect, it, vi } from "vitest";
const { profileContext, from, select, eq, maybeSingle } = vi.hoisted(() => ({
  profileContext: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(),
}));
vi.mock("../../../src/lib/profile/profile", () => ({ profileContext }));
import { readNavigationProfile } from "../../../src/lib/profile/navigation";

beforeEach(() => {
  vi.resetAllMocks();
  const query = { select, eq, maybeSingle };
  from.mockReturnValue(query); select.mockReturnValue(query); eq.mockReturnValue(query);
  profileContext.mockResolvedValue({ client: { from }, account: { state: "active", userId: "owner", roles: [] } });
});
it.each(["unauthenticated", "suspended", "missing-profile", "load-error"])("does not read avatar metadata for %s", async (state) => {
  profileContext.mockResolvedValue({ client: { from }, account: { state } });
  expect(await readNavigationProfile()).toEqual({ account: { state }, avatarUrl: null });
  expect(from).not.toHaveBeenCalled();
});
it("reads only the active session owner's metadata and reuses authenticated delivery", async () => {
  maybeSingle.mockResolvedValue({ data: { avatar_path: "owner/avatar.png", updated_at: "2026-09-28T12:00:00Z" }, error: null });
  expect(await readNavigationProfile()).toHaveProperty("avatarUrl", "/profile/avatar?v=2026-09-28T12%3A00%3A00Z");
  expect(from).toHaveBeenCalledExactlyOnceWith("player_profiles");
  expect(select).toHaveBeenCalledExactlyOnceWith("avatar_path, updated_at");
  expect(eq).toHaveBeenCalledExactlyOnceWith("user_id", "owner");
});
it.each([
  { data: null, error: null },
  { data: { avatar_path: null, updated_at: "2026-09-28T12:00:00Z" }, error: null },
  { data: null, error: { code: "42501" } },
  { data: { avatar_path: "invalid" }, error: null },
])("returns icon fallback for missing avatars or failed metadata reads %j", async (result) => {
  maybeSingle.mockResolvedValue(result);
  expect(await readNavigationProfile()).toHaveProperty("avatarUrl", null);
});
