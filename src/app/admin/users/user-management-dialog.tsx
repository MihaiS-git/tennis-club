"use client";

import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { updateUserRoleAction, updateUserStatusAction } from "./actions";
import type { UserRole } from "@/lib/auth/account";

type ManagedUser = {
  id: string;
  email: string;
  status: "active" | "suspended";
  roles: UserRole[];
};

const roleLabels: Record<UserRole, string> = {
  admin: "Admin",
  coach: "Coach",
  member: "Member",
};

const failureMessages = {
  "invalid-input": "Invalid user update.",
  "not-found": "This user no longer exists.",
  "final-active-admin": "At least one active administrator must remain.",
} as const;

export function UserManagementDialog({ user }: { user: ManagedUser }) {
  const titleId = useId();
  const statusId = useId();
  const rolesId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState(user.status);
  const [roles, setRoles] = useState(user.roles);
  const [serverState, setServerState] = useState({
    id: user.id,
    status: user.status,
    roles: user.roles.join("|"),
  });

  const incomingRoles = user.roles.join("|");
  if (user.id !== serverState.id || user.status !== serverState.status || incomingRoles !== serverState.roles) {
    setServerState({ id: user.id, status: user.status, roles: incomingRoles });
    setStatus(user.status);
    setRoles(user.roles);
  }

  async function changeStatus() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);

    const nextStatus = status === "active" ? "suspended" : "active";
    try {
      const result = await updateUserStatusAction({ userId: user.id, status: nextStatus });
      if (result.ok) {
        setStatus(result.user.status);
        toast.success(result.user.status === "suspended" ? "User suspended." : "User reactivated.");
      } else {
        toast.error(failureMessages[result.reason]);
      }
    } catch {
      toast.error("Unable to update user. Please try again.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function changeRole(role: UserRole, assigned: boolean) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);

    const operation = assigned ? "revoke" : "assign";
    try {
      const result = await updateUserRoleAction({ userId: user.id, role, operation });
      if (result.ok) {
        setRoles(result.user.roles);
        toast.success(operation === "assign" ? "Role assigned." : "Role removed.");
      } else {
        toast.error(failureMessages[result.reason]);
      }
    } catch {
      toast.error("Unable to update user. Please try again.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="inline-flex min-h-9 items-center justify-center rounded-control border border-border-strong bg-surface px-3 text-sm font-semibold text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        Manage
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-card border border-border bg-surface p-0 text-foreground shadow-floating backdrop:bg-foreground/50"
      >
        <div className="p-5 sm:p-6">
          <header className="flex items-start justify-between gap-4 border-b border-border pb-5">
            <div className="min-w-0">
              <h2 id={titleId} className="font-heading text-xl font-semibold">Manage user</h2>
              <p className="mt-1 break-all text-sm text-muted-foreground">{user.email}</p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={() => dialogRef.current?.close()}
              className="shrink-0 rounded-control border border-border-strong px-3 py-1.5 text-sm font-medium text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              Close
            </button>
          </header>

          <section className="border-b border-border py-5" aria-labelledby={statusId}>
            <h3 id={statusId} className="font-heading text-base font-semibold">Account status</h3>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <span className={`inline-flex rounded-control px-2.5 py-1 text-xs font-semibold ${
                status === "active" ? "bg-success-background text-success" : "bg-danger-background text-danger"
              }`}>
                {status === "active" ? "Active" : "Suspended"}
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={changeStatus}
                className={`rounded-control border px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-wait disabled:opacity-60 ${
                  status === "active"
                    ? "border-danger bg-danger-background text-danger hover:bg-surface-muted"
                    : "border-border-strong bg-surface text-primary hover:bg-surface-muted"
                }`}
              >
                {status === "active" ? "Suspend user" : "Reactivate user"}
              </button>
            </div>
          </section>

          <section className="pt-5" aria-labelledby={rolesId}>
            <h3 id={rolesId} className="font-heading text-base font-semibold">Roles</h3>
            <ul className="mt-3 divide-y divide-border">
              {(["admin", "coach", "member"] as const).map((role) => {
                const assigned = roles.includes(role);
                return (
                  <li key={role} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3">
                    <div className="min-w-0">
                      <span className="font-medium text-primary">{roleLabels[role]}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {assigned ? "Assigned" : "Not assigned"}
                      </span>
                    </div>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => changeRole(role, assigned)}
                      className="min-w-18 rounded-control border border-border-strong bg-surface px-3 py-2 text-sm font-semibold text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-wait disabled:opacity-60"
                    >
                      {assigned ? "Remove" : "Assign"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </dialog>
    </>
  );
}
