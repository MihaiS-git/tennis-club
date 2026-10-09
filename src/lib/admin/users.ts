import "server-only";

import { z } from "zod";

import { adminUserFiltersSchema, type AdminUserListInput } from "@/lib/admin/users-filters";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import type { UserRole } from "@/lib/auth/account";
import { getDataSource } from "@/lib/db/data-source";
import { normalizeDatabaseError } from "@/lib/db/errors";
import { countAdminUsers, findAdminUserById, findAdminUsersPage } from "@/lib/db/repositories/users.repository";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { loadProfile } from "@/lib/profile/profile";

const roleCodeSchema = z.enum(["admin", "coach"] satisfies UserRole[]);
const statusSchema = z.enum(["active", "suspended"]);
const PAGE_SIZE = 20;
const accountRowSchema = z.object({
  id: z.uuid(), email: z.string(), status: statusSchema,
  created_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }),
  user_roles: z.array(z.object({ role_code: roleCodeSchema })),
});

export type AdminUserDetails = AdminUserListItem & NonNullable<Awaited<ReturnType<typeof loadProfile>>>;

export async function readAdminUserDetails(userId: string, supabase?: Awaited<ReturnType<typeof createClient>>): Promise<AdminUserDetails | null> {
  const client = supabase ?? await createClient();
  await requireActiveAdmin(client);
  const id = z.uuid().parse(userId);
  let data;
  try {
    data = await findAdminUserById((await getDataSource()).manager, id);
  } catch (error: unknown) {
    logger.error({ event: "admin.user_details_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to read user details");
    throw new Error("Unable to load user details.");
  }
  if (!data) return null;
  const { user_roles, ...account } = accountRowSchema.parse({
    id: data.user.id,
    email: data.user.email,
    status: data.user.status,
    created_at: data.user.createdAt.toISOString(),
    updated_at: data.user.updatedAt.toISOString(),
    user_roles: data.roleCodes.map((role_code) => ({ role_code })),
  });
  const profile = await loadProfile(client, id);
  if (!profile) throw new Error("Unable to load user details.");
  return { ...account, roles: user_roles.map(({ role_code }) => role_code).sort(), ...profile };
}

export type AdminUserListItem = {
  id: string;
  email: string;
  status: "active" | "suspended";
  created_at: string;
  updated_at: string;
  roles: UserRole[];
};

export type AdminUserListResult = {
  users: AdminUserListItem[];
  page: number;
  pageSize: 20;
  total: number;
  totalPages: number;
};

export async function listAdminUsers(
  input: AdminUserListInput = {},
  supabase?: Awaited<ReturnType<typeof createClient>>,
): Promise<AdminUserListResult> {
  const client = supabase ?? await createClient();
  await requireActiveAdmin(client);
  const filters = adminUserFiltersSchema.parse(input);

  let manager;
  let total;
  try {
    manager = (await getDataSource()).manager;
    total = await countAdminUsers(manager, filters);
  } catch (error: unknown) {
    logger.error({ event: "admin.users_list_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to count users");
    throw new Error("Unable to load users.");
  }
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const page = Math.min(filters.page, Math.max(1, totalPages));
  if (total === 0) return { users: [], page, pageSize: PAGE_SIZE, total, totalPages };

  let data;
  try {
    data = await findAdminUsersPage(manager, filters, (page - 1) * PAGE_SIZE, PAGE_SIZE);
  } catch (error: unknown) {
    logger.error({ event: "admin.users_list_failed", code: normalizeDatabaseError(error).sqlState }, "Failed to list users");
    throw new Error("Unable to load users.");
  }

  const rows = z.array(accountRowSchema).parse(data.map(({ user, roleCodes }) => ({
    id: user.id,
    email: user.email,
    status: user.status,
    created_at: user.createdAt.toISOString(),
    updated_at: user.updatedAt.toISOString(),
    user_roles: roleCodes.map((role_code) => ({ role_code })),
  })));
  const users = rows.map(({ user_roles, ...user }) => ({
    ...user,
    roles: user_roles.map(({ role_code }) => role_code).sort(),
  }));
  return { users, page, pageSize: PAGE_SIZE, total, totalPages };
}
