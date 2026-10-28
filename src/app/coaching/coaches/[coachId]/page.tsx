import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import { readCoachBookableLocationIds } from "@/lib/coaching/booking-options";
import { readPublicCoach, type PublicCoachLesson, type PublicCoachProfile } from "@/lib/coaching/public";
import {
  coachingProgramTypeLabels, coachingProgramTypes, type CoachingProgramType, formatCoachingDuration, formatPlayers, formatParticipants, isOnlineCoachingProgramType,
} from "@/lib/coaching/validation";
import { listPublicLocationsWithCourts } from "@/lib/courts/public";
import { formatMoney } from "@/lib/pricing/money";
import styles from "../../../page.module.css";
import { PageSectionNav, type PageSection } from "../../../page-section-nav";
import { coachIntroduction, initials, rentalLabel } from "../../coaching-sections";

// The profile is read before rendering so unknown or hidden coaches return a real 404.
export const instant = false;

type CoachPageProps = { params: Promise<{ coachId: string }> };

const sections: PageSection[] = [
  { id: "about", label: "About" },
  { id: "programs", label: "Programs" },
  { id: "locations", label: "Locations" },
  { id: "prices", label: "Prices" },
];

// The public locations, in booking-page order, where the coach has online-bookable lessons;
// null when that could not be determined, so neither booking nor contact is suggested.
type CoachPageData = PublicCoachProfile & { bookableLocationIds: string[] | null };

// Deduplicates the public read between metadata and the page within one request.
const readCoach = cache(async (coachId: string): Promise<CoachPageData | null | "unavailable"> => {
  await connection();
  try {
    const locations = await listPublicLocationsWithCourts();
    const coach = await readPublicCoach(coachId, locations);
    if (!coach) return null;
    const bookableLocationIds = await readCoachBookableLocationIds(coach.id, locations).catch(() => null);
    return { ...coach, bookableLocationIds };
  } catch {
    return "unavailable";
  }
});

// The coaching timetable with the coach preselected at their first online-bookable location.
function bookingHref(coach: CoachPageData) {
  const [locationId] = coach.bookableLocationIds ?? [];
  return locationId ? `/book?${new URLSearchParams({ mode: "coaching", location: locationId, coach: coach.id })}` : null;
}

function HeroCallToAction({ coach }: { coach: CoachPageData }) {
  const href = bookingHref(coach);
  if (href) return (
    <Link href={href} className="mt-7 inline-flex min-h-12 items-center justify-center rounded-control bg-chalk px-6 font-sans text-sm font-semibold text-primary transition hover:bg-surface-muted">Book a lesson</Link>
  );
  if (coach.bookableLocationIds) return (
    <Link href="/contact" prefetch={false} className="mt-7 inline-flex min-h-12 items-center justify-center rounded-control border border-ivory/80 bg-forest-900/20 px-6 font-sans text-sm font-semibold text-chalk transition hover:border-accent-on-dark hover:bg-forest-900/40">Contact the club</Link>
  );
  return null;
}

function BookingCallToAction({ coach, firstName }: { coach: CoachPageData; firstName: string }) {
  const href = bookingHref(coach);
  if (href) return (
    <p className="mt-4 max-w-xl font-sans text-sm leading-6 text-ivory">
      <Link href={href} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">Book a lesson with {firstName}</Link>
    </p>
  );
  // Group/Junior sessions, or no current working hours: arranged with the club, not booked online.
  if (coach.bookableLocationIds) return (
    <p className="mt-4 max-w-xl font-sans text-sm leading-6 text-ivory">
      Sessions with {firstName} are not booked online.{" "}
      <Link href="/contact" prefetch={false} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">Contact the club</Link> to arrange one.
    </p>
  );
  return null;
}

export async function generateMetadata({ params }: CoachPageProps): Promise<Metadata> {
  const coach = await readCoach((await params).coachId);
  if (coach === "unavailable") return { title: "Coaching | Tennis Club" };
  if (!coach) return { title: "Coach not found | Tennis Club" };
  return {
    title: `${coach.displayName} | Coaching | Tennis Club`,
    description: coachIntroduction(coach.bio) || `${coach.displayName} coaches at the Tennis Club.`,
    alternates: { canonical: `/coaching/coaches/${coach.id}` },
  };
}

const eyebrowClassName = "font-sans text-xs font-semibold uppercase tracking-[0.16em]";
const headingClassName = "font-heading text-[clamp(34px,4vw,56px)] font-semibold leading-[1.08] tracking-[-0.035em]";
const bodyClassName = "font-sans text-base leading-7 md:text-lg md:leading-8";
const sectionClassName = "scroll-mt-20 px-6 py-14 md:px-8 md:py-20 xl:py-28";
const compactSectionClassName = "scroll-mt-20 px-6 py-12 md:px-8 md:py-16";
const textLinkClassName = `${styles.editorialLink} inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold transition-colors focus-visible:rounded-control`;

