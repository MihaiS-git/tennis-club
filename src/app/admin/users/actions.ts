"use server";

import { revalidatePath } from "next/cache";

import {
  adminUserRoleSchema,
  type AdminUserRoleInput,
  type AdminUserRoleResult,
  updateAdminUserRole,
} from "@/lib/admin/user-role";
import {
  adminUserStatusSchema,
  type AdminUserStatusInput,
  type AdminUserStatusResult,
  updateAdminUserStatus,
} from "@/lib/admin/user-status";

type UserStatusActionResult = AdminUserStatusResult | { ok: false; reason: "invalid-input" };
type UserRoleActionResult = AdminUserRoleResult | { ok: false; reason: "invalid-input" };

export async function updateUserStatusAction(input: AdminUserStatusInput): Promise<UserStatusActionResult> {
  const parsed = adminUserStatusSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input" };

  const result = await updateAdminUserStatus(parsed.data);
  if (result.ok) revalidatePath("/admin/users");
  return result;
}

export async function updateUserRoleAction(input: AdminUserRoleInput): Promise<UserRoleActionResult> {
  const parsed = adminUserRoleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input" };

  const result = await updateAdminUserRole(parsed.data);
  if (result.ok) revalidatePath("/admin/users");
  return result;
}
