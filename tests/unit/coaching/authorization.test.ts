import { beforeEach, expect, it, vi } from "vitest";

const { readCurrentAccount, notFound, redirect, getDataSource } = vi.hoisted(() => ({
  readCurrentAccount: vi.fn(),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
  getDataSource: vi.fn(),
}));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount }));
vi.mock("next/navigation", () => ({ notFound, redirect }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource }));

import {
  deleteCoachingProgram, deleteCoachProfile, coachIneligibility, loadAdminCoaching, removeClubCoachingPrice, saveClubCoachingPrice, saveCoachingProgram, saveCoachProfile,
  setCoachingProgramStatus, setCoachVisibility,
} from "@/lib/coaching/admin";
import CoachingLayout from "@/app/admin/coaching/layout";

beforeEach(() => vi.clearAllMocks());

const operations = [
  () => deleteCoachingProgram({}), () => deleteCoachProfile({}),
  () => loadAdminCoaching(), () => saveCoachingProgram({}), () => setCoachingProgramStatus({}), () => saveCoachProfile({}),
  () => setCoachVisibility({}), () => saveClubCoachingPrice({}), () => removeClubCoachingPrice({}),
];

it.each([
  ["a coach", { state: "active", userId: "u", email: "c@example.test", roles: ["coach"] }, "notFound"],
  ["a member", { state: "active", userId: "u", email: "m@example.test", roles: [] }, "notFound"],
  ["a suspended admin", { state: "suspended", userId: "u", email: "a@example.test", roles: ["admin"] }, "notFound"],
  ["an anonymous visitor", { state: "unauthenticated" }, "redirect:/login"],
])("rejects %s before reading or writing coaching data", async (_label, account, error) => {
  readCurrentAccount.mockResolvedValue(account);
  for (const operation of operations) await expect(operation()).rejects.toThrow(error);
  await expect(CoachingLayout({ children: null })).rejects.toThrow(error);
  expect(getDataSource).not.toHaveBeenCalled();
});

it("validates Admin input before opening a transaction", async () => {
  readCurrentAccount.mockResolvedValue({ state: "active", userId: "admin", email: "a@example.test", roles: ["admin"] });
  expect(await saveCoachingProgram({ fields: { name: "" } })).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await saveClubCoachingPrice({ amount: "-1" })).toMatchObject({ ok: false, reason: "invalid-input" });
  // The club pricing operation cannot address a coach's own override.
  const key = { program_id: "a1000000-0000-4000-8000-000000000001", duration_minutes: 60, currency: "RON" };
  expect(await saveClubCoachingPrice({ ...key, coach_user_id: "c1000000-0000-4000-8000-00000000000a", amount: "10" }))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await removeClubCoachingPrice({ ...key, coach_user_id: "c1000000-0000-4000-8000-00000000000a" }))
    .toMatchObject({ ok: false, reason: "invalid-input" });
  expect(await saveCoachProfile({ user_id: "x", create: true, fields: {} })).toMatchObject({ ok: false, reason: "invalid-input" });
  expect(getDataSource).not.toHaveBeenCalled();
});

it("requires an active account holding the coach role", () => {
  expect(coachIneligibility({ status: "active", roles: ["coach"] })).toBeNull();
  expect(coachIneligibility({ status: "active", roles: ["admin", "coach"] })).toBeNull();
  expect(coachIneligibility({ status: "active", roles: ["admin"] })).toBe("no-coach-role");
  expect(coachIneligibility({ status: "suspended", roles: ["coach"] })).toBe("suspended");
  expect(coachIneligibility(null)).toBe("suspended");
});
