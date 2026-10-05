import type { Metadata } from "next";
import { Suspense } from "react";
import { z } from "zod";
import { localToday } from "@/lib/courts/calendar";
import { getReservationDay, listInternalLocations } from "@/lib/reservations/service";
import { ReservationCalendar } from "./reservation-calendar";
import { ReservationControls } from "./reservation-controls";

export const metadata: Metadata = { title: "Reservations | Tennis Club" };

export default function ReservationsPage({ searchParams }: { searchParams: Promise<{ location?: string; date?: string }> }) {
  return <main className="flex-1 px-6 py-3 md:px-8"><div className="mx-auto max-w-7xl">
    <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-accent">Club operations</p>
    <h1 className="font-heading text-[clamp(32px,4vw,44px)] font-semibold leading-tight tracking-[-0.04em] text-primary">Reservations</h1>
    <Suspense fallback={<p role="status" className="mt-4 text-muted-foreground">Loading reservations…</p>}>
      <ReservationContent searchParams={searchParams} />
    </Suspense>
  </div></main>;
}

export async function ReservationContent({ searchParams }: { searchParams: Promise<{ location?: string; date?: string }> }) {
  const locations = await listInternalLocations();
  if (!locations.length) return <p className="mt-5 rounded-card border border-border bg-surface p-5">No configured locations are available for reservations.</p>;
  const params = await searchParams;
  const location = locations.find((item) => item.id === params.location) ?? locations[0];
  const now = new Date();
  const today = localToday(location.timezone, now);
  const validDate = z.iso.date().safeParse(params.date).success;
  const date = !params.date ? today : validDate ? params.date! : null;
  return <>
    <ReservationControls locations={locations} locationId={location.id} date={date} today={today} />
    <p className="mt-2 text-xs text-muted-foreground">Times shown in {location.timezone}.</p>
    {params.date && !validDate && <p role="alert" className="mt-2 text-sm text-danger">Choose a valid date.</p>}
    {!date ? <p className="mt-5 text-sm text-muted-foreground">Choose a date to see available courts.</p> :
      <ReservationDay location={location} date={date} now={now} />}
  </>;
}

async function ReservationDay({ location, date, now }: {
  location: Awaited<ReturnType<typeof listInternalLocations>>[number]; date: string; now: Date;
}) {
  const day = await getReservationDay(location, date, now);
  return <ReservationCalendar key={`${location.id}:${date}`} day={day} date={date} location={location}
    occupancy={day.occupancy} adminOccupancy={day.adminOccupancy} />;
}
