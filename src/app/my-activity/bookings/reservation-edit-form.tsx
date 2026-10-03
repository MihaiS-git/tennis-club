"use client";

import { ReservationEditForm as SharedReservationEditForm, type ReservationEditDraft, type ReservationEditSaveResult } from "@/components/reservation-edit-form";
import { reservationEditInput, reservationEditSchema } from "@/lib/reservations/domain";
import type { PersonalReservation } from "@/lib/reservations/personal";
import { editOwnReservationAction, loadReservationEditDayAction } from "./actions";

export function ReservationEditForm({ reservation, inProgress, onCancel, onSaved, onStale, onPendingChange }: {
  reservation: PersonalReservation;
  inProgress: boolean;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onStale: () => Promise<void>;
  onPendingChange: (pending: boolean) => void;
}) {
  async function save({ date, selection, reason, inProgress: reasonOnly }: ReservationEditDraft): Promise<ReservationEditSaveResult> {
    const input = reservationEditInput({ id: reservation.id, expectedUpdatedAt: reservation.updated_at,
      courtId: reservation.court_id, bookingDate: reservation.booking_date, startMinute: reservation.starts_at_minute,
      endMinute: reservation.ends_at_minute, date, selection, reason, reasonOnly });
    const parsed = reservationEditSchema.safeParse(input);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) fieldErrors[String(issue.path.at(-1) ?? "form")] ??= issue.message;
      return { ok: false, message: "Check the highlighted fields.", fieldErrors };
    }
    return editOwnReservationAction(parsed.data);
  }

  return <SharedReservationEditForm reservation={reservation} inProgress={inProgress}
    loadAvailability={loadReservationEditDayAction} onCancel={onCancel} onSave={save}
    onSaved={onSaved} onStale={onStale} onPendingChange={onPendingChange} />;
}
