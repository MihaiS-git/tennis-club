"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { readAdminUserDetails } from "@/lib/admin/users";
import { logger } from "@/lib/logger";

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

export async function readUserDetailsAction(userId: string) {
  const parsed = z.uuid().safeParse(userId);
  if (!parsed.success) return { ok: false, error: "Invalid user." } as const;
  try {
    const user = await readAdminUserDetails(parsed.data);
    return user ? { ok: true, user } as const : { ok: false, error: "This user no longer exists." } as const;
  } catch (error) {
    unstable_rethrow(error);
    logger.error({ event: "admin.user_details_request_failed" }, "Failed to load user details");
    return { ok: false, error: "Unable to load user details. Please try again." } as const;
  }
}

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
