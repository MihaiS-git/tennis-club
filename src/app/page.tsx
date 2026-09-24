import Link from "next/link";

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
    </main>
  );
}
