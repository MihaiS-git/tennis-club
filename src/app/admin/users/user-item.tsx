"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { AdminUserListItem } from "@/lib/admin/users";
import { formatUserDate } from "./date-format";

const roleLabels: Record<AdminUserListItem["roles"][number], string> = { admin: "Admin", coach: "Coach" };

export function StatusBadge({ status }: { status: AdminUserListItem["status"] }) {
  return <span className={`inline-flex rounded-control px-2.5 py-1 text-xs font-semibold ${status === "active"
    ? "bg-success-background text-success" : "bg-danger-background text-danger"}`}>
    {status === "active" ? "Active" : "Suspended"}
  </span>;
}

export function RoleChips({ roles }: { roles: AdminUserListItem["roles"] }) {
  if (roles.length === 0) return <span className="text-muted-foreground">—</span>;
  return <span className="flex flex-wrap gap-1.5">{roles.map((role) =>
    <span key={role} className="rounded-control bg-surface-muted px-2.5 py-1 text-xs font-medium text-primary">{roleLabels[role]}</span>)}</span>;
}

export function UserItem({ user, mobile }: {
  user: AdminUserListItem; mobile?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = new URLSearchParams(searchParams);
  query.delete("tab");
  const href = `/admin/users/${user.id}${query.size ? `?${query}` : ""}`;
  const rowProps = {
    tabIndex: 0,
    "aria-label": `Manage user ${user.email}`,
    onClick: (event: React.MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("a, button")) return;
      router.push(href);
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); router.push(href); }
    },
  };
  const hover = "cursor-pointer transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus";
  return mobile ? <>
    <article {...rowProps} role="button" className={`min-w-0 rounded-card border border-border bg-surface p-5 ${hover}`}>
      <Link href={href} className="break-words font-semibold text-foreground hover:text-primary focus-visible:outline-2 focus-visible:outline-focus">{user.email}</Link>
      <dl className="mt-4 grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-3 text-sm">
        <dt className="pt-1 text-xs text-muted-foreground">Status</dt><dd><StatusBadge status={user.status} /></dd>
        <dt className="pt-1 text-xs text-muted-foreground">Roles</dt><dd><RoleChips roles={user.roles} /></dd>
        <dt className="text-xs text-muted-foreground">Joined</dt><dd className="text-foreground">{formatUserDate(user.created_at)}</dd>
      </dl>
    </article>
  </> : <>
    <tr {...rowProps} className={hover}>
      <td className="break-words px-4 py-5 font-semibold text-foreground lg:px-5"><Link href={href} className="hover:text-primary focus-visible:outline-2 focus-visible:outline-focus">{user.email}</Link></td>
      <td className="px-4 py-5 lg:px-5"><StatusBadge status={user.status} /></td>
      <td className="px-4 py-5 lg:px-5"><RoleChips roles={user.roles} /></td>
      <td className="px-4 py-5 text-muted-foreground lg:px-5">{formatUserDate(user.created_at)}</td>
    </tr>
  </>;
}
