import { readPublicCoaching, type PublicCoaching } from "@/lib/coaching/public";
import { readPublicCoachingLessonAvailability, type PublicCoachingLessonAvailability } from "@/lib/coaching/lesson-availability";
import { coachingBookingOptions } from "@/lib/coaching/booking-options";
import { CoachingControls } from "./coaching-controls";
import type { CoachingSelection } from "./coaching-selection";
import { connection } from "next/server";
import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";

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
type BookLocation = Awaited<ReturnType<typeof listPublicLocationsWithCourts>>[number];

const statusClass = "mt-3 rounded-card border border-dashed border-border-strong bg-surface p-4 text-sm text-muted-foreground";
const Alert = ({ children }: { children: ReactNode }) => <p role="alert" className="mt-3 flex items-center gap-2 rounded-control border border-danger/30 bg-danger-background px-3 py-2 text-sm font-medium text-danger">
  <AlertCircle aria-hidden className="size-4 shrink-0" />{children}
</p>;

export async function BookingContent({ searchParams }: { searchParams: Promise<BookParams> }) {
  await connection();
  const locations = await listPublicLocationsWithCourts();
  if (!locations.length) return <p className="mt-5 rounded-card border border-border bg-surface p-6 text-muted-foreground">No locations are currently open for public booking. Please check back soon.</p>;
  const params = await searchParams;
  if (params.mode === "coaching") return <CoachingContent locations={locations} params={params} />;
  const location = locations.find((item) => item.id === params.location) ?? locations[0];
  const now = new Date();
  const today = localToday(location.timezone, now);
  const validDate = z.iso.date().safeParse(params.date).success && params.date! >= today;
  const date = !params.date ? today : validDate ? params.date! : null;
  return <>
    <CalendarControls locations={locations} locationId={location.id} date={date} today={today} timezone={location.timezone} />
    {params.date && !validDate && <Alert>Choose a valid date from today onward.</Alert>}
    {!date ? <p className="mt-4 rounded-card border border-dashed border-border-strong bg-surface p-5 text-sm text-muted-foreground">Choose a date to see available courts.</p> :
      <BookingDay location={location} date={date} today={today} now={now} />}
  </>;
}

// Location → Coach → Program → Duration → Date/Time. Resolve missing choices
// from public selector options; explicit URL choices keep their validation path.
async function CoachingContent({ locations, params }: { locations: BookLocation[]; params: BookParams }) {
  let coaching: PublicCoaching | undefined;
  try { coaching = await readPublicCoaching(locations); }
  catch { /* Rendered as the unavailable state below. */ }
  const linkedCoach = !params.location ? coaching?.coaches.find(coach => coach.id === params.coach) : undefined;
  const linkedLocations = linkedCoach ? locations.filter(item => linkedCoach.locations.some(loc => loc.id === item.id)) : [];
  const location = params.location ? locations.find(item => item.id === params.location)
    : linkedLocations[0] ?? locations[0];
  if (!location) return <>
    <CalendarControls locations={locations} date={null} today="" coaching={{}} />
    {params.location && <Alert>The selected location is not available for booking. Choose a location.</Alert>}
    {!coaching ? <Alert>Coaching information is temporarily unavailable. Please try again.</Alert>
      : <p role="status" className={statusClass}>Choose a location to see its coaches.</p>}
  </>;
  const now = new Date();
  const today = localToday(location.timezone, now);
  const validDate = z.iso.date().safeParse(params.date).success && params.date! >= today;
  const date = !params.date ? today : validDate ? params.date! : null;
  return <>
    <CalendarControls locations={locations} locationId={location.id} date={date} today={today} timezone={location.timezone}
      coaching={{ coach: params.coach, program: params.program, duration: params.duration }} />
    {params.date && !validDate && <Alert>Choose a valid date from today onward.</Alert>}
    {!date ? <p className="mt-4 rounded-card border border-dashed border-border-strong bg-surface p-5 text-sm text-muted-foreground">Choose a date to see available courts.</p> :
      !coaching ? <p role="alert" className="mt-4 text-danger">Coaching information is temporarily unavailable. Please try again.</p> :
      <CoachingDay location={location} date={date} today={today} now={now} data={coaching} params={params} />}
  </>;
}

async function BookingDay({ location, date, today, now, coaching }: {
  coaching?: CoachingSelection;
  location: BookLocation; date: string; today: string; now: Date;
}) {
  const client = await createClient();
  const [day, contact, account, cancellationNoticeMinutes, onlineProvider] = await Promise.all([
    getPublicCourtDay(location, date, today, now), bookingContactPrefill(client), readCurrentAccount(client), readPublicBookingCancellationNotice(location.id), activeOnlinePaymentProvider(),
  ]);
  return <BookingCalendar key={`${location.id}:${date}`} coaching={coaching} day={day} date={date}
    onlinePaymentAvailable={supportsOnlineCheckout(onlineProvider)} allowPayAtClub={!coaching && location.allow_pay_at_club} timezone={location.timezone} cancellationNoticeMinutes={cancellationNoticeMinutes} locationName={location.name} currency={location.currency} initialContact={contact} authenticated={account.state === "active"} />;
}

