import "server-only";

import { z } from "zod";

import { requireActiveAdmin } from "@/lib/admin/authorization";
import { inTransaction } from "@/lib/db/transaction";
import { lockActiveAdminAccount } from "@/lib/db/repositories/accounts.repository";
import { lockAdminRole, lockUserIdentityFacts, countActiveAdmins } from "@/lib/db/repositories/user-roles.repository";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { updateUserStatus } from "@/lib/db/repositories/users.repository";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

export const adminUserStatusSchema = z.object({
  userId: z.uuid(),
  status: z.enum(["active", "suspended"]),
});

export type AdminUserStatusInput = z.infer<typeof adminUserStatusSchema>;

type AdminUserStatusSuccess = {
  ok: true;
  user: { id: string; status: AdminUserStatusInput["status"] };
};

type AdminUserStatusFailure = {
  ok: false;
  reason: "not-found" | "final-active-admin" | "self-management";
};

export type AdminUserStatusResult = AdminUserStatusSuccess | AdminUserStatusFailure;

export async function updateAdminUserStatus(
  input: AdminUserStatusInput,
  supabase?: Awaited<ReturnType<typeof createClient>>,
): Promise<AdminUserStatusResult> {
  const { userId, status } = adminUserStatusSchema.parse(input);
  const client = supabase ?? await createClient();
  const actor = await requireActiveAdmin(client);

  if (userId.toLowerCase() === actor.userId) {
    return { ok: false, reason: "self-management" };
  }

  let data;
  try {
    const result = await inTransaction(async (manager) => {
      await lockAdminRole(manager);
      if (!await lockActiveAdminAccount(manager, actor.userId)) throw new Error("Administrator required");
      const target = await lockUserIdentityFacts(manager, userId);
      if (!target) return { ok: false, reason: "not-found" } as const;
      if (status === "suspended" && target.status === "active" && target.roles.includes("admin")
        && await countActiveAdmins(manager) <= 1) return { ok: false, reason: "final-active-admin" } as const;
      return { ok: true, user: await updateUserStatus(manager, userId, status) } as const;
    });
    if (!result.ok) return result;
    data = result.user;
  } catch (error: unknown) {
    const databaseError = normalizeDatabaseError(error);
    if (databaseError.sqlState === "23514" && databaseError.driverMessage === "At least one active administrator must remain.") {
      return { ok: false, reason: "final-active-admin" };
    }

    logger.error({ event: "admin.user_status_update_failed", code: databaseError.sqlState }, "Failed to update user status");
    throw new Error("Unable to update user status.");
  }

  if (!data) return { ok: false, reason: "not-found" };

  return { ok: true, user: { id: data.id, status: adminUserStatusSchema.shape.status.parse(data.status) } };
}
