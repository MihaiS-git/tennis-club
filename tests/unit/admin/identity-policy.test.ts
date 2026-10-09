import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(), transaction: vi.fn(), mutex: vi.fn(), actor: vi.fn(), target: vi.fn(), count: vi.fn(),
  assign: vi.fn(), remove: vi.fn(), list: vi.fn(), status: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.auth }));
vi.mock("@/lib/db/transaction", () => ({ inTransaction: mocks.transaction }));
vi.mock("@/lib/db/repositories/accounts.repository", () => ({ lockActiveAdminAccount: mocks.actor }));
vi.mock("@/lib/db/repositories/user-roles.repository", () => ({
  lockAdminRole: mocks.mutex, lockUserIdentityFacts: mocks.target, countActiveAdmins: mocks.count,
  assignUserRole: mocks.assign, removeUserRole: mocks.remove, listUserRoleCodes: mocks.list,
}));
vi.mock("@/lib/db/repositories/users.repository", () => ({ updateUserStatus: mocks.status }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
import { updateAdminUserRole } from "@/lib/admin/user-role";
import { updateAdminUserStatus } from "@/lib/admin/user-status";
const userId = "c7000000-0000-4000-8000-000000000031";
const actorId = "c7000000-0000-4000-8000-000000000032";
const revoke = () => updateAdminUserRole({ userId, role: "admin", operation: "revoke" });
const suspend = () => updateAdminUserStatus({ userId, status: "suspended" });
beforeEach(() => {
  vi.resetAllMocks(); mocks.auth.mockResolvedValue({ userId: actorId });
  mocks.transaction.mockImplementation((work: (manager: object) => Promise<unknown>) => work({}));
  mocks.actor.mockResolvedValue(true); mocks.target.mockResolvedValue({ status: "active", roles: ["admin"] });
  mocks.count.mockResolvedValue(1); mocks.list.mockResolvedValue([]);
  mocks.status.mockResolvedValue({ id: userId, status: "suspended" });
});
test.each([revoke, suspend])("rejects final active Admin before persistence", async (command) => {
  expect(await command()).toEqual({ ok: false, reason: "final-active-admin" });
  expect(mocks.remove).not.toHaveBeenCalled(); expect(mocks.status).not.toHaveBeenCalled();
  expect(mocks.actor.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.mutex.mock.invocationCallOrder[0]);
  expect(mocks.target.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.actor.mock.invocationCallOrder[0]);
  expect(mocks.count.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.target.mock.invocationCallOrder[0]);
});
test.each([revoke])("rechecks actor after acquiring the mutex", async (command) => {
  mocks.actor.mockResolvedValue(false);
  await expect(command()).rejects.toThrow();
  expect(mocks.target).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled(); expect(mocks.status).not.toHaveBeenCalled();
});
test("role assignment and reactivation also participate in the mutex", async () => {
  await updateAdminUserRole({ userId, role: "admin", operation: "assign" });
  expect(mocks.assign).toHaveBeenCalledWith(expect.anything(), userId, "admin", actorId);
  await updateAdminUserStatus({ userId, status: "active" });
  expect(mocks.mutex).toHaveBeenCalledTimes(2); expect(mocks.count).not.toHaveBeenCalled();
});
