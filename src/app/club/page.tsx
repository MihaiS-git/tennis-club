import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { guestCancellationInstruction } from "@/lib/bookings/self-cancellation";
import { listPublicVisitorLocations } from "@/lib/courts/public";
import { EditorialHero } from "../editorial-hero";
import styles from "../page.module.css";
import { PageSectionNav } from "../page-section-nav";
import { ClubBookingTerms, ClubLocations } from "./club-locations";

export const metadata: Metadata = {
  title: "The Club | Tennis Club",
  description: "The story of the club since 1978, membership, the people who run it, club rules and booking policies, and how to visit each location.",
};

const sections = [
  { id: "story", label: "Our story" },
  { id: "membership", label: "Membership" },
  { id: "people", label: "People" },
  { id: "facilities", label: "Facilities" },
  { id: "rules", label: "Rules & policies" },
  { id: "visit", label: "Visit" },
];

const milestones = [
  { year: "1978", text: "Six neighbouring families lease an overgrown olive grove and lay two clay courts between the trees." },
  { year: "1986", text: "The old stone farm building becomes the clubhouse. Members build the terrace themselves over two summers." },
  { year: "1994", text: "Junior Saturdays begin: one morning a week given over entirely to children learning the game." },
  { year: "2008", text: "The first Autumn Cup, the club’s own end-of-season tournament, still played for the same modest trophy." },
  { year: "2019", text: "The club grows beyond its first address, taking the same rules and the same Sunday doubles with it." },
];

const memberships = [
  { numeral: "I", title: "Playing", audience: "For players who are on court most weeks.",
    benefits: ["Weekday evening social play", "Sunday doubles mornings", "A vote at the annual meeting"] },
  { numeral: "II", title: "Family & junior", audience: "For households who play together, whatever their level.",
    benefits: ["Junior Saturdays for under-18s", "Family doubles afternoons", "One membership for the household"] },
  { numeral: "III", title: "Competition", audience: "For players who want a fixture list as well as a game.",
    benefits: ["Selection for interclub league teams", "Entry to the Autumn Cup", "Match-play practice evenings"] },
  { numeral: "IV", title: "Social", audience: "For those who come for the company as much as the tennis.",
    benefits: ["Club evenings and the season’s closing dinner", "Autumn Cup finals day", "A standing invitation to the Sunday group"] },
];

const people = [
  { name: "Elena Marinescu", role: "Club Director", since: "At the club since 1994",
    bio: "Came to the very first Junior Saturdays aged nine and never really left. Elena now looks after the club’s direction, its finances and its long-term plans, and still turns up for Sunday doubles whenever the calendar allows.",
    quote: "A good club is one where you can arrive on your own and still find a game." },
  { name: "Radu Constantin", role: "Operations & Grounds", since: "At the club since 2009",
    bio: "Responsible for the courts, the daily schedule and everything in between. Radu’s team prepares the clay each spring, keeps the lines straight through the season and knows exactly which corner dries last after rain.",
    quote: "Clay forgives almost anything, except being ignored." },
  { name: "Ioana Dragomir", role: "Reception & Member Services", since: "At the club since 2017",
    bio: "The first person most visitors meet. Ioana answers questions about bookings and membership, introduces newcomers to players at their level and keeps a remarkably well-organised lost-and-found.",
    quote: "Tell us if it’s your first visit. We would rather show you around than leave you looking for the right court." },
];

const facilities = [
  { title: "Clubhouse & terrace", text: "The social heart of the club: somewhere to wait for a court, watch the end of a match or settle the argument about that line call. Club notices go up here first." },
  { title: "Changing & showers", text: "Come straight from work and leave ready for dinner. Allow ten minutes before your booking to change, so the court is yours from the first minute." },
  { title: "Kit & small rescues", text: "Forgotten your racket, run out of balls or snapped a string mid-set? Ask at reception. Between the staff and the members, there is usually a spare." },
  { title: "Getting here", text: "Addresses, directions and opening hours for every location are below. Weekday evenings are the busiest time at the club, so allow a little extra time to arrive." },
];

