import { connection } from "next/server";

import { supportsOnlineCheckout } from "@/lib/payments/providers";
import { readPublicBookingCancellationNotice } from "@/lib/bookings/confirmation-policy";
import { activeOnlinePaymentProvider } from "@/lib/payments/settings";
import { z } from "zod";
import { readCurrentAccount } from "@/lib/auth/account";
import { createClient } from "@/lib/supabase/server";
import { listPublicLocationsWithCourts } from "@/lib/courts/public";
import { getPublicCourtDay } from "@/lib/courts/public-calendar";
import { localToday } from "@/lib/courts/calendar";
import { bookingContactPrefill } from "@/lib/bookings/prefill";
import { CalendarControls } from "./calendar-controls";
import { BookingCalendar } from "./booking-calendar";

export async function BookingContent({ searchParams }: { searchParams: Promise<{ location?: string; date?: string }> }) {
  await connection();
  const locations = await listPublicLocationsWithCourts();
  if (!locations.length) return <p className="rounded-card border border-border bg-surface p-6">No locations are currently open for public booking. Please check back soon.</p>;
  const params = await searchParams;
  const location = locations.find((item) => item.id === params.location) ?? locations[0];
  const now = new Date();
  const today = localToday(location.timezone, now);
  const validDate = z.iso.date().safeParse(params.date).success && params.date! >= today;
  const date = !params.date ? today : validDate ? params.date! : null;
  return <>
    <CalendarControls locations={locations} locationId={location.id} date={date} today={today} />
    <p className="mt-2 text-xs text-muted-foreground">Times shown in {location.timezone}.</p>
    {params.date && !validDate && <p role="alert" className="mt-2 text-sm text-danger">Choose a valid date from today onward.</p>}
    {!date ? <p className="mt-5 text-sm text-muted-foreground">Choose a date to see available courts.</p> :
      <BookingDay location={location} date={date} today={today} now={now} />}
  </>;
}

async function BookingDay({ location, date, today, now }: {
  location: Awaited<ReturnType<typeof listPublicLocationsWithCourts>>[number]; date: string; today: string; now: Date;
}) {
  const client = await createClient();
  const [day, contact, account, cancellationNoticeMinutes, onlineProvider] = await Promise.all([
    getPublicCourtDay(location, date, today, now, client), bookingContactPrefill(client), readCurrentAccount(client), readPublicBookingCancellationNotice(location.id), activeOnlinePaymentProvider(),
  ]);
  return <BookingCalendar key={`${location.id}:${date}`} day={day} date={date}
    onlinePaymentAvailable={supportsOnlineCheckout(onlineProvider)} allowPayAtClub={location.allow_pay_at_club} timezone={location.timezone} cancellationNoticeMinutes={cancellationNoticeMinutes} locationName={location.name} currency={location.currency} initialContact={contact} authenticated={account.state === "active"} />;
}
