# Tennis Club

A web platform for operating a **single tennis club with multiple physical locations**.

The application manages courts, coaches, members, bookings, memberships, payments, partner matching, match results, and player rankings across all club locations.

## Product scope

The club operates one shared system for:

- members;
- memberships;
- payments;
- player rankings;
- match history.

Individual locations manage their own:

- courts;
- opening hours;
- court availability;
- coaches;
- coach availability;
- location-specific pricing or operational rules.

```text
Tennis Club
├── Location A
│   ├── Court 1
│   ├── Court 2
│   └── Coaches
│
├── Location B
│   ├── Court 3
│   ├── Court 4
│   └── Coaches
│
└── ...
```

This is **not a multi-tenant SaaS platform**. One tennis club owns and operates the complete application.

---

## Technology stack

### Application

- Next.js
- React
- TypeScript
- Zod

### Backend services

- Supabase Auth
- Supabase PostgreSQL
- Supabase Row Level Security
- Supabase Storage where required
- Supabase Realtime where useful

### Payments

- Stripe
- Stripe PaymentIntents
- Stripe Subscriptions
- Stripe Refunds
- Stripe Webhooks

### Database access

Use `supabase-js` as the normal database access layer.

No ORM is required initially.

No separate NestJS or Express backend is required initially.

---

## Architecture

```text
Browser
   │
   ▼
Next.js
├── Server Components
├── Client Components
├── Server Actions
└── Route Handlers
   │
   ▼
TypeScript application/domain logic
   │
   ├─────────────► Stripe
   │                  │
   │                  ▼
   │             Stripe Webhooks
   │                  │
   ▼                  │
supabase-js ◄─────────┘
   │
   ▼
PostgREST
   │
   ▼
PostgreSQL
├── RLS
├── constraints
├── indexes
└── transactional RPCs where required
```

The main architectural rule is:

> **TypeScript decides business behavior, PostgreSQL guarantees data integrity, RLS protects data access, and Stripe owns payment processing.**

---

## User roles

### Admin

Admins can manage:

- locations;
- courts;
- coaches;
- members;
- availability;
- bookings;
- pricing;
- membership plans;
- subscriptions;
- payments;
- cancellations;
- refunds;
- platform configuration.

### Coach

Coaches can:

- manage their availability;
- view assigned coaching sessions;
- access member information required for those sessions.

### Member

Members can:

- manage their profile;
- book courts;
- book courts with coaches;
- manage bookings;
- reschedule eligible bookings;
- cancel eligible bookings;
- manage membership information;
- manage payment-related information;
- create and join partner requests;
- record eligible match results;
- view rankings and match history.

A user may have more than one role.

---

## Security model

Supabase RLS is a real application security boundary.

Typical authorization rules include:

- members can access their own private data;
- members cannot access another member's private data;
- members can manage only their permitted bookings;
- coaches can manage their own availability;
- coaches can view sessions assigned to them;
- admins can manage club resources;
- public player/ranking information can be visible to members;
- private account and payment information remains restricted.

Role checks must use authoritative database data.

The browser must never be authoritative for:

- price;
- discounts;
- membership entitlements;
- membership credits;
- booking availability;
- payment status;
- refund amount;
- role;
- rating changes.

Client data is always treated as input to validate, not as trusted business state.

---

## Supabase access

There are two server-side Supabase access patterns.

### User-scoped client

Uses the authenticated user's Supabase session.

RLS remains active.

This should be the default.

```text
Authenticated user
→ Next.js
→ user-scoped supabase-js client
→ PostgREST
→ PostgreSQL
→ RLS
```

### Privileged client

Uses the Supabase service-role credential and bypasses RLS.

Use it only for trusted system operations such as:

- Stripe webhooks;
- controlled system synchronization;
- exceptional administrative operations that genuinely require elevated access.

The service-role key must never reach the browser or client bundle.

Running code on the server does **not** automatically justify using the service-role client.

---

## Application structure

Business logic should not live directly inside React components or large Server Actions.

Use a layered flow:

```text
UI
↓
Server Action / Route Handler
↓
Application/domain service
↓
Supabase / Stripe adapter
↓
PostgreSQL / Stripe
```

Example application functions:

```text
bookCourt()
bookCourtWithCoach()
calculateBookingPrice()
rescheduleBooking()
cancelBooking()
calculateRefund()
resolveMembershipEntitlements()
findPartnerMatches()
recordMatch()
calculateElo()
```

These should remain framework-light and unit-testable where practical.

