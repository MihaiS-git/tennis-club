"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { reservationDateLabel } from "@/components/reservation-details";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";
import type { AdminCancellationAvailability } from "@/lib/bookings/admin-history";
import { cancelledBookingMessage } from "@/lib/payments/refund-message";
import { cancelCoachLessonAction } from "./actions";
import { CoachLessonReschedule } from "./lesson-reschedule";

const unavailableMessages: Partial<Record<AdminCancellationAvailability, string>> = {
  started: "This lesson has started and can no longer be rescheduled or cancelled.",
  cancellation_pending: "Cancellation requested. The lesson stays confirmed until the customer's refund is confirmed.",
  change_pending: "A change to this lesson is still being processed. Rescheduling and cancellation are available once it finishes.",
};
// Compact List cell labels; the full message is the tooltip.
const unavailableLabels: Partial<Record<AdminCancellationAvailability, string>> = {
  started: "Started", cancellation_pending: "Cancellation pending", change_pending: "Change pending",
};

export type CoachCancellableLesson = { id: string; customer_name: string; location_name: string; court_name: string;
  booking_date: string; starts_at_minute: number; ends_at_minute: number; coach_name?: string | null; coaching_program_name?: string | null };
export type CoachLessonCancellationState = { availability: AdminCancellationAvailability; startsAt: string; refundAvailable: boolean };

// The assigned Coach's Cancel lesson control, shared by Lesson details, the Coach Calendar
// and the Coach List. The server re-checks the Coach's role, assignment and eligibility on
// submit and its message is shown when it declines. The trash icon cancels; nothing is deleted.
export function CoachLessonCancellation({ lesson, cancellation: { availability, startsAt, refundAvailable }, variant = "button",
  onCancelled, onPendingChange }: {
  lesson: CoachCancellableLesson; cancellation: CoachLessonCancellationState; variant?: "button" | "icon";
  onCancelled?: () => void | Promise<void>; onPendingChange?: (pending: boolean) => void;
}) {
  const router = useRouter();
  const [parentDialog, setParentDialog] = useState<HTMLDialogElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [started, setStarted] = useState(false);
  const pendingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // An open page stops offering cancellation once the lesson starts.
  useEffect(() => {
    if (availability !== "eligible") return;
    const timer = setTimeout(() => setStarted(true), Math.max(0, Math.min(2_147_483_647, Date.parse(startsAt) - Date.now())));
    return () => clearTimeout(timer);
  }, [availability, startsAt]);
  const current = availability === "eligible" && started ? "started" : availability;
  if (current === "unavailable") return null;
  async function cancel() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); onPendingChange?.(true);
    const notification = toast.loading("Cancelling lesson…");
    let cancelledMessage: string | null = null;
    try {
      const result = await cancelCoachLessonAction({ id: lesson.id });
      if (!result.ok) { toast.error(result.message, { id: notification }); return; }
      setConfirming(false);
      cancelledMessage = cancelledBookingMessage(result, "admin").replace(/^Booking/, "Lesson");
      toast.success(cancelledMessage, { id: notification });
      await onCancelled?.();
      router.refresh();
    } catch {
      if (cancelledMessage) toast.warning(cancelledMessage, { id: notification, description: "Unable to refresh details. Reopen the booking to see the cancellation." });
      else toast.error("Unable to cancel this lesson. Try again.", { id: notification });
    } finally {
      pendingRef.current = false;
      setPending(false); onPendingChange?.(false);
    }
  }
  if (current !== "eligible") return variant === "icon"
    ? <span title={unavailableMessages[current]} className="text-xs text-muted-foreground">{unavailableLabels[current]}</span>
    : <p role="status" className="basis-full text-sm text-muted-foreground">{unavailableMessages[current]}</p>;
  return <>
    {variant === "icon"
      // Sits above the row's stretched link so it never navigates.
      ? <Button ref={triggerRef} type="button" variant="destructive" size="icon" className="relative z-10" disabled={pending}
          aria-busy={pending} aria-label={pending ? "Cancelling lesson…" : "Cancel lesson"} title="Cancel lesson" onClick={(event) => { setParentDialog(event.currentTarget.closest("dialog")); setConfirming(true); }}>
          <Trash2 size={14} aria-hidden="true" className={pending ? "motion-safe:animate-pulse" : undefined} />
        </Button>
      : <Button ref={triggerRef} type="button" variant="destructive" disabled={pending} onClick={(event) => { setParentDialog(event.currentTarget.closest("dialog")); setConfirming(true); }}>Cancel lesson</Button>}
    <ConfirmationDialog parentDialog={parentDialog} open={confirming} title="Cancel lesson?"
      message={`Customer\n${lesson.customer_name}\nCoach: ${lesson.coach_name ?? "You"}\n\n${lesson.coaching_program_name ?? "Coaching"} lesson\n${lesson.location_name} · ${lesson.court_name}\n${reservationDateLabel(lesson.booking_date)} · ${minuteToTime(lesson.starts_at_minute)}–${minuteToTime(lesson.ends_at_minute)}\n\nThis will cancel the lesson, free the court and notify the customer.`}
      confirmLabel="Confirm cancellation" pendingLabel="Cancelling lesson…" cancelLabel="Keep booking" pending={pending}
      onConfirm={cancel} onClose={() => { if (!pendingRef.current) setConfirming(false); }} returnFocusRef={triggerRef}>
      {refundAvailable && <p className="mt-3 text-sm">The customer&apos;s online payment will be refunded automatically. The lesson stays confirmed until the refund is confirmed.</p>}
    </ConfirmationDialog>
  </>;
}

// Lesson details' action area: Reschedule lesson and Cancel lesson share one eligibility,
// and the cancellation control explains any state in which neither is offered.
export function LessonCancellation({ lesson, availability, startsAt, refundAvailable }: {
  lesson: CoachCancellableLesson; availability: AdminCancellationAvailability; startsAt: string; refundAvailable: boolean;
}) {
  if (availability === "unavailable") return null;
  return <section aria-label="Lesson actions" className="mb-6 flex max-w-4xl flex-wrap items-center gap-3">
    <CoachLessonReschedule lesson={lesson} cancellation={{ availability, startsAt }} />
    <CoachLessonCancellation lesson={lesson} cancellation={{ availability, startsAt, refundAvailable }} />
  </section>;
}
