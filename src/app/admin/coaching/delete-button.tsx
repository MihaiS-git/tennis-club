"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { deleteCoachingProgramAction, deleteCoachProfileAction, setCoachingProgramStatusAction } from "./actions";
import { coachingFailureMessages } from "./coaching-form";

export function CoachingDeleteButton({ kind, id, name }: { kind: "program" | "coach"; id: string; name: string }) {
  const router = useRouter();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasBookings, setHasBookings] = useState(false);
  async function remove(deactivate = false) {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError(null);
    try {
      const result = deactivate ? await setCoachingProgramStatusAction({ id, is_active: false })
        : kind === "program" ? await deleteCoachingProgramAction({ id }) : await deleteCoachProfileAction({ user_id: id });
      if (result.ok) {
        toast.success(deactivate ? "Program deactivated." : result.archived ? "Coach archived and removed from the roster."
          : kind === "program" ? "Program deleted." : "Coach profile deleted.");
        setOpen(false); router.refresh();
      } else {
        setHasBookings(result.reason === "has-bookings");
        setError(result.reason === "invalid-input" ? "Invalid deletion request." : coachingFailureMessages[result.reason]);
      }
    } catch {
      setError("Unable to remove this item. Please try again.");
    } finally {
      pendingRef.current = false; setPending(false);
    }
  }
  return <>
    <Button ref={buttonRef} type="button" variant="destructive" size="small" aria-label={`Delete ${kind}`}
      onClick={() => { setError(null); setHasBookings(false); setOpen(true); }}><Trash2 size={14} aria-hidden="true" /></Button>
    <ConfirmationDialog open={open} title={`${kind === "coach" ? "Remove" : "Delete"} ${name}?`}
      message={kind === "coach" ? "The coach will leave the active coaching roster. Profiles with historical lessons are archived; unused profiles are permanently deleted."
        : "Permanently delete this program and its prices and coach assignments? Programs with booking history must be deactivated instead."}
      confirmLabel={kind === "coach" ? "Remove coach" : "Delete program"}
      pendingLabel={kind === "coach" ? "Removing coach…" : "Deleting program…"} pending={pending} confirmDisabled={hasBookings}
      returnFocusRef={buttonRef} onClose={() => { if (!pendingRef.current) setOpen(false); }} onConfirm={() => void remove()}>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {hasBookings && <Button type="button" variant="secondary" size="small" disabled={pending} onClick={() => void remove(true)}>Deactivate program</Button>}
    </ConfirmationDialog>
  </>;
}
