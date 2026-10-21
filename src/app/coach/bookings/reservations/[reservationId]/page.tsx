import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ReservationRecord } from "@/app/admin/bookings/reservations/[reservationId]/reservation-record";
import { parseCoachBookingReturn } from "@/lib/bookings/admin-query";
import { getCoachDirectReservation } from "@/lib/bookings/coach-bookings";
import { requireActiveCoach } from "@/lib/coaching/authorization";

export const metadata: Metadata = { title: "Reservation details | Tennis Club" };
export const instant = false;

// Only the Coach's own staff reservations; anyone else's is not found.
export default async function CoachReservationPage({ params, searchParams }: {
  params: Promise<{ reservationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireActiveCoach();
  const id = z.uuid().safeParse((await params).reservationId);
  if (!id.success) notFound();
  const search = await searchParams;
  const details = await getCoachDirectReservation(id.data);
  if (!details) notFound();
  return <ReservationRecord details={details} back={parseCoachBookingReturn(search)} scope="owner" />;
}
