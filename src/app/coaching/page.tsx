import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { readPublicCoaching } from "@/lib/coaching/public";
import { listPublicLocationsWithCourts } from "@/lib/courts/public";
import { EditorialHero } from "../editorial-hero";
import styles from "../page.module.css";
import { PageSectionNav } from "../page-section-nav";
import { CoachingCoaches, CoachingPrices, CoachingPrograms } from "./coaching-sections";

export const metadata: Metadata = {
  title: "Coaching | Tennis Club",
  description: "Coaching programs, the club’s coaches and coaching prices.",
};

const sections = [
  { id: "programs", label: "Programs" },
  { id: "coaches", label: "Coaches" },
  { id: "prices", label: "Prices" },
  { id: "how-it-works", label: "How it works" },
  { id: "faq", label: "FAQ" },
];

const steps = [
  { title: "Choose a program", text: "Each program describes who it suits, how long a lesson lasts, how many players take part and whether the court is included in the price." },
  { title: "Meet the coaches", text: "Coach profiles show their background, specialties, the languages they coach in, where they teach and the programs they offer." },
  { title: "Check the price", text: "Club prices apply at every location and are charged in the location’s currency. Where a coach has an individual price, it is shown on their profile." },
  { title: "Choose a lesson", text: "Choose your location, coach and lesson length, then select an available court and time. Pay online to confirm your lesson." },
];

const questions = [
  { question: "Is this page different for members?", answer: "No. Members and visitors see the same programs, coaches and prices." },
  { question: "Is the court included in the price?", answer: "Each program states whether court rental is included. Where it is not included, the price shown covers the coaching only." },
  { question: "Why do some coaches have a different price?", answer: "The club sets a standard price for each program and lesson length. Some coaches have an individual price, also set by the club, which is shown on their profile and in the price list." },
  { question: "Why are prices shown in different currencies?", answer: "Each lesson is charged in its location’s currency. Prices are set separately in each currency and are never converted." },
  { question: "Can I book or pay for a lesson online?", answer: "Private and Semi-private lessons use the booking timetable and one online payment for the complete session. Group and Junior programs are not available for online booking." },
];

// One public read per request, shared by every data-backed section. Only
// locations that are publicly visible are used to place coaches and prices.
async function readCoaching() {
  await connection();
  return readPublicCoaching(await listPublicLocationsWithCourts());
}

const eyebrowClassName = "font-sans text-xs font-semibold uppercase tracking-[0.16em]";
const headingClassName = "font-heading text-[clamp(34px,4vw,56px)] font-semibold leading-[1.08] tracking-[-0.035em]";
const bodyClassName = "font-sans text-base leading-7 md:text-lg md:leading-8";
const sectionClassName = "scroll-mt-20 px-6 py-14 md:px-8 md:py-20 xl:py-28";

