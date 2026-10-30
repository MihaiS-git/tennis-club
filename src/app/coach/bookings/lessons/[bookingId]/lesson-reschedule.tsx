"use client";

import { useEffect, useState } from "react";
import { OperationalBookingEdit } from "@/app/admin/bookings/admin-booking-editor";
import type { CoachLessonCancellationState } from "./lesson-cancellation";
import { loadCoachBookingEditorAction, loadCoachBookingDayAction, changeCoachBookingAction } from "./actions";

export const coachActions = { load: loadCoachBookingEditorAction, change: changeCoachBookingAction, day: loadCoachBookingDayAction };

// Coach entry points open rescheduling in the shared staff Calendar.
export function CoachLessonReschedule({ lesson, cancellation: { availability, startsAt }, variant = "button",
  onStart }: {
  lesson: { id: string; booking_date: string }; cancellation: Pick<CoachLessonCancellationState, "availability" | "startsAt">;
  onStart?: () => void; variant?: "button" | "icon";
}) {
  const [started, setStarted] = useState(() => Date.parse(startsAt) <= Date.now());
  useEffect(() => {
    const timer = setTimeout(() => setStarted(true), Math.max(0, Math.min(2_147_483_647, Date.parse(startsAt) - Date.now())));
    return () => clearTimeout(timer);
  }, [startsAt]);
  if (availability !== "eligible" || started) return null;
  return <OperationalBookingEdit bookingId={lesson.id} startsAt={startsAt} capacity="coach"
    variant={variant} onStart={onStart} />;
}
