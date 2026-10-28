import Link from "next/link";

import type { PublicCoach, PublicCoaching, PublicCoachingProgram } from "@/lib/coaching/public";
import { coachingProgramTypeLabels, formatCoachingDuration, formatParticipants, isOnlineCoachingProgramType } from "@/lib/coaching/validation";
import { formatMoney } from "@/lib/pricing/money";
import styles from "../page.module.css";

// The first paragraph of the biography, shortened to its first sentence when long.
export function coachIntroduction(bio: string) {
  const paragraph = bio.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ") ?? "";
  if (paragraph.length <= 240) return paragraph;
  return paragraph.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? paragraph;
}

function coachProfileHref(coachId: string) {
  return `/coaching/coaches/${coachId}`;
}

const eyebrowClassName = "font-sans text-xs font-semibold uppercase tracking-[0.16em]";

async function settle(coaching: Promise<PublicCoaching>) {
  try {
    return await coaching;
  } catch {
    return null;
  }
}

function Unavailable({ dark = false }: { dark?: boolean }) {
  return <p role="alert" className={`border-t pt-5 font-sans text-base ${dark ? "border-ivory/30 text-ivory" : "border-border text-muted-foreground"}`}>
    Coaching information is temporarily unavailable. Please try again later.
  </p>;
}

function Empty({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return <p className={`max-w-xl border-t pt-5 font-sans text-base leading-7 ${dark ? "border-ivory/30 text-ivory" : "border-border text-muted-foreground"}`}>{children}</p>;
}

// The program's lowest applicable price per currency, resolved by the public projection
// (fromPrices); locations may charge in different currencies, which are never compared.
export function startingPrices(program: Pick<PublicCoachingProgram, "fromPrices">) {
  return program.fromPrices.map((price) => formatMoney(price.amountMinor, price.currency));
}

// "From …": the lowest configured lesson price/person per currency.
export function startingPriceLabel(program: Pick<PublicCoachingProgram, "fromPrices">) {
  const from = startingPrices(program);
  if (!from.length) return null;
  return `From ${from.join(" · ")} per person per lesson`;
}

export function rentalLabel(included: boolean) {
  return included ? "Court rental included" : "Court rental not included";
}

export async function CoachingPrograms({ coaching }: { coaching: Promise<PublicCoaching> }) {
  const data = await settle(coaching);
  if (!data) return <Unavailable />;
  if (!data.programs.length) return <Empty>No coaching programs are published yet. They will appear here as soon as the club adds them.</Empty>;
  return <ul aria-label="Coaching programs" className="grid gap-x-8 md:grid-cols-2">
    {data.programs.map((program) => {
      const participants = formatParticipants(program.minParticipants, program.maxParticipants);
      const from = startingPriceLabel(program);
      return <li key={program.id} className="flex flex-col border-t-2 border-accent py-7">
        <p className={`${eyebrowClassName} text-accent`}>{coachingProgramTypeLabels[program.type]}</p>
        <h3 className="mt-3 font-heading text-2xl font-semibold tracking-[-0.025em] text-primary md:text-3xl">{program.name}</h3>
        {program.description && <p className="mt-3 max-w-xl whitespace-pre-line font-sans text-base leading-7 text-muted-foreground">{program.description}</p>}
        <dl className="mt-5 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 font-sans text-sm leading-6">
          <dt className="text-muted-foreground">Lesson length</dt>
          <dd className="font-medium text-foreground">{program.durations.map(formatCoachingDuration).join(" · ")}</dd>
          {participants && <><dt className="text-muted-foreground">Group size</dt><dd className="font-medium text-foreground">{participants}</dd></>}
          <dt className="text-muted-foreground">Court</dt>
          <dd className="font-medium text-foreground">{rentalLabel(program.courtRentalIncluded)}</dd>
          <dt className="text-muted-foreground">Price</dt>
          <dd className="font-medium text-foreground">{from ?? "Prices not published."}</dd>
          {!isOnlineCoachingProgramType(program.type) && <><dt className="text-muted-foreground">Booking</dt>
            <dd className="font-medium text-foreground">Arranged with the coach or club · Paid at the club</dd></>}
        </dl>
      </li>;
    })}
  </ul>;
}

export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function CoachCard({ coach }: { coach: PublicCoach }) {
  return <li className="flex flex-col rounded-card border border-border bg-surface p-6 md:p-7">
    <div className="flex items-center gap-4">
      {/* Profile photographs are private account data; coaches are shown with their initials. */}
      <span aria-hidden="true" className="flex size-16 shrink-0 items-center justify-center rounded-full bg-forest-900 font-heading text-xl font-semibold tracking-[-0.02em] text-chalk">
        {initials(coach.displayName)}
      </span>
      <div className="min-w-0">
        <h3 className="break-words font-heading text-2xl font-semibold tracking-[-0.025em] text-primary">
          <Link href={coachProfileHref(coach.id)} className="underline-offset-4 transition-colors hover:text-accent hover:underline focus-visible:rounded-control">{coach.displayName}</Link>
        </h3>
        {coach.locations.length > 0 && <p className="mt-1 font-sans text-sm text-muted-foreground">{coach.locations.map((location) => location.name).join(" · ")}</p>}
      </div>
    </div>
    {coach.specialties.length > 0 && <ul aria-label={`${coach.displayName}’s specialties`} className="mt-5 flex flex-wrap gap-2">
      {coach.specialties.map((specialty) => <li key={specialty} className="rounded-full bg-surface-muted px-3 py-1 font-sans text-xs font-semibold text-foreground">{specialty}</li>)}
    </ul>}
    {coach.bio && <p className="mt-5 whitespace-pre-line font-sans text-base leading-7 text-muted-foreground">{coach.bio}</p>}
    <dl className="mt-5 space-y-3 border-t border-border pt-5 font-sans text-sm leading-6">
      {coach.qualifications && <div><dt className="font-semibold text-foreground">Qualifications</dt><dd className="whitespace-pre-line text-muted-foreground">{coach.qualifications}</dd></div>}
      {coach.languages.length > 0 && <div><dt className="font-semibold text-foreground">Languages</dt><dd className="text-muted-foreground">{coach.languages.join(", ")}</dd></div>}
      {coach.programs.length > 0 && <div><dt className="font-semibold text-foreground">Programs</dt><dd className="text-muted-foreground">{coach.programs.map((program) => program.name).join(", ")}</dd></div>}
    </dl>
    <Link href={coachProfileHref(coach.id)} aria-label={`View ${coach.displayName}’s profile`}
      className={`${styles.editorialLink} mt-auto inline-flex min-h-11 w-fit items-center pt-4 font-sans text-sm font-semibold text-primary transition-colors hover:text-accent focus-visible:rounded-control`}>
      <span className={`${styles.editorialLabel} underline decoration-accent underline-offset-8`}>View profile</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
    </Link>
  </li>;
}

export async function CoachingCoaches({ coaching }: { coaching: Promise<PublicCoaching> }) {
  const data = await settle(coaching);
  if (!data) return <Unavailable />;
  if (!data.coaches.length) return <Empty>Coach profiles have not been published yet. Check back soon to meet the coaches.</Empty>;
  return <ul aria-label="Coaches" className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
    {data.coaches.map((coach) => <CoachCard key={coach.id} coach={coach} />)}
  </ul>;
}
