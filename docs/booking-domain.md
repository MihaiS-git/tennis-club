# Booking Domain

## Locations and resources

A court belongs to exactly one physical location.

A coach may work at multiple locations.

A location may define:

- opening hours;
- courts;
- court schedules;
- coaches;
- local pricing;
- operational exceptions.

Court and coach availability both participate in booking validation.

## Availability

Availability combines normal schedules with exceptions and current reservations.

```text
base schedule
+ exceptions
+ active bookings
+ temporary booking holds
= actual availability
```

Example:

```text
Court 1

Normal schedule:
Monday–Friday 08:00–22:00

Exception:
24 December — Closed
```

A coach can be offered only when:

```text
coach works at selected location
AND
coach is available
AND
coach has no overlapping booking
```

## Court booking flow

```text
Choose location
→ choose date/time
→ view available courts
→ select court
→ calculate authoritative price
→ create temporary booking hold
→ pay if required
→ confirm booking
```

A booking fully covered by membership entitlement may be confirmed without payment after server-side validation.

## Court + coach booking

```text
Choose location
→ choose date/time
→ select court
→ find coaches available for the same interval/location
→ select coach
→ calculate total price
→ create temporary hold
→ pay
→ confirm booking
```

The court and coach must both remain available for the entire interval.

## Concurrency

A prior availability query is not enough.

This is unsafe:

```text
check availability
→ insert booking
```

Another request may reserve the same resource between those steps.

The database must prevent overlapping active reservations for:

- the same court;
- the same coach.

Two concurrent requests for the same resource/time must never both succeed.

## Booking holds

Paid checkout requires a temporary hold so the resource does not remain publicly available while payment is in progress.

```text
available
→ held
→ payment
→ confirmed
```

or:

```text
available
→ held
→ expired
```

The exact hold duration belongs in application configuration/domain policy.

Expired holds release the resources.

## Booking states

Expected states:

```text
held
confirmed
cancelled
completed
expired
```

Rescheduling should normally be represented as booking history rather than a permanent `rescheduled` state.

## Rescheduling

Members should be able to choose between:

```text
Manage booking
├── Reschedule
└── Cancel / Refund
```

Rescheduling flow:

```text
select new location/court/date/time
→ validate availability
→ optionally change coach
→ calculate new price
→ compare with previous amount
→ charge/refund difference
→ move reservation atomically
→ store rescheduling history
```

Price outcomes:

```text
same price
→ no payment operation

higher price
→ charge difference

lower price
→ refund difference according to policy
```

The booking may retain its identity while scheduled resources change.

## Cancellation and refunds

Cancellation/refund policy must be configurable rather than hard-coded in UI components.

Illustrative policy from the product specification:

```text
More than 24 hours:
100% refund

6–24 hours:
50% refund

Less than 6 hours:
No refund
```

This example is not a fixed production policy.

Cancellation flow:

```text
request cancellation
→ load booking/payment state
→ evaluate cancellation policy
→ calculate refund
→ cancel booking
→ create Stripe refund if applicable
→ synchronize payment state
```

Prevent:

- duplicate cancellation;
- duplicate refund;
- refunds exceeding paid amount;
- unauthorized refunds;
- refunds for unpaid transactions.

Admin cancellation of customer bookings and direct reservations is permitted only
strictly before the location-local start. The details dialog hides cancellation
for started or past intervals. Both cancellation transactions check wall-clock time after
acquiring row locks; rejected attempts preserve all booking/reservation snapshots.

## Booking UI

### Desktop

Use a court/resource timeline rather than a generic list.

```text
           17:00   17:30   18:00   18:30   19:00

Court 1    booked  booked  ───── available ─────
Court 2    ───── available ─────  booked  booked
Court 3    booked  ───── available ─────────────
Court 4    ───────────────── available ─────────
```

Make important information immediately visible:

- court;
- surface/type;
- available time;
- duration;
- price.

After selecting a court/time, show compatible coaches for the same interval.

### Mobile

Do not shrink the desktop timeline.

