import { createClient } from "@supabase/supabase-js";
import { QueryFailedError } from "typeorm";
import { beforeEach, expect, it, vi } from "vitest";

import type { PersonalInformationPersistence } from "@/lib/db/repositories/users.repository";
import type { PlayerProfilePersistence } from "@/lib/db/repositories/player-profiles.repository";

const { source, personalRead, playerRead, personalWrite, playerWrite, accountRead, logError, manager } = vi.hoisted(() => ({
  source: vi.fn(), personalRead: vi.fn(), playerRead: vi.fn(), personalWrite: vi.fn(), playerWrite: vi.fn(), accountRead: vi.fn(), logError: vi.fn(), manager: {},
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: source }));
vi.mock("@/lib/db/repositories/users.repository", () => ({ findPersonalInformationByUserId: personalRead, updatePersonalInformation: personalWrite }));
vi.mock("@/lib/db/repositories/player-profiles.repository", () => ({ findPlayerProfileByUserId: playerRead, upsertEditableTennisInformation: playerWrite }));
vi.mock("@/lib/logger", () => ({ logger: { error: logError } }));

vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: accountRead }));

import { personalInformationSchema, tennisProfileSchema } from "@/lib/profile/validation";
import { loadProfile, savePersonalInformation, saveTennisProfile } from "@/lib/profile/profile";

const personal = {
  firstName: "Ana", lastName: "Player", phone: "+40 123", dateOfBirth: "1990-04-23",
  addressLine1: "Street 1", addressLine2: null, city: "Bucharest", postalCode: "123456", countryCode: "RO",
} satisfies PersonalInformationPersistence;
const player = {
  displayName: "Ace", avatarPath: "owner/avatar.webp", sportyaLevel: "5.5", rating: 1450,
  handedness: "left", backhand: "two_handed", preferredGame: "both", preferredSurface: "clay",
  bio: null, updatedAt: new Date("2026-09-28T12:00:00Z"),
} satisfies PlayerProfilePersistence;
const client = createClient("http://127.0.0.1:54321", "test-key", {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const userId = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  source.mockResolvedValue({ manager });
  personalRead.mockResolvedValue(personal);
  playerRead.mockResolvedValue(player);
  personalWrite.mockResolvedValue(true);
  playerWrite.mockResolvedValue(true);
  accountRead.mockResolvedValue({ state: "active", userId, email: "owner@example.test", roles: [] });
});

it.each(["personal"] as const)("sanitizes %s persistence failures", async (boundary) => {
  const failure = new QueryFailedError("private SQL", ["private parameter"],
    Object.assign(new Error("private connection information"), { code: "40001" }));
  ({ source, personal: personalRead, player: playerRead }[boundary]).mockRejectedValue(failure);
  expect(await loadProfile(client, userId)).toBeNull();
  expect(logError).toHaveBeenCalledExactlyOnceWith(
    { event: "profile.load_failed", kind: "serialization_failure", code: "40001" }, "Failed to load profile",
  );
});

const emptyPersonal = Object.fromEntries(Object.keys(personalInformationSchema.shape).map((key) => [key, ""]));
const emptyTennis = Object.fromEntries(Object.keys(tennisProfileSchema.shape).map((key) => [key, ""]));
const workflows = [
  { name: "personal", save: savePersonalInformation, write: personalWrite, input: emptyPersonal,
    success: "Personal information saved.", validation: "Check your personal information.",
    failure: "We couldn't save your personal information. Please try again.", message: "Failed to save personal information" },
  { name: "tennis", save: saveTennisProfile, write: playerWrite, input: emptyTennis,
    success: "Tennis profile saved.", validation: "Check your tennis profile.",
    failure: "We couldn't save your tennis profile. Please try again.", message: "Failed to save tennis profile" },
];

it.each(workflows)("saves $name using only editable fields and the authoritative owner", async ({ name, save, write, input, success }) => {
  const from = vi.spyOn(client, "from");
  expect(await save(input, client)).toEqual({ success });
  expect(accountRead).toHaveBeenCalledExactlyOnceWith(client);
  const keys = name === "personal"
    ? ["firstName", "lastName", "phone", "dateOfBirth", "addressLine1", "addressLine2", "city", "postalCode", "countryCode"]
    : ["displayName", "sportyaLevel", "handedness", "backhand", "preferredGame", "preferredSurface", "bio"];
  expect(write).toHaveBeenCalledExactlyOnceWith(manager, userId, Object.fromEntries(keys.map((key) => [key, null])));
  expect(from).not.toHaveBeenCalled();
});

it.each(workflows)("rejects non-editable submitted $name fields before authorization/persistence", async ({ save, input, validation }) => {
  for (const key of ["user_id", "id", "rating", "avatar_path", "created_at", "updated_at", "email", "status", "roles"]) {
    expect(await save({ ...input, [key]: "spoof" }, client)).toHaveProperty("formError", validation);
  }
  expect(accountRead).not.toHaveBeenCalled();
  expect(source).not.toHaveBeenCalled();
  expect(personalWrite).not.toHaveBeenCalled();
  expect(playerWrite).not.toHaveBeenCalled();
});

it.each(workflows)("requires an active account before $name persistence", async ({ save, input }) => {
  for (const state of ["unauthenticated", "missing-profile", "load-error", "suspended"]) {
    accountRead.mockResolvedValue({ state, userId });
    expect(await save(input, client)).toEqual({ formError: "Profile changes require an active account." });
  }
  expect(source).not.toHaveBeenCalled();
  expect(personalWrite).not.toHaveBeenCalled();
  expect(playerWrite).not.toHaveBeenCalled();
});

it.each([workflows[1]])("sanitizes $name repository and connection errors", async ({ name, save, write, input, failure, message }) => {
  const error = new QueryFailedError("private SQL", ["private personal data"],
    Object.assign(new Error("private connection information"), { code: "40001" }));
  for (const boundary of [write, source]) {
    write.mockResolvedValue(true);
    source.mockResolvedValue({ manager });
    logError.mockClear();
    boundary.mockRejectedValue(error);
    expect(await save(input, client)).toEqual({ formError: failure });
    expect(logError).toHaveBeenCalledExactlyOnceWith({
      event: `profile.${name}_save_failed`, kind: "serialization_failure", code: "40001",
    }, message);
  }
});
