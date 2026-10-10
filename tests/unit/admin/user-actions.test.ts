import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ revalidate: vi.fn(), status: vi.fn(), role: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("../../../src/lib/admin/user-status", async (original) => ({ ...await original<typeof import("../../../src/lib/admin/user-status")>(), updateAdminUserStatus: mocks.status }));
vi.mock("../../../src/lib/admin/user-role", async (original) => ({ ...await original<typeof import("../../../src/lib/admin/user-role")>(), updateAdminUserRole: mocks.role }));
import { updateUserRoleAction, updateUserStatusAction } from "../../../src/app/admin/users/actions";
const userId = "84c64ef2-6925-4901-a137-f01395541411";
beforeEach(() => vi.resetAllMocks());
it("revalidates the table and management page after each successful status or role change", async () => {
  mocks.status.mockResolvedValue({ ok: true, user: { id: userId, status: "suspended" } });
  await updateUserStatusAction({ userId, status: "suspended" });
  expect(mocks.revalidate.mock.calls).toEqual([["/admin/users"], [`/admin/users/${userId}`]]);
  mocks.revalidate.mockClear();
  mocks.role.mockResolvedValue({ ok: true, user: { id: userId, roles: ["coach"] } });
  await updateUserRoleAction({ userId, role: "coach", operation: "assign" });
  expect(mocks.revalidate.mock.calls).toEqual([["/admin/users"], [`/admin/users/${userId}`]]);
});
it("retains failed and invalid mutation results without revalidation", async () => {
  mocks.status.mockResolvedValue({ ok: false, reason: "final-active-admin" });
  mocks.role.mockResolvedValue({ ok: false, reason: "self-management" });
  expect(await updateUserStatusAction({ userId, status: "suspended" })).toEqual({ ok: false, reason: "final-active-admin" });
  expect(await updateUserRoleAction({ userId, role: "admin", operation: "revoke" })).toEqual({ ok: false, reason: "self-management" });
  expect(await updateUserStatusAction({ userId: "invalid", status: "suspended" })).toEqual({ ok: false, reason: "invalid-input" });
  expect(mocks.revalidate).not.toHaveBeenCalled();
});
