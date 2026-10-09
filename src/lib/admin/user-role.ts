import "server-only";

import { z } from "zod";

import { requireActiveAdmin } from "@/lib/admin/authorization";
import type { UserRole } from "@/lib/auth/account";
import { inTransaction } from "@/lib/db/transaction";
import { lockActiveAdminAccount } from "@/lib/db/repositories/accounts.repository";
import { normalizeDatabaseError } from "@/lib/db/errors";
import {
  assignUserRole,
  lockAdminRole, lockUserIdentityFacts, countActiveAdmins,
  listUserRoleCodes,
  removeUserRole,
} from "@/lib/db/repositories/user-roles.repository";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

export const adminUserRoleSchema = z.object({
  userId: z.uuid(),
  role: z.enum(["admin", "coach"] satisfies UserRole[]),
  operation: z.enum(["assign", "revoke"]),
});

export type AdminUserRoleInput = z.infer<typeof adminUserRoleSchema>;

type AdminUserRoleSuccess = {
  ok: true;
  user: { id: string; roles: UserRole[] };
};

type AdminUserRoleFailure = {
  ok: false;
  reason: "not-found" | "final-active-admin" | "self-management";
};

export type AdminUserRoleResult = AdminUserRoleSuccess | AdminUserRoleFailure;

function failUpdate(stage: string, code?: string): never {
  logger.error({ event: "admin.user_role_update_failed", stage, code }, "Failed to update user roles");
  throw new Error("Unable to update user roles.");
}

export async function updateAdminUserRole(
  input: AdminUserRoleInput,
  supabase?: Awaited<ReturnType<typeof createClient>>,
): Promise<AdminUserRoleResult> {
  const { userId, role, operation } = adminUserRoleSchema.parse(input);
  const client = supabase ?? await createClient();
  const actor = await requireActiveAdmin(client);

  if (userId.toLowerCase() === actor.userId && role === "admin") {
    return { ok: false, reason: "self-management" };
  }

  let stage = "target";
  let assignments: string[];
  try {
    const result = await inTransaction(async (manager) => {
      await lockAdminRole(manager);
      if (!await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Administrator required");
      const target = await lockUserIdentityFacts(manager, userId);
      if (!target) return { ok: false, reason: "not-found" } as const;
      if (operation === "revoke" && role === "admin" && target.status === "active"
        && target.roles.includes("admin") && await countActiveAdmins(manager) <= 1) {
        return { ok: false, reason: "final-active-admin" } as const;
      }
      stage = "mutation";
      if (operation === "assign") await assignUserRole(manager, userId, role, actor.userId);
      else await removeUserRole(manager, userId, role);
      stage = "roles";
      return { ok: true, roles: await listUserRoleCodes(manager, userId) } as const;
    });
    if (!result.ok) return result;
    assignments = result.roles;
  } catch (error: unknown) {
    const databaseError = normalizeDatabaseError(error);
    if (
      stage === "mutation" &&
      databaseError.sqlState === "23514" &&
      databaseError.driverMessage === "At least one active administrator must remain."
    ) {
      return { ok: false, reason: "final-active-admin" };
    }
    failUpdate(stage, databaseError.sqlState);
  }

  const roles = adminUserRoleSchema.shape.role.array()
    .safeParse(assignments);
  if (!roles.success) failUpdate("roles");

  return { ok: true, user: { id: userId, roles: roles.data.sort() } };
}
