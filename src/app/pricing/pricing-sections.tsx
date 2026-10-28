import Link from "next/link";

import type { PublicCoaching } from "@/lib/coaching/public";
import { coachingProgramTypeLabels, coachingProgramTypes, formatCoachingDuration, formatParticipants, isOnlineCoachingProgramType } from "@/lib/coaching/validation";
import type { PublicLocationToday } from "@/lib/courts/public-calendar";
import { countLabel } from "@/lib/courts/summary";
import { formatMoney } from "@/lib/pricing/money";
import { rentalLabel, startingPrices } from "../coaching/coaching-sections";
import styles from "../page.module.css";

const eyebrowClassName = "font-sans text-xs font-semibold uppercase tracking-[0.16em]";

async function settle<T>(value: Promise<T>) {
  try {
    return await value;
  } catch {
    return null;
  }
}

function Message({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return <p className={`border-t pt-5 font-sans text-base leading-7 ${dark ? "border-ivory/30 text-ivory" : "border-border text-muted-foreground"}`}>{children}</p>;
}

// Today's lowest configured hourly rate per location, in its own currency. The rate may
// apply to a single half-hour slot, so it is never presented as a booking total.
export async function CourtRates({ locations }: { locations: Promise<PublicLocationToday[]> }) {
  const publicLocations = await settle(locations);
  if (!publicLocations) return <Message>Pricing temporarily unavailable.</Message>;
  if (!publicLocations.length) return <Message>No club locations are currently open to the public.</Message>;
  return (
    <ul aria-label="Court hire by location" className="border-b border-border">
      {publicLocations.map((location) => (
        <li key={location.id} className="grid gap-x-6 gap-y-3 border-t border-border py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="min-w-0">
            <h3 className="font-heading text-2xl font-semibold tracking-[-0.025em] text-primary">{location.name}</h3>
            <p className="mt-1 font-sans text-sm leading-6 text-muted-foreground">
              {countLabel(location.courts.length, "court")} · Prices in {location.currency} · {location.allow_pay_at_club ? "Pay online or at the club" : "Pay online"}
            </p>
          </div>
          <div className="sm:text-right">
            {location.startingRateMinor === null ? (
              <p className="font-sans text-sm leading-6 text-muted-foreground">No court rate available for today.</p>
            ) : (
              <>
                <p className="font-sans text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Lowest hourly rate today</p>
                <p className="mt-1 font-heading text-2xl font-semibold tabular-nums tracking-[-0.02em] text-foreground">
                  From {formatMoney(location.startingRateMinor, location.currency)}<span className="font-sans text-base font-medium text-muted-foreground"> per hour</span>
                </p>
              </>
            )}
          </div>
          <Link href={`/book?${new URLSearchParams({ location: location.id })}`}
            className={`${styles.editorialLink} inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-primary transition-colors hover:text-accent focus-visible:rounded-control sm:col-span-2`}>
            <span className={`${styles.editorialLabel} underline decoration-accent underline-offset-8`}>Exact prices at {location.name}</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

// Online-bookable types first (Private, Semi-private), then Group and Junior; stable within a type.
const programTypeOrder = (type: PublicCoaching["programs"][number]["type"]) => coachingProgramTypes.indexOf(type);

// The lowest published lesson price/person of each program, per currency. A starting price
// is not tied to a duration, group size or coach, and is never combined with court rates.
export async function CoachingRates({ coaching }: { coaching: Promise<PublicCoaching> }) {
  const data = await settle(coaching);
  if (!data) return <Message dark>Pricing temporarily unavailable.</Message>;
  if (!data.programs.length) return <Message dark>No coaching programs are published yet.</Message>;
  const coachesWithOwnPrices = data.coaches.filter((coach) => coach.rates.length > 0);
  return (
    <>
      <ul aria-label="Coaching starting prices" className="border-b border-ivory/30">
        {data.programs.toSorted((a, b) => programTypeOrder(a.type) - programTypeOrder(b.type)).map((program) => {
          const participants = formatParticipants(program.minParticipants, program.maxParticipants);
          const from = startingPrices(program);
          return (
            <li key={program.id} className="grid gap-x-6 gap-y-3 border-t border-ivory/30 py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
              <div className="min-w-0">
                <p className={`${eyebrowClassName} text-accent-on-dark`}>{coachingProgramTypeLabels[program.type]}</p>
                <h3 className="mt-2 font-heading text-2xl font-semibold tracking-[-0.025em] text-chalk">{program.name}</h3>
                <p className="mt-1 font-sans text-sm leading-6 text-ivory">
                  {[program.durations.map(formatCoachingDuration).join(" · "), participants, program.courtRentalIncluded && rentalLabel(true)].filter(Boolean).join(" · ")}
                </p>
                {!program.courtRentalIncluded && (
                  <p className="mt-3 border-l-2 border-accent-on-dark pl-3 font-sans text-sm leading-6 text-ivory">
                    <span className="font-semibold text-chalk">{rentalLabel(false)}</span> · Court hire is charged separately at the court’s rate.
                  </p>
                )}
                <p className="mt-1 font-sans text-sm leading-6 text-ivory">
                  {isOnlineCoachingProgramType(program.type) ? "Booked and paid online" : "Arranged with the coach or club · Paid at the club"}
                </p>
              </div>
              <div className="sm:text-right">
                {from.length ? (
                  <>
                    <p className="font-sans text-xs font-semibold uppercase tracking-[0.12em] text-ivory">Per person per lesson</p>
                    <ul aria-label={`${program.name} starting prices`} className="mt-1 font-heading text-2xl font-semibold tabular-nums tracking-[-0.02em] text-chalk">
                      {from.map((price) => <li key={price}>From {price}</li>)}
                    </ul>
                    {!program.courtRentalIncluded && <p className="mt-1 font-sans text-sm font-semibold text-accent-on-dark">Plus court hire</p>}
                  </>
                ) : (
                  <p className="font-sans text-sm leading-6 text-ivory">Prices not published.</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {coachesWithOwnPrices.length > 0 && (
        <p className="mt-6 font-sans text-sm leading-6 text-ivory">
          <span className="font-semibold text-chalk">Coaches with their own prices:</span>{" "}
          {coachesWithOwnPrices.map((coach, index) => (
            <span key={coach.id}>
              {index > 0 && " · "}
              <Link href={`/coaching/coaches/${coach.id}`} prefetch={false} className="font-semibold text-chalk underline decoration-accent-on-dark underline-offset-4 hover:text-chalk focus-visible:rounded-control">{coach.displayName}</Link>
            </span>
          ))}
        </p>
      )}
    </>
  );
}
