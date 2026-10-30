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
  "active-lessons": "This coach has upcoming lessons or pending lesson checkouts. Cancel those lessons or wait until they are completed first.",
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
    setConfirmation(null);
  }

  async function changeStatus() {
    if (pendingRef.current || isOwnAccount) return;
    pendingRef.current = true;
    setPending(true);

    const notification = toast.loading("Updating user status…");
    const nextStatus = status === "active" ? "suspended" : "active";
    try {
      const result = await updateUserStatusAction({ userId: user.id, status: nextStatus });
      if (result.ok) {
        setStatus(result.user.status);
        setConfirmation(null);
        router.refresh();
        toast.success(result.user.status === "suspended" ? "User suspended." : "User reactivated.", { id: notification });
      } else {
        const message = result.reason === "self-management"
          ? "Your account status can only be changed by another administrator."
          : failureMessages[result.reason];
        toast.error(message, { id: notification });
      }
    } catch {
      const message = "Unable to update user. Please try again.";
      toast.error(message, { id: notification });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function changeRole(role: UserRole, assigned: boolean) {
    if (pendingRef.current || (isOwnAccount && role === "admin")) return;
    pendingRef.current = true;
    setPending(true);

    const notification = toast.loading("Updating user role…");
    const operation = assigned ? "revoke" : "assign";
    try {
      const result = await updateUserRoleAction({ userId: user.id, role, operation });
      if (result.ok) {
        setRoles(result.user.roles);
        setConfirmation(null);
        router.refresh();
        toast.success(`${roleLabels[role]} role ${operation === "assign" ? "assigned" : "removed"}.`, { id: notification });
      } else {
        const message = result.reason === "self-management"
          ? "Your admin role can only be changed by another administrator."
          : failureMessages[result.reason];
        toast.error(message, { id: notification });
      }
    } catch {
      const message = "Unable to update user. Please try again.";
      toast.error(message, { id: notification });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return <>
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.85fr)] lg:gap-6">
      <div className="min-w-0">
        <section aria-label="Account information">
          <h2 className="mb-3 text-sm font-semibold text-primary">Account</h2>
          <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm [&_dd]:break-words">
            <dt className="text-muted-foreground">Email</dt><dd>{user.email}</dd>
            <dt className="text-muted-foreground">Joined</dt><dd>{formatUserDate(user.created_at)}</dd>
            <dt className="text-muted-foreground">Last updated</dt><dd>{formatUserDate(user.updated_at)}</dd>
          </dl>
        </section>
        <section className="mt-4 border-t border-border pt-4" aria-labelledby={statusId}>
          <h3 id={statusId} className="text-sm font-semibold text-primary">Account status</h3>
          <div className="mt-3 flex flex-wrap items-center gap-3">
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
      </div>
      <section className="min-w-0 border-t border-border pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6" aria-labelledby={rolesId}>
        <h3 id={rolesId} className="text-sm font-semibold text-primary">Roles</h3>
        <ul className="mt-1 divide-y divide-border">
          {(["admin", "coach"] as const).map((role) => {
            const assigned = roles.includes(role);
            const policyDisabled = isOwnAccount && role === "admin";
            return (
              <li key={role} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3">
                <div className="min-w-0">
                  <span className="font-medium text-primary">{roleLabels[role]}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground sm:ml-2 sm:mt-0 sm:inline">
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
      pending={pending}
      returnFocusRef={confirmationTriggerRef} onClose={() => { if (!pendingRef.current) setConfirmation(null); }}
      onConfirm={() => { if (confirmation?.kind === "suspend") void changeStatus();
        else if (confirmation?.kind === "revoke") void changeRole(confirmation.role, true); }} />
  </>;
}
