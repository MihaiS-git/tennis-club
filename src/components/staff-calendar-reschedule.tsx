"use client";

import type { ReactNode } from "react";
import type { AdminBookingEditor } from "@/lib/bookings/admin-edit";
import { OperationalCalendarReschedule, adminActions } from "@/app/admin/bookings/admin-booking-editor";
import { coachActions } from "@/app/coach/bookings/lessons/[bookingId]/lesson-reschedule";

export function StaffCalendarReschedule({ bookingId, capacity, initialData, locationId, date, children }: {
  bookingId?: string; capacity: "admin" | "coach"; initialData?: AdminBookingEditor & { actingCoachId?: string };
  locationId: string; date: string | null; children: ReactNode;
}) {
  return <OperationalCalendarReschedule bookingId={bookingId} capacity={capacity} initialData={initialData}
    locationId={locationId} date={date} actions={capacity === "admin" ? adminActions : coachActions}>{children}</OperationalCalendarReschedule>;
}
