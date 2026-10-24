import Link from "next/link";

import type { PublicCoach, PublicCoaching, PublicCoachingProgram } from "@/lib/coaching/public";
import { coachingProgramTypeLabels, formatCoachingDuration, formatParticipants, hasParticipantRates } from "@/lib/coaching/validation";
import { formatMoney, type LocationCurrency } from "@/lib/pricing/money";
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

// Lowest club price per currency; locations may charge in different currencies. Group/Junior
// programs use their club rates per person per 60 minutes.
export function startingPrices(program: Pick<PublicCoachingProgram, "prices" | "participantPrices">) {
  const lowest = new Map<LocationCurrency, number>();
  for (const price of [...program.prices, ...program.participantPrices]) {
    const current = lowest.get(price.currency);
    if (current === undefined || price.amountMinor < current) lowest.set(price.currency, price.amountMinor);
  }
  return [...lowest].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => formatMoney(amount, currency));
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
      const from = startingPrices(program);
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
          <dd className="font-medium text-foreground">{from.length ? `From ${from.join(" · ")}${hasParticipantRates(program.type) ? " per person / 60 min" : ""}` : "Not yet published"}</dd>
          {hasParticipantRates(program.type) && <><dt className="text-muted-foreground">Booking</dt>
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
      {coach.rates.length > 0 && <div>
        <dt className="font-semibold text-foreground">Individual prices</dt>
        <dd>
          <ul className="text-muted-foreground">
            {coach.rates.map((rate) => <li key={`${rate.programId}-${rate.currency}-${rate.durationMinutes}`}>
              {rate.programName}, {formatCoachingDuration(rate.durationMinutes)}:{" "}
              <span className="font-semibold text-foreground">{formatMoney(rate.amountMinor, rate.currency)}</span>
              {" "}<span className="text-xs">({rentalLabel(rate.courtRentalIncluded).toLowerCase()})</span>
            </li>)}
          </ul>
        </dd>
      </div>}
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

type CurrencyPrices = { currency: LocationCurrency; rows: { program: PublicCoachingProgram; durationMinutes: number; amount: string | null;
  coaches: { name: string; amount: string }[] }[] };

// Club-wide prices per currency, with any individual coach prices for the same lesson.
// A lesson priced only for individual coaches is listed without a club price.
export function pricesByCurrency(data: PublicCoaching): CurrencyPrices[] {
  const currencies = new Map<LocationCurrency, CurrencyPrices>();
  const row = (program: PublicCoachingProgram, currency: LocationCurrency, durationMinutes: number) => {
    const group = currencies.get(currency) ?? { currency, rows: [] };
    currencies.set(currency, group);
    let entry = group.rows.find((item) => item.program.id === program.id && item.durationMinutes === durationMinutes);
    if (!entry) group.rows.push(entry = { program, durationMinutes, amount: null, coaches: [] });
    return entry;
  };
  for (const program of data.programs) {
    for (const price of program.prices) {
      row(program, price.currency, price.durationMinutes).amount = formatMoney(price.amountMinor, price.currency);
    }
  }
  const programs = new Map(data.programs.map((program) => [program.id, program]));
  for (const coach of data.coaches) {
    for (const rate of coach.rates) {
      const program = programs.get(rate.programId);
      if (program) row(program, rate.currency, rate.durationMinutes).coaches
        .push({ name: coach.displayName, amount: formatMoney(rate.amountMinor, rate.currency) });
    }
  }
  const order = new Map(data.programs.map((program, index) => [program.id, index]));
  for (const group of currencies.values()) {
    group.rows.sort((a, b) => (order.get(a.program.id) ?? 0) - (order.get(b.program.id) ?? 0) || a.durationMinutes - b.durationMinutes);
  }
  return [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export async function CoachingPrices({ coaching }: { coaching: Promise<PublicCoaching> }) {
  const data = await settle(coaching);
  if (!data) return <Unavailable dark />;
  const groups = pricesByCurrency(data);
  if (!groups.length) return <Empty dark>Coaching prices have not been published yet.</Empty>;
  return <div className="space-y-12">
    {groups.map((group) => <section key={group.currency} aria-label={`Coaching prices in ${group.currency}`}>
      <h3 className="font-heading text-2xl font-semibold tracking-[-0.025em] text-chalk">Prices in {group.currency}</h3>
      <ul className="mt-4">
        {group.rows.map((row) => <li key={`${row.program.id}-${row.durationMinutes}`}
          className="grid gap-x-6 gap-y-1 border-t border-ivory/25 py-4 font-sans sm:grid-cols-[minmax(0,1fr)_auto]">
          <div>
            <p className="text-base font-semibold text-chalk">{row.program.name} · {formatCoachingDuration(row.durationMinutes)}</p>
            <p className="text-sm text-ivory">{rentalLabel(row.program.courtRentalIncluded)}</p>
            {row.coaches.length > 0 && <ul aria-label="Individual coach prices" className="mt-2 space-y-0.5 text-sm text-ivory">
              {row.coaches.map((coach, index) => <li key={`${coach.name}-${index}`}>{coach.name}: <span className="font-semibold text-chalk">{coach.amount}</span></li>)}
            </ul>}
          </div>
          {row.amount ? <p className="text-lg font-semibold tabular-nums text-chalk sm:text-right">{row.amount}
            <span className="block text-xs font-normal text-ivory">Club price</span></p>
            : <p className="text-sm text-ivory sm:text-right">No club price</p>}
        </li>)}
      </ul>
    </section>)}
  </div>;
}

// Group and Junior club rates per person per 60 minutes, one table per program and currency.
// Only persisted club rates inside the program's current player range are listed; there are
// no coach rates for these programs and missing player counts are not filled in.
export async function CoachingGroupPrices({ coaching }: { coaching: Promise<PublicCoaching> }) {
  const data = await settle(coaching);
  if (!data) return <Unavailable />;
  const programs = data.programs.filter((program) => hasParticipantRates(program.type));
  if (!programs.length) return <Empty>No group or junior programs are published at the moment.</Empty>;
  return <ul aria-label="Group and junior coaching prices" className="grid gap-x-8 md:grid-cols-2">
    {programs.map((program) => {
      const participants = formatParticipants(program.minParticipants, program.maxParticipants);
      const currencies = [...new Set(program.participantPrices.map((price) => price.currency))].sort();
      return <li key={program.id} className="flex flex-col border-t-2 border-accent py-7">
        <p className={`${eyebrowClassName} text-accent`}>{coachingProgramTypeLabels[program.type]} coaching</p>
        <h3 className="mt-3 font-heading text-2xl font-semibold tracking-[-0.025em] text-primary md:text-3xl">{program.name}</h3>
        {program.description && <p className="mt-3 max-w-xl whitespace-pre-line font-sans text-base leading-7 text-muted-foreground">{program.description}</p>}
        <dl className="mt-5 grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 font-sans text-sm leading-6">
          {participants && <><dt className="text-muted-foreground">Group size</dt><dd className="font-medium text-foreground">{participants}</dd></>}
          {program.durations.length > 0 && <><dt className="text-muted-foreground">Session length</dt>
            <dd className="font-medium text-foreground">{program.durations.map(formatCoachingDuration).join(" · ")}</dd></>}
        </dl>
        {currencies.length ? currencies.map((currency) => <table key={currency} className="mt-5 w-full max-w-md font-sans text-sm"
          aria-label={`${program.name} club prices in ${currency}`}>
          <thead className="border-b border-border text-left text-xs font-semibold text-muted-foreground">
            <tr><th scope="col" className="py-2 pr-4">Number of players</th>
              <th scope="col" className="py-2 text-right">Club price per person / 60 min</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {program.participantPrices.filter((price) => price.currency === currency).map((price) => <tr key={price.participantCount}>
              <td className="py-2 pr-4 tabular-nums text-foreground">{price.participantCount}</td>
              <td className="py-2 text-right font-semibold tabular-nums text-foreground">{formatMoney(price.amountMinor, price.currency)}</td>
            </tr>)}
          </tbody>
        </table>) : <p className="mt-5 font-sans text-sm leading-6 text-muted-foreground">Prices for this program have not been published yet. Contact the club for details.</p>}
      </li>;
    })}
  </ul>;
}