const etiquette = [
  { title: "Be ready on time", text: "Arrive changed and warmed up for the start of your booking. Your time ends when the booking does, even if you started late." },
  { title: "Wear clay-court shoes", text: "Tennis shoes with a clay or all-court sole only. Running shoes tear up the surface and are not allowed on court." },
  { title: "Leave the court as you found it", text: "Use the last five minutes of your booking to brush the court and sweep the lines for the next players." },
  { title: "Wait for the point", text: "Cross behind other courts only between points, and ask before retrieving a ball from a court in play." },
  { title: "Play fair", text: "Call your own lines honestly, keep language and volume down, and shake hands at the end, whatever the score." },
  { title: "Guests and children", text: "Visitors follow the same rules as members. Children on court should be with an adult unless they are in a coached session." },
];

// One public locations read per request, shared by the policies and visit sections.
async function readPublicLocations() {
  await connection();
  return listPublicVisitorLocations();
}

const eyebrowClassName = "font-sans text-xs font-semibold uppercase tracking-[0.16em]";
const headingClassName = "font-heading text-[clamp(34px,4vw,56px)] font-semibold leading-[1.08] tracking-[-0.035em]";
const bodyClassName = "font-sans text-base leading-7 md:text-lg md:leading-8";
const sectionClassName = "scroll-mt-20 px-6 py-14 md:px-8 md:py-20 xl:py-28";

