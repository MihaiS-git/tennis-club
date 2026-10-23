# Coaching

Admin-configured programs, public coach profiles and coaching prices form the foundation.
Coaches and Admins manage private coach availability (see [Coach availability](#coach-availability)).
Reservation Steps 1–6 support Private and Semi-private lessons on `/book?mode=coaching`, using protected
coach/court holds and the existing combined-payment, settlement, expiry and refund lifecycle.
Coaching packages remain deferred. Customer lesson rescheduling uses the shared My Activity editor
(see "Lesson rescheduling").

## Data model

The initial migration creates six coaching tables, generated from the
entity metadata (`db/migration-cutover.integration.test.ts` keeps them equal).
Browser roles have no grants on any of them.

| Table | Purpose |
| --- | --- |
| `coaching_programs` | Name, description, `program_type` (`private`, `semi_private`, `group`, `junior`), optional min/max participants, `court_rental_included`, `is_active`. Unused programs may be deleted; booking history requires deactivation. |
| `coaching_program_durations` | Any nonempty subset of 60, 90 and 120 minutes, for every program type. |
| `coach_profiles` | Public coaching profile keyed by `user_id`: display name, bio, qualifications, specialties, languages, `is_public`. A sibling of `player_profiles`. |
| `coach_locations`, `coach_programs` | Where a coach teaches and which programs they offer. |
| `coaching_prices` | A club-wide default (`coach_user_id IS NULL`) or one coach's override for a program duration in one `currency`, with `amount_minor`. Prices name no location. |

Program types are configurable labels for offerings the Admin creates; migrations seed
nothing and the application assumes no program exists (see [Development seed](#development-seed)).

PostgreSQL owns structural integrity only:

- partial unique indexes allow one club default per program × duration × currency
  (`coaching_prices_club_default`) and one override per coach × program × duration × currency
  (`coaching_prices_coach_override`);
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

The Admin manages club defaults only (`saveClubCoachingPrice` / `removeClubCoachingPrice` in
`src/lib/coaching/admin.ts`); their input cannot name a coach. A coach manages only their own
overrides (`saveOwnCoachingPrice` / `removeOwnCoachingPrice` in `src/lib/coaching/coach-pricing.ts`):
the owner is the verified session's account, never input, and the coach must have an eligible
profile offering the program.

`/coach/pricing` (My prices, in the Coach navigation) lists, for each assigned program,
duration and pricing currency, the club price, the coach's own price and the effective
booking price (`loadOwnCoachPricing`). Pricing currencies are those of the coach's active
assigned locations; locations sharing a currency share its prices, and a currency that
still holds one of the coach's overrides stays listed so it can be removed. The coach
sets, edits or removes their own price inline (removal restores the club price, if any,
without confirmation); a row with neither price shows "Not configured". Price changes
affect new quotations only.

`resolveCoachingPrice()` in `src/lib/coaching/pricing.ts` is deterministic, for the program,
duration and the booking location's currency:

1. the coach's override, if one exists, whether higher or lower than the club default;
2. otherwise the club default;
3. otherwise no price: the lesson cannot proceed to payment. No price is invented.

The booking location determines the currency; amounts are never converted. After a location
currency change, prices in the old currency stay stored but no longer apply to that location
until prices exist in its new currency. Duplicate matches throw.

## Admin

`/admin/coaching` (Programs, Coaches, Prices) is active-Admin-only at the layout and
in every service. Server Actions only delegate to `src/lib/coaching/admin.ts`, which
validates with Zod, authorizes, and runs short READ COMMITTED transactions:

- programs: exclusive configuration fence → Admin fence → program `FOR UPDATE`; removed durations delete all their club/coach prices in every currency before removing duration associations, in the same transaction;
- coaches: configuration share fence → profile `FOR UPDATE` → ordered locations `FOR SHARE`
  → Admin fence → coach account facts `FOR SHARE` → programs `FOR SHARE`; removing a program
  assignment deletes that coach's overrides for that program in the same transaction (club
  defaults, other coaches' overrides and booking snapshots are untouched; this grants the
  Admin no price editing); locations do not affect prices; new assignments need a
  non-archived location;
- club prices: configuration share fence → Admin fence → program `FOR SHARE`; the upsert is
  arbitrated by `coaching_prices_club_default`;
- coach's own prices: configuration share fence → coach profile `FOR SHARE` → coach account
  facts `FOR SHARE` → program `FOR SHARE`; arbitrated by `coaching_prices_coach_override`.

The UI follows the Admin conventions: compact tables, inline program status (deactivation
confirms), inline coach visibility and inline club prices, and one Create/Edit dialog each
for programs and coaches. The Prices page shows individual coach prices read-only; the Admin
cannot edit them.

The Program Create/Edit dialog also edits club prices: one input per selected duration and
pricing currency (currencies of current locations, plus any currency that still holds prices,
labelled with the locations charging in it), on the same `coaching_prices` rows (coach `NULL`)
as Prices. An empty input means not configured, never zero; removing a saved price is an
explicit Remove action. Program details, durations and submitted club price changes save in one
transaction (configuration exclusive fence → Admin fence → program `FOR UPDATE`); unsupported
currencies are rejected as invalid input. Removing a duration still deletes its club and coach
prices, and the dialog lists the affected prices before saving.

## Public page

`/coaching` is the same for visitors and members. One request-time read
(`readPublicCoaching`) uses an explicit SQL projection: active programs, public eligible
coaches and their prices. It selects no email, contact or account fields. Locations come
from the existing public location eligibility, so non-public locations and coach assignments
are omitted. Club prices are listed per currency charged by a public location; a coach's own
prices are listed in the currencies of that coach's public locations. Each data section has empty and unavailable states, and
nothing is invented.

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
programs, their public locations with links to `/courts#location-<id>` and `/club#visit`,
and lesson prices. Every program duration, in each currency of the coach's public locations, is
resolved with `resolveCoachingPrice` for that coach: the override ("<name>’s price"), else the club price,
else "Price not published". Currency rules are those of [Pricing](#pricing). There is no inline availability or lesson-time picker; a booking link opens
`/book?mode=coaching&coach=<user_id>` with the coach preselected.

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
a timezone (the expected case for one club); see the open decisions below.

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
- Before any write, the change is rejected (`booking-conflict`, with the dates) if a live court or
  coaching reservation at the location that fits the current opening hours would fall outside the new
  ones on an affected date and has not yet ended. Live means active, or held with an unexpired hold or
  an accepted capture, the occupancy rule of booking commands; containment is the booking rule
  (`fitsOpeningHours`). Nothing is cancelled or moved: the Admin moves or cancels those bookings first.
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

### Before coaching reservations

A future engine will intersect resolved coach windows with program durations, location opening
hours, court availability, court reservations and coaching reservations, under the existing
location-first occupancy locks. Open decisions:

- the slot grid (program duration vs. 30-minute starts) and buffer time between lessons;
- whether coach eligibility, location publication and archived locations gate resolution
  (the resolver leaves this to its caller);
- how a coaching reservation reserves the coach (e.g. a coach-time GiST exclusion) alongside the
  court reservation, and how weekly edits or new absences treat already-booked lessons;
- multi-timezone coaches: compare intervals by instant per date instead of wall time;
- booking horizon and minimum notice for lessons.

## Coaching reservations (persistence foundation)

The initial migration's coaching columns let lessons reuse the existing booking,
revision, reservation and payment lifecycle. Server-side checkout, settlement and `/book?mode=coaching` now use it.

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
read, locked or written. Private and Semi-private programs are offered (one coach, one paying customer, one court).
Private has one player; Semi-private has two players. One customer books the complete session,
with no second account, enrollment, booking or payment. Group and Junior remain excluded.

- `quoteCoachingLesson(day, request)` decides one lesson (program, court, start, duration).
- `listCoachingLessonOffers(day, { programId, durationMinutes })` lists every offerable start on
  every available court (supplied court order, each court and start once). Offers at one start are
  alternatives for a single lesson and may differ in price by court.

Rules, in order (the first failure is the result's `reason`):

1. `invalid-time`: 30-minute start, a 60/90/120-minute duration, ending by midnight.
2. `not-offered`: eligibility comes from `projectPublicCoachProfile` over the public coaching facts
   (active program, public coach with an active account holding the `coach` role, assigned to the
   program and, independently, to the location). The program must be `private` or `semi_private`. The location must be publicly eligible
   (`isPubliclyEligible`); callers pass only such locations and their active courts.
3. `invalid-duration`: the duration must be configured for the program.
4. `unpriced`: `resolveCoachingPrice` in the location's currency (override, else club default).
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
evidence for a future revision: the resolved coaching price (source `coach`/`club`), the court's
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

`projectCoachingLessonAvailability` lists each priced duration on the court grid, its starts and,
per start, every available court with its coaching, court and total amounts in the location's
currency. Pricing evidence, customers, bookings and private coach data are not exposed.
Tests: `tests/unit/coaching/lesson-quote.test.ts`,
`tests/integration/coaching-lesson-availability.integration.test.ts`.

## Lesson booking creation

`createCoachingBooking(input, reader?)` in `src/lib/coaching/booking.ts` atomically creates one
pending Private or Semi-private lesson with the court-booking lifecycle: a `pending_payment` booking, its `created`
revision, one `held` court reservation naming the coach (`coach_user_id`) and one `pending` online
payment attempt sharing the hold deadline. It starts no Stripe checkout itself. The `/book` coaching Server Action delegates to
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
amount and participant count; older private revisions may omit the count) beside the court slot evidence. Revision terms reject coaching fields that disagree with
that evidence, and later revisions carry them unchanged. Tests:
`tests/integration/coaching-booking.integration.test.ts`, `tests/unit/booking-revision.test.ts`.

## Step 5: shared Stripe checkout and settlement

`commitCoachingCheckout(input, reader?)` in `src/lib/coaching/checkout.ts` delegates to
`createCoachingBooking`, then passes its committed attempt ID to the existing
`startOnlineCheckout`. Step 6 connects it to `/book?mode=coaching` through the existing
timetable/checkout and a thin Server Action; there is no separate booking page.
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
reservation. Duplicate/concurrent events cannot append another confirmation. Declines
remain retryable under the existing deadline; terminal failure/cancellation and unpaid
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

### Retained limitations

The existing provider-initialization/attachment ambiguity and loss of guest capability on
browser refresh remain as documented in `payments-memberships.md` and the payment workflow
audit. No new recovery workflow or migration is introduced.

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

### Step 5 changed files and focused validation

Application changes:

- `src/lib/coaching/checkout.ts`: internal post-commit checkout entry point.
- `src/lib/payments/service.ts`: coaching contract validation within shared settlement.
- `src/lib/db/repositories/reservations.repository.ts`: locked coach identity projection.
- `src/lib/bookings/commands.ts`: shared coaching eligibility (lesson rescheduling since replaced it).
- `src/lib/db/repositories/court-activity.repository.ts`, `src/lib/bookings/activity-service.ts`,
  `src/lib/bookings/personal.ts`, `src/lib/bookings/history.ts`: owner-scoped coaching classification.
- `src/app/my-activity/bookings/customer-booking-cancellation.tsx`: withhold coaching Edit.

Tests: `tests/unit/coaching/checkout.test.ts`,
`tests/integration/coaching-booking.integration.test.ts`,
`tests/components/personal-activity.test.tsx`, `tests/unit/activity-service.test.ts`;
`tests/unit/booking-commit.test.ts` only gains the null coach field in its
court-only locked-reservation fixture.
Documentation: this file and `README.md`.

Focused commands (Stripe SDK calls mocked; isolated `tennis-club-tests` PostgreSQL only):

```bash
npm run test:integration -- tests/integration/coaching-booking.integration.test.ts \
  tests/integration/stripe-payment.integration.test.ts \
  tests/integration/owner-customer-booking-reschedule.integration.test.ts \
  tests/integration/personal-customer-bookings.integration.test.ts
npx vitest run tests/unit/coaching/checkout.test.ts tests/unit/payment-integrity.test.ts \
  tests/unit/booking-commit.test.ts tests/components/personal-activity.test.tsx \
  tests/unit/customer-booking-action.test.ts tests/unit/stripe-adapter.test.ts \
  tests/unit/activity-service.test.ts
npm run typecheck
npx eslint src/lib/coaching/checkout.ts src/lib/payments/service.ts \
  src/lib/bookings/{commands,personal,history,activity-service}.ts \
  src/lib/db/repositories/{reservations,court-activity}.repository.ts \
  src/app/my-activity/bookings/customer-booking-cancellation.tsx \
  tests/unit/coaching/checkout.test.ts tests/integration/coaching-booking.integration.test.ts \
  tests/components/personal-activity.test.tsx \
  tests/unit/{booking-commit,activity-service}.test.ts
```

Validation passed: 26 PostgreSQL integration tests across four focused files, 118 unit/component
tests across seven files, TypeScript, scoped ESLint and `git diff --check`.
No migrations, database resets, real financial transactions, builds, commits or Step 6 UI work.

## Step 6: coaching mode on `/book`

`/book` retains court booking. `/book?mode=coaching` adds Private and Semi-private lessons on the same
page, with mode links and shared location/date navigation. Selection order is
**Location → Coach → Program → Duration → Date/Time**, using URL navigation and server rendering:

- Location: no location is selected until the user chooses one, the URL names a public location,
  or a coach link (`coach=<user_id>`) names a coach with exactly one public location. A coach
  link with several locations lists them and carries the coach into the first location choice.
- Coach: every public eligible coach assigned to the location (`coach_locations`). The list is
  never filtered by date, working hours, reservations, courts, programs or prices.
- Program: the selected coach's own `coach_programs` assignments (active programs). Group and
  Junior assignments are listed but disabled (not bookable online). Nothing is derived from the location.
- Duration: the program's configured subset of 60, 90 and 120 minutes,
  each labelled with its effective price (`coachingBookingOptions` in
  `src/lib/coaching/booking-options.ts`): the coach's override, else the club default, in the
  location's currency; otherwise "price unavailable", which blocks lesson starts and checkout.
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
existing Step 4 schema and delegates to `commitCoachingCheckout`; it returns the existing
pending-checkout contract, never a client-side confirmation. Coaching offers online
payment only. No provider adapter, lifecycle, pricing rule or backend availability logic
is reimplemented. Coaching success names the coach/court booking without promising an
email template that does not exist.

Location changes clear coach, program and duration and resolve the new location's current date;
coach changes clear program and duration; program changes clear duration. Date navigation
retains valid lesson preferences. Location/date key the calendar; program/coach/duration key its selection and review subtree.
Changing lesson preferences clears the chosen court/interval while retaining edited contact details. Stale availability or
price at submission clears selection and refreshes offers while retaining entered contact;
a price change requires selecting a fresh offer and reviewing its full breakdown. Once
checkout holds resources, its chosen quote remains snapshotted in UI state across action
revalidation, even when that hold disappears from public availability. Payment outcomes
continue to come exclusively from the existing verified status flow.

Coaching and coach detail pages link to the shared booking route. The browser
capability/initialization recovery limitations from Step 5 remain.

### Step 6 validation

Focused component/unit coverage includes mode and URL selection changes, public service
selection, invalid/ineligible choices, multiple courts/prices, full-duration selection
and highlighting, included/excluded rental, guest/account contact defaults, pending versus
verified payment, checkout expiry, quote refresh and retained contact, and preservation of
the agreed breakdown across hold revalidation. Existing court calendar, action, location
navigation and online payment tests are retained.

```bash
npx vitest run tests/components/booking-calendar.test.tsx \
  tests/components/coaching-booking-controls.test.tsx tests/unit/book-page.test.tsx \
  tests/unit/coaching-booking-action.test.ts tests/components/coaching-page.test.tsx \
  tests/components/coach-profile-page.test.tsx tests/components/online-payment.test.tsx \
  tests/unit/customer-booking-action.test.ts tests/components/location-select.test.tsx
npm run typecheck
```

Headless Chrome smoke checks against the existing local development server use 1440 × 1000
and 390 × 844 (touch) viewports: coaching controls and all court rows render, duration/date
navigation retains preferences, location changes reset dependent choices, mode switching
returns to the ordinary timetable, and document width does not overflow. No client errors
were observed. The available development data has no lesson starts at the inspected times;
selectable/payment cases use focused component fixtures and mocked payment transport.
Validation passed: **84 focused tests across nine files**, TypeScript, scoped ESLint
on the touched application/test files, `git diff --check`, and both browser smoke viewports.
No real financial transaction, database reset, build or commit is made.

Step 6 touches the shared `/book` content, calendar, controls, confirmation and actions;
adds `coaching-controls.tsx` and the public offer prop type `coaching-selection.ts`;
adds an optional legend label override to `court-timeline-grid.tsx`; links the Coaching and
coach detail pages; and updates the focused tests above plus this document and README.
The coaching creation/checkout modules only have their obsolete UI-deferred comments updated.

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
- Prices: club-wide RON defaults and a few coach overrides, written only when a current
  location charges in RON; locations in other currencies are reported as unpriced.

One READ COMMITTED transaction takes the Admin coaching lock order (configuration share fence →
locations → programs → coach account facts → profiles). Only missing records are inserted:
existing programs, profiles, assignments and prices are never updated or removed, so Admin
edits survive reruns and nothing is duplicated. Bookings, reservations and payments are
not touched. Remove seeded data through Admin (deactivate programs, hide coaches).

## Tests

```bash
npx vitest run tests/unit/coaching tests/components/coaching-page.test.tsx \
  tests/components/admin-coaching.test.tsx tests/components/homepage-coaching.test.tsx \
  tests/components/coach-profile-page.test.tsx tests/components/public-page-layout.test.tsx \
  tests/components/coach-availability.test.tsx tests/components/admin-navigation.test.tsx
npm run test:integration -- tests/integration/admin/coaching.integration.test.ts \
  tests/integration/admin/coach-availability.integration.test.ts \
  tests/integration/coaching-seed.integration.test.ts \
  tests/integration/coaching-lesson-availability.integration.test.ts \
  tests/integration/coaching-booking.integration.test.ts
```


## Private and Semi-private online selection

The former private-only filters were an implementation scope limit, not a product rule.
The shared online eligibility predicate now accepts `private` and `semi_private` at both the
public availability and locked quote boundaries. `createCoachingBooking` reuses that quote;
`commitCoachingCheckout` delegates to creation and the unchanged post-commit Stripe flow.
No new lifecycle, database tables or migration is needed.

The Coaching mode shows actual configured program names without a disabled program placeholder,
selects the first eligible program (including the sole option), and offers only priced configured
durations on the existing court grid. Switching programs preserves the coach and customer contact
while clearing the previous duration, interval and review. The whole lesson must fit coach and court
availability. Group and Junior are excluded even when assigned and priced.

The configured coaching amount is the complete session price, including for two-player Semi-private
lessons. The existing resolver chooses the coach override, then club default; no applicable price
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
configured durations, and coach/court conflicts through the same semi-private path. No database reset
or real payment is required.

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

Focused regressions: `admin/coaching.integration.test.ts` covers cross-location/override/stale-currency
cleanup, retained prices, rollback, real foreign keys, removal authorization, historical protections,
coach eligibility and preserved identities. `admin-coaching.test.tsx` covers visible icon actions,
confirmation, explicit deactivation, archive feedback and canonical Junior duration selection.

### Correction validation and changed files

The existing uncommitted Private/Semi-private selector, quote, booking, snapshot and
single-payment corrections were preserved and verified. Earlier development fixtures contained unsupported 45-minute Junior lessons. Current
fixtures use canonical durations; legacy financial contracts remain untouched.

Changes for management cleanup and removal:

- `src/app/admin/coaching/actions.ts`
- `src/app/admin/coaching/coaching-form.tsx`
- `src/app/admin/coaching/delete-button.tsx`
- `src/app/admin/coaching/programs/programs-table.tsx`
- `src/app/admin/coaching/programs/program-dialog.tsx`
- `src/app/admin/coaching/coaches/coaches-table.tsx`
- `src/lib/coaching/admin.ts`
- `src/lib/coaching/validation.ts`
- `src/lib/db/repositories/coaching.repository.ts`
- `src/lib/db/entities/coach-profile.entity.ts`
- `tests/components/admin-coaching.test.tsx`
- `tests/unit/coaching/authorization.test.ts`
- `tests/integration/admin/coaching.integration.test.ts`
- `tests/integration/coaching-booking.integration.test.ts`
- `docs/coaching.md`

Validation: 172 unit/component tests across 13 focused files; 42 PostgreSQL integration
tests across Admin coaching, coaching booking, lesson availability and coaching reservation
constraints; TypeScript and scoped ESLint passed. The three Admin integration tests were
also rerun after adding the explicit assignment cleanup assertion. The new migration alone
was applied to the isolated test database and local development database; no reset, unrelated
migration, build, broad suite or commit was performed.


## Management lists and time-off ranges

Programs use `q`, `type`, `status`, `sort` (`name`, `type`, `status`), `dir` and `page`.
Prices use `q` (program name or coach name/email), `currency`, `program`, `duration`,
`scope` (`club`, `coach`), optional `coach`, `sort` (`program`, `currency`, `duration`,
`amount`), `dir` and `page`. Both use the extracted shared ManagementTableToolbar,
shared sortable headings and existing Pagination. Query boundaries normalize invalid/repeated
parameters. Sorting is changed only through column headings (first click ascending, second
descending); there are no Sort/Direction controls. Filter/sort changes reset pagination; Clear
filters resets the list URL. The Prices Program filter is a searchable combobox. In Coaches, the
Visibility filter treats coaches without a profile or with an archived profile as Hidden.
Repository SELECTs apply filtering/sorting/counting and 20-group pagination in PostgreSQL;
counts and page reads share a read snapshot. Prices retain one group per program/duration/currency
(currencies of non-archived locations plus currencies holding prices), including unset targets
when no explicit scope is selected, with the inline club editor and read-only coach prices. Scope filters require an entered price of that scope;
coach filters restrict assigned coach targets. Multiple matching overrides do not duplicate groups.
Amount sorting uses the lowest matching entered amount within a group, with unset amounts last;
amounts keep their stored currency. Checkout resolution uses the same resolver.

Saving time off rejects overlapping active coaching occupancy or unexpired payment holds
with `booking-conflict`, preserving every booking. Extra availability at a different location
also rejects such conflicts. This check uses each reservation's own local playing date and
half-open minutes under the existing coach-profile write fence; booking commands hold its
shared counterpart before location locks and reread the ranged schedule. Expired holds do not
reject configuration. PostgreSQL's inclusive `daterange` plus minute-range GiST exclusion backs
TypeScript overlap checks. Availability never bypasses opening hours, public eligibility,
court/coach occupancy or other existing lesson quote restrictions.

The consolidated initial migration and entity include non-null `until_date`; existing
applied databases are unchanged by source edits. An explicitly authorized development rebuild
and separate test-project reinitialization are required before exercising ranged workflows.
Do not run a reset/rebuild without approval. Existing single-day fixtures explicitly store
identical start and end dates. Focused range integration coverage is in
`tests/integration/admin/coach-availability.integration.test.ts`; list coverage is in
`tests/integration/admin/coaching-lists.integration.test.ts`.

### Canonical duration correction

`CanonicalCoachingDurations1791462257928` tightens the configuration CHECK to 60/90/120.
It never changes booked lessons, revisions or financial records. Existing unsupported
configuration is retained for explicit Admin cleanup, hidden from customer offerings;
the CHECK applies to all new/updated rows and is validated immediately when no legacy rows exist.
The earlier applied migration stays immutable. Apply the additive migration before deployment.

Rescheduling notifications always retain the eligible customer/Coach in-app messages.
Email is optional and queues only when Admin has enabled configured delivery in Club settings;
Admin/Coach accounts never receive transactional application email. The coaching integration
fixture explicitly selects disabled/unconfigured or enabled/configured settings, restores the
previous singleton values, and never dispatches Brevo. Supabase Auth mail is independent.
