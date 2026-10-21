import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { adminBookingsHref, parseAdminBookingQuery, parseAdminBookingReturn } from "@/lib/bookings/admin-query";
import { getAdminDirectReservation } from "@/lib/reservations/service";
import { ReservationRecord } from "./reservation-record";

export const metadata: Metadata = { title: "Reservation details | Tennis Club" };
export const instant = false;

export default async function AdminReservationPage({ params, searchParams }: {
  params: Promise<{ reservationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireActiveAdmin();
  const id = z.uuid().safeParse((await params).reservationId);
  if (!id.success) notFound();
  const search = await searchParams;
  const details = await getAdminDirectReservation(id.data);
  if (!details) notFound();
  const back = parseAdminBookingReturn(search) ?? { href: adminBookingsHref(parseAdminBookingQuery(search)), label: "Back to Bookings" };
  return <ReservationRecord details={details} back={back} scope="admin" />;
}
