"use client";

import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { ModalDialog } from "@/components/modal-dialog";
import { Button, DialogCloseButton } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";

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
};

const failureMessages = {
  "invalid-input": "Invalid user update.",
  "not-found": "This user no longer exists.",
  "final-active-admin": "At least one active administrator must remain.",
} as const;

export function UserManagementDialog({ user, currentAdminId, open, onOpenChange }: {
  user: ManagedUser; currentAdminId: string; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const isOwnAccount = user.id === currentAdminId;
  const titleId = useId();
  const statusId = useId();
  const rolesId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const confirmationTriggerRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState(user.status);
  const [roles, setRoles] = useState(user.roles);
  const [statusError, setStatusError] = useState("");
  const [roleError, setRoleError] = useState("");
  const [confirmation, setConfirmation] = useState<{ kind: "suspend" } | { kind: "revoke"; role: UserRole } | null>(null);
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
    setStatusError("");
    setRoleError("");
    setConfirmation(null);
  }

  async function changeStatus() {
    if (pendingRef.current || isOwnAccount) return;
    pendingRef.current = true;
    setPending(true);
    setStatusError("");

    const nextStatus = status === "active" ? "suspended" : "active";
    try {
      const result = await updateUserStatusAction({ userId: user.id, status: nextStatus });
      if (result.ok) {
        setStatus(result.user.status);
        setConfirmation(null);
        toast.success(result.user.status === "suspended" ? "User suspended." : "User reactivated.");
      } else {
        const message = result.reason === "self-management"
          ? "Your account status can only be changed by another administrator."
          : failureMessages[result.reason];
        setStatusError(message);
        toast.error(message);
      }
    } catch {
      const message = "Unable to update user. Please try again.";
      setStatusError(message);
      toast.error(message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function changeRole(role: UserRole, assigned: boolean) {
    if (pendingRef.current || (isOwnAccount && role === "admin")) return;
    pendingRef.current = true;
    setPending(true);
    setRoleError("");

    const operation = assigned ? "revoke" : "assign";
    try {
      const result = await updateUserRoleAction({ userId: user.id, role, operation });
      if (result.ok) {
        setRoles(result.user.roles);
        setConfirmation(null);
        toast.success(`${roleLabels[role]} role ${operation === "assign" ? "assigned" : "removed"}.`);
      } else {
        const message = result.reason === "self-management"
          ? "Your admin role can only be changed by another administrator."
          : failureMessages[result.reason];
        setRoleError(message);
        toast.error(message);
      }
    } catch {
      const message = "Unable to update user. Please try again.";
      setRoleError(message);
      toast.error(message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  const dialog = <ModalDialog
        ref={dialogRef}
        active={open}
        onClose={() => onOpenChange(false)}
        onCancel={(event) => { if (pendingRef.current) event.preventDefault(); else onOpenChange(false); }}
        aria-labelledby={titleId}
        className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-card border border-border bg-surface p-0 text-foreground shadow-floating backdrop:bg-foreground/50"
      >
        <div className="p-5 sm:p-6">
          <header className="mb-5 flex items-start justify-between gap-4 border-b border-border pb-4">
            <h2 id={titleId} className="font-heading text-xl font-semibold">Manage user</h2>
            <DialogCloseButton disabled={pending} onClick={() => dialogRef.current?.close()} />
          </header>
          <div className="min-w-0">
            <p className="break-all text-sm text-foreground">{user.email}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Last updated <time dateTime={user.updated_at}>{formatUserDate(user.updated_at)}</time>
            </p>
          </div>

          <section className="mt-5 border-b border-border pb-5" aria-labelledby={statusId}>
            <h3 id={statusId} className="font-heading text-base font-semibold">Account status</h3>
            <p role={statusError && confirmation?.kind !== "suspend" ? "alert" : undefined} className="min-h-5 pt-1 text-sm text-danger">{confirmation?.kind === "suspend" ? "" : statusError}</p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <span className={`inline-flex rounded-control px-2.5 py-1 text-xs font-semibold ${
                status === "active" ? "bg-success-background text-success" : "bg-danger-background text-danger"
              }`}>
                {status === "active" ? "Active" : "Suspended"}
              </span>
              <Button
                type="button"
                disabled={pending || isOwnAccount}
                aria-busy={pending && !isOwnAccount}
                onClick={(event) => {
                  if (status === "active") {
                    confirmationTriggerRef.current = event.currentTarget;
                    setStatusError("");
                    setConfirmation({ kind: "suspend" });
                  } else void changeStatus();
                }}
                variant={status === "active" ? "destructive" : "secondary"}
                size="small"
              >
                {status === "active" ? "Suspend user" : "Reactivate user"}
              </Button>
            </div>
          </section>

          <section className="pt-5" aria-labelledby={rolesId}>
            <h3 id={rolesId} className="font-heading text-base font-semibold">Roles</h3>
            <p role={roleError && confirmation?.kind !== "revoke" ? "alert" : undefined} className="min-h-5 pt-1 text-sm text-danger">{confirmation?.kind === "revoke" ? "" : roleError}</p>
            <ul className="mt-3 divide-y divide-border">
              {(["admin", "coach"] as const).map((role) => {
                const assigned = roles.includes(role);
                const policyDisabled = isOwnAccount && role === "admin";
                return (
                  <li key={role} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3">
                    <div className="min-w-0">
                      <span className="font-medium text-primary">{roleLabels[role]}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {assigned ? "Assigned" : "Not assigned"}
                      </span>
                    </div>
                    <Button
                      type="button"
                      disabled={pending || policyDisabled}
                      aria-busy={pending && !policyDisabled}
                      onClick={(event) => {
                        if (assigned) {
                          confirmationTriggerRef.current = event.currentTarget;
                          setRoleError("");
                          setConfirmation({ kind: "revoke", role });
                        } else void changeRole(role, false);
                      }}
                      variant={assigned ? "destructive" : "secondary"} size="small" className="min-w-18"
                    >
                      {assigned ? "Remove" : "Assign"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </ModalDialog>;

  return <>
    {dialog}
    <ConfirmationDialog open={confirmation !== null}
      title={confirmation?.kind === "suspend" ? `Suspend ${user.email}?` : `Remove ${confirmation?.kind === "revoke" ? roleLabels[confirmation.role] : ""} role?`}
      message={confirmation?.kind === "suspend"
        ? `${user.email} will lose access until reactivated.`
        : `${user.email} will lose ${confirmation?.kind === "revoke" ? roleLabels[confirmation.role] : ""} access.`}
      confirmLabel={confirmation?.kind === "suspend" ? "Suspend user" : `Remove ${confirmation?.kind === "revoke" ? roleLabels[confirmation.role] : ""} role`}
      pending={pending} error={confirmation?.kind === "suspend" ? statusError : roleError}
      returnFocusRef={confirmationTriggerRef} onClose={() => { if (!pendingRef.current) setConfirmation(null); }}
      onConfirm={() => { if (confirmation?.kind === "suspend") void changeStatus();
        else if (confirmation?.kind === "revoke") void changeRole(confirmation.role, true); }} />
  </>;
}
