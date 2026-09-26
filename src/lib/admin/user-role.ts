import "server-only";

import { z } from "zod";

import { requireActiveAdmin } from "@/lib/admin/authorization";
import type { UserRole } from "@/lib/auth/account";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

export const adminUserRoleSchema = z.object({
  userId: z.uuid(),
  role: z.enum(["admin", "coach"] satisfies UserRole[]),
  operation: z.enum(["assign", "revoke"]),
});

export type AdminUserRoleInput = z.infer<typeof adminUserRoleSchema>;

export type AdminUserRoleSuccess = {
  ok: true;
  user: { id: string; roles: UserRole[] };
};

export type AdminUserRoleFailure = {
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

  const target = await client.from("users").select("id").eq("id", userId).maybeSingle();
  if (target.error) failUpdate("target", target.error.code);
  if (!target.data) return { ok: false, reason: "not-found" };

  const mutation = operation === "assign"
    ? await client.from("user_roles").upsert(
      { user_id: userId, role_code: role },
      { onConflict: "user_id,role_code", ignoreDuplicates: true },
    )
    : await client.from("user_roles").delete().eq("user_id", userId).eq("role_code", role);

  if (mutation.error) {
    if (
      mutation.error.code === "23514" &&
      mutation.error.message === "At least one active administrator must remain."
    ) {
      return { ok: false, reason: "final-active-admin" };
    }
    failUpdate("mutation", mutation.error.code);
  }

  const assignments = await client.from("user_roles")
    .select("role_code")
    .eq("user_id", userId)
    .order("role_code");
  if (assignments.error || !assignments.data) failUpdate("roles", assignments.error?.code);

  const roles = adminUserRoleSchema.shape.role.array()
    .safeParse(assignments.data.map(({ role_code }) => role_code));
  if (!roles.success) failUpdate("roles");

  return { ok: true, user: { id: userId, roles: roles.data.sort() } };
}
