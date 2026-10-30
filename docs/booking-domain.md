# Booking Domain

Court bookings, coaching lessons, staff (direct) reservations, checkout holds, rescheduling
and cancellation. Payments and refunds are in [payments](payments-memberships.md); lesson
rules are in [coaching](coaching.md); pricing and opening hours are in [pricing](pricing.md).

## Locations and courts

One club operates several physical locations. A court belongs to exactly one location; a
coach may teach at several. Each location has an IANA timezone, one currency (EUR, USD, GBP,
RON or CHF), effective-dated opening hours, a customer cancellation notice and an optional
Pay at club switch. Bookings store location-local dates and half-open minute intervals.

- **Publication.** `locations.is_public` is the Admin's explicit intent and defaults to false.
  Public `/book`, `/courts` and coaching discovery list only active, unarchived, published
  locations that are also *ready*: valid name/slug/timezone/currency, opening hours, an active
  court, and current or future base-state pricing for every active court. Readiness is
  derived in `src/lib/locations/publication.ts`; no flag is stored. Enabling Public booking is
  rejected server-side with the missing configuration.
- **Courts.** Surface (clay/hard/grass/carpet), outdoor/indoor environment and lighting.
  Outdoor courts may have inclusive calendar-date *coverage periods* (GiST prevents overlaps);
  `getCourtStateForDate()` in `src/lib/courts/state.ts` returns indoor, outdoor or covered.
  A court with coverage periods cannot become indoor until they are removed.
