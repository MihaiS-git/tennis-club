"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AdminUserListItem } from "@/lib/admin/users";
import { formatUserDate } from "./date-format";
import { UserManagementDialog } from "./user-management-dialog";

const roleLabels: Record<AdminUserListItem["roles"][number], string> = { admin: "Admin", coach: "Coach" };

function StatusBadge({ status }: { status: AdminUserListItem["status"] }) {
  return <span className={`inline-flex rounded-control px-2.5 py-1 text-xs font-semibold ${status === "active"
    ? "bg-success-background text-success" : "bg-danger-background text-danger"}`}>
    {status === "active" ? "Active" : "Suspended"}
  </span>;
}

function RoleChips({ roles }: { roles: AdminUserListItem["roles"] }) {
  if (roles.length === 0) return <span className="text-muted-foreground">—</span>;
  return <span className="flex flex-wrap gap-1.5">{roles.map((role) =>
    <span key={role} className="rounded-control bg-surface-muted px-2.5 py-1 text-xs font-medium text-primary">{roleLabels[role]}</span>)}</span>;
}

export function UserItem({ user, currentAdminId, mobile }: {
  user: AdminUserListItem; currentAdminId: string; mobile?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLElement | null>(null);
  const rowProps = {
    ref: (element: HTMLTableRowElement | HTMLElement | null) => { rowRef.current = element; },
    tabIndex: 0,
    "aria-label": `Manage user ${user.email}`,
    onClick: () => setOpen(true),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(true); }
    },
  };
  const hover = "cursor-pointer transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus";
  const dialog = open && createPortal(<UserManagementDialog user={user} currentAdminId={currentAdminId} open={open} onOpenChange={(nextOpen) => {
    setOpen(nextOpen);
    if (!nextOpen) rowRef.current?.focus();
  }} />, document.body);
  return mobile ? <>
    <article {...rowProps} role="button" className={`min-w-0 rounded-card border border-border bg-surface p-5 ${hover}`}>
      <p className="break-words font-semibold text-foreground">{user.email}</p>
      <dl className="mt-4 grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-3 text-sm">
        <dt className="pt-1 text-xs text-muted-foreground">Status</dt><dd><StatusBadge status={user.status} /></dd>
        <dt className="pt-1 text-xs text-muted-foreground">Roles</dt><dd><RoleChips roles={user.roles} /></dd>
        <dt className="text-xs text-muted-foreground">Joined</dt><dd className="text-foreground">{formatUserDate(user.created_at)}</dd>
      </dl>
    </article>
    {dialog}
  </> : <>
    <tr {...rowProps} className={hover}>
      <td className="break-words px-4 py-5 font-semibold text-foreground lg:px-5">{user.email}</td>
      <td className="px-4 py-5 lg:px-5"><StatusBadge status={user.status} /></td>
      <td className="px-4 py-5 lg:px-5"><RoleChips roles={user.roles} /></td>
      <td className="px-4 py-5 text-muted-foreground lg:px-5">{formatUserDate(user.created_at)}</td>
    </tr>
    {dialog}
  </>;
}
