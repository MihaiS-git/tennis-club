import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import { readPublicCoach, type PublicCoachLesson, type PublicCoachProfile } from "@/lib/coaching/public";
import { coachingProgramTypeLabels, formatCoachingDuration, formatParticipants } from "@/lib/coaching/validation";
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

// Deduplicates the public read between metadata and the page within one request.
const readCoach = cache(async (coachId: string): Promise<PublicCoachProfile | null | "unavailable"> => {
  await connection();
  try {
    return await readPublicCoach(coachId, await listPublicLocationsWithCourts());
  } catch {
    return "unavailable";
  }
});

export async function generateMetadata({ params }: CoachPageProps): Promise<Metadata> {
  const coach = await readCoach((await params).coachId);
  if (coach === "unavailable") return { title: "Coaching | Tennis Club" };
  if (!coach) return { title: "Coach not found | Tennis Club" };
  return {
    title: `${coach.displayName} | Coaching | Tennis Club`,
    description: coachIntroduction(coach.bio) || `${coach.displayName} coaches at the Tennis Club.`,
  };
}

const eyebrowClassName = "font-sans text-xs font-semibold uppercase tracking-[0.16em]";
const headingClassName = "font-heading text-[clamp(34px,4vw,56px)] font-semibold leading-[1.08] tracking-[-0.035em]";
const bodyClassName = "font-sans text-base leading-7 md:text-lg md:leading-8";
const sectionClassName = "scroll-mt-20 px-6 py-14 md:px-8 md:py-20 xl:py-28";
const textLinkClassName = `${styles.editorialLink} inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold transition-colors focus-visible:rounded-control`;

function BackLink({ dark = false }: { dark?: boolean }) {
  return (
    <Link href="/coaching#coaches" className={`${textLinkClassName} ${dark ? "text-ivory hover:text-chalk" : "text-primary hover:text-accent"}`}>
      <span aria-hidden="true" className="mr-2">←</span><span className={`${styles.editorialLabel} underline underline-offset-8 ${dark ? "decoration-accent-on-dark" : "decoration-accent"}`}>All coaches</span>
    </Link>
  );
}

function Empty({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return <p className={`max-w-xl border-t pt-5 font-sans text-base leading-7 ${dark ? "border-ivory/30 text-ivory" : "border-border text-muted-foreground"}`}>{children}</p>;
}

function lessonsByLocation(lessons: readonly PublicCoachLesson[]) {
  const locations = new Map<string, { id: string; name: string; lessons: PublicCoachLesson[] }>();
  for (const lesson of lessons) {
    const location = locations.get(lesson.locationId) ?? { id: lesson.locationId, name: lesson.locationName, lessons: [] };
    location.lessons.push(lesson);
    locations.set(lesson.locationId, location);
  }
  return [...locations.values()];
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
  const introduction = coachIntroduction(coach.bio);
  const programTypes = new Map(coach.programs.map((program) => [program.id, program]));
  const priceLocations = lessonsByLocation(coach.lessons);

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
            {coach.programs.length ? (
              <ul aria-label={`Programs taught by ${coach.displayName}`} className="grid gap-x-8 md:grid-cols-2">
                {coach.programs.map((program) => {
                  const participants = formatParticipants(program.minParticipants, program.maxParticipants);
                  return (
                    <li key={program.id} className="border-t-2 border-accent py-7">
                      <p className={`${eyebrowClassName} text-accent`}>{coachingProgramTypeLabels[program.type]}</p>
                      <h3 className="mt-3 font-heading text-2xl font-semibold tracking-[-0.025em] text-primary md:text-3xl">{program.name}</h3>
                      {program.description && <p className="mt-3 max-w-xl whitespace-pre-line font-sans text-base leading-7 text-muted-foreground">{program.description}</p>}
                      <dl className="mt-5 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 font-sans text-sm leading-6">
                        <dt className="text-muted-foreground">Lesson length</dt>
                        <dd className="font-medium text-foreground">{program.durations.map(formatCoachingDuration).join(" · ")}</dd>
                        {participants && <><dt className="text-muted-foreground">Group size</dt><dd className="font-medium text-foreground">{participants}</dd></>}
                        <dt className="text-muted-foreground">Court</dt>
                        <dd className="font-medium text-foreground">{rentalLabel(program.courtRentalIncluded)}</dd>
                      </dl>
                    </li>
                  );
                })}
              </ul>
            ) : <Empty>No coaching programs are currently listed for {coach.displayName}.</Empty>}
          </div>
        </div>
      </section>

      <section id="locations" aria-labelledby="coach-locations-title" className={`${sectionClassName} bg-background`}>
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16 xl:gap-24">
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
                    <Link href={`/courts#location-${location.id}`} aria-label={`Courts at ${location.name}`} className={`${textLinkClassName} text-primary hover:text-accent`}>
                      <span className={`${styles.editorialLabel} underline decoration-accent underline-offset-8`}>Courts</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
                    </Link>
                    <Link href="/club#visit" aria-label={`Opening hours and directions for ${location.name}`} className={`${textLinkClassName} text-primary hover:text-accent`}>
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
              Prices are per lesson and set by the club for each location, in that location’s currency. Where {firstName} has an individual price, it replaces the club price.
            </p>
            <p className="mt-4 max-w-xl font-sans text-sm leading-6 text-ivory">
              <Link href={`/book?mode=coaching&coach=${coach.id}`} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">Book a lesson with {firstName}</Link>
            </p>
          </div>
          {priceLocations.length ? (
            <div className="space-y-12">
              {priceLocations.map((location) => (
                <section key={location.id} aria-label={`Lesson prices at ${location.name}`}>
                  <h3 className="font-heading text-2xl font-semibold tracking-[-0.025em] text-chalk">{location.name}</h3>
                  <ul className="mt-4">
                    {location.lessons.map((lesson) => (
                      <li key={`${lesson.programId}-${lesson.durationMinutes}`} className="grid gap-x-6 gap-y-1 border-t border-ivory/25 py-4 font-sans sm:grid-cols-[minmax(0,1fr)_auto]">
                        <div>
                          <p className="text-base font-semibold text-chalk">{lesson.programName} · {formatCoachingDuration(lesson.durationMinutes)}</p>
                          <p className="text-sm text-ivory">{rentalLabel(programTypes.get(lesson.programId)?.courtRentalIncluded ?? false)}</p>
                        </div>
                        {lesson.price ? (
                          <p className="text-lg font-semibold tabular-nums text-chalk sm:text-right">
                            {formatMoney(lesson.price.amountMinor, lesson.price.currency)}
                            <span className="block text-xs font-normal text-ivory">{lesson.price.source === "coach" ? `${firstName}’s price` : "Club price"}</span>
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