// URL selections are honoured only while their upstream selection is valid; an
// invalid one is reported and left unselected, never replaced by another choice.
async function CoachingDay({ location, date, today, now, data, params }: {
  location: BookLocation; date: string; today: string; now: Date; data: PublicCoaching; params: BookParams;
}) {
  let options: Awaited<ReturnType<typeof coachingBookingOptions>>;
  try { options = await coachingBookingOptions(data, location, now); }
  catch { return <><Alert>Coaching information is temporarily unavailable. Please try again.</Alert></>; }
  const pricedProgram = (candidate: typeof options[number]) => candidate.programs.find(item =>
    item.bookable && item.durations.some(length => length.price));
  const coach = params.coach ? options.find(option => option.id === params.coach)
    : options.find(option => params.program && params.duration && option.programs.some(item => item.id === params.program && item.bookable && item.durations.some(length => String(length.durationMinutes) === params.duration && length.price)))
      ?? options.find(option => params.program && option.programs.some(item => item.id === params.program && item.bookable))
      ?? options.find(option => params.duration && option.programs.some(item => item.bookable && item.durations.some(length => String(length.durationMinutes) === params.duration && length.price)))
      ?? options.find(option => pricedProgram(option));
  const program = coach && (params.program ? coach.programs.find(item => item.id === params.program && item.bookable)
    : coach.programs.find(item => item.bookable && params.duration && item.durations.some(length => String(length.durationMinutes) === params.duration && length.price))
      ?? pricedProgram(coach));
  const duration = program && (params.duration ? program.durations.find(item => String(item.durationMinutes) === params.duration)
    : program.durations.find(item => item.durationMinutes === 60 && item.price)
      ?? program.durations.filter(item => item.price).sort((a, b) => a.durationMinutes - b.durationMinutes)[0]);
  let availability: PublicCoachingLessonAvailability | null = null;
  let unavailable = false;
  try {
    if (coach && program && duration?.price) availability = await readPublicCoachingLessonAvailability({ locationId: location.id,
      programId: program.id, coachId: coach.id, date }, now);
  } catch { unavailable = true; }
  const starts = availability?.durations.find(item => item.durationMinutes === duration?.durationMinutes)?.starts;
  const bookable = coach?.programs.filter(item => item.bookable) ?? [];
  const status = !options.length ? `No coaches currently offer online-bookable lessons at ${location.name}.`
    : !coach ? "Choose a coach to see their programs."
    : !coach.programs.length ? `${coach.displayName} has no programs assigned yet.`
    : !bookable.length ? `None of ${coach.displayName}’s programs can be booked online.`
    : !program ? "Choose a program."
    : !program.durations.length ? `${program.name} has no lesson lengths that can be booked online.`
    : !duration ? "Choose a lesson length."
    : !duration.price ? null
    : unavailable ? null
    : !availability ? `${coach.displayName} does not currently offer ${program.name} at ${location.name}.`
    : !starts?.length ? "No lessons are available for this coach and lesson length on this date." : null;
  return <>
    <CoachingControls locationId={location.id} date={date}
      coaches={options.map(option => ({ id: option.id, displayName: option.displayName }))}
      programs={coach?.programs.map(item => ({ id: item.id, name: item.name, bookable: item.bookable })) ?? []}
      durations={program?.durations.map(item => ({ durationMinutes: item.durationMinutes, price: item.price })) ?? []}
      coachId={coach?.id ?? ""} programId={program?.id ?? ""} durationMinutes={duration?.durationMinutes ?? 0}
      courtRentalIncluded={program?.courtRentalIncluded ?? false} />
    {params.coach && !coach && <Alert>The selected coach is not available at {location.name}. Choose a coach.</Alert>}
    {coach && params.program && !program && <Alert>{coach.displayName} does not offer the selected program online. Choose a program.</Alert>}
    {program && params.duration && !duration && <Alert>The selected lesson length is not offered for {program.name}. Choose a lesson length.</Alert>}
    {duration && !duration.price && <Alert>Pricing is unavailable for this lesson length at {location.name}, so it cannot be booked.</Alert>}
    {unavailable && <Alert>Unable to load lesson availability. Please try again.</Alert>}
    {status && <p role="status" className={statusClass}>{status}</p>}
    <BookingDay location={location} date={date} today={today} now={now} coaching={{ locationId: location.id,
      programId: program?.id ?? "", coachId: coach?.id ?? "", programName: program?.name ?? "", coachName: coach?.displayName ?? "",
      participantCount: availability?.program.participantCount ?? 1,
      durationMinutes: starts ? duration!.durationMinutes : 0, courtRentalIncluded: availability?.program.courtRentalIncluded ?? false,
      starts: starts ?? [] }} />
  </>;
}