export default function CoachingPage() {
  const coaching = readCoaching();

  return (
    <main className="flex-1">
      <EditorialHero
        titleId="coaching-hero-title"
        eyebrow="Coaching"
        title="Better tennis, one lesson at a time."
        titleClassName="max-w-[14ch]"
        intro="Find a coaching program that suits your game, meet the coaches who teach it and see what lessons cost."
        image={{
          src: "/images/tennis-coaching-session.webp",
          alt: "A coach guides a player during a practice session on a clay tennis court",
          className: "object-[60%_center] md:object-center",
        }}
      >
        <Link href="/book?mode=coaching" className="inline-flex min-h-12 items-center justify-center rounded-control bg-chalk px-6 font-sans text-sm font-semibold text-primary transition hover:bg-surface-muted">Book coaching</Link>
        <a href="#programs" className="inline-flex min-h-12 items-center justify-center rounded-control bg-chalk px-6 font-sans text-sm font-semibold text-primary transition hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
          Explore programs
        </a>
        <a href="#coaches" className={`${styles.editorialLink} inline-flex min-h-11 w-fit items-center font-sans text-sm font-semibold text-chalk transition-colors hover:text-chalk focus-visible:rounded-control`}>
          <span className={`${styles.editorialLabel} underline decoration-accent-on-dark underline-offset-8`}>Meet the coaches</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
        </a>
      </EditorialHero>
      <PageSectionNav sections={sections} />

      <section id="programs" aria-labelledby="coaching-programs-title" className={`${sectionClassName} bg-background`}>
        <div className="mx-auto max-w-7xl">
          <div className={`${styles.reveal} grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-end lg:gap-16`}>
            <div>
              <p className={`${eyebrowClassName} text-accent`}>Programs</p>
              <h2 id="coaching-programs-title" className={`${headingClassName} mt-4 max-w-[13ch] text-foreground`}>Find the right way to train.</h2>
            </div>
            <p className={`${bodyClassName} max-w-xl text-muted-foreground`}>
              The coaching programs currently offered by the club, with the lesson lengths available and whether the court is included.
            </p>
          </div>
          <div className="mt-10 md:mt-14">
            <Suspense fallback={<p role="status" className="border-t border-border pt-5 font-sans text-base text-muted-foreground">Loading programs…</p>}>
              <CoachingPrograms coaching={coaching} />
            </Suspense>
          </div>
        </div>
      </section>

      <section id="coaches" aria-labelledby="coaching-coaches-title" className={`${sectionClassName} bg-chalk`}>
        <div className="mx-auto max-w-7xl">
          <div className={`${styles.reveal} grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-end lg:gap-16`}>
            <div>
              <p className={`${eyebrowClassName} text-accent`}>Meet our coaches</p>
              <h2 id="coaching-coaches-title" className={`${headingClassName} mt-4 max-w-[13ch] text-foreground`}>The people on the other side of the net.</h2>
            </div>
            <p className={`${bodyClassName} max-w-xl text-muted-foreground`}>
              Where each coach teaches, what they focus on and the programs they offer.
            </p>
          </div>
          <div className="mt-10 md:mt-14">
            <Suspense fallback={<p role="status" className="border-t border-border pt-5 font-sans text-base text-muted-foreground">Loading coaches…</p>}>
              <CoachingCoaches coaching={coaching} />
            </Suspense>
          </div>
        </div>
      </section>

      <section id="prices" aria-labelledby="coaching-prices-title" className={`${sectionClassName} bg-forest-900 text-chalk`}>
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16 xl:gap-24">
          <div className={styles.reveal}>
            <p className={`${eyebrowClassName} text-accent-on-dark`}>Prices</p>
            <h2 id="coaching-prices-title" className={`${headingClassName} mt-4 max-w-[12ch]`}>What a lesson costs.</h2>
            <p className={`${bodyClassName} mt-6 max-w-xl text-ivory`}>
              Prices are per lesson, the same at every location that charges in that currency. Each line states whether court rental is included.
            </p>
            <p className="mt-4 max-w-xl font-sans text-sm leading-6 text-ivory">
              The club price applies to every coach unless a coach has an individual price, listed beneath it.
            </p>
          </div>
          <Suspense fallback={<p role="status" className="border-t border-ivory/30 pt-5 font-sans text-base text-ivory">Loading prices…</p>}>
            <CoachingPrices coaching={coaching} />
          </Suspense>
        </div>
      </section>

      <section id="how-it-works" aria-labelledby="coaching-how-title" className={`${sectionClassName} bg-background`}>
        <div className="mx-auto max-w-7xl">
          <div className={styles.reveal}>
            <p className={`${eyebrowClassName} text-accent`}>How coaching works</p>
            <h2 id="coaching-how-title" className={`${headingClassName} mt-4 max-w-[14ch] text-foreground`}>From first question to first lesson.</h2>
          </div>
          <ol aria-label="How coaching works" className={`${styles.stagger} mt-10 grid gap-x-8 md:mt-14 md:grid-cols-2 lg:grid-cols-4`}>
            {steps.map((step, index) => (
              <li key={step.title} className="border-t-2 border-accent py-5">
                <p aria-hidden="true" className="font-heading text-2xl font-semibold tabular-nums tracking-[-0.03em] text-accent md:text-3xl">{String(index + 1).padStart(2, "0")}</p>
                <h3 className="mt-3 font-heading text-xl font-semibold leading-snug tracking-[-0.02em] text-primary">{step.title}</h3>
                <p className="mt-3 font-sans text-sm leading-6 text-muted-foreground md:text-base md:leading-7">{step.text}</p>
              </li>
            ))}
          </ol>
          <Link href="/club#visit" className={`${styles.editorialLink} mt-6 inline-flex min-h-11 w-fit items-center font-sans text-base font-semibold text-primary transition-colors hover:text-accent focus-visible:rounded-control`}>
            <span className={`${styles.editorialLabel} underline decoration-accent underline-offset-8`}>Find your location</span> <span aria-hidden="true" className={`${styles.editorialArrow} ml-2`}>→</span>
          </Link>
        </div>
      </section>

      <section id="faq" aria-labelledby="coaching-faq-title" className={`${sectionClassName} bg-chalk`}>
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
          <div className={styles.reveal}>
            <p className={`${eyebrowClassName} text-accent`}>FAQ</p>
            <h2 id="coaching-faq-title" className={`${headingClassName} mt-4 max-w-[12ch] text-foreground`}>Questions, answered.</h2>
          </div>
          <dl className="font-sans">
            {questions.map((item) => (
              <div key={item.question} className="border-t border-border py-5">
                <dt className="text-base font-semibold text-foreground md:text-lg">{item.question}</dt>
                <dd className="mt-2 text-sm leading-6 text-muted-foreground md:text-base md:leading-7">{item.answer}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </main>
  );
}
