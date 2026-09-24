import Link from "next/link";

const courts = [
  {
    name: "Court 1",
    surface: "Clay",
    times: ["19:00", "19:30", "20:00", "20:30"],
  },
  {
    name: "Court 2",
    surface: "Clay",
    times: ["20:00", "20:30", "21:00"],
  },
  {
    name: "Court 3",
    surface: "Clay",
    times: ["21:30", "22:00"],
  },
  {
    name: "Court 4",
    surface: "Clay",
    times: [],
  },
];

const openMatches = [
  { format: "Singles", level: "Level 5", time: "19:00", playersNeeded: "1 player needed" },
  { format: "Doubles", level: "Level 4", time: "20:00", playersNeeded: "2 players needed" },
  { format: "Singles", level: "Level 5.5", time: "20:30", playersNeeded: "1 player needed" },
  { format: "Doubles", level: "Level 6", time: "21:00", playersNeeded: "1 player needed" },
];

const coachingSlots = [
  { name: "Ana Pop", time: "17:30" },
  { name: "Victor Ionescu", time: "19:00" },
  { name: "Ana Pop", time: "20:00" },
  { name: "Victor Ionescu", time: "21:00" },
];

export default function Home() {
  return (
    <main className="flex-1">
      <section
        aria-labelledby="hero-title"
        className="relative lg:h-[clamp(620px,47vw,760px)] lg:overflow-hidden"
      >
        <picture className="block h-[43svh] min-h-[290px] max-h-[390px] overflow-hidden md:absolute md:right-0 md:top-0 md:h-[clamp(500px,54vw,560px)] md:w-[55%] md:min-h-0 md:max-h-none lg:inset-0 lg:h-full lg:w-full">
          <source media="(min-width: 1024px)" type="image/avif" srcSet="/images/tennis-hero-desktop.avif" />
          <source media="(min-width: 1024px)" type="image/webp" srcSet="/images/tennis-hero-desktop.webp" />
          <source type="image/avif" srcSet="/images/tennis-hero-mobile.avif" />
          <source type="image/webp" srcSet="/images/tennis-hero-mobile.webp" />
          <img
            src="/images/tennis-hero-mobile.webp"
            alt="Tennis players rallying on a clay court at sunset"
            width="1122"
            height="1402"
            fetchPriority="high"
            decoding="async"
            className="h-full w-full object-cover object-[center_75%] md:object-[center_60%] lg:object-[60%_center]"
          />
        </picture>
        <div
          aria-hidden="true"
          className="hidden lg:absolute lg:inset-0 lg:block lg:bg-linear-to-r lg:from-forest-900/85 lg:from-0% lg:via-forest-900/50 lg:via-35% lg:to-transparent lg:to-65%"
        />

        <div className="relative mx-auto max-w-7xl lg:h-full">
          <div className="px-6 pb-7 pt-7 md:flex md:h-[clamp(500px,54vw,560px)] md:w-[45%] md:flex-col md:justify-start md:px-8 md:py-20 lg:h-auto lg:w-auto lg:max-w-[470px] lg:px-6 lg:pt-[clamp(88px,9vw,140px)] lg:text-chalk xl:px-8">
            <h1
              id="hero-title"
              className="max-w-[10ch] font-heading text-[42px] font-semibold leading-[1.02] tracking-[-0.045em] text-foreground md:text-[clamp(44px,5.8vw,60px)] lg:max-w-[9ch] lg:text-[clamp(52px,5vw,72px)] lg:leading-[0.99] lg:text-chalk"
            >
              Play more tennis.
            </h1>
            <p className="mt-4 max-w-[340px] font-sans text-base leading-6 text-muted-foreground md:mt-6 md:text-lg md:leading-7 lg:mt-5 lg:max-w-[420px] lg:text-ivory xl:mt-6">
              Book a court, find your next match, or train with a coach.
            </p>
            <div className="mt-6 flex flex-col gap-2.5 md:mt-8 md:flex-row md:items-center md:gap-2 lg:mt-6 lg:gap-3 xl:mt-8">
              <Link
                href="/book"
                className="inline-flex min-h-12 w-full items-center justify-center rounded-control bg-primary px-5 font-sans text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover md:w-auto lg:px-6"
              >
                Book a court
              </Link>
              <Link
                href="/matches"
                className="inline-flex min-h-12 w-full items-center justify-center rounded-control border border-border-strong bg-surface px-5 font-sans text-sm font-semibold text-primary transition hover:bg-surface-muted md:w-auto lg:border-ivory/80 lg:bg-forest-900/20 lg:px-6 lg:text-chalk lg:hover:bg-forest-900/40 lg:hover:text-chalk"
              >
                Find a match
              </Link>
            </div>
            <Link
              href="/coaching"
              className="mt-3 inline-flex min-h-11 w-fit items-center font-sans text-sm font-medium text-primary underline decoration-primary/60 underline-offset-4 hover:text-primary-hover md:mt-5 lg:mt-4 lg:min-h-10 lg:text-ivory lg:decoration-ivory/60 lg:hover:text-chalk xl:mt-5"
            >
              Book coaching →
            </Link>
          </div>

          <div className="mx-6 mb-8 rounded-card border border-border bg-surface px-5 py-4 md:mx-8 md:my-6 md:flex md:items-center md:justify-between md:gap-6 md:px-6 lg:absolute lg:bottom-8 lg:left-6 lg:mx-0 lg:my-0 lg:w-[750px] lg:justify-start lg:gap-4 lg:bg-surface/95 lg:px-5 lg:py-5 lg:text-foreground lg:shadow-card xl:left-8 xl:w-[780px] xl:gap-6 xl:px-6">
            <h2 className="font-heading text-lg font-semibold text-primary lg:shrink-0 lg:leading-tight">
              Play today
            </h2>
            <dl className="mt-2 font-sans text-sm text-foreground md:mt-0 md:border-l md:border-border md:pl-6 lg:flex lg:flex-1 lg:items-center lg:justify-between lg:gap-5">
              <div className="inline lg:block">
                <dt className="sr-only lg:not-sr-only lg:text-xs lg:text-muted-foreground">Location</dt>
                <dd className="inline font-semibold lg:mt-1 lg:block lg:whitespace-nowrap">
                  Central Club <span aria-hidden="true" className="lg:hidden">·</span>
                </dd>
              </div>{" "}
              <div className="inline lg:block">
                <dt className="sr-only lg:not-sr-only lg:text-xs lg:text-muted-foreground">Date</dt>
                <dd className="inline font-semibold lg:mt-1 lg:block">Today</dd>
              </div>
              <div>
                <dt className="sr-only lg:not-sr-only lg:text-xs lg:text-muted-foreground">Time</dt>
                <dd className="mt-1 text-muted-foreground lg:whitespace-nowrap lg:text-foreground">18:00–20:00</dd>
              </div>
            </dl>
            <Link
              href="/book"
              className="mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-control bg-primary px-5 font-sans text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover md:mt-0 md:w-auto md:shrink-0"
            >
              Find a court
            </Link>
          </div>
        </div>
      </section>

      <section aria-labelledby="today-title" className="bg-background px-6 py-16 md:px-8 md:py-20 lg:py-24">
        <div className="mx-auto max-w-7xl">
          <div className="mb-9 md:mb-12">
            <h2 id="today-title" className="font-heading text-[clamp(32px,4vw,52px)] font-semibold leading-tight tracking-[-0.035em] text-foreground">
              Today at the club
            </h2>
            <p className="mt-3 font-sans text-base leading-7 text-muted-foreground md:text-lg">
              See what’s happening on court today.
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] lg:items-start lg:gap-5">
            <article aria-labelledby="courts-title" className="rounded-card border border-border bg-surface p-6 md:p-8 lg:p-9">
              <div className="flex items-start justify-between gap-4 border-b border-border pb-6">
                <div>
                  <p className="mb-3 font-sans text-xs font-semibold uppercase tracking-[0.16em] text-accent">On court</p>
                  <h3 id="courts-title" className="font-heading text-2xl font-semibold tracking-[-0.025em] text-primary md:text-[30px]">
                    Court availability
                  </h3>
                </div>
                <span className="hidden font-sans text-sm text-muted-foreground sm:block">Today</span>
              </div>

              {courts.length > 0 ? (
                <div>
                  {courts.map((court) => (
                    <div key={court.name} className="grid gap-3 border-b border-border py-5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center md:py-6">
                      <div className="flex items-baseline gap-3">
                        <Link href="/book" className="font-heading text-lg font-semibold text-foreground transition-colors hover:text-accent hover:underline hover:decoration-accent focus-visible:rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">{court.name}</Link>
                        <span className="font-sans text-sm text-muted-foreground">{court.surface}</span>
                      </div>
                      {court.times.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {court.times.map((time) => (
                            <Link key={time} href="/book" aria-label={`Book ${court.name} at ${time}`} className="inline-flex min-h-10 min-w-[72px] items-center justify-center rounded-control border border-border-strong bg-background px-3 font-sans text-sm font-semibold tabular-nums text-primary transition-colors hover:border-primary hover:bg-forest-100 hover:text-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
                              {time}
                            </Link>
                          ))}
                        </div>
                      ) : (
                        <span className="font-sans text-sm text-muted-foreground">No suitable availability today</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-8 font-sans text-sm leading-6">
                  <p className="font-semibold text-foreground">No court availability today.</p>
                  <p className="mt-1 text-muted-foreground">Check another time or date.</p>
                </div>
              )}

              <Link href="/book" className="mt-4 inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-primary underline decoration-accent underline-offset-8 transition-colors hover:text-accent hover:decoration-2 focus-visible:rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
                View courts <span aria-hidden="true" className="ml-2">→</span>
              </Link>
            </article>

            <div className="grid gap-4 md:grid-cols-2 md:items-start lg:grid-cols-1 lg:gap-5">
              <article aria-labelledby="match-title" className="rounded-card bg-primary p-6 text-primary-foreground md:p-7 lg:p-8">
                <h3 id="match-title" className="mb-3 font-sans text-xs font-semibold uppercase tracking-[0.16em] text-ivory">Open matches</h3>
                {openMatches.length > 0 ? (
                  <div>
                    {openMatches.slice(0, 4).map((match) => (
                      <Link key={`${match.format}-${match.level}-${match.time}`} href="/matches" className="block border-t border-ivory/20 py-3 transition-colors first:border-t-0 hover:bg-forest-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tennis">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                          <p className="font-heading text-base font-semibold text-chalk">
                            {match.format} <span className="font-sans text-sm font-normal text-ivory">· {match.level}</span>
                          </p>
                          <span className="font-sans text-sm tabular-nums text-ivory">{match.time}</span>
                        </div>
                        <p className="mt-1 font-sans text-xs font-semibold text-tennis">{match.playersNeeded}</p>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="py-5 font-sans text-sm leading-6">
                    <p className="font-semibold text-chalk">No open matches today.</p>
                    <p className="mt-1 text-ivory">Be the first to start one.</p>
                  </div>
                )}
                <Link href="/matches" className="mt-2 inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-chalk underline decoration-clay-300 underline-offset-8 transition-colors hover:text-tennis hover:decoration-tennis hover:decoration-2 focus-visible:rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tennis">
                  View matches <span aria-hidden="true" className="ml-2">→</span>
                </Link>
              </article>

              <article aria-labelledby="coaching-title" className="rounded-card border border-border bg-surface p-6 md:p-7 lg:p-8">
                <h3 id="coaching-title" className="mb-5 font-heading text-xl font-semibold tracking-[-0.02em] text-primary">Coaching today</h3>
                {coachingSlots.length > 0 ? (
                  <div>
                    {coachingSlots.slice(0, 4).map((slot) => (
                      <Link key={`${slot.name}-${slot.time}`} href="/coaching" className="group flex items-center justify-between gap-4 border-t border-border py-3 font-sans text-sm transition-colors first:border-t-0 first:pt-0 hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
                        <span className="font-medium text-foreground transition-colors group-hover:text-accent">{slot.name}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">{slot.time}</span>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="py-5 font-sans text-sm leading-6">
                    <p className="font-semibold text-foreground">No coaching slots today.</p>
                    <p className="mt-1 text-muted-foreground">Check upcoming availability.</p>
                  </div>
                )}
                <Link href="/coaching" className="mt-2 inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-primary underline decoration-accent underline-offset-8 transition-colors hover:text-accent hover:decoration-2 focus-visible:rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
                  View coaches <span aria-hidden="true" className="ml-2">→</span>
                </Link>
              </article>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
