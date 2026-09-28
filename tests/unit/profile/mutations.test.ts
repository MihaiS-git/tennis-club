import { beforeEach, expect, it, vi } from "vitest";
import type { CurrentAccount } from "../../../src/lib/auth/account";
import { personalInformationSchema, tennisProfileSchema } from "../../../src/lib/profile/validation";

const { readCurrentAccount, from, update, insert, eq, result } = vi.hoisted(() => ({
  readCurrentAccount: vi.fn(), from: vi.fn(), update: vi.fn(), insert: vi.fn(), eq: vi.fn(), result: vi.fn(),
}));
vi.mock("../../../src/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("../../../src/lib/supabase/server", () => ({ createClient: async () => ({ from }) }));
import { savePersonalInformation, saveTennisProfile } from "../../../src/lib/profile/profile";

const personal = Object.fromEntries(Object.keys(personalInformationSchema.shape).map((key) => [key, ""]));
const tennis = Object.fromEntries(Object.keys(tennisProfileSchema.shape).map((key) => [key, ""]));
beforeEach(() => {
  vi.resetAllMocks();
  readCurrentAccount.mockResolvedValue({ state: "active", userId: "owner", email: "owner@example.test", roles: [] } satisfies CurrentAccount);
  const query = { update, insert, eq, select: () => query, maybeSingle: result };
  from.mockReturnValue(query); update.mockReturnValue(query); insert.mockReturnValue(query); eq.mockReturnValue(query);
  result.mockResolvedValue({ data: { id: "owner", user_id: "owner" }, error: null });
});

it("updates only permitted personal fields on the session owner's row", async () => {
  expect(await savePersonalInformation({ ...personal, first_name: " Ana " })).toEqual({ success: "Personal information saved." });
  expect(update).toHaveBeenCalledExactlyOnceWith({ ...Object.fromEntries(Object.keys(personal).map((key) => [key, null])), first_name: "Ana" });
  expect(eq).toHaveBeenCalledWith("id", "owner");
});
it.each(["unauthenticated", "missing-profile", "load-error", "suspended"])("rejects mutations for %s", async (state) => {
  readCurrentAccount.mockResolvedValue({ state });
  expect(await savePersonalInformation(personal)).toHaveProperty("formError");
  expect(await saveTennisProfile(tennis)).toHaveProperty("formError");
  expect(from).not.toHaveBeenCalled();
});
it.each([{ rating: 2500 }, { user_id: "victim" }, { avatar_path: "victim/avatar.jpg" }, { updated_at: "now" }])(
  "rejects managed fields before persistence %j", async (fields) => {
    expect(await saveTennisProfile({ ...tennis, ...fields })).toHaveProperty("formError");
    expect(from).not.toHaveBeenCalled();
  },
);
it("creates a player only on the first tennis save with session ownership", async () => {
  result.mockResolvedValueOnce({ data: null, error: null });
  expect(await saveTennisProfile({ ...tennis, display_name: "Ana" })).toHaveProperty("success");
  expect(insert).toHaveBeenCalledWith({ user_id: "owner", display_name: "Ana", sportya_level: null, handedness: null, backhand: null, preferred_game: null, preferred_surface: null, bio: null });
});
it("updates tennis fields without touching the existing avatar or rating", async () => {
  expect(await saveTennisProfile(tennis)).toHaveProperty("success");
  expect(update).toHaveBeenCalledWith({ display_name: null, sportya_level: null, handedness: null, backhand: null, preferred_game: null, preferred_surface: null, bio: null, updated_at: expect.any(String) });
  expect(eq).toHaveBeenCalledWith("user_id", "owner");
});
it("retries a concurrent first-save conflict as an owner update", async () => {
  result.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: null, error: { code: "23505" } });
  expect(await saveTennisProfile(tennis)).toHaveProperty("success");
  expect(insert).toHaveBeenCalledOnce(); expect(update).toHaveBeenCalledOnce();
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ updated_at: expect.any(String) }));
});
it("sets the player update timestamp from the server clock", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
  try {
    expect(await saveTennisProfile(tennis)).toHaveProperty("success");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ updated_at: "2026-09-28T12:00:00.000Z" }));
  } finally { vi.useRealTimers(); }
});
it("returns a safe error when persistence fails or affects no row", async () => {
  result.mockResolvedValue({ data: null, error: { code: "42501", message: "secret internal details" } });
  const state = await savePersonalInformation(personal);
  expect(state).toHaveProperty("formError"); expect(JSON.stringify(state)).not.toContain("secret");
});

it("personal saves never create or overwrite a chosen player display name", async () => {
  expect(await savePersonalInformation({ ...personal, first_name: "Changed", last_name: "Name" })).toHaveProperty("success");
  expect(from).toHaveBeenCalledExactlyOnceWith("users");
  expect(insert).not.toHaveBeenCalled();
  expect(update.mock.calls[0][0]).not.toHaveProperty("display_name");
});
it.each([{ country_code: "ZZ" }, { country_code: "UK" }])("rejects noncanonical countries before any server persistence %j", async (input) => {
  expect(await savePersonalInformation({ ...personal, ...input })).toHaveProperty("fieldErrors.country_code");
  expect(from).not.toHaveBeenCalled();
});
it.each(["3", "10", "5.5", "advanced"])("rejects invalid Sportya %s before server persistence", async (sportya_level) => {
  expect(await saveTennisProfile({ ...tennis, sportya_level })).toHaveProperty("fieldErrors.sportya_level");
  expect(from).not.toHaveBeenCalled();
});