export default function ClubPage() {
  const locations = readPublicLocations();

  return (
    <main className="flex-1">
      <EditorialHero
        titleId="club-hero-title"
        eyebrow="The Club"
        title="Built slowly, kept with care."
        titleClassName="max-w-[13ch]"
        intro="Since 1978, two courts on an old olive grove have grown into a club with habits of its own: courts brushed after every match, Sunday doubles that never quite finish on time, and a terrace where the last point is argued over long after it was played."
        image={{
          src: "/images/tennis-club-aerial.webp",
          alt: "The stone clubhouse and its terrace above clay courts, surrounded by olive trees and cypresses in late-afternoon light",
          className: "object-[18%_center] md:object-[center_35%]",
        }}
      />
      <PageSectionNav sections={sections} />

      <section id="story" aria-labelledby="club-story-title" className={`${sectionClassName} bg-background`}>
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:items-center lg:gap-16 xl:gap-24">
            <div className={styles.reveal}>
              <p className={`${eyebrowClassName} text-accent`}>Our story</p>
              <h2 id="club-story-title" className={`${headingClassName} mt-4 max-w-[16ch] text-foreground`}>It started with two courts and a borrowed roller.</h2>
              <div className="mt-6 max-w-xl space-y-5 text-muted-foreground">
                <p className={bodyClassName}>
                  In the spring of 1978, six families from the neighbourhood leased a neglected olive grove and set about turning it into somewhere to play. They kept as many trees as they could, laid two clay courts between them and shared a single roller, passed from house to house on a handcart.
                </p>
                <p className={bodyClassName}>
                  There was no clubhouse, no staff and no waiting list, just a timetable pinned to the gate and an agreement that whoever played last would brush the court. That agreement is still the first thing new members hear.
                </p>
                <p className={bodyClassName}>
                  The club has grown since, beyond those first courts and beyond its first address, but it has kept the same character: modest, unhurried, and more interested in who you play with than in how well.
                </p>
              </div>
              <figure className="mt-8 max-w-xl border-l-2 border-accent pl-5">
                <blockquote className="font-heading text-xl font-medium leading-snug tracking-[-0.02em] text-primary md:text-2xl">
                  “Play properly, brush the court, stay for one more drink.”
                </blockquote>
                <figcaption className="mt-2 font-sans text-sm text-muted-foreground">Club saying, since the first summer</figcaption>
              </figure>
            </div>
            <div className={`${styles.photo} ${styles.reveal} relative -mx-6 aspect-[4/3] overflow-hidden md:mx-0 lg:aspect-[4/5]`}>
              <Image
                src="/images/tennis-courts-public.webp"
                alt="A wooden bench, rackets and a basket of balls beside a clay court as the sun sets behind olive trees"
                fill
                sizes="(min-width: 1280px) 520px, (min-width: 1024px) 42vw, 100vw"
                className="object-cover object-[22%_center]"
              />
            </div>
          </div>

          <ol aria-label="Club milestones" className={`${styles.stagger} mt-14 grid gap-x-8 md:mt-20 md:grid-cols-2 lg:grid-cols-5`}>
            {milestones.map((milestone) => (
              <li key={milestone.year} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 border-t-2 border-accent py-4 md:block md:py-5">
                <p className="font-heading text-2xl font-semibold tabular-nums tracking-[-0.03em] text-accent md:text-3xl">{milestone.year}</p>
                <p className="font-sans text-sm leading-6 text-muted-foreground md:mt-3 md:text-base md:leading-7">{milestone.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="membership" aria-labelledby="club-membership-title" className={`${sectionClassName} bg-forest-900 text-chalk`}>
        <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16 xl:gap-24">
          <div className={styles.reveal}>
            <p className={`${eyebrowClassName} text-accent-on-dark`}>Membership</p>
            <h2 id="club-membership-title" className={`${headingClassName} mt-4 max-w-[13ch]`}>Belonging, at your own pace.</h2>
            <p className={`${bodyClassName} mt-6 max-w-xl text-ivory`}>
              Most people’s first visit is a booked court with a friend. Membership is for those who want to keep coming back: a regular game, familiar faces on court and a say in how the club is run.
            </p>
            <aside aria-label="About these membership types" className="mt-8 max-w-xl rounded-card border border-ivory/30 p-5 font-sans text-sm leading-6 text-ivory">
              <p className="font-semibold text-chalk">Illustrative membership</p>
              <p className="mt-1">
                These membership types show how this demonstration club is organised. They are not sold online and have no published prices. Court booking works the same way for everyone, member or visitor.
              </p>
            </aside>
            <div className={`${styles.photo} relative mt-10 hidden aspect-[4/5] overflow-hidden lg:block`}>
              <Image
                src="/images/tennis-matches-community.webp"
                alt="Four players chatting beside a clay court after a game, with the clubhouse terrace behind them"
                fill
                sizes="(min-width: 1280px) 460px, 38vw"
                className="object-cover object-[38%_center]"
              />
            </div>
          </div>

          <ol aria-label="Membership types" className={`${styles.stagger} self-start`}>
            {memberships.map((membership) => (
              <li key={membership.title} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-4 border-t border-ivory/25 py-7 md:grid-cols-[5rem_minmax(0,1fr)] md:py-9">
                <p aria-hidden="true" className="font-heading text-2xl font-semibold text-accent-on-dark md:text-4xl">{membership.numeral}</p>
                <div>
                  <h3 className="font-heading text-2xl font-semibold tracking-[-0.025em] md:text-3xl">{membership.title}</h3>
                  <p className="mt-2 font-sans text-base leading-7 text-ivory">{membership.audience}</p>
                  <ul aria-label={`${membership.title} membership benefits`} className="mt-4 flex flex-wrap gap-x-5 gap-y-1 font-sans text-sm leading-6 text-chalk">
                    {membership.benefits.map((benefit) => (
                      <li key={benefit} className="flex items-center gap-2">
                        <span aria-hidden="true" className="size-1.5 rounded-full bg-accent-on-dark" />{benefit}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="people" aria-labelledby="club-people-title" className={`${sectionClassName} bg-chalk`}>
        <div className="mx-auto max-w-7xl">
          <div className={`${styles.reveal} grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-end lg:gap-16`}>
            <div>
              <p className={`${eyebrowClassName} text-accent`}>The people</p>
              <h2 id="club-people-title" className={`${headingClassName} mt-4 max-w-[14ch] text-foreground`}>The people who keep it running.</h2>
            </div>
            <p className={`${bodyClassName} max-w-xl text-muted-foreground`}>
              A small team, most of whom were members long before they were staff. Coaches are introduced separately; these are the people behind everything else.
            </p>
          </div>

          <ul aria-label="Club team" className={`${styles.stagger} mt-10 md:mt-14`}>
            {people.map((person) => (
              <li key={person.name} className="grid gap-4 border-t border-border py-8 md:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] md:gap-x-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,5fr)_minmax(0,4fr)] lg:gap-x-12 lg:py-10">
                <div>
                  <p className={`${eyebrowClassName} text-accent`}>{person.role}</p>
                  <p className="mt-2 font-sans text-sm text-muted-foreground">{person.since}</p>
                </div>
                <div>
                  <h3 className="font-heading text-2xl font-semibold tracking-[-0.025em] text-primary md:text-3xl">{person.name}</h3>
                  <p className="mt-3 max-w-xl font-sans text-base leading-7 text-muted-foreground">{person.bio}</p>
                </div>
                <blockquote className="border-l-2 border-accent pl-5 font-heading text-lg font-medium leading-snug tracking-[-0.015em] text-foreground md:col-start-2 lg:col-start-auto lg:self-center lg:text-xl">
                  “{person.quote}”
                </blockquote>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="facilities" aria-labelledby="club-facilities-title" className={`${sectionClassName} bg-background`}>
        <div className="mx-auto max-w-7xl">
          <div className={`${styles.reveal} grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-end lg:gap-16`}>
            <div>
              <p className={`${eyebrowClassName} text-accent`}>Facilities &amp; services</p>
              <h2 id="club-facilities-title" className={`${headingClassName} mt-4 max-w-[13ch] text-foreground`}>Off the court, too.</h2>
            </div>
            <p className={`${bodyClassName} max-w-xl text-muted-foreground`}>
              What players remember about a visit is often what happens around the game: a cold shower after a long match, shade on the terrace, someone who knows where the spare balls are. Each location has grown up differently, so facilities vary between them; the care that goes into them does not.
            </p>
          </div>

          <figure className={`${styles.photo} ${styles.reveal} relative -mx-6 mt-10 aspect-[4/3] overflow-hidden md:mx-0 md:mt-14 md:aspect-[21/9]`}>
            <Image
              src="/images/tennis-courts-facilities.webp"
              alt="The clubhouse terrace with lounge seating and potted olive trees, set above a clay court"
              fill
              sizes="(min-width: 1280px) 1216px, 100vw"
              className="object-cover object-[92%_25%] md:object-[center_30%]"
            />
            <figcaption className="absolute bottom-0 left-0 bg-forest-900/80 px-4 py-2 font-sans text-xs font-medium text-chalk md:px-5 md:text-sm">
              The terrace, late afternoon
            </figcaption>
          </figure>

          <ul aria-label="Club facilities and services" className={`${styles.stagger} mt-10 grid gap-x-8 gap-y-2 md:mt-14 md:grid-cols-2 lg:grid-cols-4`}>
            {facilities.map((facility) => (
              <li key={facility.title} className="border-t border-border py-5">
                <h3 className="font-heading text-xl font-semibold leading-snug tracking-[-0.02em] text-primary">{facility.title}</h3>
                <p className="mt-3 font-sans text-sm leading-6 text-muted-foreground md:text-base md:leading-7">{facility.text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section id="rules" aria-labelledby="club-rules-title" className={`${sectionClassName} bg-chalk`}>
        <div className="mx-auto max-w-7xl">
          <div className={styles.reveal}>
            <p className={`${eyebrowClassName} text-accent`}>Club rules &amp; policies</p>
            <h2 id="club-rules-title" className={`${headingClassName} mt-4 max-w-[14ch] text-foreground`}>A few rules, kept short.</h2>
            <p className={`${bodyClassName} mt-6 max-w-xl text-muted-foreground`}>
              Most of them come down to looking after the courts and the people on them.
            </p>
          </div>

          <div className="mt-10 grid gap-12 md:mt-14 lg:grid-cols-2 lg:gap-16 xl:gap-24">
            <div>
              <h3 className="font-heading text-2xl font-semibold tracking-[-0.025em] text-primary">On court</h3>
              <ol className={`${styles.stagger} mt-5`}>
                {etiquette.map((rule, index) => (
                  <li key={rule.title} className="grid grid-cols-[2.25rem_minmax(0,1fr)] border-t border-border py-4">
                    <span aria-hidden="true" className="font-sans text-sm font-semibold tabular-nums text-accent">{String(index + 1).padStart(2, "0")}</span>
                    <p className="font-sans text-sm leading-6 text-muted-foreground md:text-base md:leading-7">
                      <strong className="font-semibold text-foreground">{rule.title}.</strong> {rule.text}
                    </p>
                  </li>
                ))}
              </ol>
            </div>

            <div>
              <h3 className="font-heading text-2xl font-semibold tracking-[-0.025em] text-primary">Bookings, cancellations &amp; refunds</h3>
              <dl className="mt-5 font-sans text-sm leading-6 md:text-base md:leading-7">
                <div className="border-t border-border py-4">
                  <dt className="font-semibold text-foreground">Booking</dt>
                  <dd className="mt-1 text-muted-foreground">A court is reserved once your booking is confirmed; seeing it as available does not hold it. While you pay online, the court is held for you for a short time.</dd>
                </div>
                <div className="border-t border-border py-4">
                  <dt className="font-semibold text-foreground">Payment</dt>
                  <dd className="mt-1 text-muted-foreground">An online booking is confirmed once the payment has been received. The payment options for each booking are shown before you confirm it.</dd>
                </div>
                <div className="border-t border-border py-4">
                  <dt className="font-semibold text-foreground">Cancelling</dt>
                  <dd className="mt-1 text-muted-foreground">
                    With an account, cancel from{" "}
                    <Link href="/my-activity/bookings" className="font-semibold text-primary underline decoration-accent underline-offset-4 hover:text-accent focus-visible:rounded-control">My bookings</Link>{" "}
                    before the deadline shown on your booking. Once a booking has started, it can no longer be cancelled online.
                  </dd>
                  <dd className="mt-2 text-muted-foreground">Booked as a guest? {guestCancellationInstruction}</dd>
                </div>
                <div className="border-t border-border py-4">
                  <dt className="font-semibold text-foreground">Refunds</dt>
                  <dd className="mt-1 text-muted-foreground">Cancelling a booking paid online refunds the amount paid to the original payment method. The cancellation is complete once the refund is confirmed; until then, your booking stays in place. Bookings to be paid at the club are cancelled straight away.</dd>
                </div>
              </dl>

              <h4 className={`${eyebrowClassName} mt-8 text-muted-foreground`}>Notice by location</h4>
              <div className="mt-3">
                <Suspense fallback={<p role="status" className="border-t border-border pt-4 font-sans text-sm text-muted-foreground">Loading booking terms…</p>}>
                  <ClubBookingTerms locations={locations} />
                </Suspense>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="visit" aria-labelledby="club-visit-title" className={`${sectionClassName} bg-forest-900 text-chalk`}>
        <div className="mx-auto max-w-7xl">
          <div className={`${styles.reveal} grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-end lg:gap-16`}>
            <div>
              <p className={`${eyebrowClassName} text-accent-on-dark`}>Contact &amp; visit</p>
              <h2 id="club-visit-title" className={`${headingClassName} mt-4 max-w-[12ch]`}>Come and see us.</h2>
            </div>
            <p className={`${bodyClassName} max-w-xl text-ivory`}>
              Opening hours for the coming week, directions and booking for every location. The best way to get to know the club is still to book a court and see for yourself.
            </p>
          </div>
          <div className="mt-10 md:mt-14">
            <Suspense fallback={<p role="status" className="border-t border-ivory/30 pt-5 font-sans text-base text-ivory">Loading locations…</p>}>
              <ClubLocations locations={locations} />
            </Suspense>
          </div>
        </div>
      </section>
    </main>
  );
}
