"use client";

import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { updateUserRoleAction, updateUserStatusAction } from "./actions";
import { formatUserDate } from "./date-format";
import type { UserRole } from "@/lib/auth/account";

type ManagedUser = {
  id: string;
  email: string;
  updated_at: string;
  status: "active" | "suspended";
  roles: UserRole[];
};

const roleLabels: Record<UserRole, string> = {
  admin: "Admin",
  coach: "Coach",
  member: "Member",
};

const failureMessages = {
  "member-role-required": "The member role is required for every account.",
  "invalid-input": "Invalid user update.",
  "not-found": "This user no longer exists.",
  "final-active-admin": "At least one active administrator must remain.",
} as const;

export function UserManagementDialog({ user, currentAdminId }: { user: ManagedUser; currentAdminId: string }) {
  const isOwnAccount = user.id === currentAdminId;
  const titleId = useId();
  const statusId = useId();
  const rolesId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const [isOpen, setIsOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState(user.status);
  const [roles, setRoles] = useState(user.roles);
  const [serverState, setServerState] = useState({
    id: user.id,
    status: user.status,
    roles: user.roles.join("|"),
  });

  useEffect(() => {
    if (!isOpen) return;

    const bodyOverflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
    };
  }, [isOpen]);

  const incomingRoles = user.roles.join("|");
  if (user.id !== serverState.id || user.status !== serverState.status || incomingRoles !== serverState.roles) {
    setServerState({ id: user.id, status: user.status, roles: incomingRoles });
    setStatus(user.status);
    setRoles(user.roles);
  }

  async function changeStatus() {
    if (pendingRef.current || isOwnAccount) return;
    pendingRef.current = true;
    setPending(true);

    const nextStatus = status === "active" ? "suspended" : "active";
    try {
      const result = await updateUserStatusAction({ userId: user.id, status: nextStatus });
      if (result.ok) {
        setStatus(result.user.status);
        toast.success(result.user.status === "suspended" ? "User suspended." : "User reactivated.");
      } else {
        toast.error(result.reason === "self-management"
          ? "Your account status can only be changed by another administrator."
          : failureMessages[result.reason]);
      }
    } catch {
      toast.error("Unable to update user. Please try again.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function changeRole(role: UserRole, assigned: boolean) {
    if (pendingRef.current || (isOwnAccount && role === "admin")) return;
    pendingRef.current = true;
    setPending(true);

    const operation = assigned ? "revoke" : "assign";
    try {
      const result = await updateUserRoleAction({ userId: user.id, role, operation });
      if (result.ok) {
        setRoles(result.user.roles);
        toast.success(`${roleLabels[role]} role ${operation === "assign" ? "assigned" : "removed"}.`);
      } else {
        toast.error(result.reason === "self-management"
          ? "Your admin role can only be changed by another administrator."
          : failureMessages[result.reason]);
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
        onClick={() => {
          dialogRef.current?.showModal();
          setIsOpen(true);
        }}
        className="inline-flex min-h-9 items-center justify-center rounded-control border border-border-strong bg-surface px-3 text-sm font-semibold text-primary hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        Manage
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => setIsOpen(false)}
        onCancel={() => setIsOpen(false)}
        aria-labelledby={titleId}
        className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-card border border-border bg-surface p-0 text-foreground shadow-floating backdrop:bg-foreground/50"
      >
        <div className="p-5 sm:p-6">
          <header className="flex items-start justify-between gap-4 border-b border-border pb-5">
            <div className="min-w-0">
              <h2 id={titleId} className="font-heading text-xl font-semibold">Manage user</h2>
              <p className="mt-1 break-all text-sm text-muted-foreground">{user.email}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                Last updated <time dateTime={user.updated_at}>{formatUserDate(user.updated_at)}</time>
              </p>
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
                disabled={pending || isOwnAccount}
                aria-busy={pending && !isOwnAccount}
                style={{ cursor: isOwnAccount ? "not-allowed" : pending ? "wait" : undefined }}
                onClick={changeStatus}
                className={`rounded-control border px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60 ${
                  status === "active"
                    ? "border-danger bg-danger-background text-danger enabled:hover:bg-surface-muted"
                    : "border-border-strong bg-surface text-primary enabled:hover:bg-surface-muted"
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
                const policyDisabled = isOwnAccount && role === "admin";
                return (
                  <li key={role} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3">
                    <div className="min-w-0">
                      <span className="font-medium text-primary">{roleLabels[role]}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {role === "member" ? "Required" : assigned ? "Assigned" : "Not assigned"}
                      </span>
                    </div>
                    {role !== "member" && <button
                      type="button"
                      disabled={pending || policyDisabled}
                      aria-busy={pending && !policyDisabled}
                      style={{ cursor: policyDisabled ? "not-allowed" : pending ? "wait" : undefined }}
                      onClick={() => changeRole(role, assigned)}
                      className="min-w-18 rounded-control border border-border-strong bg-surface px-3 py-2 text-sm font-semibold text-primary enabled:hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60"
                    >
                      {assigned ? "Remove" : "Assign"}
                    </button>}
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