Use mobile-specific resource cards and time-slot controls.

```text
Court 1

17:00
17:30
18:00
19:30
```

## Implemented checkout lifecycle

See [payment lifecycle foundation](payments-memberships.md). Online commits create
one pending booking, one temporary reservation hold and one payment attempt.
Pay at club confirms immediately only when enabled for that location. Expired holds stop blocking using database time
and transactional cleanup, with the same reservation GiST constraint.


## Implemented immutable booking contracts

A checkout aggregate is linked permanently to its account owner and one mutable
court-reservation occupancy row; a business booking identity exists only after confirmation. `checkout_records.current_revision_id` points to the
sole authoritative commercial snapshot in `booking_revisions`; price, contact,
currency, method and cancellation notice are not duplicated on `bookings`.
Operational checkout/hold status and processing timestamps remain on the identity.
PostgreSQL rejects every ownership change after creation, including NULL-to-account,
account-to-NULL and account-to-account changes. Unchanged ownership writes are allowed.
Guest email equality never establishes account ownership.

Revisions record their number, predecessor, stable operation key/intent hash,
operation kind, effective state, local schedule, location/court identities and
historical names/timezone, customer contact, total/currency/method/policy, recorded
actor scope/time, adjustment source and cancellation cause. Pricing evidence is
versioned, typed and bounded to 48 half-hour slots, preserving rule/rule-set IDs,
rates and date scope. It has no live FK to replaceable pricing rules. Existing
calendar pricing and rounding functions remain the price authority.

Online creation records a pending revision and held occupancy. Verified successful
settlement appends one confirmed revision and activates the same reservation.
Duplicate receipts or distinct observations of the same capture cannot append
another confirmation. Failed/expired checkout changes processing state without
creating a fictional confirmed contract. Pay-at-club creation records a confirmed
contract with an uncollected `due` request, never a captured online payment.

Owner same-price and Pay-at-club changes append one applied revision and move
occupancy atomically. Pay-at-club debt derives from the current revision; its
original payment-request amount remains unchanged. Online reductions also create
newest-capture-first refund obligations atomically. Online increases retain the
proposal, surcharge and hold-fragment workflow: the base revision and confirmed
occupancy remain unchanged until verified capture passes current eligibility,
pricing and concurrency checks. An unapplied capture retains its evidence and
compensation obligation without a rescheduled revision.

Owners retain existing active-account, fixed-location, notice and before-start
rules, including Coach/Admin owner notice bypass. The revision UUID is the booking
concurrency token; the lossless reservation timestamp remains the occupancy fence.
Stable operation keys reject changed intent. Identical effective saves leave the
pointer, timestamps, payments and refunds unchanged; a genuine
price-only contractual change appends a revision.

Owner/Admin cancellation appends a final snapshot, releases occupancy and creates
remaining captured-funds obligations in one transaction. Cancellation without a
refund still replays successfully. Admins can cancel customer/guest bookings and
refund captured online funds automatically; they cannot reschedule someone else's
booking or choose to retain captured funds. Uncollected Pay-at-club debt is never
refunded. Admin direct-reservation editing is unchanged. Checkout abandonment uses
the capability boundary, records cancellation intent and releases occupancy;
provider calls follow commit, with compensation for later exact captures.

Composite FKs enforce same-booking predecessor, current-head and adjustment lineage;
the initial current-pointer FK is deferred to allow identity/revision insertion in
one transaction. Unique numbering, predecessor and operation keys protect identity.
Native integrity triggers reject non-linear appends, orphan/rewound heads and any
revision UPDATE/DELETE/TRUNCATE and ownership changes. They validate structure only, never pricing,
eligibility, refunds or application workflows. Revisions never cascade away.


Checkout persistence now lives in `checkout_records`. The separate `bookings` table
contains only identities promoted on genuine confirmation, with the original
confirmation revision retained as proof. Financial `booking_id` references keep the
shared aggregate UUID, including unsuccessful checkout evidence. See
[checkout lifecycle correction](checkout-lifecycle-correction.md).
