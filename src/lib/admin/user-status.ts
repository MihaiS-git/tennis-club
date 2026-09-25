import "server-only";

import { z } from "zod";

import { requireActiveAdmin } from "@/lib/admin/authorization";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

export const adminUserStatusSchema = z.object({
  userId: z.uuid(),
  status: z.enum(["active", "suspended"]),
});

export type AdminUserStatusInput = z.infer<typeof adminUserStatusSchema>;

export type AdminUserStatusSuccess = {
  ok: true;
  user: { id: string; status: AdminUserStatusInput["status"] };
};

export type AdminUserStatusFailure = {
  ok: false;
  reason: "not-found" | "final-active-admin";
};

export type AdminUserStatusResult = AdminUserStatusSuccess | AdminUserStatusFailure;

export async function updateAdminUserStatus(
  input: AdminUserStatusInput,
  supabase?: Awaited<ReturnType<typeof createClient>>,
): Promise<AdminUserStatusResult> {
  const { userId, status } = adminUserStatusSchema.parse(input);
  const client = supabase ?? await createClient();
  await requireActiveAdmin(client);

  const { data, error } = await client
    .from("users")
    .update({ status })
    .eq("id", userId)
    .select("id, status")
    .maybeSingle();

  if (error) {
    if (error.code === "23514" && error.message === "At least one active administrator must remain.") {
      return { ok: false, reason: "final-active-admin" };
    }

    logger.error({ event: "admin.user_status_update_failed", code: error.code }, "Failed to update user status");
    throw new Error("Unable to update user status.");
  }

  if (!data) return { ok: false, reason: "not-found" };

  return { ok: true, user: { id: data.id, status: adminUserStatusSchema.shape.status.parse(data.status) } };
}
