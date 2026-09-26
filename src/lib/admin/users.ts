import "server-only";

import { z } from "zod";

import { adminUserFiltersSchema, type AdminUserListInput } from "@/lib/admin/users-filters";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import type { UserRole } from "@/lib/auth/account";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

const roleCodeSchema = z.enum(["admin", "coach"] satisfies UserRole[]);
const statusSchema = z.enum(["active", "suspended"]);
const PAGE_SIZE = 20;

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

  function filteredQuery(head: boolean) {
    // A separate embedding filters parent users without narrowing the full role list.
    const columns = filters.role
      ? "id, email, status, created_at, updated_at, user_roles!user_roles_user_id_fkey(role_code), role_filter:user_roles!user_roles_user_id_fkey!inner(role_code)"
      : "id, email, status, created_at, updated_at, user_roles!user_roles_user_id_fkey(role_code)";
    let query = client.from(filters.sort === "roles" ? "user_role_sort_keys" : "users").select(columns, { head, count: head ? "exact" : undefined });
    if (filters.search) {
      // Escape regex metacharacters so search is literal partial text, not a pattern.
      // Unlike ILIKE, PostgREST's imatch does not reinterpret '*' as a wildcard.
      const literal = filters.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query = query.filter("email", "imatch", literal);
    }
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.role) query = query.eq("role_filter.role_code", filters.role);
    return query;
  }

  const counted = await filteredQuery(true);
  if (counted.error || counted.count === null) {
    logger.error({ event: "admin.users_list_failed", code: counted.error?.code }, "Failed to count users");
    throw new Error("Unable to load users.");
  }
  const total = counted.count;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const page = Math.min(filters.page, Math.max(1, totalPages));
  if (total === 0) return { users: [], page, pageSize: PAGE_SIZE, total, totalPages };

  const { data, error } = await filteredQuery(false)
    .order({ email: "email", status: "status", roles: "role_sort_key", joined: "created_at" }[filters.sort], { ascending: filters.dir === "asc" })
    .order("id", { ascending: filters.dir === "asc" })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (error || !data) {
    logger.error({ event: "admin.users_list_failed", code: error?.code }, "Failed to list users");
    throw new Error("Unable to load users.");
  }

  const rows = z.array(z.object({
    id: z.uuid(),
    email: z.string(),
    status: statusSchema,
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
    user_roles: z.array(z.object({ role_code: roleCodeSchema })),
  })).parse(data);
  const users = rows.map(({ user_roles, ...user }) => ({
    ...user,
    roles: user_roles.map(({ role_code }) => role_code).sort(),
  }));
  return { users, page, pageSize: PAGE_SIZE, total, totalPages };
}