- **Archive/deactivation.** Archiving deactivates a location; restoring leaves it inactive
  until explicitly activated. Admin refuses timezone changes, location deactivation/archive,
  court deactivation and court moves while affected unfinished bookings exist, and refuses
  currency changes while bookings, unresolved financial operations or court prices exist.
  See [architecture](architecture.md#location-currency-changes).
- **Cancellation notice.** `locations.customer_cancellation_notice_minutes` (0–43,200,
  default 1,440) is set under Booking policy and snapshotted on each booking revision; later
  location changes never affect existing bookings.

Admin manages locations at `/admin/locations` and each location's Courts, Opening hours and
Pricing tabs at `/admin/locations/[locationId]?tab=…`. Legacy `/admin/courts` and
`/admin/pricing` redirect there.

## Availability

A court interval is bookable when the location's applicable opening-hours schedule covers it,
a compatible price applies to every 30-minute cell, it is in the future, and no `active` or
protected `held` reservation overlaps it. There are no opening-hours exceptions. Configuration
changes never cancel, move or reject existing reservations; calendars extend their visible
range to show occupancy outside the current hours.

Reservations need at least 60 minutes, start and end on 30-minute boundaries and stay within
one local day. Calendars default to the location's current date; `/book` rejects past dates,
while staff calendars can show past dates read-only. Open timetables refresh every 15 seconds
and on focus.

A held reservation blocks occupancy while its deadline is later than the shared `now`, and
also while it is *payment-protected* (a registered unresolved Stripe intent or an accepted
capture). Reads never expire holds; writes expire safe holds under location locks first. The
same occupancy predicate is used by public, staff, owner-edit, coach and expiry queries.

## Concurrency

An availability check followed by an insert is never sufficient. PostgreSQL arbitrates with
partial GiST exclusions on `court_reservations` for `active`/`held` rows:
`court_reservation_no_overlap` per court and `court_reservation_coach_no_overlap` per coach
across all courts and locations. Overlap violations roll back the whole write set and return
a safe availability message.

Lock order: shared (or, for configuration writes, exclusive) configuration advisory fence
`(1791462257, 1)` → location `FOR UPDATE` → checkout/booking → reservation → payment rows →
actor role/account fences. Changed-parent discovery retries in at most three fresh
transactions. No Auth, Storage or Stripe call runs inside a transaction. See
[architecture](architecture.md#resource-persistence).

## Checkout lifecycle

```text
timetable selection (browser only, no reservation)
→ customer details → Continue to payment
→ Transaction A: checkout record + held reservation + pending payment attempt (5-minute hold)
→ Stripe Payment Element (manual capture)
→ verified capture → confirmed booking, active reservation
```

- Timetable selection never creates a reservation. **Continue to payment** creates the
  temporary hold; `paymentHoldDurationSeconds` (5 minutes) applies to court and coaching
  checkout alike, with no heartbeat or extension. Paid booking modifications use their own
  10-minute hold (`modificationHoldDurationSeconds`).
- The server recalculates price, notice and payment method under locks; a stale browser quote
  returns the current price for reconfirmation. Guests book without an account; active
  signed-in accounts (including Admins and Coaches) are resolved server-side and get editable
  profile contact defaults. Contact edits affect only the booking snapshot. Guest email
  matching never grants ownership.
- **Pay at club** (if enabled for the location) confirms immediately with a `due` payment
  request and no provider.
- **Explicit cancellation** of an unpaid checkout releases the court (and coach) immediately
  once Stripe confirms cancellation of the intent.
- **Definitive card declines** end both court and coaching initial checkouts; a new card needs
  a new checkout. An expired payment form cannot start a payment.
- **Abandonment** (closed browser): unregistered holds expire at the deadline; registered
  intents keep occupancy until Stripe confirms cancellation or capture. Processing,
  accepted-capture and uncertain payments retain protection. The every-minute expiry Cron
  resolves them without a browser.

Details: [payments](payments-memberships.md#stripe-one-time-checkout).

## Checkout records and booking identities

`checkout_records` owns each temporary allocation: one unique `court_reservations` row, an
optional account link, lifecycle status (`pending_payment`, `confirmed`, `cancelled`,
`failed`, `expired`) and a required `current_revision_id`. `bookings` contains only genuinely
confirmed identities with their confirmation-revision proof, inserted atomically with online
settlement or pay-at-club creation. Failed, expired and abandoned checkouts have no booking
identity and no cancellation revision or notification. Business booking lists, details,
history and counts require a `bookings` identity; payment review and occupancy guards use all
checkout records. Financial `booking_id` references keep the shared aggregate UUID.

Reservation statuses are `held`, `active`, `released` (hold ended) and `cancelled`.

## Immutable booking contracts

Commercial terms live only in append-only `booking_revisions`: number, predecessor, operation
key/intent hash, kind, effective state, schedule, location/court identities and historical
names/timezone, contact, total/currency/payment method, cancellation notice, actor,
adjustment source and cancellation cause. Pricing evidence is typed and bounded (48
half-hour slots) and has no live FK to replaceable pricing rules. `buildBookingRevision()`
builds every snapshot.

Composite FKs enforce same-booking predecessor, current head and adjustment lineage (the
current-pointer FK is deferred). Native integrity triggers reject non-linear appends, rewound
heads, revision UPDATE/DELETE/TRUNCATE and ownership changes; they validate structure only.

- Online creation appends a pending revision; verified settlement appends exactly one
  confirmed revision, even with duplicate receipts.
- Same-price and Pay-at-club changes append one revision and move occupancy atomically.
  Pay-at-club debt comes from the current revision; the original request is unchanged.
- Online increases and reductions use the adjustment workflow in
  [payments](payments-memberships.md#paid-booking-price-adjustments).
- The revision UUID is the contractual stale token; the lossless reservation `updated_at`
  is the occupancy token. Identical saves do not write.

## Rescheduling

Customer self-rescheduling is owner-only, from `/my-activity/bookings` (including Admin and Coach
owners). Location is fixed. Ordinary owners must be within the snapshotted notice cutoff
(inclusive); Admin/Coach owners bypass notice only. Every owner must act before start.
Guest self-management is not implemented. Coaching lessons change only date and start time; see
[lesson rescheduling](coaching.md#lesson-rescheduling).

Admin operational editing uses the existing staff Calendar, entered from List, Calendar and Details, through
`runOperationalBookingChange`. Admins may move eligible customer or guest court/coaching
bookings across active locations and courts, and reassign active Coaches. Program,
duration, participants and agreed lesson fee stay fixed. Coach configuration restrictions
may be overridden; court/Coach occupancy, started bookings, inactive original resources,
pending financial operations and currency restrictions remain authoritative.

The shared `OperationalCalendarReschedule` uses the existing staff Calendar and
`CourtTimelineGrid`. Location/date navigation loads a single
staff-authorized day; court/time selection preserves duration, marks the original interval
and proposed destination, and shows unrelated occupancy without its details. Coach selection
reloads applicable availability and supports reassignment at the original interval.
`loadOperationalBookingDay` reuses the existing operational day reads and scheduling policy,
excludes the booking's reservation from court and Coach occupancy, and returns only generic
cells and permitted starts. It does not apply public publication or customer eligibility.
A changed revision blocks preview; scheduling conflicts refresh occupancy and clear selection.
Timetable clicks never save or request a financial quote.

Every change is previewed server-side and explicitly confirmed with `financialAcceptance`.
The club absorbs increases; reductions refund eligible captured funds or reduce club debt.
Refund-backed changes remain pending until settlement. Coach-only reassignment preserves
the agreed price. Customer and Coach notifications come from the existing domain events.

## Cancellation

- Owners cancel confirmed future bookings within the notice rules; Admins may cancel
  eligible customer and guest bookings strictly before start from
  `/admin/bookings/[bookingId]`. Admins cannot choose refund/no-refund.
- Pay-at-club or nothing refundable: the cancellation completes immediately.
- Refund-backed cancellation is a pending request; the booking and occupancy stay unchanged
  until every refund succeeds. See [refunds](payments-memberships.md#stripe-cancellation-refunds).
- Admins may supply an optional trimmed explanation of up to 500 characters. Existing
  cancellation adjustments retain the first accepted explanation through refund retries;
  the applied revision references it for history and customer/assigned-Coach notifications.
  Coach notifications contain operational details and the explanation, without financial details.
- Cancellation never deletes booking or financial records.

## Staff (direct) reservations

Active Admins and Coaches create free reservations with a required reason (≤ 255 chars) in
their staff calendars for active courts at structurally ready locations, including
unpublished ones. They have no price or payment and record their creator.

- **Admin** may edit any active direct reservation (future: date/court/time/reason at the
  fixed location; started: reason only) and cancel it strictly before start.
- **Owners** (Admin/Coach creators) edit their own on `/my-activity/bookings` with the same
  rules and may cancel until the reservation ends.
- Edits lock the row, compare the microsecond `updated_at` token and keep the location fixed;
  stale edits and GiST conflicts leave the original unchanged. Cancellation records the
  canceller and releases occupancy. Direct commands reject rows linked to a checkout record.

## Staff and customer views

| Route | Audience | Content |
| --- | --- | --- |
| `/book`, `/book?mode=coaching` | Public | Single-day court timetable; Private/Semi-private lessons |
| `/my-activity/bookings`, `/my-activity/history` | Account owner | Upcoming and past bookings and own direct reservations, 20 rows per page |
| `/admin/bookings` (List, `?view=calendar`) | Active Admin | All bookings and staff reservations; details at `/admin/bookings/[id]` and `/admin/bookings/reservations/[id]` |
| `/coach/bookings` (List, `?view=calendar`) | Active Coach | Court calendar; own lessons (read-only, no prices) and own reservations |

`/admin/reservations` redirects to the role's Calendar; `/admin` redirects Admins to Locations
and Coaches to `/coach/bookings`. The Admin Calendar shows initial holds as **Temporary
checkout hold** (deadline and payment-review link) and paid modification holds as
**Modification in progress**, with no booking management controls. Public `/book` reads only
court, date and minutes of occupancy; reasons, creators and contacts stay private.
