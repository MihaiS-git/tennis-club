import { readPublicCoaching, type PublicCoaching } from "@/lib/coaching/public";
import { readPublicCoachingLessonAvailability } from "@/lib/coaching/lesson-availability";
import { readCoachingBookingOptions } from "@/lib/coaching/booking-options";
import { CoachingControls } from "./coaching-controls";
import type { CoachingSelection } from "./coaching-selection";
import { connection } from "next/server";
import { AlertCircle } from "lucide-react";

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

type BookParams = { location?: string; date?: string; mode?: string; program?: string; coach?: string; duration?: string };

export async function BookingContent({ searchParams }: { searchParams: Promise<BookParams> }) {
  await connection();
  const locations = await listPublicLocationsWithCourts();
  if (!locations.length) return <p className="mt-5 rounded-card border border-border bg-surface p-6 text-muted-foreground">No locations are currently open for public booking. Please check back soon.</p>;
  const params = await searchParams;
  let coaching: PublicCoaching | undefined;
  let coachingUnavailable = false;
  try { if (params.mode === "coaching") coaching = await readPublicCoaching(locations); }
  catch { coachingUnavailable = true; }
  const preferredCoach = coaching?.coaches.find(coach => coach.id === params.coach);
  const location = locations.find((item) => item.id === params.location)
    ?? (!params.location && preferredCoach ? locations.find(item => preferredCoach.locations.some(loc => loc.id === item.id)) : undefined)
    ?? locations[0];
  const now = new Date();
  const today = localToday(location.timezone, now);
  const validDate = z.iso.date().safeParse(params.date).success && params.date! >= today;
  const date = !params.date ? today : validDate ? params.date! : null;
  return <>
    <CalendarControls locations={locations} locationId={location.id} date={date} today={today} timezone={location.timezone} coaching={params.mode === "coaching" ? { program: params.program, coach: params.coach, duration: params.duration } : undefined} />
    {params.date && !validDate && <p role="alert" className="mt-3 flex items-center gap-2 rounded-control border border-danger/30 bg-danger-background px-3 py-2 text-sm font-medium text-danger">
      <AlertCircle aria-hidden className="size-4 shrink-0" />Choose a valid date from today onward.
    </p>}
    {!date ? <p className="mt-4 rounded-card border border-dashed border-border-strong bg-surface p-5 text-sm text-muted-foreground">Choose a date to see available courts.</p> :
      coachingUnavailable ? <p role="alert" className="mt-4 text-danger">Coaching information is temporarily unavailable. Please try again.</p> :
      coaching ? <CoachingDay location={location} date={date} today={today} now={now} data={coaching} params={params} /> :
      <BookingDay location={location} date={date} today={today} now={now} />}
  </>;
}

async function BookingDay({ location, date, today, now, coaching }: {
  coaching?: CoachingSelection;
  location: Awaited<ReturnType<typeof listPublicLocationsWithCourts>>[number]; date: string; today: string; now: Date;
}) {
  const client = await createClient();
  const [day, contact, account, cancellationNoticeMinutes, onlineProvider] = await Promise.all([
    getPublicCourtDay(location, date, today, now), bookingContactPrefill(client), readCurrentAccount(client), readPublicBookingCancellationNotice(location.id), activeOnlinePaymentProvider(),
  ]);
  return <BookingCalendar key={`${location.id}:${date}`} coaching={coaching} day={day} date={date}
    onlinePaymentAvailable={supportsOnlineCheckout(onlineProvider)} allowPayAtClub={!coaching && location.allow_pay_at_club} timezone={location.timezone} cancellationNoticeMinutes={cancellationNoticeMinutes} locationName={location.name} currency={location.currency} initialContact={contact} authenticated={account.state === "active"} />;
}


async function CoachingDay({ location, date, today, now, data, params }: {
  location: Awaited<ReturnType<typeof listPublicLocationsWithCourts>>[number];
  date: string; today: string; now: Date; data: PublicCoaching; params: BookParams;
}) {
  const options = await readCoachingBookingOptions(data, location, now);
  const programs = data.programs.filter(program => options.some(option => option.programs.some(item => item.id === program.id)));
  const requestedDuration = params.duration ? Number(params.duration) : undefined;
  const preferred = options.find(option => option.coach.id === params.coach);
  const program = params.program ? programs.find(program => program.id === params.program)
    : programs.find(program => preferred?.programs.some(item => item.id === program.id
      && (requestedDuration === undefined || item.durations.includes(requestedDuration)))) ?? programs[0];
  const eligibleOptions = options.filter(option => option.programs.some(item => item.id === program?.id
    && (requestedDuration === undefined || item.durations.includes(requestedDuration))));
  const coaches = eligibleOptions.map(option => option.coach);
  const coach = params.coach ? coaches.find(coach => coach.id === params.coach) : coaches[0];
  const eligibleDurations = options.find(option => option.coach.id === coach?.id)?.programs.find(item => item.id === program?.id)?.durations ?? [];
  const cleanParams = new URLSearchParams({ mode: "coaching", location: location.id, date });
  if (params.program) cleanParams.set("program", params.program);
  if (params.duration) cleanParams.set("duration", params.duration);
  let availability = null;
  let unavailable = false;
  try {
    if (program && coach) availability = await readPublicCoachingLessonAvailability({ locationId: location.id,
      programId: program.id, coachId: coach.id, date }, now);
  } catch { unavailable = true; }
  const durations = availability?.durations.filter(item => eligibleDurations.includes(item.durationMinutes)) ?? [];
  const duration = params.duration ? durations.find(item => String(item.durationMinutes) === params.duration) : durations[0];
  return <>
    <CoachingControls locationId={location.id} date={date} programs={programs} invalidCoachUrl={params.coach && !coach ? `/book?${cleanParams}` : undefined} coaches={coaches}
      durations={durations.map(item => item.durationMinutes)}
      programId={program?.id ?? ""} coachId={coach?.id ?? ""} durationMinutes={duration?.durationMinutes ?? 0} />
    {unavailable && <p role="alert" className="mt-3 text-danger">Unable to load lesson availability. Please try again.</p>}
    {!duration && !unavailable && <p role="status" className="mt-3 text-muted-foreground">Choose an eligible program, coach and priced lesson duration to see lesson times.</p>}
    {duration && !duration.starts.length && <p role="status" className="mt-3 text-muted-foreground">No lessons are available for this coach and lesson length on this date.</p>}
    <BookingDay location={location} date={date} today={today} now={now} coaching={{ locationId: location.id,
      programId: program?.id ?? "", coachId: coach?.id ?? "", programName: program?.name ?? "", coachName: coach?.displayName ?? "",
      participantCount: availability?.program.participantCount ?? 1,
      durationMinutes: duration?.durationMinutes ?? 0, courtRentalIncluded: availability?.program.courtRentalIncluded ?? false,
      starts: duration?.starts ?? [] }} />
  </>;
}
