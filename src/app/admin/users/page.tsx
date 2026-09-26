import { requireActiveAdmin } from "@/lib/admin/authorization";
import { listAdminUsers, type AdminUserListItem } from "@/lib/admin/users";

import { formatUserDate } from "./date-format";
import { UserManagementDialog } from "./user-management-dialog";

const roleLabels: Record<AdminUserListItem["roles"][number], string> = {
  admin: "Admin",
  coach: "Coach",
  member: "Member",
};

function StatusBadge({ status }: { status: AdminUserListItem["status"] }) {
  return (
    <span className={`inline-flex rounded-control px-2.5 py-1 text-xs font-semibold ${
      status === "active"
        ? "bg-success-background text-success"
        : "bg-danger-background text-danger"
    }`}>
      {status === "active" ? "Active" : "Suspended"}
    </span>
  );
}

function RoleChips({ roles }: { roles: AdminUserListItem["roles"] }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {roles.map((role) => (
        <span key={role} className="rounded-control bg-surface-muted px-2.5 py-1 text-xs font-medium text-primary">
          {roleLabels[role]}
        </span>
      ))}
    </span>
  );
}

export default async function AdminUsersPage() {
  const actor = await requireActiveAdmin();
  const users = await listAdminUsers();

  return (
    <main className="flex-1 bg-background">
      <div className="mx-auto max-w-7xl px-6 py-10 md:px-8 md:py-12 lg:py-16">
        <header className="mb-8 md:mb-10">
          <h1 className="font-heading text-4xl font-semibold tracking-tight text-foreground md:text-5xl">
            Users
          </h1>
          <p className="mt-3 max-w-2xl text-base text-muted-foreground">
            Manage club members, coaches and administrators.
          </p>
        </header>

        {users.length === 0 ? (
          <div className="rounded-card border border-border bg-surface px-6 py-8 text-muted-foreground">
            No users found.
          </div>
        ) : (
          <>
            <div className="space-y-3 lg:hidden">
              {users.map((user) => (
                <article key={user.id} className="min-w-0 rounded-card border border-border bg-surface p-5">
                  <p className="break-words font-semibold text-foreground">{user.email}</p>
                  <dl className="mt-4 grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-3 text-sm">
                    <dt className="pt-1 text-xs text-muted-foreground">Status</dt>
                    <dd><StatusBadge status={user.status} /></dd>
                    <dt className="pt-1 text-xs text-muted-foreground">Roles</dt>
                    <dd><RoleChips roles={user.roles} /></dd>
                    <dt className="text-xs text-muted-foreground">Joined</dt>
                    <dd className="text-foreground">{formatUserDate(user.created_at)}</dd>
                  </dl>
                  <div className="mt-5 border-t border-border pt-4">
                    <UserManagementDialog user={user} currentAdminId={actor.userId} />
                  </div>
                </article>
              ))}
            </div>

            <div className="hidden overflow-hidden rounded-card border border-border bg-surface lg:block">
              <table className="w-full table-fixed text-left font-sans text-sm">
                <thead className="border-b border-border text-xs font-semibold text-muted-foreground">
                  <tr>
                    <th scope="col" className="w-[30%] px-4 py-4 lg:px-5">Email</th>
                    <th scope="col" className="w-[15%] px-4 py-4 lg:px-5">Status</th>
                    <th scope="col" className="px-4 py-4 lg:px-5">Roles</th>
                    <th scope="col" className="w-[17%] px-4 py-4 lg:px-5">Joined</th>
                    <th scope="col" className="w-[13%] px-4 py-4 lg:px-5">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {users.map((user) => (
                    <tr key={user.id}>
                      <td className="break-words px-4 py-5 font-semibold text-foreground lg:px-5">{user.email}</td>
                      <td className="px-4 py-5 lg:px-5"><StatusBadge status={user.status} /></td>
                      <td className="px-4 py-5 lg:px-5"><RoleChips roles={user.roles} /></td>
                      <td className="px-4 py-5 text-muted-foreground lg:px-5">
                        {formatUserDate(user.created_at)}
                      </td>
                      <td className="px-4 py-5 lg:px-5"><UserManagementDialog user={user} currentAdminId={actor.userId} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
