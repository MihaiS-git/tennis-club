import "server-only";

import { z } from "zod";

import { requireActiveAdmin } from "@/lib/admin/authorization";
import type { UserRole } from "@/lib/auth/account";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

const roleCodeSchema = z.enum(["admin", "coach", "member"] satisfies UserRole[]);
const statusSchema = z.enum(["active", "suspended"]);
const USER_LIMIT = 100;

export type AdminUserListItem = {
  id: string;
  email: string;
  status: "active" | "suspended";
  created_at: string;
  updated_at: string;
  roles: UserRole[];
};

export async function listAdminUsers(
  supabase?: Awaited<ReturnType<typeof createClient>>,
): Promise<AdminUserListItem[]> {
  const client = supabase ?? await createClient();
  await requireActiveAdmin(client);

  const { data, error } = await client
    .from("users")
    .select("id, email, status, created_at, updated_at, user_roles!user_roles_user_id_fkey(role_code)")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(USER_LIMIT);

  if (error || !data) {
    logger.error({ event: "admin.users_list_failed", code: error?.code }, "Failed to list users");
    throw new Error("Unable to load users.");
  }

  return data.map(({ id, email, status, created_at, updated_at, user_roles }) => ({
    id,
    email,
    status: statusSchema.parse(status),
    created_at,
    updated_at: z.iso.datetime({ offset: true }).parse(updated_at),
    roles: roleCodeSchema.array().parse(user_roles.map(({ role_code }) => role_code)).sort(),
  }));
}
