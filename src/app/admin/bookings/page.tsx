import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminPageHeader } from "@/components/admin-page-controls";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { listAdminBookingCoachFilterOptions, listAdminBookingFilterOptions, listAdminBookings } from "@/lib/bookings/admin-details";
import { adminBookingsHref, parseAdminBookingQuery } from "@/lib/bookings/admin-query";
import { ReservationContent } from "../reservations/reservation-content";
import { BookingsList } from "./bookings-list";
import { BookingsToolbar } from "./bookings-toolbar";
import { ManagementTabs } from "./management-tabs";
import { LoadingStatus } from "@/components/loading-status";

export const metadata: Metadata = { title: "Bookings & Reservations | Tennis Club" };
export const instant = false;

export default async function AdminBookingsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireActiveAdmin();
  const params = await searchParams;
  // The List stays the default so existing /admin/bookings links keep their meaning.
  if (params.view === "calendar") return <>
    <AdminPageHeader title="Bookings & Reservations" description="Reserve courts and review the day’s bookings by location." />
    <ManagementTabs view="calendar" />
    <Suspense fallback={<LoadingStatus variant="page" label="Loading reservations…" />}>
      <ReservationContent href="/admin/bookings?view=calendar"
        searchParams={Promise.resolve({ location: single(params.location), date: single(params.date), reschedule: single(params.reschedule) })} />
    </Suspense>
  </>;
  const parsed = parseAdminBookingQuery(params);
  const [locations, coaches] = await Promise.all([listAdminBookingFilterOptions(),
    parsed.type === "coaching" ? listAdminBookingCoachFilterOptions() : Promise.resolve([])]);
  // Unknown locations and courts outside the selected location are dropped, never queried.
  const location = locations.find((item) => item.id === parsed.location);
  const query = { ...parsed, coach: coaches.some((coach) => coach.id === parsed.coach) ? parsed.coach : "", location: location?.id ?? "", court: location?.courts.some((court) => court.id === parsed.court) ? parsed.court : "" };
  const result = await listAdminBookings(query);
  return <>
    <AdminPageHeader title="Bookings & Reservations" description="Search and review customer bookings and staff reservations across all locations, including past and cancelled records." />
    <ManagementTabs view="list" />
    <BookingsToolbar locations={locations} coaches={coaches} />
    <BookingsList result={result} query={query} href={adminBookingsHref} />
  </>;
}

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}