function BackLink({ dark = false }: { dark?: boolean }) {
  return (
    <Link href="/coaching#coaches" prefetch={false} className={`${textLinkClassName} ${dark ? "text-ivory hover:text-chalk" : "text-primary hover:text-accent"}`}>
      <span aria-hidden="true" className="mr-2">←</span><span className={`${styles.editorialLabel} underline underline-offset-8 ${dark ? "decoration-accent-on-dark" : "decoration-accent"}`}>All coaches</span>
    </Link>
  );
}

function Empty({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return <p className={`max-w-xl border-t pt-5 font-sans text-base leading-7 ${dark ? "border-ivory/30 text-ivory" : "border-border text-muted-foreground"}`}>{children}</p>;
}

function lessonsByCurrency(lessons: readonly PublicCoachLesson[]) {
  const currencies = new Map<string, { currency: string; lessons: PublicCoachLesson[] }>();
  for (const lesson of lessons) {
    const group = currencies.get(lesson.currency) ?? { currency: lesson.currency, lessons: [] };
    group.lessons.push(lesson);
    currencies.set(lesson.currency, group);
  }
  return [...currencies.values()];
}

// The hero's one-sentence lede, omitted when it is the whole biography shown under About.
function heroIntroduction(bio: string) {
  const introduction = coachIntroduction(bio);
  const sentence = introduction.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? introduction;
  return sentence === bio.trim().replace(/\s+/g, " ") ? "" : sentence;
}

// Private, Semi-private, Group, Junior; programs of one type keep their published order.
function programsInDisplayOrder<T extends { type: CoachingProgramType }>(programs: readonly T[]) {
  return [...programs].sort((a, b) => coachingProgramTypes.indexOf(a.type) - coachingProgramTypes.indexOf(b.type));
}

export default async function CoachPage({ params }: CoachPageProps) {
  const coach = await readCoach((await params).coachId);
  if (coach === "unavailable") {
    return (
      <main className="flex-1 bg-background px-6 py-14 md:px-8 md:py-20">
        <div className="mx-auto max-w-7xl">
          <BackLink />
          <p role="alert" className="mt-8 border-t border-border pt-5 font-sans text-base text-muted-foreground">
            Coaching information is temporarily unavailable. Please try again later.
          </p>
        </div>
      </main>
    );
  }
  if (!coach) notFound();

  const firstName = coach.displayName.split(/\s+/)[0] || coach.displayName;
  const introduction = heroIntroduction(coach.bio);
  const programs = programsInDisplayOrder(coach.programs);
  const programTypes = new Map(coach.programs.map((program) => [program.id, program]));
  const priceGroups = lessonsByCurrency(coach.lessons);

  return (
    <main className="flex-1">
      <section aria-labelledby="coach-title" className="bg-forest-900 text-chalk">
        <div className="mx-auto max-w-7xl px-6 pb-12 pt-6 md:px-8 md:pb-16 md:pt-8 lg:pb-20">
          <BackLink dark />
          <div className={`${styles.heroEntrance} mt-8 grid gap-6 md:mt-12 md:grid-cols-[auto_minmax(0,1fr)] md:items-end md:gap-10`}>
            {/* Profile photographs are private account data; coaches are shown with their initials. */}
            <span aria-hidden="true" className="flex size-24 items-center justify-center rounded-full bg-chalk font-heading text-3xl font-semibold tracking-[-0.02em] text-primary md:size-36 md:text-5xl">
              {initials(coach.displayName)}
            </span>
            <div className="min-w-0 max-w-3xl">
              <p className={`${eyebrowClassName} flex items-center gap-3 text-chalk`}>
                <span aria-hidden="true" className="h-0.5 w-8 bg-accent-on-dark" />Coach
              </p>
              <h1 id="coach-title" className="mt-4 break-words font-heading text-[clamp(40px,5.6vw,76px)] font-semibold leading-[1] tracking-[-0.045em]">
                {coach.displayName}
              </h1>
              {coach.specialties.length > 0 && (
                <p className="mt-4 font-sans text-sm font-semibold uppercase tracking-[0.12em] text-accent-on-dark">
                  <span className="sr-only">Specialties: </span>{coach.specialties.slice(0, 3).join(" · ")}
                </p>
              )}
              {introduction && <p className="mt-5 max-w-[56ch] text-pretty font-sans text-base leading-7 text-ivory md:text-lg md:leading-8">{introduction}</p>}
              <HeroCallToAction coach={coach} />
            </div>
          </div>
        </div>
      </section>
      <PageSectionNav sections={sections} />

      <section id="about" aria-labelledby="coach-about-title" className={`${sectionClassName} bg-background`}>
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16 xl:gap-24">
          <div className={styles.reveal}>
            <p className={`${eyebrowClassName} text-accent`}>About the coach</p>
            <h2 id="coach-about-title" className={`${headingClassName} mt-4 max-w-[13ch] text-foreground`}>Meet {firstName}.</h2>
          </div>
          <div>
            {coach.bio
              ? <p className={`${bodyClassName} whitespace-pre-line text-muted-foreground`}>{coach.bio}</p>
              : <Empty>{coach.displayName} has not added a biography yet.</Empty>}
            <dl className="mt-8 font-sans text-sm leading-6 md:text-base md:leading-7">
              {coach.qualifications && <div className="border-t border-border py-4">
                <dt className="font-semibold text-foreground">Qualifications</dt>
                <dd className="mt-1 whitespace-pre-line text-muted-foreground">{coach.qualifications}</dd>
              </div>}
              {coach.languages.length > 0 && <div className="border-t border-border py-4">
                <dt className="font-semibold text-foreground">Languages</dt>
                <dd className="mt-1 text-muted-foreground">{coach.languages.join(", ")}</dd>
              </div>}
              {coach.specialties.length > 0 && <div className="border-t border-border py-4">
                <dt className="font-semibold text-foreground">Coaching specialties</dt>
                <dd className="mt-2">
                  <ul aria-label={`${coach.displayName}’s specialties`} className="flex flex-wrap gap-2">
                    {coach.specialties.map((specialty) => <li key={specialty} className="rounded-full bg-surface-muted px-3 py-1 text-xs font-semibold text-foreground">{specialty}</li>)}
                  </ul>
                </dd>
              </div>}
            </dl>
          </div>
        </div>
      </section>

      <section id="programs" aria-labelledby="coach-programs-title" className={`${sectionClassName} bg-chalk`}>
        <div className="mx-auto max-w-7xl">
          <div className={`${styles.reveal} grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-end lg:gap-16`}>
            <div>
              <p className={`${eyebrowClassName} text-accent`}>Coaching programs</p>
              <h2 id="coach-programs-title" className={`${headingClassName} mt-4 max-w-[13ch] text-foreground`}>What {firstName} teaches.</h2>
            </div>
            <p className={`${bodyClassName} max-w-xl text-muted-foreground`}>
              The club programs {firstName} currently offers, with lesson lengths, group sizes and whether the court is included.
            </p>
          </div>
          <div className="mt-10 md:mt-14">
            {programs.length ? (
              <ul aria-label={`Programs taught by ${coach.displayName}`} className="grid gap-x-8 md:grid-cols-2">
                {programs.map((program, index) => {
                  const participants = formatParticipants(program.minParticipants, program.maxParticipants);
                  // An odd last program spans both columns, with its details beside the description.
                  const wide = index === programs.length - 1 && index % 2 === 0;
                  return (
                    <li key={program.id} className={`border-t-2 border-accent py-7 ${wide ? "md:col-span-2 md:grid md:grid-cols-2 md:items-start md:gap-x-8" : ""}`}>
                      <div>
                        <p className={`${eyebrowClassName} text-accent`}>{coachingProgramTypeLabels[program.type]}</p>
                        <h3 className="mt-3 font-heading text-2xl font-semibold tracking-[-0.025em] text-primary md:text-3xl">{program.name}</h3>
                        {program.description && <p className="mt-3 max-w-xl whitespace-pre-line font-sans text-base leading-7 text-muted-foreground">{program.description}</p>}
                      </div>
                      <div className={wide ? "md:pt-8" : ""}>
                        <dl className={`mt-5 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 font-sans text-sm leading-6 ${wide ? "md:mt-0" : ""}`}>
                          <dt className="text-muted-foreground">Lesson length</dt>
                          <dd className="font-medium text-foreground">{program.durations.map(formatCoachingDuration).join(" · ")}</dd>
                          {participants && <><dt className="text-muted-foreground">Group size</dt><dd className="font-medium text-foreground">{participants}</dd></>}
                          <dt className="text-muted-foreground">Court</dt>
                          <dd className="font-medium text-foreground">{rentalLabel(program.courtRentalIncluded)}</dd>
                        </dl>
                        {/* Group/Junior sessions are organized by the coach or club, never booked online. */}
                        {!isOnlineCoachingProgramType(program.type) && (
                          <p className="mt-4 max-w-xl font-sans text-sm leading-6 text-muted-foreground">
                            Arranged through {firstName} or the club, not booked online.{" "}
                            <Link href="/contact" prefetch={false} aria-label={`Contact the club about ${program.name}`} className="font-semibold text-primary underline decoration-accent underline-offset-4 hover:text-accent">Contact the club</Link>
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : <Empty>No coaching programs are currently listed for {coach.displayName}.</Empty>}
          </div>
        </div>
      </section>

      <section id="locations" aria-labelledby="coach-locations-title" className={`${compactSectionClassName} bg-background`}>
        <div className="mx-auto grid max-w-7xl gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-end lg:gap-16 xl:gap-24">
          <div className={styles.reveal}>
            <p className={`${eyebrowClassName} text-accent`}>Locations</p>
            <h2 id="coach-locations-title" className={`${headingClassName} mt-4 max-w-[13ch] text-foreground`}>Where {firstName} coaches.</h2>
          </div>
          {coach.locations.length ? (
            <ul aria-label={`Locations where ${coach.displayName} coaches`}>
              {coach.locations.map((location) => (
                <li key={location.id} className="grid gap-x-6 gap-y-2 border-t border-border py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <h3 className="font-heading text-2xl font-semibold tracking-[-0.025em] text-primary">{location.name}</h3>
                  <div className="flex flex-wrap gap-x-6">
                    <Link href={`/courts#location-${location.id}`} prefetch={false} aria-label={`Courts at ${location.name}`} className={`${textLinkClassName} text-primary hover:text-accent`}>
                      <span className={`${styles.editorialLabel} underline decoration-accent underline-offset-8`}>Courts</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
                    </Link>
                    <Link href={`/contact?${new URLSearchParams({ location: location.id })}`} prefetch={false} aria-label={`Opening hours and directions for ${location.name}`} className={`${textLinkClassName} text-primary hover:text-accent`}>
                      <span className={`${styles.editorialLabel} underline decoration-accent underline-offset-8`}>Hours &amp; directions</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          ) : <Empty>{coach.displayName} is not currently teaching at a public club location.</Empty>}
        </div>
      </section>

      <section id="prices" aria-labelledby="coach-prices-title" className={`${sectionClassName} bg-forest-900 text-chalk`}>
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16 xl:gap-24">
          <div className={styles.reveal}>
            <p className={`${eyebrowClassName} text-accent-on-dark`}>Lesson prices</p>
            <h2 id="coach-prices-title" className={`${headingClassName} mt-4 max-w-[12ch]`}>Lessons with {firstName}.</h2>
            <p className={`${bodyClassName} mt-6 max-w-xl text-ivory`}>
              Prices are lesson prices per person, for each lesson length and number of players, and charged in the location’s currency. Where {firstName} has an individual price, it replaces the club price.
            </p>
            <BookingCallToAction coach={coach} firstName={firstName} />
          </div>
          {priceGroups.length ? (
            <div className="space-y-12">
              {priceGroups.map((group) => (
                <section key={group.currency} aria-label={`Lesson prices in ${group.currency}`}>
                  {priceGroups.length > 1 && <h3 className="font-heading text-2xl font-semibold tracking-[-0.025em] text-chalk">Prices in {group.currency}</h3>}
                  <ul className="mt-4">
                    {group.lessons.map((lesson) => (
                      <li key={`${lesson.programId}-${lesson.durationMinutes}-${lesson.participantCount}`} className="grid gap-x-6 gap-y-1 border-t border-ivory/25 py-4 font-sans sm:grid-cols-[minmax(0,1fr)_auto]">
                        <div>
                          <p className="text-base font-semibold text-chalk">{lesson.programName} · {formatCoachingDuration(lesson.durationMinutes)} · {formatPlayers(lesson.participantCount)}</p>
                          <p className="text-sm text-ivory">{rentalLabel(programTypes.get(lesson.programId)?.courtRentalIncluded ?? false)}</p>
                        </div>
                        {lesson.price ? (
                          <p className="text-lg font-semibold tabular-nums text-chalk sm:text-right">
                            {formatMoney(lesson.price.amountMinor, lesson.price.currency)}
                            <span className="block text-xs font-normal text-ivory">Lesson price/person · {lesson.price.source === "coach" ? `${firstName}’s price` : "Club price"}</span>
                          </p>
                        ) : <p className="text-sm text-ivory sm:text-right">Price not published</p>}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : <Empty dark>Lesson prices have not been published for {coach.displayName} yet.</Empty>}
        </div>
      </section>
    </main>
  );
}
