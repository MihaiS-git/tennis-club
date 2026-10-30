import type { AdminBookingEditor } from "@/lib/bookings/admin-edit";
import { loadAdminBookingEditor } from "@/lib/bookings/admin-edit";
import { loadCoachBookingEditor } from "@/lib/bookings/coach-edit";
import { StaffCalendarReschedule } from "@/components/staff-calendar-reschedule";
import { z } from "zod";
import { localToday } from "@/lib/courts/calendar";
import { getReservationDay, listInternalLocations } from "@/lib/reservations/service";
import { ReservationCalendar } from "./reservation-calendar";
import { ReservationControls } from "./reservation-controls";

export async function ReservationContent({ searchParams, href, scope = "admin" }: {
  searchParams: Promise<{ location?: string; date?: string; reschedule?: string }>; href?: string; scope?: "admin" | "coach";
}) {
  const params = await searchParams;
  if (params.reschedule && !z.uuid().safeParse(params.reschedule).success) return <p role="alert">Choose a valid booking.</p>;
  let editor: (AdminBookingEditor & { actingCoachId?: string }) | undefined;
  if (params.reschedule) {
    try { editor = await (scope === "admin" ? loadAdminBookingEditor : loadCoachBookingEditor)(params.reschedule); }
    catch { /* The toolbar reports an unavailable booking; normal browsing stays usable. */ }
  }
  const locations = await listInternalLocations();
  if (!locations.length) return <p className="mt-5 rounded-card border border-border bg-surface p-5">No configured locations are available for reservations.</p>;
  const location = locations.find((item) => item.id === (params.location ?? editor?.tokens.location_id)) ?? locations[0];
  const now = new Date();
  const today = localToday(location.timezone, now);
  const requestedDate = params.date ?? editor?.booking.booking_date;
  const validDate = z.iso.date().safeParse(requestedDate).success;
  const date = !requestedDate ? today : validDate ? requestedDate! : null;
  return <StaffCalendarReschedule bookingId={params.reschedule} capacity={scope} initialData={editor} locationId={location.id} date={date}>
    <ReservationControls locations={locations} locationId={location.id} date={date} today={today} href={href} />
    <p className="mt-2 text-xs text-muted-foreground">Times shown in {location.timezone}.</p>
    {params.date && !validDate && <p role="alert" className="mt-2 text-sm text-danger">Choose a valid date.</p>}
    {!date ? <p className="mt-5 text-sm text-muted-foreground">Choose a date to see available courts.</p> :
      <ReservationDay location={location} date={date} now={now} scope={scope} />}
  </StaffCalendarReschedule>;
}

async function ReservationDay({ location, date, now, scope }: {
  location: Awaited<ReturnType<typeof listInternalLocations>>[number]; date: string; now: Date; scope: "admin" | "coach";
}) {
  const day = await getReservationDay(location, date, now, undefined, scope);
  return <ReservationCalendar day={day} date={date} location={location}
    occupancy={day.occupancy} adminOccupancy={day.adminOccupancy} canManage={day.canManage} actorUserId={day.actorUserId} />;
}
