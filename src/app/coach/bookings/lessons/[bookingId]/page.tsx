import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";
import { CopyBookingId } from "@/app/admin/bookings/[bookingId]/copy-booking-id";
import { AdminPageHeader } from "@/components/admin-page-controls";
import { DetailSection } from "@/components/dialog-layout";
import { ReservationScheduleFieldsView } from "@/components/reservation-details";
import { StatusBadge } from "@/components/status-badge";
import { bookingCreatedLabel, bookingStatusLabels, bookingStatusTones, parseCoachBookingReturn } from "@/lib/bookings/admin-query";
import { bookingTypeLabels } from "@/lib/bookings/booking-type";
import { getCoachLesson } from "@/lib/bookings/coach-bookings";
import { requireActiveCoach } from "@/lib/coaching/authorization";

export const metadata: Metadata = { title: "Lesson details | Tennis Club" };
export const instant = false;

// Read-only: the Coach's own lesson with the schedule and customer contact the Coach
// Calendar already shows. No price, payment, refund or booking actions.
export default async function CoachLessonPage({ params, searchParams }: {
  params: Promise<{ bookingId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireActiveCoach();
  const id = z.uuid().safeParse((await params).bookingId);
  if (!id.success) notFound();
  const search = await searchParams;
  const lesson = await getCoachLesson(id.data);
  if (!lesson) notFound();
  const back = parseCoachBookingReturn(search);
  return <>
    <Link href={back.href} className="mb-4 inline-flex items-center gap-1.5 rounded-control text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
      <ArrowLeft size={16} aria-hidden />{back.label}
    </Link>
    <AdminPageHeader title={`Lesson #${lesson.id.slice(0, 8)}`} description={<>
      Booked {bookingCreatedLabel(lesson.created_at, lesson.location_timezone)} ({lesson.location_timezone})
    </>}>
      <StatusBadge tone={bookingStatusTones[lesson.status]}>{bookingStatusLabels[lesson.status]}</StatusBadge>
    </AdminPageHeader>
    <div className="grid max-w-4xl gap-x-8 rounded-card border border-border bg-surface p-5 pt-1 md:grid-cols-2">
      <DetailSection title="Lesson">
        <dt className="text-muted-foreground">Type</dt><dd>{bookingTypeLabels.coaching}</dd>
        <dt className="text-muted-foreground">Booking ID</dt>
        <dd className="flex flex-wrap items-center gap-2"><code className="font-mono text-xs [overflow-wrap:anywhere]">{lesson.id}</code>
          <CopyBookingId id={lesson.id} /></dd>
        <dt className="text-muted-foreground">Status</dt><dd>{bookingStatusLabels[lesson.status]}</dd>
        <dt className="text-muted-foreground">Program</dt><dd>{lesson.coaching_program_name || "Not recorded"}</dd>
        <dt className="text-muted-foreground">Coach</dt><dd>{lesson.coach_name || "Not recorded"}</dd>
      </DetailSection>
      <DetailSection title="Court and time"><ReservationScheduleFieldsView reservation={lesson} /></DetailSection>
      <DetailSection title="Customer">
        <dt className="text-muted-foreground">Name</dt><dd>{lesson.customer_name}</dd>
        <dt className="text-muted-foreground">Email</dt><dd>{lesson.customer_email}</dd>
        <dt className="text-muted-foreground">Phone</dt><dd>{lesson.customer_phone}</dd>
      </DetailSection>
    </div>
  </>;
}
