import { readPublicCoachingWithFacts } from "@/lib/coaching/public";
import { readPublicCoachingLessonAvailability, type PublicCoachingLessonRead } from "@/lib/coaching/lesson-availability";
import { coachBookableLocations, coachingBookingOptions, coachingDurationPrice } from "@/lib/coaching/booking-options";
import { isPermittedParticipantCount } from "@/lib/coaching/validation";
import { CoachingControls } from "./coaching-controls";
import type { CoachingSelection } from "./coaching-selection";
import { connection } from "next/server";
import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";

import { supportsOnlineCheckout } from "@/lib/payments/providers";
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

type BookParams = { location?: string; date?: string; mode?: string; program?: string; coach?: string; duration?: string; participants?: string };
type BookLocation = Awaited<ReturnType<typeof listPublicLocationsWithCourts>>[number];
type LoadedCoaching = Awaited<ReturnType<typeof readPublicCoachingWithFacts>>;

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

// Location → Coach → Program → Duration → Players → Date/Time. Resolve missing choices
// from public selector options; explicit URL choices keep their validation path.
async function CoachingContent({ locations, params }: { locations: BookLocation[]; params: BookParams }) {
  let loaded: LoadedCoaching | undefined;
  try { loaded = await readPublicCoachingWithFacts(locations); }
  catch { /* Rendered as the unavailable state below. */ }
  const coaching = loaded?.coaching;
  const now = new Date();
  const linkedCoach = !params.location ? coaching?.coaches.find(coach => coach.id === params.coach) : undefined;
  // A linked coach opens at their first location with online-bookable lessons; without one,
  // at their first assigned location, where CoachingDay explains why they cannot be booked.
  let bookableLocations: BookLocation[] = [];
  if (linkedCoach && coaching) {
    try { bookableLocations = await coachBookableLocations(coaching, locations, linkedCoach.id, now); }
    catch { /* CoachingDay reports the unavailable selector data. */ }
  }
  const location = params.location ? locations.find(item => item.id === params.location)
    : bookableLocations[0] ?? locations.find(item => linkedCoach?.locations.some(loc => loc.id === item.id)) ?? locations[0];
  if (!location) return <>
    <CalendarControls locations={locations} date={null} today="" coaching={{}} />
    {params.location && <Alert>The selected location is not available for booking. Choose a location.</Alert>}
    {!coaching ? <Alert>Coaching information is temporarily unavailable. Please try again.</Alert>
      : <p role="status" className={statusClass}>Choose a location to see its coaches.</p>}
  </>;
  const today = localToday(location.timezone, now);
  const validDate = z.iso.date().safeParse(params.date).success && params.date! >= today;
  const date = !params.date ? today : validDate ? params.date! : null;
  return <>
    <CalendarControls locations={locations} locationId={location.id} date={date} today={today} timezone={location.timezone}
      coaching={{ coach: params.coach, program: params.program, duration: params.duration, participants: params.participants }} />
    {params.date && !validDate && <Alert>Choose a valid date from today onward.</Alert>}
    {!date ? <p className="mt-4 rounded-card border border-dashed border-border-strong bg-surface p-5 text-sm text-muted-foreground">Choose a date to see available courts.</p> :
      !loaded ? <p role="alert" className="mt-4 text-danger">Coaching information is temporarily unavailable. Please try again.</p> :
      <CoachingDay locations={locations} location={location} date={date} today={today} now={now} data={loaded} params={params} />}
  </>;
}

// courtDay is the grid a lesson availability read of this render already built;
// without one the day is loaded here.
async function BookingDay({ location, date, today, now, coaching, courtDay }: {
  coaching?: CoachingSelection; courtDay?: PublicCoachingLessonRead["courtDay"];
  location: BookLocation; date: string; today: string; now: Date;
}) {
  const client = await createClient();
  const cancellationNoticeMinutes = location.customer_cancellation_notice_minutes;
  if (cancellationNoticeMinutes === null) throw new Error("Unable to load booking terms. Please try again.");
  const [day, contact, account, onlineProvider] = await Promise.all([
    courtDay ?? getPublicCourtDay(location, date, today, now), bookingContactPrefill(client), readCurrentAccount(client), activeOnlinePaymentProvider(),
  ]);
  return <BookingCalendar key={`${location.id}:${date}`} coaching={coaching} day={day} date={date}
    onlinePaymentAvailable={supportsOnlineCheckout(onlineProvider)} allowPayAtClub={!coaching && location.allow_pay_at_club} timezone={location.timezone} cancellationNoticeMinutes={cancellationNoticeMinutes} locationName={location.name} currency={location.currency} initialContact={contact} authenticated={account.state === "active"} />;
}

