import Link from "next/link";
import styles from "./page.module.css";

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
  const place = "Parcul Central Simion Bărnuțiu, Cluj-Napoca, Romania";
  const mapsKey = process.env.GOOGLE_MAPS_EMBED_API_KEY;
  const mapUrl = mapsKey
    ? `https://www.google.com/maps/embed/v1/place?${new URLSearchParams({ key: mapsKey, q: place })}`
    : null;
  const directionsUrl = `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", destination: place })}`;

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
          <div className={`${styles.heroEntrance} px-6 pb-7 pt-7 md:flex md:h-[clamp(500px,54vw,560px)] md:w-[45%] md:flex-col md:justify-start md:px-8 md:py-20 lg:h-auto lg:w-auto lg:max-w-[470px] lg:px-6 lg:pt-[clamp(88px,9vw,140px)] lg:text-chalk xl:px-8`}>
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
                className="inline-flex min-h-12 w-full items-center justify-center rounded-control bg-primary px-5 font-sans text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover md:w-auto lg:bg-chalk lg:px-6 lg:text-primary lg:hover:bg-surface-muted"
              >
                Book a court
              </Link>
              <Link
                href="/matches"
                className="inline-flex min-h-12 w-full items-center justify-center rounded-control border border-border-strong bg-surface px-5 font-sans text-sm font-semibold text-primary transition hover:bg-surface-muted hover:text-accent md:w-auto lg:border-ivory/80 lg:bg-forest-900/20 lg:px-6 lg:text-chalk lg:hover:border-accent-on-dark lg:hover:bg-forest-900/40 lg:hover:text-chalk"
              >
                Find a match
              </Link>
            </div>
            <Link
              href="/coaching"
              className={`${styles.editorialLink} mt-2 inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-primary hover:text-accent md:mt-4 lg:mt-3 lg:min-h-10 lg:text-chalk lg:hover:text-chalk xl:mt-4`}
            >
              <span className={`${styles.editorialLabel} underline decoration-accent underline-offset-4 lg:decoration-accent-on-dark`}>Book coaching</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-1`}>→</span>
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
                        <Link href="/book" className="font-heading text-lg font-semibold text-primary transition-colors hover:text-accent hover:underline hover:decoration-accent focus-visible:rounded-control">{court.name}</Link>
                        <span className="font-sans text-sm text-muted-foreground">{court.surface}</span>
                      </div>
                      {court.times.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {court.times.map((time) => (
                            <Link key={time} href="/book" aria-label={`Book ${court.name} at ${time}`} className="inline-flex min-h-10 min-w-[72px] items-center justify-center rounded-control border border-border-strong bg-background px-3 font-sans text-sm font-semibold tabular-nums text-primary transition-colors hover:border-accent hover:bg-surface-muted hover:text-accent">
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

              <Link href="/book" className={`${styles.editorialLink} mt-4 inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-primary transition-colors hover:text-accent focus-visible:rounded-control`}>
                <span className={`${styles.editorialLabel} underline decoration-accent underline-offset-8`}>View courts</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
              </Link>
            </article>

            <div className="grid gap-4 md:grid-cols-2 md:items-start lg:grid-cols-1 lg:gap-5">
              <article aria-labelledby="match-title" className="rounded-card bg-primary p-6 text-primary-foreground md:p-7 lg:p-8">
                <h3 id="match-title" className="mb-3 font-sans text-xs font-semibold uppercase tracking-[0.16em] text-ivory">Open matches</h3>
                {openMatches.length > 0 ? (
                  <div>
                    {openMatches.slice(0, 4).map((match) => (
                      <Link key={`${match.format}-${match.level}-${match.time}`} href="/matches" className="block border-t border-ivory/20 py-3 transition-colors first:border-t-0 hover:bg-forest-700">
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
                <Link href="/matches" className={`${styles.editorialLink} mt-2 inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-chalk transition-colors hover:text-chalk focus-visible:rounded-control`}>
                  <span className={`${styles.editorialLabel} underline decoration-accent-on-dark underline-offset-8`}>View matches</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
                </Link>
              </article>

              <article aria-labelledby="coaching-title" className="rounded-card border border-border bg-surface p-6 md:p-7 lg:p-8">
                <h3 id="coaching-title" className="mb-5 font-heading text-xl font-semibold tracking-[-0.02em] text-primary">Coaching today</h3>
                {coachingSlots.length > 0 ? (
                  <div>
                    {coachingSlots.slice(0, 4).map((slot) => (
                      <Link key={`${slot.name}-${slot.time}`} href="/coaching" className="group flex items-center justify-between gap-4 border-t border-border py-3 font-sans text-sm transition-colors first:border-t-0 first:pt-0 hover:bg-background">
                        <span className="font-medium text-primary transition-colors group-hover:text-accent">{slot.name}</span>
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
                <Link href="/coaching" className={`${styles.editorialLink} mt-2 inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-primary transition-colors hover:text-accent focus-visible:rounded-control`}>
                  <span className={`${styles.editorialLabel} underline decoration-accent underline-offset-8`}>View coaches</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
                </Link>
              </article>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="club-intro-title" className="bg-forest-900 px-0 py-16 text-chalk md:px-8 md:py-20 xl:py-28">
        <div className="mx-auto max-w-7xl lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center lg:gap-16">
          <div className="max-w-2xl px-6 md:px-0 lg:max-w-none">
            <h2 id="club-intro-title" className="max-w-[13ch] font-heading text-[clamp(36px,4vw,56px)] font-semibold leading-[1.08] tracking-[-0.035em]">
              A tennis club built around playing.
            </h2>
            <p className="mt-6 font-sans text-base leading-7 text-ivory md:text-lg md:leading-8">
              TennisClub brings together clay tennis courts, coaching, open matches and a community of players in Cluj-Napoca. Whether you play regularly or are looking for somewhere new to get on court, the club is designed to make tennis easy to join and part of your week.
            </p>
            <ul className="mt-8 grid grid-cols-2 gap-x-8 font-sans text-sm font-medium text-ivory md:max-w-lg md:text-base">
              <li className="border-t border-ivory/30 py-3">Courts</li>
              <li className="border-t border-ivory/30 py-3">Coaching</li>
              <li className="border-t border-ivory/30 py-3">Open matches</li>
              <li className="border-t border-ivory/30 py-3">Community</li>
            </ul>
            <Link href="/club" className={`${styles.editorialLink} mt-6 inline-flex min-h-11 items-center font-sans text-base font-semibold text-chalk transition-colors hover:text-chalk focus-visible:rounded-control`}>
              <span className={`${styles.editorialLabel} underline decoration-accent-on-dark underline-offset-8`}>Discover the club</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
            </Link>
          </div>

          <div className="px-3 md:px-0">
            <picture>
              <source type="image/avif" srcSet="/images/tennis-club-aerial.avif" />
              <source type="image/webp" srcSet="/images/tennis-club-aerial.webp" />
              <img
                src="/images/tennis-club-aerial.webp"
                alt="Aerial view of a clay-court tennis club with clubhouse and surrounding greenery"
                loading="lazy"
                decoding="async"
                width="1536"
                height="1024"
                className="mt-10 aspect-3/2 w-full max-w-[960px] object-cover lg:mt-0 lg:max-w-none"
              />
            </picture>
          </div>
        </div>
      </section>

      <section aria-labelledby="facilities-title" className="bg-chalk px-6 py-16 md:px-8 md:py-20 xl:py-28">
        <div className="mx-auto max-w-7xl">
          <div className="lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-x-16">
            <div>
              <h2 id="facilities-title" className="max-w-[13ch] font-heading text-[clamp(36px,4vw,56px)] font-semibold leading-[1.08] tracking-[-0.035em] text-foreground">
                Clay courts and everything you need to play.
              </h2>
              <p className="mt-6 max-w-xl font-sans text-base leading-7 text-muted-foreground md:text-lg md:leading-8">
                TennisClub combines eight clay courts with practical player facilities for training, matches and time at the club. The courts and shared spaces are designed for everyday play, coaching and club activity in Cluj-Napoca.
              </p>
            </div>

            <div className="mt-10 grid gap-x-8 gap-y-8 md:grid-cols-2 md:gap-y-10 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mt-0">
              <div className="border-t border-border pt-4">
                <h3 className="font-heading text-xl font-semibold leading-snug tracking-[-0.02em] text-primary">8 clay courts</h3>
                <p className="mt-3 font-sans text-sm leading-6 text-muted-foreground md:text-base md:leading-7">Outdoor clay courts for training, casual play and competitive matches.</p>
              </div>
              <div className="border-t border-border pt-4">
                <h3 className="font-heading text-xl font-semibold leading-snug tracking-[-0.02em] text-primary">Changing rooms &amp; showers</h3>
                <p className="mt-3 font-sans text-sm leading-6 text-muted-foreground md:text-base md:leading-7">Comfortable facilities for players before and after time on court.</p>
              </div>
              <div className="border-t border-border pt-4">
                <h3 className="font-heading text-xl font-semibold leading-snug tracking-[-0.02em] text-primary">Clubhouse &amp; terrace</h3>
                <p className="mt-3 font-sans text-sm leading-6 text-muted-foreground md:text-base md:leading-7">A social space to meet, relax and spend time around the club.</p>
              </div>
              <div className="border-t border-border pt-4">
                <h3 className="font-heading text-xl font-semibold leading-snug tracking-[-0.02em] text-primary">Court lighting</h3>
                <p className="mt-3 font-sans text-sm leading-6 text-muted-foreground md:text-base md:leading-7">Lighting that supports play into the evening.</p>
              </div>
            </div>

            <Link href="/courts" className={`${styles.editorialLink} mt-8 inline-flex min-h-11 w-fit items-center font-sans text-base font-semibold text-primary transition-colors hover:text-accent focus-visible:rounded-control lg:col-start-1 lg:row-start-2 lg:mt-6 lg:self-start`}>
              <span className={`${styles.editorialLabel} underline decoration-accent underline-offset-8`}>Explore the courts</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
            </Link>
          </div>

          <picture className="mt-12 block md:mt-16 lg:mt-20">
            <source type="image/avif" srcSet="/images/tennis-courts-facilities.avif" />
            <source type="image/webp" srcSet="/images/tennis-courts-facilities.webp" />
            <img
              src="/images/tennis-courts-facilities.webp"
              alt="Clay tennis court with clubhouse, lighting and player facilities at TennisClub"
              loading="lazy"
              decoding="async"
              width="1672"
              height="941"
              className="block h-auto w-full"
            />
          </picture>
        </div>
      </section>

      <section aria-labelledby="coaching-section-title" className="bg-forest-900 px-6 py-16 md:px-8 md:py-20 xl:py-28">
        <div className="mx-auto max-w-7xl lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-center lg:gap-x-12 xl:gap-x-20">
          <div className="lg:col-start-2 lg:row-start-1">
            <h2 id="coaching-section-title" className="max-w-[13ch] font-heading text-[clamp(36px,4vw,56px)] font-semibold leading-[1.08] tracking-[-0.035em] text-chalk">
              Coaching for every stage of your game.
            </h2>
            <p className="mt-6 max-w-xl font-sans text-base leading-7 text-ivory md:text-lg md:leading-8">
              Train with experienced coaches for individual sessions, structured practice and ongoing development. Coaching is available for players who are just starting out as well as those looking to improve specific parts of their game.
            </p>
            <ul className="mt-10 grid gap-x-8 font-sans text-base font-medium text-ivory md:grid-cols-2">
              <li className="border-t border-ivory/30 py-4">Individual coaching</li>
              <li className="border-t border-ivory/30 py-4">Junior coaching</li>
              <li className="border-t border-ivory/30 py-4">Group sessions</li>
              <li className="border-t border-ivory/30 py-4">Performance training</li>
            </ul>
            <Link href="/coaching" className={`${styles.editorialLink} mt-6 inline-flex min-h-11 w-fit items-center font-sans text-base font-semibold text-chalk transition-colors hover:text-chalk focus-visible:rounded-control`}>
              <span className={`${styles.editorialLabel} underline decoration-accent-on-dark underline-offset-8`}>Meet the coaches</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
            </Link>
          </div>

          <picture className="-mx-3 mt-12 block w-[calc(100%+1.5rem)] md:mx-0 md:mt-16 md:w-auto lg:col-start-1 lg:row-start-1 lg:mt-0">
            <source type="image/avif" srcSet="/images/tennis-coaching-session.avif" />
            <source type="image/webp" srcSet="/images/tennis-coaching-session.webp" />
            <img
              src="/images/tennis-coaching-session.webp"
              alt="A coach guides a player during a practice session on a clay tennis court"
              loading="lazy"
              decoding="async"
              width="1536"
              height="1024"
              className="block h-auto w-full"
            />
          </picture>
        </div>
      </section>

      <section aria-labelledby="matches-community-title" className="bg-background px-6 py-16 md:px-8 md:py-20 xl:py-28">
        <div className="mx-auto max-w-7xl lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center lg:gap-x-12 xl:gap-x-20">
          <div>
            <h2 id="matches-community-title" className="max-w-[13ch] font-heading text-[clamp(36px,4vw,56px)] font-semibold leading-[1.08] tracking-[-0.035em] text-foreground">
              Find the right people to play with.
            </h2>
            <p className="mt-6 max-w-xl font-sans text-base leading-7 text-muted-foreground md:text-lg md:leading-8">
              Join open matches, find players at a similar level, or organize your own game. TennisClub makes it easier to spend less time searching for partners and more time on court.
            </p>
            <ul className="mt-10 font-sans text-base font-medium text-primary">
              <li className="border-t border-border py-4">Open matches</li>
              <li className="border-t border-border py-4">Players at a similar level</li>
              <li className="border-t border-border py-4">Singles &amp; doubles</li>
            </ul>
            <Link href="/matches" className={`${styles.editorialLink} mt-6 inline-flex min-h-11 w-fit items-center font-sans text-base font-semibold text-primary transition-colors hover:text-accent focus-visible:rounded-control`}>
              <span className={`${styles.editorialLabel} underline decoration-accent underline-offset-8`}>Explore matches</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
            </Link>
          </div>

          <picture className="-mx-3 mt-12 block w-[calc(100%+1.5rem)] md:mx-0 md:mt-16 md:w-auto lg:mt-0">
            <source type="image/avif" srcSet="/images/tennis-matches-community.avif" />
            <source type="image/webp" srcSet="/images/tennis-matches-community.webp" />
            <img
              src="/images/tennis-matches-community.webp"
              alt="Four tennis players talking together beside a clay court"
              loading="lazy"
              decoding="async"
              width="1536"
              height="1024"
              className="block h-auto w-full"
            />
          </picture>
        </div>
      </section>

      <section aria-labelledby="visit-club-title" className="bg-forest-900 px-6 py-16 md:px-8 md:py-20 xl:py-28">
        <div className="mx-auto max-w-7xl lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-stretch lg:gap-x-12 xl:gap-x-20">
          <div>
            <h2 id="visit-club-title" className="max-w-[14ch] font-heading text-[clamp(40px,4.4vw,64px)] font-semibold leading-[1.04] tracking-[-0.04em] text-chalk">
              Play in the heart of Cluj-Napoca.
            </h2>
            <p className="mt-6 max-w-xl font-sans text-base leading-7 text-ivory md:text-lg md:leading-8">
              Central Club is set in Parcul Central Simion Bărnuțiu, with clay courts, coaching and club activity in one of Cluj-Napoca’s most accessible central locations.
            </p>
            <div className="mt-12 border-t border-ivory/30 pb-6 pt-5">
              <h3 className="font-sans text-xs font-semibold uppercase tracking-[0.16em] text-ivory">Location</h3>
              <address className="mt-3 font-heading text-xl font-medium leading-7 text-chalk not-italic">
                Parcul Central Simion Bărnuțiu<br />
                Cluj-Napoca
              </address>
            </div>
            <div className="border-t border-ivory/30 pb-5 pt-5 font-heading text-lg font-medium leading-7 text-chalk">
              <h3 className="mb-3 font-sans text-xs font-semibold uppercase tracking-[0.16em] text-ivory">Hours</h3>
              <p>Mon–Fri · 07:00–24:00</p>
              <p>Sat–Sun · 07:00–24:00</p>
            </div>
            <a href={directionsUrl} target="_blank" rel="noopener noreferrer" className={`${styles.editorialLink} mt-6 inline-flex min-h-11 w-fit items-center font-sans text-base font-semibold text-chalk transition-colors hover:text-chalk focus-visible:rounded-control`}>
              <span className={`${styles.editorialLabel} underline decoration-accent-on-dark underline-offset-8`}>Get directions</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
            </a>
          </div>

          <div className="-mx-3 mt-12 aspect-[4/3] w-[calc(100%+1.5rem)] md:mx-0 md:mt-16 md:aspect-[3/2] md:w-full lg:-mr-4 lg:ml-0 lg:mt-0 lg:aspect-auto lg:w-[calc(100%+1rem)] xl:-mr-12 xl:w-[calc(100%+3rem)]">
            {mapUrl ? (
              <iframe
                src={mapUrl}
                title="Map showing Central Club in Parcul Central Simion Bărnuțiu, Cluj-Napoca"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                allowFullScreen
                className="block h-full w-full border-0"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center border border-ivory/30 font-sans text-base text-ivory">
                Map unavailable.
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
