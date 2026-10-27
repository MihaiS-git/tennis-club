"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { cancelAdminReservationAction, editAdminReservationAction, loadAdminReservationEditDayAction } from "@/app/admin/reservations/actions";
import { cancelOwnReservationAction, editOwnReservationAction, loadReservationEditDayAction } from "@/app/my-activity/bookings/actions";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Button } from "@/components/button";
import { DialogHeader } from "@/components/dialog-layout";
import { ModalDialog } from "@/components/modal-dialog";
import { reservationDateLabel } from "@/components/reservation-details";
import { ReservationEditForm, type EditableReservation } from "@/components/reservation-edit-form";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import { reservationEditInput, reservationEditSchema } from "@/lib/reservations/domain";

const maxTimer = 2_147_483_647;
// Admins use the Admin commands (cancel until the start); a creator uses the existing
// owner commands, as in the Coach Calendar and My Activity (cancel until the end).
const scopedActions = {
  admin: { load: loadAdminReservationEditDayAction, edit: editAdminReservationAction, cancel: cancelAdminReservationAction },
  owner: { load: loadReservationEditDayAction, edit: editOwnReservationAction, cancel: cancelOwnReservationAction },
};

// The Calendar's Edit and Cancel for a free staff reservation: the same form,
// actions and commands, which re-check eligibility on submit. No payment or refund applies.
export function ReservationActions({ reservation, creatorName, startsAt, endsAt, started, editable, cancellable, scope = "admin" }: {
  reservation: EditableReservation; creatorName: string; startsAt: string; endsAt: string; started: boolean;
  editable: boolean; cancellable: boolean; scope?: "admin" | "owner";
}) {
  const actions = scopedActions[scope];
  const router = useRouter();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const [clock, setClock] = useState({ started, ended: false });
  const [editing, setEditing] = useState(false);
  const [editToken, setEditToken] = useState<string | null>(null);
  const [editError, setEditError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  // An open page stops offering cancellation at the start and editing at the end.
  useEffect(() => {
    if (!editable && !cancellable) return;
    // Beyond the timer range nothing can change while this page stays open.
    const at = (instant: string, update: () => void) => {
      const delay = Math.max(0, Date.parse(instant) - Date.now());
      return delay <= maxTimer ? setTimeout(update, delay) : undefined;
    };
    const start = at(startsAt, () => setClock((value) => ({ ...value, started: true })));
    const end = at(endsAt, () => setClock({ started: true, ended: true }));
    return () => { clearTimeout(start); clearTimeout(end); };
  }, [editable, cancellable, startsAt, endsAt]);
  const canEdit = editable && !clock.ended, canCancel = cancellable && !(scope === "admin" ? clock.started : clock.ended);
  // A started reservation can change only its reason, as in the Calendar.
  const inProgress = clock.started;

  async function openEdit() {
    setEditing(true); setEditToken(null); setEditError("");
    const notification = toast.loading("Loading reservation…");
    try {
      const result = await actions.load(reservation.id, reservation.booking_date);
      toast.dismiss(notification);
      setEditToken(result.reservation.updated_at);
    } catch {
      setEditError("Unable to load the current reservation. Try again.");
      toast.error("Unable to load the current reservation. Try again.", { id: notification });
    }
  }
  async function cancelReservation() {
    if (pending) return;
    const notification = toast.loading("Cancelling…");
    setPending(true);
    try {
      const result = await actions.cancel(reservation.id);
      if (!result.ok) { toast.error(result.message, { id: notification }); return; }
      setConfirming(false);
      toast.success("Reservation cancelled.", { id: notification });
      router.refresh();
    } catch {
      toast.error("Unable to cancel this reservation. Try again.", { id: notification });
    } finally { setPending(false); }
  }

  if (!editable && !cancellable) return null;
  if (!canEdit && !canCancel) return <section aria-label="Reservation actions" className="mb-6 max-w-4xl">
    <p role="status" className="text-sm text-muted-foreground">This reservation has ended and can no longer be changed.</p>
  </section>;
  return <section aria-label="Reservation actions" className="mb-6 flex max-w-4xl flex-wrap items-center gap-3">
    {canEdit && <Button type="button" variant="secondary" disabled={pending} onClick={openEdit}>Edit reservation</Button>}
    {canCancel ? <Button ref={cancelButtonRef} type="button" variant="destructive" disabled={pending} onClick={() => setConfirming(true)}>Cancel reservation</Button>
      : clock.started && <p role="status" className="text-sm text-muted-foreground">This reservation has started and can no longer be cancelled.</p>}
    {editing && typeof document !== "undefined" && createPortal(
      <ModalDialog ref={dialogRef} active aria-labelledby={titleId}
        onCancel={(event) => { if (pending) event.preventDefault(); }}
        onClose={() => { setEditing(false); setEditToken(null); }}
        className={`fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50 ${inProgress ? "max-w-md" : "max-w-6xl"}`}>
        <DialogHeader titleId={titleId} title="Edit reservation" disabled={pending} onClose={() => dialogRef.current?.close()} />
        {!editToken ? <div className="mt-4 min-h-20 text-sm" aria-busy={!editError}>
          {editError && <><span role="alert">{editError}</span>
            <Button type="button" variant="text" className="ml-2 font-semibold underline" onClick={openEdit}>Retry</Button></>}
        </div> : <ReservationEditForm reservation={reservation} inProgress={inProgress}
          loadAvailability={actions.load} onPendingChange={setPending}
          onCancel={() => dialogRef.current?.close()}
          onSave={async ({ date, selection, reason, inProgress: reasonOnly }) => {
            const parsed = reservationEditSchema.safeParse(reservationEditInput({ id: reservation.id, expectedUpdatedAt: editToken,
              courtId: reservation.court_id, bookingDate: reservation.booking_date, startMinute: reservation.starts_at_minute,
              endMinute: reservation.ends_at_minute, date, selection, reason, reasonOnly }));
            if (!parsed.success) {
              const fieldErrors: Record<string, string> = {};
              for (const issue of parsed.error.issues) fieldErrors[String(issue.path.at(-1) ?? "form")] ??= issue.message;
              return { ok: false, message: "Check the highlighted fields.", fieldErrors };
            }
            return actions.edit(parsed.data);
          }}
          onSaved={async () => { dialogRef.current?.close(); router.refresh(); }}
          onStale={async () => { dialogRef.current?.close(); router.refresh(); }} />}
      </ModalDialog>, document.body)}
    <ConfirmationDialog open={confirming && canCancel} title="Cancel reservation?"
      message={`${reservation.location_name} · ${reservation.court_name}\n${reservationDateLabel(reservation.booking_date)} · ${minuteToTime(reservation.starts_at_minute)}–${minuteToTime(reservation.ends_at_minute)}\nCreated by\n${creatorName}\n\nThis will free the court for other bookings and reservations.`}
      confirmLabel="Cancel reservation" pendingLabel="Cancelling reservation…" cancelLabel="Keep reservation" pending={pending}
      onConfirm={cancelReservation} onClose={() => { if (!pending) setConfirming(false); }} returnFocusRef={cancelButtonRef} />
  </section>;
}
