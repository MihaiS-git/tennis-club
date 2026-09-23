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