---

## Locations and resources

A court belongs to exactly one location.

A coach may work at multiple locations.

Each location may define:

- opening hours;
- courts;
- court schedules;
- coaches;
- local pricing;
- operational exceptions.

Each court and coach has availability participating in booking validation.

---

## Availability

Availability should distinguish between normal schedules and exceptions.

Example:

```text
Court 1

Normal schedule:
Monday–Friday 08:00–22:00

Exception:
24 December — Closed
```

Effective availability is derived from:

```text
base schedule
+ exceptions
+ active bookings
+ temporary booking holds
= actual availability
```

A coach can be offered only when:

```text
coach works at selected location
AND
coach is available
AND
coach has no overlapping booking
```

---

## Court booking

Basic court booking flow:

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

Bookings fully covered by membership entitlement may be confirmed without payment after server-side validation.

---

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

---

## Booking concurrency

Application-side availability checks are not sufficient.

The database must prevent overlapping active reservations for:

- the same court;
- the same coach.

Two concurrent requests for the same court/time must never both succeed.

---

## Booking holds

Payment checkout introduces a race condition if a resource remains publicly available while payment is in progress.

Use short-lived booking holds.

```text
available
→ held
→ payment
→ confirmed
```

Example hold duration:

```text
10 minutes
```

Successful payment:

```text
held → confirmed
```

Failed or abandoned checkout:

```text
held → expired
```

Expired holds release the resources automatically.

---

## Booking states

Recommended booking states:

```text
held
confirmed
cancelled
completed
expired
```

A rescheduled booking normally stays `confirmed`.

Rescheduling should be represented by history rather than a permanent `rescheduled` booking status.

---

## Rescheduling

Members should be able to choose between rescheduling and cancellation/refund.

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

Possible outcomes:

```text
same price
→ no payment operation

higher price
→ charge difference

lower price
→ refund difference according to policy
```

The booking can retain its existing identity while its scheduled resources change.

---

## Cancellation and refunds

Cancellation/refund policy must be configurable.

Example:

```text
More than 24 hours:
100% refund

6–24 hours:
50% refund

Less than 6 hours:
No refund
```

Actual club policy must come from configuration rather than UI code.

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

The system must prevent:

- duplicate cancellation;
- duplicate refund;
- refunds exceeding the paid amount;
- unauthorized refunds;
- refunds for unpaid transactions.

---

## Payments

Payment state and booking state are separate.

Recommended payment states:

```text
unpaid
processing
paid
failed
partially_refunded
refunded
```

A single booking may have multiple financial operations.

Example:

```text
Booking
├── Original payment       €30
├── Reschedule surcharge   €10
└── Partial refund          €5
```

Do not assume:

```text
1 booking = 1 Stripe transaction
```

Stripe operations that may be retried should use idempotency protection.

---

## Stripe webhooks

Stripe webhooks are authoritative for asynchronous Stripe state changes.

Potential webhook events include:

- payment succeeded;
- payment failed;
- refund created;
- refund updated;
- subscription created;
- subscription updated;
- subscription cancelled;
- invoice paid;
- invoice payment failed.

Webhook processing must be idempotent.

```text
Stripe webhook
→ verify signature
→ inspect event ID
→ already processed?
    yes → acknowledge
    no  → process
→ persist state
→ store event ID
```

Processed Stripe event IDs should be stored so duplicate delivery cannot repeat business operations.

---

## Memberships

Potential plans include:

- Standard;
- Premium;
- Coaching;
- Court Credits.

Membership benefits may include:

- booking discounts;
- included court hours;
- coaching credits;
- advance booking access;
- booking priority;
- other configurable entitlements.

Stripe handles subscription billing.

Application code determines what each plan actually allows.

Example:

```text
Stripe:
subscription active

Application:
Premium Membership
├── 15% court discount
├── 4 coaching credits/month
└── booking up to 14 days ahead
```

Consumable credits should preferably use a ledger/transaction model instead of only storing a mutable balance.

---

## Partner matching

Members can create partner requests.

Example:

```text
Looking for partner

Location: Central Club
Tuesday: 18:00–20:00
Level: 3.5–4.5
Game: Singles
```

Matching can consider:

- location;
- availability;
- player level/rating;
- game type;
- optional player preferences.

Initial matching should remain deterministic and simple.

```text
Create request
→ find compatible players
→ player accepts
→ choose common time
→ select court
→ book/pay
→ play
→ record result
→ update rating
```

AI-based partner matching is not required initially.

---

