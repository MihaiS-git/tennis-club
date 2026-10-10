"use client";

import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";

import { updateUserRoleAction, updateUserStatusAction } from "./actions";
import type { AdminUserDetails } from "@/lib/admin/users";
import { useRouter } from "next/navigation";
import { formatUserDate } from "./date-format";
import type { UserRole } from "@/lib/auth/account";

const roleLabels: Record<UserRole, string> = {
  admin: "Admin",
  coach: "Coach",
};

const failureMessages = {
  "invalid-input": "Invalid user update.",
  "not-found": "This user no longer exists.",
  "final-active-admin": "At least one active administrator must remain.",
} as const;

export function UserAccessControls({ user, currentAdminId }: {
  user: AdminUserDetails; currentAdminId: string;
}) {
  const router = useRouter();
  const isOwnAccount = user.id === currentAdminId;
  const statusId = useId();
  const rolesId = useId();
  const pendingRef = useRef(false);
  const confirmationTriggerRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState(user.status);
  const [roles, setRoles] = useState(user.roles);
  const managementDisabled = pending;
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
        router.refresh();
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
        router.refresh();
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

  return <>
    <section aria-label="Account information" className="mb-6">
      <h2 className="mb-3 text-sm font-semibold text-primary">Account</h2>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm [&_dd]:break-words">
        <dt className="text-muted-foreground">Email</dt><dd>{user.email}</dd>
        <dt className="text-muted-foreground">Joined</dt><dd>{formatUserDate(user.created_at)}</dd>
        <dt className="text-muted-foreground">Last updated</dt><dd>{formatUserDate(user.updated_at)}</dd>
      </dl>
    </section>
    <div className="grid items-start gap-6 md:grid-cols-2">
      <section className="min-w-0" aria-labelledby={statusId}>
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
            disabled={managementDisabled || isOwnAccount}
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

      <section className="min-w-0" aria-labelledby={rolesId}>
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
                  disabled={managementDisabled || policyDisabled}
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