// URL selections are honoured only while their upstream selection is valid; an
// invalid one is reported and left unselected, never replaced by another choice.
async function CoachingDay({ locations, location, date, today, now, data, params }: {
  locations: BookLocation[]; location: BookLocation; date: string; today: string; now: Date; data: LoadedCoaching; params: BookParams;
}) {
  let options: Awaited<ReturnType<typeof coachingBookingOptions>>;
  try { options = await coachingBookingOptions(data.coaching, location, now); }
  catch { return <><Alert>Coaching information is temporarily unavailable. Please try again.</Alert></>; }
  type ProgramOption = typeof options[number]["programs"][number];
  // A duration is bookable for some permitted count when any count has its own configured price.
  const priced = (length: ProgramOption["durations"][number]) => length.prices.some(item => item.price);
  const pricedProgram = (candidate: typeof options[number]) => candidate.programs.find(item => item.durations.some(priced));
  const coach = params.coach ? options.find(option => option.id === params.coach)
    : options.find(option => params.program && params.duration && option.programs.some(item => item.id === params.program && item.durations.some(length => String(length.durationMinutes) === params.duration && priced(length))))
      ?? options.find(option => params.program && option.programs.some(item => item.id === params.program))
      ?? options.find(option => params.duration && option.programs.some(item => item.durations.some(length => String(length.durationMinutes) === params.duration && priced(length))))
      ?? options.find(option => pricedProgram(option));
  const program = coach && (params.program ? coach.programs.find(item => item.id === params.program)
    : coach.programs.find(item => params.duration && item.durations.some(length => String(length.durationMinutes) === params.duration && priced(length)))
      ?? pricedProgram(coach));
  // The URL's permitted count, else the smallest count priced for the selected (or any)
  // duration, else the program's configured minimum. Prices are never borrowed across counts.
  const pricedCount = program?.durations.filter(length => !params.duration || String(length.durationMinutes) === params.duration)
    .flatMap(length => length.prices.filter(item => item.price).map(item => item.participantCount)).sort((a, b) => a - b)[0];
  const participantCount = !program ? 0 : params.participants === undefined ? pricedCount ?? program.participants.min
    : /^\d+$/.test(params.participants) && isPermittedParticipantCount(program.participants, Number(params.participants)) ? Number(params.participants) : 0;
  // Each duration is labelled with the exact configured price of the selected count.
  const durations = program?.durations.map(item => ({ durationMinutes: item.durationMinutes, price: coachingDurationPrice(item, participantCount) })) ?? [];
  const duration = program && (params.duration ? durations.find(item => String(item.durationMinutes) === params.duration)
    : durations.find(item => item.durationMinutes === 60 && item.price)
      ?? durations.filter(item => item.price).sort((a, b) => a.durationMinutes - b.durationMinutes)[0]);
  // A public coach requested where they cannot be booked: name their bookable locations, if any.
  const requested = params.coach && !coach ? data.coaching.coaches.find(item => item.id === params.coach) : undefined;
  let elsewhere: BookLocation[] | null = null;
  if (requested) {
    try { elsewhere = await coachBookableLocations(data.coaching, locations.filter(item => item.id !== location.id), requested.id, now); }
    catch { /* Falls back to the generic coach alert. */ }
  }
  const coachAlert = !requested || !elsewhere ? `The selected coach is not available at ${location.name}. Choose a coach.`
    : elsewhere.length ? `${requested.displayName} does not offer online-bookable lessons at ${location.name}. Available at ${
      new Intl.ListFormat("en-GB", { type: "disjunction" }).format(elsewhere.map(item => item.name))}; choose that location or another coach.`
    : `${requested.displayName} does not currently offer lessons that can be booked online. Please contact the club, or choose another coach.`;
  let lesson: PublicCoachingLessonRead | null = null;
  let unavailable = false;
  try {
    if (coach && program && duration?.price && participantCount) lesson = await readPublicCoachingLessonAvailability({ locationId: location.id,
      programId: program.id, coachId: coach.id, date, participantCount }, { locations, coaching: data.facts }, now);
  } catch { unavailable = true; }
  const availability = lesson?.availability ?? null;
  const starts = availability?.durations.find(item => item.durationMinutes === duration?.durationMinutes)?.starts;
  const status = !options.length ? `No coaches currently offer online-bookable lessons at ${location.name}.`
    : !coach ? "Choose a coach to see their programs."
    : !coach.programs.length ? `${coach.displayName} has no programs assigned yet.`
    : !program ? "Choose a program."
    : !program.durations.length ? `${program.name} has no lesson lengths that can be booked online.`
    : !participantCount ? "Choose the number of players."
    : !duration ? "Choose a lesson length."
    : !duration.price ? null
    : unavailable ? null
    : !availability ? `${coach.displayName} does not currently offer ${program.name} at ${location.name}.`
    : !starts?.length ? "No lessons are available for this coach and lesson length on this date." : null;
  return <>
    <CoachingControls locationId={location.id} date={date}
      coaches={options.map(option => ({ id: option.id, displayName: option.displayName }))}
      programs={coach?.programs.map(item => ({ id: item.id, name: item.name })) ?? []}
      durations={durations}
      participants={program?.participants ?? null}
      coachId={coach?.id ?? ""} programId={program?.id ?? ""} durationMinutes={duration?.durationMinutes ?? 0} participantCount={participantCount}
      courtRentalIncluded={program?.courtRentalIncluded ?? false} />
    {params.coach && !coach && <Alert>{coachAlert}</Alert>}
    {coach && params.program && !program && <Alert>{coach.displayName} does not offer the selected program online. Choose a program.</Alert>}
    {program && params.duration && !duration && <Alert>The selected lesson length is not offered for {program.name}. Choose a lesson length.</Alert>}
    {program && params.participants !== undefined && !participantCount && <Alert>The selected number of players is not offered for {program.name}. Choose the number of players.</Alert>}
    {duration && participantCount > 0 && !duration.price && <Alert>Pricing is unavailable for this lesson length and number of players at {location.name}, so it cannot be booked.</Alert>}
    {unavailable && <Alert>Unable to load lesson availability. Please try again.</Alert>}
    {status && <p role="status" className={statusClass}>{status}</p>}
    <BookingDay location={location} date={date} today={today} now={now} courtDay={lesson?.courtDay} coaching={{ locationId: location.id,
      programId: program?.id ?? "", coachId: coach?.id ?? "", programName: program?.name ?? "", coachName: coach?.displayName ?? "",
      participantCount,
      durationMinutes: starts ? duration!.durationMinutes : 0, courtRentalIncluded: availability?.program.courtRentalIncluded ?? false,
      starts: starts ?? [] }} />
  </>;
}