## Player profiles

Player data should distinguish public tennis information from private account information.

### Public tennis information

Potentially includes:

- display name;
- rating;
- ranking;
- match statistics;
- rating history;
- optional tennis preferences.

### Private information

Includes:

- contact information;
- billing-related data;
- private preferences;
- account information.

This separation is important because PostgreSQL RLS primarily protects rows rather than individual columns.

---

## Rankings

The initial ranking system uses Elo-style ratings.

Ranking calculations remain in TypeScript.

A ranked match should update:

```text
match result
+
player A rating
+
player B rating
+
player A rating history
+
player B rating history
```

The database persistence must be atomic.

The application must never leave a partially applied rating update.

---

## Transactional operations

Using `supabase-js` does not mean every workflow should consist of independent PostgREST requests.

Some operations require database transactions.

Examples:

- confirming bookings;
- rescheduling;
- consuming membership credits;
- recording match results and rating changes;
- certain payment/refund state transitions.

Where required, use small PostgreSQL functions exposed through Supabase RPC.

The responsibility split remains:

```text
TypeScript
→ decides what should happen

PostgreSQL transaction
→ guarantees all required changes happen atomically
```

Do not move domain algorithms such as Elo, pricing, partner matching, or membership rules into SQL.

---

## Database responsibilities

PostgreSQL should enforce structural and concurrency invariants using:

- primary keys;
- foreign keys;
- unique constraints;
- `NOT NULL`;
- `CHECK` constraints;
- indexes;
- overlap protection;
- RLS;
- transactions.

The database should make invalid states impossible where practical.

---

## TypeScript responsibilities

TypeScript owns application and domain logic such as:

- booking eligibility;
- pricing;
- discounts;
- membership entitlements;
- cancellation policy;
- refund calculation;
- partner matching;
- Elo calculations;
- Stripe orchestration;
- workflow decisions.

---

## Initial data model

The exact schema should be derived incrementally from implemented workflows.

Likely starting entities:

```text
auth.users
    Supabase managed

profiles
user_private_profiles

roles
user_roles

locations

courts
court_availability
court_availability_exceptions

coaches
coach_locations
coach_availability
coach_availability_exceptions

bookings
booking_participants
booking_reschedules

partner_requests
partner_request_members

matches
ratings
rating_history

membership_plans
subscriptions
membership_credit_ledger

payments
refunds
stripe_events

audit_events
```

Do not create every table mechanically before the corresponding workflow exists.

---

## Audit trail

Sensitive operations should create audit records.

Examples:

- role changes;
- admin booking modifications;
- booking cancellations;
- refunds;
- membership overrides;
- rating adjustments.

Useful audit information includes:

```text
who
performed what action
on which entity
when
```

---

## Booking UI

### Desktop

Use a court/resource timeline.

```text
           17:00   17:30   18:00   18:30   19:00

Court 1    booked  booked  ───── available ─────
Court 2    ───── available ─────  booked  booked
Court 3    booked  ───── available ─────────────
Court 4    ───────────────── available ─────────
```

Important information should be immediately visible:

- court;
- surface/type;
- available time;
- duration;
- price.

After selecting a court/time, display compatible coaches for the same interval.

### Mobile

Do not shrink the desktop timeline.

Use resource cards and time-slot buttons.

```text
Court 1

17:00
17:30
18:00
19:30

Court 2

17:30
18:30
20:00
```

---

## Admin UI

The admin interface should focus on operational workflows rather than only CRUD tables.

Important dashboard information:

- today's bookings;
- court occupancy;
- coach schedules;
- cancellations;
- failed payments;
- refunds;
- memberships;
- member lookup.

Administrative resource screens manage:

- locations;
- courts;
- coaches;
- pricing;
- availability;
- membership plans.

---

## Delivery plan

### V1 — Club operations

#### Foundation

- authentication;
- profiles;
- RBAC;
- RLS;
- locations;
- courts;
- coaches;
- availability.

#### Booking

- court booking;
- court + coach booking;
- concurrency protection;
- booking holds;
- booking management.

#### Payments

- Stripe one-time payments;
- Stripe webhooks;
- cancellations;
- refunds;
- partial refunds;
- rescheduling;
- price differences.

#### Memberships

- plans;
- subscriptions;
- discounts;
- basic entitlements;
- credits where required.

#### Administration

- dashboard;
- location management;
- court management;
- coach management;
- member management;
- booking management;
- payment/refund visibility.

### V2 — Tennis-specific features

