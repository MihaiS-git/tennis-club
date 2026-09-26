import { beforeEach, expect, it, vi } from "vitest";

import type { AdminUserRoleInput } from "../../../src/lib/admin/user-role";
import type { AdminUserStatusInput } from "../../../src/lib/admin/user-status";

const { updateAdminUserStatus, updateAdminUserRole, revalidatePath } = vi.hoisted(() => ({
  updateAdminUserStatus: vi.fn(),
  updateAdminUserRole: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../../../src/lib/admin/user-status", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/lib/admin/user-status")>(),
  updateAdminUserStatus,
}));
vi.mock("../../../src/lib/admin/user-role", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/lib/admin/user-role")>(),
  updateAdminUserRole,
}));

import { updateUserRoleAction, updateUserStatusAction } from "../../../src/app/admin/users/actions";

const userId = "84c64ef2-6925-4901-a137-f01395541411";
const statusInput: AdminUserStatusInput = { userId, status: "suspended" };
const roleInput: AdminUserRoleInput = { userId, role: "coach", operation: "assign" };

beforeEach(() => {
  vi.clearAllMocks();
});

it("updates status and revalidates the users page once", async () => {
  const result = { ok: true, user: { id: userId, status: "suspended" } };
  updateAdminUserStatus.mockResolvedValue(result);

  await expect(updateUserStatusAction(statusInput)).resolves.toBe(result);
  expect(updateAdminUserStatus).toHaveBeenCalledExactlyOnceWith(statusInput);
  expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/admin/users");
});

it("rejects an invalid status user ID before mutation", async () => {
  await expect(updateUserStatusAction({ ...statusInput, userId: "invalid-id" })).resolves.toEqual({
    ok: false, reason: "invalid-input",
  });
  expect(updateAdminUserStatus).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
});

it("rejects an invalid status before mutation", async () => {
  await expect(updateUserStatusAction({
    ...statusInput, status: "inactive" as AdminUserStatusInput["status"],
  })).resolves.toEqual({ ok: false, reason: "invalid-input" });
  expect(updateAdminUserStatus).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
});

it.each(["not-found", "final-active-admin", "self-management"] as const)(
  "preserves the status %s failure without revalidation",
  async (reason) => {
    const result = { ok: false, reason };
    updateAdminUserStatus.mockResolvedValue(result);

    await expect(updateUserStatusAction(statusInput)).resolves.toBe(result);
    expect(revalidatePath).not.toHaveBeenCalled();
  },
);

it("propagates unexpected status errors without revalidation", async () => {
  const error = new Error("unexpected failure");
  updateAdminUserStatus.mockRejectedValue(error);

  await expect(updateUserStatusAction(statusInput)).rejects.toBe(error);
  expect(revalidatePath).not.toHaveBeenCalled();
});

it.each(["assign", "revoke"] as const)(
  "updates a role with %s and revalidates the users page once",
  async (operation) => {
    const input = { ...roleInput, operation };
    const result = { ok: true, user: { id: userId, roles: operation === "assign" ? ["coach"] : [] } };
    updateAdminUserRole.mockResolvedValue(result);

    await expect(updateUserRoleAction(input)).resolves.toBe(result);
    expect(updateAdminUserRole).toHaveBeenCalledExactlyOnceWith(input);
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/admin/users");
  },
);

it("rejects an invalid role user ID before mutation", async () => {
  await expect(updateUserRoleAction({ ...roleInput, userId: "invalid-id" })).resolves.toEqual({
    ok: false, reason: "invalid-input",
  });
  expect(updateAdminUserRole).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
});

it("rejects an invalid role before mutation", async () => {
  await expect(updateUserRoleAction({
    ...roleInput, role: "owner" as AdminUserRoleInput["role"],
  })).resolves.toEqual({ ok: false, reason: "invalid-input" });
  expect(updateAdminUserRole).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
});

it("rejects an invalid role operation before mutation", async () => {
  await expect(updateUserRoleAction({
    ...roleInput, operation: "replace" as AdminUserRoleInput["operation"],
  })).resolves.toEqual({ ok: false, reason: "invalid-input" });
  expect(updateAdminUserRole).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
});

it.each(["not-found", "final-active-admin", "self-management", "member-role-required"] as const)(
  "preserves the role %s failure without revalidation",
  async (reason) => {
    const result = { ok: false, reason };
    updateAdminUserRole.mockResolvedValue(result);

    await expect(updateUserRoleAction(roleInput)).resolves.toBe(result);
    expect(revalidatePath).not.toHaveBeenCalled();
  },
);

it("propagates unexpected role errors without revalidation", async () => {
  const error = new Error("unexpected failure");
  updateAdminUserRole.mockRejectedValue(error);

  await expect(updateUserRoleAction(roleInput)).rejects.toBe(error);
  expect(revalidatePath).not.toHaveBeenCalled();
});
