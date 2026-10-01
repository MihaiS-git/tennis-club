import Link from "next/link";
import { AdminPageHeader } from "@/components/admin-page-controls";
import { Pagination } from "@/components/pagination";
import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { adminUserFiltersSchema } from "@/lib/admin/users-filters";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { listAdminUsers } from "@/lib/admin/users";

import { UserItem } from "./user-item";
import { UsersToolbar } from "./users-toolbar";

export const instant = false;

export default async function AdminUsersPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActiveAdmin();
  const params = await searchParams;
  const filters = adminUserFiltersSchema.parse({ search: params.q, status: params.status, role: params.role, page: params.page, sort: params.sort, dir: params.dir });
  const { users, page, totalPages } = await listAdminUsers(filters);
  const hasFilters = Boolean(filters.search || filters.status || filters.role);
  function filterQuery() {
    const query = new URLSearchParams();
    if (filters.search) query.set("q", filters.search);
    if (filters.status) query.set("status", filters.status);
    if (filters.role) query.set("role", filters.role);
    query.set("sort", filters.sort);
    query.set("dir", filters.dir);
    return query;
  }
  function pageHref(nextPage: number) {
    const query = filterQuery();
    query.set("page", String(nextPage));
    return `/admin/users?${query}`;
  }

  return (
    <>
      <AdminPageHeader title="Users" description="Manage accounts, coaches and administrators." />

      <UsersToolbar />

      {users.length === 0 ? (
        <div className="rounded-card border border-border bg-surface px-6 py-8 text-muted-foreground">
          {hasFilters ? "No users match these filters." : "No users found."}
        </div>
      ) : (
        <>
          <div className="space-y-3 lg:hidden">
            {users.map((user) => <UserItem key={user.id} user={user} currentAdminId={actor.userId} mobile />)}
          </div>

          <div className="hidden overflow-hidden rounded-card border border-border bg-surface lg:block">
            <table className="w-full table-fixed text-left font-sans text-sm">
              <thead className="border-b border-border bg-surface-muted text-xs font-semibold text-muted-foreground">
                <tr>
                  {([
                    ["email", "Email", "w-[30%]"],
                    ["status", "Status", "w-[15%]"],
                    ["roles", "Roles", ""],
                    ["joined", "Joined", "w-[17%]"],
                  ] as const).map(([column, label, width]) => {
                    const active = filters.sort === column;
                    const dir = active ? (filters.dir === "asc" ? "desc" : "asc") : column === "joined" ? "desc" : "asc";
                    const query = filterQuery();
                    query.set("sort", column);
                    query.set("dir", dir);
                    const Icon = active ? filters.dir === "asc" ? ArrowUp : ArrowDown : ArrowUpDown;
                    return (
                      <th key={column} scope="col" aria-sort={active ? filters.dir === "asc" ? "ascending" : "descending" : "none"} className={`${width} px-3 py-3`}>
                        <Link href={`/admin/users?${query}`} scroll={false} className="inline-flex items-center gap-1.5 rounded-control hover:text-primary focus-visible:outline-2 focus-visible:outline-primary">
                          {label}<Icon aria-hidden="true" size={14} />
                        </Link>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {users.map((user) => <UserItem key={user.id} user={user} currentAdminId={actor.userId} />)}
              </tbody>
            </table>
          </div>
        </>
      )}
      {totalPages > 1 && (
        <div className="mt-6">
          <Pagination currentPage={page} totalPages={totalPages} buildHref={pageHref} />
        </div>
      )}
    </>
  );
}