- player profiles;
- partner matching;
- match recording;
- Elo rating;
- rankings;
- rating history;
- match history.

### V3 — Possible expansion

- tournaments;
- club leagues;
- recurring bookings;
- waiting lists;
- group coaching;
- notifications;
- advanced membership credits;
- guest players;
- advanced player statistics;
- club events.

---

## Non-goals for V1

Do not introduce prematurely:

- multi-tenancy;
- microservices;
- separate NestJS backend;
- ORM;
- event sourcing;
- AI partner matching;
- complex dynamic pricing;
- tournament engine;
- generic multi-sport support.

The architecture should be extensible without paying these complexity costs before they are required.

---

## Testing strategy

### Unit tests

Test pure TypeScript business logic:

- pricing;
- discounts;
- membership entitlements;
- cancellation rules;
- refund calculations;
- Elo calculations;
- partner matching rules.

### Database/integration tests

Verify:

- RLS boundaries;
- foreign key integrity;
- court overlap protection;
- coach overlap protection;
- atomic rating updates;
- membership-credit consistency;
- privileged vs user-scoped Supabase access.

### Stripe integration tests

Verify:

- successful payment;
- failed payment;
- duplicate webhook delivery;
- full refund;
- partial refund;
- duplicate refund protection;
- subscription activation;
- subscription cancellation;
- rescheduling surcharge;
- rescheduling refund.

### End-to-end tests

Critical workflows:

```text
signup/login
→ book court
→ pay
→ confirmation
```

```text
book court + coach
→ pay
→ confirmation
```

```text
booking
→ reschedule
→ price difference
```

```text
booking
→ cancel
→ refund
```

```text
partner request
→ match
→ book
→ play
→ record result
→ rating update
```

---

## Implementation order

Recommended sequence:

```text
1. Supabase project and database foundation
2. Authentication, profiles, roles and RLS
3. Locations and courts
4. Court availability
5. Booking domain model
6. Database overlap protection
7. Basic booking UI
8. Booking holds
9. Stripe one-time payments
10. Coaches and coach availability
11. Court + coach booking
12. Cancellation/refund rules
13. Rescheduling
14. Membership plans and subscriptions
15. Admin operational dashboard
16. Partner matching
17. Match recording
18. Elo ranking
```

The goal is to prove the difficult architectural constraints before adding secondary tennis features.

---

## Local validation

Before expanding the platform, prove the following cases locally:

- a member cannot access another member's private information;
- browser payload manipulation cannot change authoritative prices;
- browser payload manipulation cannot grant roles or discounts;
- admin, coach, and member RLS policies behave correctly;
- two concurrent users cannot successfully reserve the same court/time;
- two overlapping bookings cannot use the same coach;
- abandoned checkout releases its booking hold;
- failed payment does not produce a confirmed booking;
- duplicate Stripe webhooks do not repeat operations;
- rescheduling cannot create an overlapping reservation;
- rescheduling correctly charges/refunds price differences;
- cancellation policy produces the expected refund;
- refunds cannot be issued twice;
- match result and both rating updates commit atomically;
- Elo calculations are deterministic and unit-tested.

---

## Assumptions

- One tennis club owns the platform.
- The club may operate multiple physical locations.
- Courts belong to one location.
- Coaches may work across multiple locations.
- Members have one club-wide identity.
- Memberships are club-wide unless explicitly restricted.
- Rankings are club-wide.
- Court and coach availability are location-specific.
- Stripe is the payment provider.
- Supabase Auth is the authentication provider.
- PostgreSQL is the primary application database.
- `supabase-js` is the primary database access mechanism.
- No ORM is required initially.
- No separate backend framework is required initially.
- RLS is part of the primary authorization architecture.
- Domain algorithms remain in TypeScript.
- PostgreSQL RPCs are used only where database-level atomicity or integrity requires them.

---

## Design principles

1. **Security is enforced server-side and in PostgreSQL, never only in the UI.**
2. **Business rules remain explicit and testable in TypeScript.**
3. **Database constraints protect invariants that application checks alone cannot guarantee.**
4. **Payments and bookings have separate state machines.**
5. **Stripe webhooks must be idempotent.**
6. **RLS remains active for normal authenticated user operations.**
7. **Privileged Supabase access is narrowly scoped.**
8. **Features are added incrementally from real workflows instead of speculative schema design.**
9. **The system remains a modular monolith unless scale or complexity creates a concrete reason to change it.**
10. **Correctness, security, and maintainability take priority over architectural complexity.**