import type { Metadata } from "next";
import { Suspense } from "react";
import { BookingsList } from "@/app/admin/bookings/bookings-list";
import { BookingsToolbar } from "@/app/admin/bookings/bookings-toolbar";
import { ManagementTabs } from "@/app/admin/bookings/management-tabs";
import { ReservationContent } from "@/app/admin/reservations/reservation-content";
import { AdminPageHeader } from "@/components/admin-page-controls";
import { coachBookingsHref, parseCoachBookingQuery } from "@/lib/bookings/admin-query";
import { listCoachBookingFilterOptions, listCoachBookings } from "@/lib/bookings/coach-bookings";
import { requireActiveCoach } from "@/lib/coaching/authorization";

export const metadata: Metadata = { title: "Bookings & Reservations | Tennis Club" };
export const instant = false;

// The Coach's Calendar (every court's occupancy, as before) and a List of only their
// own coaching lessons and staff reservations. Admin routes stay Admin-only.
export default async function CoachBookingsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireActiveCoach();
  const params = await searchParams;
  if (params.view === "calendar") return <>
    <AdminPageHeader title="Bookings & Reservations" description="Reserve courts and review the day’s bookings by location." />
    <ManagementTabs view="calendar" base="/coach/bookings" />
    <Suspense fallback={<p role="status" className="mt-4 text-muted-foreground">Loading reservations…</p>}>
      <ReservationContent href="/coach/bookings?view=calendar"
        searchParams={Promise.resolve({ location: single(params.location), date: single(params.date) })} />
    </Suspense>
  </>;
  const parsed = parseCoachBookingQuery(params);
  const locations = await listCoachBookingFilterOptions();
  // Unknown locations and courts outside the selected location are dropped, never queried.
  const location = locations.find((item) => item.id === parsed.location);
  const query = { ...parsed, location: location?.id ?? "", court: location?.courts.some((court) => court.id === parsed.court) ? parsed.court : "" };
  const result = await listCoachBookings(query);
  return <>
    <AdminPageHeader title="Bookings & Reservations" description="Search and review your coaching lessons and your staff reservations, including past and cancelled records." />
    <ManagementTabs view="list" base="/coach/bookings" />
    <BookingsToolbar locations={locations} scope="coach" />
    <BookingsList result={result} query={query} href={coachBookingsHref} scope="coach" />
  </>;
}

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined;
}
