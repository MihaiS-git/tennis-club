# Coaching

Admin-configured programs, public coach profiles and coaching prices form the foundation.
Coaches and Admins manage private coach availability (see [Coach availability](#coach-availability)).
Private and Semi-private lessons are booked online at `/book?mode=coaching`, using protected
coach/court holds and the shared checkout, settlement, expiry and refund lifecycle.
Coaching packages are planned, not implemented. Customer lesson rescheduling uses the shared My Activity editor
(see "Lesson rescheduling"). Group and Junior sessions are organized by the coach or club, who
reserve the court through the existing staff reservation; they are paid at the club and are never
booked or paid online (see [Online booking by program type](#online-booking-by-program-type)).

## Data model

The initial migration creates six coaching tables, generated from the
entity metadata (`db/migration-cutover.integration.test.ts` keeps them equal).
Browser roles have no grants on any of them.

| Table | Purpose |
| --- | --- |
| `coaching_programs` | Name, description, `program_type` (`private`, `semi_private`, `group`, `junior`), min/max participants (nullable in storage; required, 1 ≤ min ≤ max ≤ 100, for an active program), `court_rental_included`, `is_active`. Unused programs may be deleted; booking history requires deactivation. |
| `coaching_program_durations` | Any nonempty subset of 60, 90 and 120 minutes, for every program type. |
| `coach_profiles` | Public coaching profile keyed by `user_id`: display name, bio, qualifications, specialties, languages, `is_public`. A sibling of `player_profiles`. |
| `coach_locations`, `coach_programs` | Where a coach teaches and which programs they offer. |
| `coaching_prices` | The only coaching price table: one explicitly configured **lesson price/person** (`amount_minor` > 0) for program × `duration_minutes` × `participant_count` (1–100) × `currency`, as a club-wide default (`coach_user_id IS NULL`) or one coach's override. Prices name no location. Used by every program type; Group/Junior have club defaults only. |

Program types are configurable labels for offerings the Admin creates; migrations seed
nothing and the application assumes no program exists (see [Development seed](#development-seed)).

PostgreSQL owns structural integrity only:

- partial unique indexes allow one club default per program × duration × participant count ×
  currency (`coaching_prices_club_default`) and one override per coach × program × duration ×
  participant count × currency (`coaching_prices_coach_override`);
- `coaching_prices_participants_check` keeps every lesson price's participant count in 1–100;
- `coaching_prices_duration_fkey` prevents prices for a duration the program does not offer;
- the composite `coaching_prices_coach_program_fkey` `(coach_user_id, program_id)` requires an
  override's coach to offer that program (MATCH SIMPLE skips it for club defaults).

Programs are club-wide. Coach↔location (`coach_locations`), coach↔program (`coach_programs`) and
availability↔location are independent relationships; no program is tied to a location.
- restrictive foreign keys protect pricing dependencies. Admin program edits and deletion explicitly remove owned configuration atomically; bookings and financial records never cascade.

## Coach eligibility

A coach profile does not grant a role. Creating a profile, or making one public,
requires an active account holding the `coach` role (other roles may also be held).
The public projection rechecks this on every read, so suspending an account or
removing its coach role hides the coach immediately without changing the profile.
Admin shows such profiles with a warning badge and keeps them editable while hidden.

## Pricing

There is one pricing model, **Lesson price/person**: what each player pays for one complete
lesson of one program, duration and number of players. Its identity is program × duration ×
participant count × currency × Club/Coach scope, and the only calculation is
`coachingLessonAmount()` in `src/lib/coaching/pricing.ts`:

```text
coachingTotalMinor = configuredPricePerPersonMinor × participantCount
```

Nothing scales by duration: there are no hourly rates, no `/60`, no extrapolation, no fallback
and no automatic tiers. Every duration × participant count is entered independently; a missing
configuration means the lesson is unavailable. Applicable court rental is added separately.
Booking revisions snapshot the resolved `pricePerPersonMinor`, `participantCount` and the
charged `amountMinor`.

The Admin manages club defaults only, in the Program Create/Edit dialog (`saveCoachingProgram` in
`src/lib/coaching/admin.ts`: `club_prices` and explicit `removed_club_prices`, each naming a
currency, one of the program's selected durations and a participant count); its input cannot name
a coach. Saved counts must lie in the program's submitted range, and a saved price's currency must
be charged by a current location (`invalid-currency`); a price in a currency no current location
charges can only be removed. Coach overrides are shown read-only in the Admin Coach dialog. A coach manages only their own
overrides (`saveOwnCoachingPrice` / `removeOwnCoachingPrice` in `src/lib/coaching/coach-pricing.ts`):
the owner is the verified session's account, never input, and the coach must have an eligible
profile offering the program.

`/coach/pricing` (My prices, in the Coach navigation) lists, for each assigned program,
duration, participant count of the current range and pricing currency, the club price, the coach's own price and the effective
booking price (`loadOwnCoachPricing`). Pricing currencies are those of the coach's active
assigned locations; locations sharing a currency share its prices, and a currency that
still holds one of the coach's overrides stays listed so it can be removed. The coach
sets, edits or removes their own price inline (removal restores the club price, if any,
without confirmation); a row with neither price shows "Not configured". Price changes
affect new quotations only.

`resolveCoachingPrice()` in `src/lib/coaching/pricing.ts` is deterministic, for the program,
duration, participant count and the booking location's currency (exact matches only):

1. the coach's override, if one exists, whether higher or lower than the club default;
2. otherwise the club default;
3. otherwise no price: the lesson cannot proceed to payment. No price is invented.

The booking location determines the currency; amounts are never converted. After a permitted
location currency change ([prerequisites](architecture.md#location-currency-changes)), prices in
the old currency stay stored but no longer apply to that location until prices exist in its new currency. Duplicate matches throw.

### Group and Junior prices

Group and Junior programs have no coach overrides. Their club lesson prices/person have the same
meaning as for other programs and are tied to an explicit program duration: one price per
duration × participant count × pricing currency, saved with the program (`saveCoachingProgram`).
Missing prices stay missing: nothing is defaulted, interpolated or tiered. They are
informational (organized and paid at the club, never a checkout price); court rental is never
included.
Saved counts must lie in the program's submitted `min_participants`–`max_participants` range
(`invalid-input` without a valid range) and the currency must be charged by a current
location (`invalid-currency`); amounts must be positive. Removal accepts any stored count.

`saveOwnCoachingPrice` returns `club-priced` for these programs.

### Configuration changes reconcile prices

Saving a program (`saveCoachingProgram`, `deleteObsoleteProgramPrices` in the same transaction,
before the program update) deletes every club and coach price the new configuration no longer
allows: counts outside the new range, removed durations (in every currency, including currencies
no current location charges in), and coach prices when the type becomes Group or Junior. Club
prices keep their meaning across type changes. A program saved without a valid range keeps no
prices. The Program dialog lists the club and coach prices that will be removed before saving.
Expanding the range or re-adding a duration never restores deleted prices; the new counts start
unconfigured. Booking revisions keep their snapshots, so pending and confirmed bookings are
unaffected (see [Lesson availability and quotes](#lesson-availability-and-quotes)).

## Admin

`/admin/coaching` (Programs, Coaches, Coach availability) is active-Admin-only at the layout and
in every service. Server Actions only delegate to `src/lib/coaching/admin.ts`, which
validates with Zod, authorizes, and runs short READ COMMITTED transactions:

- programs and their club prices: exclusive configuration fence → Admin fence → (current location
  currencies, read only when prices are saved) → program `FOR UPDATE`; prices outside the new range
  or durations (club and coach, every currency), and coach prices of a Group/Junior program, are
  deleted before the program update and duration changes, then submitted club price removals and
  upserts (arbitrated by `coaching_prices_club_default`) are applied, all in the same transaction;
- coaches: configuration share fence → profile `FOR UPDATE` → ordered locations `FOR SHARE`
  → Admin fence → coach account facts `FOR SHARE` → programs `FOR SHARE`; removing a program
  assignment deletes that coach's overrides for that program in the same transaction (club
  defaults, other coaches' overrides and booking snapshots are untouched; this grants the
  Admin no price editing); locations do not affect prices; new assignments need a
  non-archived location;
- coach's own prices: configuration share fence → coach profile `FOR SHARE` → coach account
  facts `FOR SHARE` → program `FOR SHARE`; arbitrated by `coaching_prices_coach_override`.

The UI follows the Admin conventions: compact tables, inline program status (deactivation
confirms), inline coach visibility, and one Create/Edit dialog each for programs and coaches.
There is no separate Admin Prices page: club prices are edited only in the Program dialog.
The Coach dialog has a read-only Individual prices section listing that coach's overrides
grouped by program and ordered by duration, participant count and currency (or "No individual
prices"); the Admin cannot edit them, and coaches keep managing them under `/coach/pricing`.
Unchecking a program assignment shows, before saving, how many of the coach's individual prices
saving will remove, and marks them in that section.

An active program needs explicit participant limits: saving an active program without both limits
is `invalid-input` with field errors (the dialog shows them inline and keeps Save disabled), and
activating a stored program whose limits are missing or invalid returns `participants-required`.
Stored values are never changed automatically; an existing incomplete program stays as stored
(and unbookable) until an Admin enters its limits. Confirmed bookings keep the participant count
recorded in their revision evidence regardless of later limit changes.

The Program Create/Edit dialog also edits club prices: one input per permitted participant count
and pricing currency, for each selected duration, labelled "Lesson price/person" for every program
type (currencies of current locations, plus any currency that still holds prices,
labelled with the locations charging in it), on the `coaching_prices` rows with coach `NULL`.
A currency no current location charges shows only its saved prices, read-only, with Remove; it
offers no inputs for new prices. An empty input means not configured, never zero; removing a saved price is an
explicit Remove action. Program details, durations and submitted club price changes save in one
transaction (configuration exclusive fence → Admin fence → program `FOR UPDATE`); unsupported
currencies are rejected as invalid input, and saved prices in a currency no current location
charges as `invalid-currency`. Save is disabled without changes or with invalid entries; server
errors appear beside the prices and entered values are kept. Range, duration and type changes reconcile prices as
described in [Configuration changes reconcile prices](#configuration-changes-reconcile-prices).

## Public page

`/coaching` is the same for visitors and members. One request-time read
(`readPublicCoaching`) uses an explicit SQL projection: active programs, public eligible
coaches and their prices. It selects no email, contact or account fields. Locations come
from the existing public location eligibility, so non-public locations and coach assignments
are omitted. Each data section has empty and unavailable states, and nothing is invented.

The page presents Programs, Coaches, How it works and FAQ. It is not a price catalogue: each
program shows a single "From" price per currency, coach cards show no prices, and a link leads
to `/pricing#coaching`. Every lesson price of a coach is on that coach's profile.

Each program's "From" price per currency (`fromPrices`, computed in `public.ts` from the
database facts, never hardcoded) reads "From … per person per lesson" and never mixes currencies:

- Group/Junior: the lowest club lesson price/person for a current duration and count;
- Private/Semi-private: the lowest effective price (coach override, else club price) over every
  public eligible coach assigned to the program at a public location charging in that currency,
  every count of the current range and every configured duration; when no such coach teaches in a
  currency, the lowest published club price in it.

Every program type requires at least one club/default price for a current duration and participant
count in a public location's currency before appearing in public discovery, `/pricing` or coach
offerings. Coach overrides alone cannot publish a program. A partial club price grid is sufficient;
unconfigured combinations remain unavailable unless an eligible coach override prices them.
Online booking selectors require a club price in the selected location's currency, matching lesson
availability and checkout eligibility. Unpriced programs remain visible and editable in Admin.
Prices outside the current configuration are never considered. Price and configuration actions revalidate the public pages.
Group/Junior program cards state that sessions are arranged with the coach or club and paid at
the club; they contain no booking links. Coach profiles list rates and lessons only for Private
and Semi-private programs.

`/pricing` repeats the same `fromPrices` per program, with the factors behind lesson prices
(duration, number of players, coach overrides) and whether court rental is included. A starting
price is never tied to a particular duration, group size or coach, and is never added to a court
rate. Coaches with their own prices (`PublicCoach.rates`) are linked to their profiles.

The homepage coaching section names the active programs from the same read
(`readPublicCoaching` on the public locations), with neutral copy when none are published
or the read fails. No program category is hardcoded.

## Public coach profiles

`/coaching/coaches/[coachId]` uses the coach's `user_id` as its stable identifier. Coach
cards on `/coaching` link to it, and it links back to `/coaching#coaches`. `readPublicCoach`
reuses the public facts read and projection, so a profile is shown only while it is public
and its account is active and holds the `coach` role. Malformed, unknown and ineligible
identifiers render the not-found page with a real 404 status: the page blocks on the read
(`instant = false`) instead of streaming. A failed read shows an unavailable state.

The page shows the hero (initials, name, up to three specialties, the first paragraph or
sentence of the bio), About (bio, qualifications, languages, specialties), the coach's active
programs, their public locations with links to `/courts#location-<id>` and `/contact?location=<id>`,
and lesson prices. Every program duration and participant count, in each currency of the coach's public locations, is
resolved with `resolveCoachingPrice` for that coach: the override ("<name>’s price"), else the club price,
else "Price not published". Currency rules are those of [Pricing](#pricing). There is no inline availability or lesson-time picker. When the coach passes the
booking selector rules (priced Private/Semi-private program and current/future working hours) at
one or more public locations, "Book a lesson" opens `/book?mode=coaching&location=<id>&coach=<user_id>`
at the first of them. Otherwise (e.g. only Group/Junior programs, or no working hours) the coach
stays discoverable and the page directs visitors to `/contact` instead of online booking.

Coach photographs are deferred: avatars live in the private `profile-avatars` bucket,
readable only by authenticated active users, and publishing a player avatar publicly
would need an explicit storage and consent decision. Coaches are shown with initials.

## Coach availability

Coaches set regular weekly working hours and date exceptions. Availability is private
operational data: it is not published, and alone it never makes a lesson bookable.

### Data model

The initial migration creates two availability tables (entity-generated, no browser grants):

| Table | Purpose |
| --- | --- |
| `coach_weekly_availability` | Coach, location, Monday-first `weekday` (0–6), `start_minute`/`end_minute`, inclusive `valid_from` / nullable `valid_until` (no end: unbounded). |
| `coach_availability_exceptions` | Coach, inclusive `exception_date` / `until_date`, `kind` (`unavailable`, `available`), optional location and minutes, private `note` (≤ 200). |

Minutes are local wall time at the location (like opening hours), on 30-minute boundaries,
`0 ≤ start < end ≤ 1440`; there are no overnight intervals. PostgreSQL enforces structure only:

- composite `(coach_user_id, location_id)` FKs to `coach_locations`: availability exists only at
  assigned locations, and an assignment with availability cannot be removed (Admin coach saves
  return `has-availability`; remove the availability first, including past exceptions);
- `coach_weekly_availability_no_overlap`: one coach's weekly intervals never overlap on a weekday
  on overlapping validity dates, across all locations; `coach_weekly_availability_dates_check`
  keeps the finite validity dates ordered;
- `coach_availability_exceptions_no_overlap`: one coach's inclusive date ranges and minute intervals cannot both overlap
  (a whole-day absence covers `[0, 1440)`);
- `unavailable` is coach-wide (no location), for one or more whole days (no minutes) or a single-day interval;
  `available` names one date, a location and an interval. Both dates are finite and ordered;
  multi-day rows must be whole-day time off. No daily expansion is stored.

### Schedule resolution

`resolveCoachAvailability()` in `src/lib/coaching/availability-schedule.ts` is pure and
deterministic for one local date:

1. take the weekly intervals for the date's weekday;
2. every exception whose inclusive period contains that local date overrides the weekly schedule for its interval: its range is
   removed from every weekly interval;
3. `available` exceptions are added at their location;
4. each window is converted to instants with its location's timezone (`localStartInstant`);
   local time skipped by a DST change collapses, and empty windows are dropped. Locations missing
   from the supplied timezone map are omitted, so callers decide which locations are acceptable.

Overlap is compared in wall time across locations. This is exact while a coach's locations share
a timezone (the expected case for one club); coaches teaching across timezones are not
supported exactly.

### Rules and authorization

`src/lib/coaching/availability.ts` is the single service for both areas. Coach calls take the
coach from the verified session (the input cannot name one); Admin calls name the coach.
Each change runs one READ COMMITTED transaction with the coach-profile lock order:
configuration share fence → coach profile `FOR UPDATE` → ordered locations `FOR SHARE` →
Admin fence (Admin only) → coach account facts `FOR SHARE`. The profile lock serializes all
availability writes and assignment changes per coach; TypeScript then checks:

- the coach is an active account holding the `coach` role with a coaching profile
  (`not-eligible`); Admins may still remove availability of a suspended or former coach;
- a saved location is assigned and not archived (`invalid-location`); existing rows at an
  archived location remain listed and removable;
- no overlap with the coach's other weekly intervals, or other date/minute exception ranges (`overlap`);
- adding working hours applies one location, interval and validity range to any set of weekdays in one
  transaction (the shared dialog offers Weekdays / Weekend quick toggles, shows the selected
  location's current and scheduled opening hours with Closed days, and offers only times open on
  every selected day throughout the chosen dates); every selected day is checked first, and any
  conflict returns `overlap` with the conflicting weekdays and saves nothing;
- working hours must lie inside the location's opening hours on every date they apply to
  (see below); otherwise `outside-opening-hours` names the weekdays and nothing is saved;
- validity starts today or later in the location's calendar (default: today); an edited row may keep
  its original start; ended rows (`valid_until` before today) can only be removed;
- exception dates are from today (the location's date for additional hours, the earliest local
  date across the coach's locations for absences) up to 366 days ahead; completed periods can only
  be removed (`out-of-range`); ongoing periods may retain their original start when edited;
- an edited or removed row must belong to the coach (`not-found`).

Exclusion and FK violations map to the same results.

### Opening hours dependency

A coach's working hours at a location are always contained in that location's applicable
opening hours. Opening hours are effective-dated schedules (`opening_hours_schedules`), so
working hours carry their own validity dates and are checked per schedule period; dates
covered by no schedule are closed. The pure rules are in `src/lib/coaching/working-hours.ts`
(touching opening intervals are joined; boundaries are narrowed to the 30-minute grid).

- Saving working hours (`src/lib/coaching/availability.ts`) rereads the location's schedules
  under the configuration share fence and rejects any selected weekday that is not open
  throughout the interval on every remaining date of the validity range.
- Saving opening hours (`src/lib/admin/opening-hours.ts`) reconciles every coach's working hours at
  that location in the same transaction, after pricing reconciliation, under the exclusive
  configuration fence (which excludes availability writes and booking commands). Only the dates whose
  opening hours changed are touched, from the location's today: the edited schedule's old and new
  periods when its intervals change, otherwise the dates entering or leaving it (including an
  automatically shortened current schedule). On those dates hours inside stay, partly outside are
  trimmed to the intersection (possibly several intervals), entirely outside or on closed dates are
  removed. A row whose result differs by date is split at the period boundary; earlier dates and
  history keep their hours. Extensions never extend working hours.
- Existing court and coaching reservations never block the change and are never cancelled or moved.
  Confirmed ones keep their terms and stay visible as occupancy, also outside the new hours; a pending
  checkout hold is revalidated against the new hours when its payment is confirmed.
- Other locations, other dates, and bookings with their payment records are never changed. A failure
  rolls back the opening-hours change, pricing and working hours together. The Admin is told when
  coach working hours were adjusted.

### Interfaces

- `/coach/availability` (Management sidebar: My availability) requires an active account with the
  `coach` role at the layout and in every service call. A coach without a profile sees a set-up notice.
  An Admin who also coaches sees both the Admin entries and My availability.
- `/admin/coaching/availability` (active Admin only) selects a coach (`?coach=<user_id>`) and renders
  the same `AvailabilityManager` (`src/components/coach-availability/`) with an Admin action bound
  to that coach. Ineligible coaches are flagged and read-only except for removal.

Both show assigned locations with timezones, a compact Monday–Sunday schedule of current and future
working hours (interval chips show limited validity and open one Create/Edit dialog; ended hours are
behind a disclosure), upcoming periods in a table and completed periods behind a disclosure. Explicit Add time off
and Add extra availability actions open focused dialogs. Time off has From date and Until date
(inclusive); only single-day time off offers partial-day times. The optional private note is
shared by both workflows. Edit and Remove operate on one whole persisted period.

## Coaching reservations

Lessons reuse the booking, revision, reservation and payment lifecycle through these columns:

- `court_reservations.coach_user_id` (nullable, FK `coach_profiles`): a lesson is one ordinary
  court reservation that also occupies its coach, so holds, expiry, settlement and release
  apply to both. `court_reservation_coach_no_overlap` excludes overlapping `held`/`active` rows
  for one coach on a date across all courts and locations (local wall time, as for availability);
  `court_reservation_no_overlap` still applies to the same row. Coachless rows never conflict.
- `booking_revisions.coach_user_id`, `coaching_program_id` (FKs `coach_profiles`, `coaching_programs`)
  and historical `coach_name`/`coaching_program_name`: all set for a coaching contract, all
  NULL for a court booking (`booking_revisions_coaching`). Revisions remain immutable.

Lessons start on the existing 30-minute court grid and last 60, 90 or 120 minutes. Matching a
reservation's coach to its current revision, availability, eligibility and pricing remain
TypeScript decisions. Tests: `tests/integration/db/coaching-reservations.integration.test.ts`.

## Lesson availability and quotes

`src/lib/coaching/lesson-quote.ts` is pure: callers supply one location date's facts and nothing is
read, locked or written. Only Private and Semi-private programs are offered
(one coach, one paying customer, one court); Group and Junior are `not-offered`. The customer names the participant count, which must
lie within the program's configured `min_participants`/`max_participants` (`coachingParticipantRange`).
Both limits must be set with 1 ≤ min ≤ max ≤ 100, the same rule for every type; a program with a
missing or invalid range is `not-offered`, has no offers or availability, and is not listed for
selection. There is no default range and nothing is inferred from the type. One customer books
the complete session, with no second account, enrollment, seat, booking or payment per participant.

- `quoteCoachingLesson(day, request)` decides one lesson (program, court, start, duration).
- `listCoachingLessonOffers(day, { programId, durationMinutes, participantCount })` lists every
  offerable start on every available court (supplied court order, each court and start once), priced
  for that participant count. Offers at one start are
  alternatives for a single lesson and may differ in price by court.

Rules, in order (the first failure is the result's `reason`):

1. `invalid-time`: 30-minute start, a 60/90/120-minute duration, ending by midnight.
2. `not-offered`: eligibility comes from `projectPublicCoachProfile` over the public coaching facts
   (active program, public coach with an active account holding the `coach` role, assigned to the
   program and, independently, to the location). The program type is not restricted. The location must be publicly eligible
   (`isPubliclyEligible`); callers pass only such locations and their active courts.
   Then `invalid-participants`: the requested count must lie in the program's range.
3. `invalid-duration`: the duration must be configured for the program.
4. `unpriced`: `resolveCoachingPrice` for the requested participant count in the location's
   currency (override, else club default); another count's price is never used.
5. `invalid-time`: the lesson must last its duration in real time at the location's timezone,
   so a lesson across a clock change is rejected.
6. `coach-unavailable`: the whole lesson fits one window from `resolveCoachAvailability` at this
   location (contiguous windows are joined). No buffer between lessons.
7. `coach-booked`: no overlap with the coach's held/active reservations on the date at any court or
   location (wall time, as `court_reservation_coach_no_overlap`).
8. `court-unavailable`: the court is bookable under the existing court rules (`buildCourtDay` +
   `getCalendarSelection`: open, priced, unoccupied, not past), even when rental is included.

Price: coaching amount + the court amount from the existing court calculation, or the coaching amount
alone when the program includes court rental. Currency is the location's; nothing is converted.
The quote carries the location, court, coach, program, local minutes and instants, amounts and
evidence for a future revision: the resolved coaching price (source `coach`/`club`) with its
participant count, the court's
rental value and its `capturePricingEvidence` slots. A quote is authoritative only when its facts
were read under the booking locks; booking creation, checkout and coaching mode reuse these rules below.
Tests: `tests/unit/coaching/lesson-quote.test.ts`.

## Public lesson availability

`readPublicCoachingLessonAvailability({ locationId, programId, coachId, date })` in
`src/lib/coaching/lesson-availability.ts` is a read-only, advisory projection: no booking,
reservation, hold or payment. It takes no session, so visitors and members see the
same result. Malformed input, a non-public location, and an inactive, unsupported or unoffered
program or ineligible coach all return `null`.

`readCoachingLessonDay(manager, location, coachId, date, now)` loads one location date with a fixed
set of parallel queries, independent of courts and durations: public coaching facts
(`readPublicCoachingFacts`), the public court day (`readPublicDayConfiguration`,
`readPublicDayReservations`), the coach's weekly intervals and exceptions for the date without notes
(`listCoachDayAvailability`) and the coach's held/active lesson times at every court and location
(`listCoachDayOccupancy`, times only). Expired holds follow the public court rule: free unless a
capture was accepted. Today and the current minute are the location's local values.
It takes an explicit `EntityManager` so the future checkout can reload the same facts inside its
booking transaction, after the existing locks, and requote atomically before creating a hold.

`projectCoachingLessonAvailability(day, programId, participantCount)` lists each duration priced for
that participant count on the court grid, its starts and,
per start, every available court with its coaching, court and total amounts in the location's
currency. Pricing evidence, customers, bookings and private coach data are not exposed.
Tests: `tests/unit/coaching/lesson-quote.test.ts`,
`tests/integration/coaching-lesson-availability.integration.test.ts`.

## Lesson booking creation

`createCoachingBooking(input, reader?)` in `src/lib/coaching/booking.ts` atomically creates one
pending Private or Semi-private lesson (the locked quote rejects other types) with the court-booking
lifecycle: a `pending_payment` checkout record, its `created` revision, one `held` court reservation naming the coach (`coach_user_id`) and one `pending` online
payment attempt sharing the 5-minute initial checkout deadline. It starts no Stripe checkout itself. The `/book` coaching Server Action delegates to
`commitCoachingCheckout`, which starts the shared checkout after commit. Guests book without an account and are never matched by email;
authenticated customers use the verified session account. Contact fields reuse the court
booking rules (`bookingContactShape`); the input is strict, so no account id is accepted.

One READ COMMITTED transaction, with bounded retries for parent changes:
configuration share fence → coach profile `FOR SHARE` (before locations, the order of
availability and assignment writes) → ordered locations `FOR UPDATE` (the lesson's and those
holding the coach's expired, unreleased holds) → program `FOR SHARE` → coach and customer
account facts `FOR SHARE` → provider selection. Expired holds of the lesson court and of the
coach on any court or location are released with the existing `expirePaymentHoldsAtLocation`,
since `court_reservation_coach_no_overlap` still covers them. Facts are then reread with
`readCoachingLessonDay` (sequential on the transaction connection) and requoted with
`quoteCoachingLesson`; the expected total and currency must match or `price_changed` returns the
current quote. Both GiST exclusions remain the final arbiters (`court-unavailable`, `coach-booked`).

The revision snapshots the coach and program with historical names, the agreed total, and
`pricing_evidence.coaching` (price source, coaching amount, court rental value, charged court
amount, required participant count and lesson price/person) beside the court slot evidence. Revision terms reject coaching fields that disagree with
that evidence, and later revisions carry them unchanged. Tests:
`tests/integration/coaching-booking.integration.test.ts`, `tests/unit/booking-revision.test.ts`.

## Checkout and settlement

`commitCoachingCheckout(input, reader?)` in `src/lib/coaching/checkout.ts` delegates to
`createCoachingBooking`, then passes its committed attempt ID to the existing
`startOnlineCheckout`. `/book?mode=coaching` reaches it through the shared timetable/checkout
and a thin Server Action; there is no separate booking page.
Only online payment is accepted, with one PaymentIntent for the combined total. The
stored provider, amount and currency are authoritative, including included-rental lessons.
Initialization failure returns the existing safe error and leaves the original unpaid
hold to expire; it never creates a replacement booking or payment.

Reused infrastructure:

- `startOnlineCheckout`, selected-provider configuration and the Stripe adapter's stable
  attempt-derived creation/capture keys, manual card authorization and capability attachment;
- `resolveAuthorizedCheckoutPayment`, the common authorization decision, signed webhook,
  capability-bound `readOnlineCheckout` polling and `checkOnlinePayment` Admin recovery;
- `processOnlinePaymentEvent` / the existing settlement transaction, immutable capture/event
  receipts, terminal-state protection, same-row activation and confirmation revision;
- existing TypeScript hold expiry, late-capture compensation and combined-amount refund allocation.

Court-only settlement retains its existing live court quote/policy validation. Coaching
settlement recognizes the historical revision's coach and validates that its fixed
location, court, date, interval and coach still match the locked held reservation, and
that its online combined amount/currency match the attempt. Active court/location,
publication, future-start, location currency/timezone and cancellation-policy checks remain. It never
reloads coaching prices, court rental prices or weekly coach availability: the protected
hold owns both resources and the created contract preserves the agreed coaching/court
breakdown. Confirmation copies those terms unchanged. Later weekly changes do not move
or cancel confirmed reservations. Both GiST exclusions remain authoritative.

A verified successful capture alone confirms the booking and activates its existing
reservation. Duplicate/concurrent events cannot append another confirmation. A definitive
decline ends the checkout like a court checkout (a new card needs a new checkout); terminal failure/cancellation and unpaid
expiry release both resources together. Unknown provider outcomes remain pending/uncertain
and use the existing poll/webhook/Admin process. Accepted capture keeps both resources
protected while uncertain; later observations never dispatch another capture. Unaccepted
late capture cannot reclaim occupancy and uses the existing full compensation refund.
Amount/currency mismatch records reconciliation evidence without confirmation.

The owner-scoped edit read, quote and save share `editEligibility`; coaching uses the
lesson rules in "Lesson rescheduling" below. My Activity receives an owner-filtered
`includes_coaching` flag and offers Reschedule instead of Edit for an eligible lesson. Cancellation and
combined-payment refunds reuse their existing commands unchanged; guest self-management
remains unimplemented.

### Lesson rescheduling

The owner of a confirmed online lesson may change only its date and starting time before the snapshotted modification notice; started lessons never move. The
court, coach, program, location, participants, duration and agreed coaching fee/policy are fixed.
The server rejects a different court or end inconsistent with the stored duration; quotations
calculate the end from that duration. The lesson's
coach must still be active, hold the coach role, have an unarchived profile and be assigned
to the location and program; another coach is never substituted. Public coach/program
publication is not required, but the location must still accept public lesson bookings
because the operational day reads are the public ones.

`quoteCoachingReschedule` (`src/lib/coaching/lesson-quote.ts`) applies the lesson schedule
rules (coach windows and exceptions, the coach's other lessons and holds, court occupancy,
opening hours, the court grid) to a day read with the lesson's own reservation excluded.
The total is the agreed fee plus the current court rental, or the fee alone when the
original stored agreement includes rental, regardless of current program configuration;
`lessonPricingEvidence` keeps the coaching contract and revised court amount. The
existing adjustment lifecycle handles the difference: an unchanged total moves the row and
appends a `rescheduled` revision directly; a reduction is refund-backed; an increase holds
the target for court and coach and its proposal snapshots the accepted evidence, which
settlement applies without repricing or rechecking the coach. The edit context returns the
fixed lesson terms and every available start on the original court.

In My Activity, Reschedule opens the existing booking dialog's `BookingEditForm`. For a
lesson it shows the fixed location, court, coach, program, duration and original interval, and
renders the `/book` lesson timetable (`src/components/booking-timetable.tsx`, shared with
`BookingCalendar`) from each date's edit read: a start selects the full lesson length on the
original court. Totals, surcharge checkout and refund status come from the existing
owner quote/save actions and modification UI; the browser never prices or excludes the
original reservation itself. `tests/components/lesson-reschedule.test.tsx` covers it.

### Coach lesson management

Coach List, Calendar and lesson Details use the same `OperationalBookingEdit` as Admin,
with `loadCoachBookingEditorAction`, `loadCoachBookingDayAction` and `changeCoachBookingAction`.
The spacious timetable reuses public booking presentation with staff scheduling policy;
location/date/Coach changes reload one day and invalidate the financial preview. Active Coaches manage
only lessons currently assigned to them. The loader scopes by both current revision and
reservation assignment and returns editing fields and resource choices, without account,
payment ledger, refund identity or provider data. `runOperationalBookingChange` uses Coach
capacity and rechecks assignment, role, lifecycle and stale tokens under transaction locks,
even for Admin+Coach accounts. Reassignment transfers management access immediately.

Coaches may change location, court, date/start and assigned Coach, retaining program,
duration, participants and agreed lesson fee. Own working hours, time off and location
assignments may be overridden; replacement Coaches must meet their availability restrictions.
Program assignments do not restrict operational reassignment. Actual court and Coach
occupancy always applies.

The shared server preview shows current/destination details, agreed amount, destination
price, currency, refund or club absorption and final customer obligation before explicit
confirmation. Quotes are invalidated by edits and checked again on save. Customer obligation
never increases; bundled rental and Coach-only reassignment do not reprice. Refund-backed
changes preserve the original until settlement and report pending/success/failure honestly.
Only preview amounts and settlement status reach the Coach, without refund/adjustment IDs.

The existing assigned-Coach cancellation action remains shared by all three surfaces;
Admin cancellation explanations are not accepted. Changes and cancellations reuse domain
notifications, including assignment/unassignment and actual refund settlement, with no
customer finances in Coach notifications. The management UI uses the current operational
change actions through the staff Calendar.

### Staff operational booking changes

One foundation serves Admin changes of court bookings and lessons and Coach changes of their
currently assigned lessons; both staff areas expose it through their own authorized Server Actions.

- Authorization (`src/lib/bookings/operational-policy.ts`): pure policy, evaluated under the
  booking's locks. Admin authority is independent of coach assignment; a Coach needs the Coach
  role and the current assignment (revision and reservation). An Admin+Coach account acts with
  the capacity of the operation. Overrides of configurable Coach restrictions (working hours,
  time off, location assignment): Admin for any coach, a Coach only their own. Program
  compatibility never limits a change; court and coach occupancy are never overridable.
- Target and scheduling (`src/lib/bookings/operational.ts`, `operationalSchedule` in
  `lesson-quote.ts`): date, start, court, location and, for a lesson, coach. The location must
  be locked, active, unarchived and in the booking currency; the court an active court of it;
  a destination coach needs an active account, the Coach role and an unarchived profile.
  Program, duration and participant count are the booking's own.
- Concurrency: `withBooking` with a `target` locks the current and destination coach profiles
  in id order, then the current, destination and expired-hold locations in id order, expires
  holds at the current and destination locations and retries on a changed parent or coach.
  Both GiST exclusions arbitrate races; overlap failures map to `court-unavailable` and
  `coach-booked` after rollback.
- Notifications: a completed reassignment (immediate, or after its verified refunds) sends the
  customer the updated lesson, the replacement coach an in-app `coaching.assigned` message and
  the previous coach an in-app `coaching.unassigned` message, keyed by the applied revision.
  Coach messages carry the lesson details only (no prices, payments or refunds). Pending,
  rejected and abandoned changes send no coach messages.
- Revisions: a change (including a reassignment only) appends a `rescheduled` revision whose
  coach and location columns are the operational assignment. `pricing_evidence.coaching`
  keeps `coachUserId`, `locationId` and `source` as the commercial provenance of the agreed
  price; only a `created` revision must match them.
- Financial consequence (`operationalFinancialQuote`): the destination is priced by the
  authoritative scheduling quote; a lesson keeps its agreed coaching fee and reprices only the
  court component, and a coach reassignment never reprices. An equal price changes nothing
  financially; a higher price is absorbed by the club (agreed obligation and evidence kept); a
  lower price lowers the obligation and refunds eligible collected funds through the existing
  refund-backed modification (pay-at-club: the amount due is reduced). Any consequence other
  than none must be accepted exactly as quoted (`financialAcceptance`); see
  [payments](payments-memberships.md#staff-operational-price-differences).

### Retained limitations

The existing provider-initialization/attachment ambiguity and loss of guest capability on
browser refresh remain as documented in [payments](payments-memberships.md#typeorm-checkout-boundary).

Focused coverage extends `tests/integration/coaching-booking.integration.test.ts` with mocked
Stripe and real isolated PostgreSQL. Its explicit payment matrix covers included/excluded
rental with both club defaults and coach overrides, using the stored breakdown and one
combined payment throughout. An unpriced program/duration/currency scope rejects before
any booking or Stripe write. It also verifies guest and
account identity, authorization/poll races, duplicate/concurrent settlement, missed webhooks,
unknown capture recovery, price/weekly changes, declines, expiry/resource replacement,
mismatch, late compensation, cancellation refunds and lesson rescheduling.
`tests/unit/coaching/checkout.test.ts` covers the post-commit entry point;
`tests/components/personal-activity.test.tsx` verifies that coaching offers Reschedule instead of Edit and retains Cancel.

## Coaching mode on `/book`

`/book` retains court booking. `/book?mode=coaching` adds Private and Semi-private lessons on the same
page, with mode links and shared location/date navigation. Selection order is
**Location → Coach → Program → Duration → Date/Time**, using URL navigation and server rendering:

- Location: no location is selected until the user chooses one, the URL names a public location,
  or a coach link (`coach=<user_id>`) without a location opens that coach's first public location
  where they are bookable online (falling back to their first assigned location, which then
  explains that they cannot currently be booked online). A requested coach who is not bookable at
  the selected location is never replaced: the alert names the locations where they are bookable.
- Coach: every public coach (active account, Coach role, public non-archived profile) assigned to
  the location (`coach_locations`) who passes `coachingBookingOptions` there: at least one assigned
  active Private/Semi-private program with a valid participant range and a configured price (coach
  override, else club default) for some duration and count in the location's currency, and current
  or future working hours at that location (a weekly row with a remaining occurrence in its validity
  range, or an `available` exception later today or after). The list is not filtered by the selected
  date, date-specific absences, reservations, courts or lesson slots, so a day without starts never
  removes a coach. The same rules decide a coach link's initial location and the profile CTA.
- Program: the selected coach's own `coach_programs` assignments (active programs) that are
  bookable online: Private or Semi-private with a valid participant range. Group and Junior programs,
  and programs without valid participant limits, never appear; they are arranged with the coach or
  club. Nothing is derived from the location.
- Duration: the program's configured subset of 60, 90 and 120 minutes,
  each labelled with its effective price for the selected number of players (`coachingBookingOptions`
  and `coachingDurationPrice` in `src/lib/coaching/booking-options.ts`): the coach's override, else
  the club default, for that exact count in the location's currency; otherwise "price unavailable",
  which blocks lesson starts and checkout.
- Players: the program's configured participant range (`participants=<count>`, defaulting to the
  smallest count with a configured price for the selected duration, else the minimum). A count
  outside the range is reported and blocks lesson starts and checkout; a count without a price is
  "price unavailable". The server re-resolves the price of the submitted count at checkout and
  rejects a mismatching expected total.
- Date/Time: only then is `readPublicCoachingLessonAvailability` called; it intersects the coach's
  windows at the location, exceptions, coach and court occupancy, opening hours and court rules.

Nothing is selected automatically. A URL selection is honoured only while its upstream selection
is valid; otherwise an alert explains it and it stays unselected (no substitute is chosen).
Each step has an explicit empty state (no location, no coaches, no programs, nothing bookable
online, no price, no lesson starts), and selectors stay disabled until their prerequisite is set.

`BookingContent` reuses `readPublicCoaching` for the public options and the completed
`readPublicCoachingLessonAvailability` for priced durations and complete lesson offers.
`BookingCalendar`, `BookingTimetable`, `CourtTimelineGrid`, `TimelineLegend`,
`CalendarControls`, `LocationSelect` and `CalendarDateNavigation` remain shared. Every
active public court at the selected location stays in the existing single-day timetable,
including courts without a lesson offer. Only server-offered full-duration starts are
selectable; selection never derives a coaching total from court hourly rates. The full
chosen interval is highlighted, with the server-quoted combined total and breakdown in
the sticky selection bar and shared `BookingSummary`. Included court rental is labelled
Included; separately charged rental is shown in the location currency beside coaching.

The shared `BookingConfirmation` retains customer details, account defaults, guest support,
validation, `OnlinePayment`/Payment Element, checkout dismissal/cancellation, status polling
and server-verified confirmation. Its thin `commitCoachingBookingAction` validates the
coaching checkout schema and delegates to `commitCoachingCheckout`; it returns the existing
pending-checkout contract, never a client-side confirmation. Coaching offers online
payment only. No provider adapter, lifecycle, pricing rule or backend availability logic
is reimplemented. Coaching success names the coach/court booking without promising an
email template that does not exist.

Location changes keep a chosen coach (never substituting another), clear program and duration,
and resolve the new location's current date;
coach changes clear program and duration; program changes clear duration. Date navigation
retains valid lesson preferences. Location/date key the calendar; program/coach/duration key its selection and review subtree.
Changing lesson preferences clears the chosen court/interval while retaining edited contact details. Stale availability or
price at submission clears selection and refreshes offers while retaining entered contact;
a price change requires selecting a fresh offer and reviewing its full breakdown. Once
checkout holds resources, its chosen quote remains snapshotted in UI state across action
revalidation, even when that hold disappears from public availability. Payment outcomes
continue to come exclusively from the existing verified status flow.

Coaching and coach detail pages link to the shared booking route.

## Development seed

`npm run db:dev:seed:coaching` (`scripts/seed-dev-coaching.ts`) populates demo coaching data
for evaluating the public and Admin pages. It runs only when invoked explicitly, never from
migrations or deployment, and refuses anything but local Supabase (`127.0.0.1:54321`) and
the local development database (`127.0.0.1:54322/postgres`) before any Auth or database access.

- Accounts: `demo-coach-{andrei,maria,daniel,sofia}@example.test`, created through the local
  Auth Admin API (as `seed:users` does) with the password `StrongPassword123!`. Existing
  accounts, including their passwords, are never updated. The seed assigns the `coach`
  role and refuses to continue if an account is suspended.
- Programs: Private, Semi-private, Group and Junior coaching, with fixed IDs
  (`c0ac0000-0000-4000-8000-00000000000{1-4}`), durations, participant limits and court inclusion.
- Coaches: four public profiles assigned to existing current locations (none are created);
  the fixture's location indexes wrap to the locations that exist.
- Prices: explicit club-wide RON lesson prices/person for every duration × player count of
  each seeded program (Group and Junior included, per duration) and a few coach overrides for
  Private and Semi-private, written only when a current location charges in RON; locations in
  other currencies are reported as unpriced.

One READ COMMITTED transaction takes the Admin coaching lock order (configuration share fence →
locations → programs → coach account facts → profiles). Only missing records are inserted:
existing programs, profiles, assignments and prices are never updated or removed, so Admin
edits survive reruns and nothing is duplicated. Bookings, reservations and payments are
not touched. Remove seeded data through Admin (deactivate programs, hide coaches).

## Tests

```bash
npx vitest run tests/unit/coaching tests/components/coaching-page.test.tsx \
  tests/components/admin-coaching.test.tsx tests/components/homepage-coaching.test.tsx \
  tests/components/coach-profile-page.test.tsx \
  tests/components/coach-availability.test.tsx tests/components/admin-navigation.test.tsx
npm run test:integration -- tests/integration/admin/coaching.integration.test.ts \
  tests/integration/admin/coach-availability.integration.test.ts \
  tests/integration/coaching-lesson-availability.integration.test.ts \
  tests/integration/coaching-booking.integration.test.ts
```


## Online booking by program type

Only Private and Semi-private programs (`isOnlineCoachingProgramType`) are bookable online. The
type is checked at every boundary: booking options (`coachingBookingOptions`), public lesson
availability (`projectCoachingLessonAvailability`), the pure quote (`lessonDay` returns
`not-offered`), and therefore `createCoachingBooking` and `commitCoachingCheckout`, which reuse the
locked quote. The Coaching mode never lists Group/Junior programs, and a coach whose only programs
are Group/Junior is not a selector option. Historical Group/Junior bookings keep their revisions,
financial records, settlement, cancellation, refund and rescheduling lifecycle unchanged.

Within the online types, eligibility depends on configuration (active, assigned, priced,
available, valid participant range). The Coaching mode shows actual configured program names,
never selects a program automatically, and offers only priced configured durations on the
existing court grid. Switching programs preserves the coach and customer contact
while clearing the previous duration, interval and review. The whole lesson must fit coach and court
availability.

The coaching amount is the configured lesson price/person for the selected duration and exact
participant count, multiplied by that count (`coachingLessonAmount()`); one customer pays for all
participants. The resolver chooses the coach override, then club default; no applicable price
means unavailable. Included rental adds zero; excluded rental adds the selected court's full interval
price once. There is one combined Stripe payment. New revisions snapshot the participant count beside
the historical program/coach names and agreed amounts; confirmation carries those terms unchanged.
The shared summary displays participants, program, coach, location, court, duration and price breakdown
in review, checkout and verified confirmation.

Focused validation commands:

```bash
npx vitest run tests/unit/coaching/lesson-quote.test.ts tests/unit/coaching/checkout.test.ts \
  tests/unit/coaching-booking-action.test.ts tests/unit/booking-revision.test.ts tests/unit/book-page.test.tsx \
  tests/components/coaching-booking-controls.test.tsx tests/components/booking-calendar.test.tsx \
  tests/components/coaching-page.test.tsx tests/components/coach-profile-page.test.tsx
npm run test:integration -- tests/integration/coaching-booking.integration.test.ts \
  tests/integration/coaching-lesson-availability.integration.test.ts
npm run typecheck
```

The integration tests use the existing isolated PostgreSQL test project and mocked Stripe SDK calls.
They cover guest/account checkout, both price sources, included/excluded rental, historical confirmation,
configured durations, coach/court conflicts through the same semi-private path, Group/Junior
rejection and preserved historical Group/Junior lessons. No database reset or real payment is required.

## Removing programs and coaches

Both Admin tables expose Pencil Edit and Trash2 Delete actions, preserving inline status/visibility.
Program Edit reuses the Create/Edit dialog and retains rejected inputs. Duration removal is one save:
only removed durations and their prices are deleted; retained configuration and immutable booking
snapshots (including pending checkout agreements) are untouched. A program can be permanently
deleted with its prices, coach assignments and durations only if no booking revision references it.
The confirmation offers explicit deactivation when booking history blocks deletion.

Coach removal is Admin-only and uses the exclusive configuration fence, coach profile lock and
Admin account fence. A held reservation or active lesson whose location-local end is still in the
future blocks removal; no lesson is cancelled or refunded. Without reservation/revision references,
the profile is physically deleted after prices, availability exceptions, weekly availability,
program assignments and location assignments. With only historical references, the same cleanup
archives the profile instead (`archived_at`) and hides
it publicly. The UI reports archiving separately from physical deletion. Archived profiles are
excluded from roster, availability and booking reads and cannot be republished or edited through
normal Admin mutations. Historical names, contracts, reservations and financial evidence remain.
Auth/account records, player profiles, roles and personal court bookings are never removed.

Revoking the Coach role (`updateAdminUserRole`) or suspending the account (`updateAdminUserStatus`)
applies the same rule (`coachHasActiveLessons`) and returns `active-lessons`, after the existing
final-admin and self-management checks. Both lock the target's role and account rows `FOR UPDATE`
while lesson checkout holds them `FOR SHARE`, so a concurrent checkout either commits first and
blocks the change, or waits and is refused because the coach is no longer eligible.

Focused regressions: `admin/coaching.integration.test.ts` covers cross-location/override/stale-currency
cleanup, retained prices, rollback, real foreign keys, removal authorization, historical protections,
coach eligibility and preserved identities. `admin-coaching.test.tsx` covers visible icon actions,
confirmation, explicit deactivation, archive feedback and canonical Junior duration selection.

## Management lists and time-off ranges

Programs use `q`, `type`, `status`, `sort` (`name`, `type`, `status`), `dir` and `page`.
Coaches use `q`, `status`, `profile`, `visibility`, `sort`, `dir` and `page`. Both use the extracted shared ManagementTableToolbar,
shared sortable headings and existing Pagination. Query boundaries normalize invalid/repeated
parameters. Sorting is changed only through column headings (first click ascending, second
descending); there are no Sort/Direction controls. Filter/sort changes reset pagination; Clear
filters resets the list URL. In Coaches, the
Visibility filter treats coaches without a profile or with an archived profile as Hidden.
Repository SELECTs apply filtering/sorting/counting and 20-row pagination in PostgreSQL;
counts and page reads share a read snapshot. The Programs page also reads the listed programs'
prices (for the Program dialog), and the Coaches page the listed coaches' own overrides (for the
read-only Individual prices section). Checkout resolution uses the same resolver.

Saving time off rejects overlapping active coaching occupancy, unexpired holds and
payment-protected holds past their deadline (registered unresolved intents or accepted
captures, the shared `protectedPaymentOccupancy` rule) with `booking-conflict`, preserving
every booking. Extra availability at a different location
also rejects such conflicts. This check uses each reservation's own local playing date and
half-open minutes under the existing coach-profile write fence; booking commands hold its
shared counterpart before location locks and reread the ranged schedule. Expired unprotected holds do not
reject configuration. PostgreSQL's inclusive `daterange` plus minute-range GiST exclusion backs
TypeScript overlap checks. Availability never bypasses opening hours, public eligibility,
court/coach occupancy or other existing lesson quote restrictions.

`coach_availability_exceptions.until_date` is non-null; single-day periods store identical
start and end dates. Focused range integration coverage is in
`tests/integration/admin/coach-availability.integration.test.ts`; list coverage is in
`tests/integration/admin/coaching-lists.integration.test.ts`.

### Canonical durations

The initial schema restricts `coaching_program_durations` to 60, 90 and 120 minutes with
`coaching_program_durations_minutes_check`, matching the TypeScript duration list. The CHECK
applies to configuration only; booked lessons and revisions keep their own snapshots.

Rescheduling notifications always retain the eligible customer/Coach in-app messages.
Email is optional and queues only when Admin has enabled configured delivery in Club settings;
Admin/Coach accounts never receive transactional application email. The coaching integration
fixture explicitly selects disabled/unconfigured or enabled/configured settings, restores the
previous singleton values, and never dispatches Brevo. Supabase Auth mail is independent.


## Baseline and legacy preservation

The two final-state baseline migrations create the complete pricing schema directly:
`coaching_prices` is the only coaching price table, and there is no pricing unit column,
participant-rate table, repair migration, conditional schema upgrade or automatic price
expansion. Local development databases are rebuilt from the baseline
(`npm run db:dev:rebuild`) and reseeded rather than patched in place.
