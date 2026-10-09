# Architecture

## System boundary

The application is a modular Next.js application for one tennis club with multiple locations. The diagram below shows the intended architecture as booking and payment features are added; the current implementation includes authentication, RBAC/Admin Users, personal/contact information, and player profiles with Storage avatars.

```text
Browser
   │
   ▼
Next.js
├── Server Components
├── Server Actions
├── Route Handlers
└── Client Components
   │
   ▼
TypeScript application/domain logic
   │
   ├────────────► Stripe
   │
   ▼
TypeORM repositories
   │
   ▼
PostgreSQL
├── restricted application table grants / Storage RLS
├── constraints
├── indexes
└── transactions and Auth integration hooks
```

Architectural rule:

> Next.js is the complete primary application authorization boundary, TypeScript decides business behavior, PostgreSQL guarantees data integrity, application table grants deny direct browser access and Storage RLS protects private objects, and Stripe owns payment processing.

`src/lib/db/data-source.ts` registers all 17 entities and lazily initializes a
module-scoped connection. This preserves constructor identity across Next.js route/action
bundles; do not move the connection into a process-global registry. `DATABASE_POOL_MAX`
defaults to 2. Synchronization, dropping schemas and automatic migrations are disabled.
The standalone migration CLI reuses the DataSource and TypeScript loader.

## Resource persistence

All application reads/writes use TypeORM. Supabase verifies Auth identity and accesses
private Storage only. Repositories receive an explicit EntityManager and never start
transactions. Services authorize verified actors, explicitly scope private/public
projections, and use READ COMMITTED transactions for coupled persistence. Application
tables deny direct anon/authenticated access and have no application RLS policies.

Configuration serialization is transaction-scoped advisory locking on `(1791462257, 1)`:
exclusive writers and shared booking configuration readers acquire it before ordered
location locks. Court moves lock old/new parents in ascending UUID order and recheck
parent discovery. Occupancy writes lock location FOR UPDATE before existing
booking/reservation/payment rows; read-only configuration uses location SHARE. Parent
changes retry at most three fresh transactions. Reason-only edits/cancellation omit
the configuration fence. Actor role/account fences retain their existing lock order.

TypeScript validates publication readiness, coverage/court compatibility, pricing targets,
and opening-hours containment under these locks. Rule-set replacement preserves its
parent and atomically replaces children. No coordination tables, aggregate policy triggers,
pricing-hours bridge or application business functions are installed. PostgreSQL retains
PK/FK/UNIQUE/CHECK integrity and the four GiST overlap exclusions.

Identity services preserve Admin self-management/final-active-Admin checks in TypeScript,
serialize authoritative role/account reads, and explicitly persist attribution/timestamps.
Booking/payment/refund commands explicitly expire hold aggregates, maintain timestamps,
preserve immutable provider/financial snapshots, validate capture evidence and fence
terminal refund success. Provider calls run between short transactions. Booking email sends follow committed lifecycle changes. No Auth, Storage, Stripe or Brevo call runs
inside a database transaction.

Avatar references use owner/profile-fenced TypeORM transactions while bytes remain in
private user-scoped Supabase Storage. Initial-upload persistence failure attempts cleanup;
replacement keeps new bytes at the canonical path; removal clears the reference before
best-effort deletion. Rare non-atomic orphan/concurrent outcomes remain accepted.

TypeORM is the sole application migration authority. Native Auth/Storage integration is
installed by that history after Supabase infrastructure starts. See [fresh setup](../README.md#application-migrations-and-fresh-local-setup).
Existing populated databases require a separately authorized, data-preserving cutover.

## Next.js responsibilities

Next.js Cache Components prerenders public/shared content and streams request-specific auth/account UI behind Suspense boundaries. Protected page reads use route-specific loading boundaries. Supabase Auth/Storage access remains server-first: clients, sessions, accounts, roles, status, and profile/avatar metadata are never persistently cached. The navigation helper's React `cache()` only deduplicates reads within a server request.

Use:

- Server Components for server-side reads and initial rendering;
- Server Actions for appropriate authenticated mutations initiated by the application UI;
- Route Handlers for external HTTP boundaries such as Stripe webhooks;
- Client Components only for browser-side interaction.

Do not place substantial domain logic directly in React components, Server Actions, or Route Handlers.

Preferred flow:

```text
UI
↓
Server Action / Route Handler
↓
Application/domain function
↓
TypeORM / Stripe integration
↓
PostgreSQL / Stripe
```

## Next.js 16 Proxy

The request interception/session-refresh entrypoint is:

```text
src/proxy.ts
```

It delegates Supabase-specific cookie/session refresh work to a helper such as:

```text
src/lib/supabase/proxy.ts
```

Do not use the legacy `middleware.ts` convention for this Next.js 16 project.

The proxy is for session maintenance, not domain authorization or business rules.

## Server logging

`src/lib/logger.ts` exports the shared Pino server logger. It writes structured JSON logs at the level set by `LOG_LEVEL` (default `info`); unit tests default to `silent` unless `LOG_LEVEL` is set. Production application code uses this logger instead of `console.*`. Client Components must not import it.

Log only selected, safe context. Never intentionally log passwords, FormData, Supabase sessions, auth tokens, cookies, Authorization headers, or complete user/auth objects. Pino redaction is a secondary safeguard. Logging is separate from future exception monitoring and tracing such as Sentry or OpenTelemetry.

## Supabase access

Supabase access is server-first.

Normal user operations:

```text
authenticated user
→ Next.js
→ verified Supabase Auth identity
→ TypeORM application persistence
→ PostgreSQL invariants
```

Do not introduce a browser Supabase client by default.

A browser client may be added later only for a concrete browser-specific feature such as Realtime.

## TanStack Query

TanStack Query is planned for interactive client-side server state when a workflow benefits from:

- caching;
- invalidation;
- background refetching;
- mutation state.

Examples:

- court availability;
- coach availability;
- booking lists;
- partner requests;
- interactive admin screens.

TanStack Query should call the Next.js server boundary rather than Supabase directly.

## TypeScript responsibilities

Keep application/domain algorithms in TypeScript, including:

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

Domain functions should remain framework-light and unit-testable where practical.

## PostgreSQL responsibilities

PostgreSQL protects structural and concurrency invariants using:

- primary keys;
- foreign keys;
- unique constraints;
- `NOT NULL`;
- `CHECK`;
- indexes;
- overlap protection;
- RLS;
- transactions.

Application-side checks are not enough for concurrency-sensitive invariants.

## Transactions

Application persistence uses repositories with an explicit EntityManager.

Use TypeORM `inTransaction` when several persistence changes must commit atomically.

Examples:

- moving a booking during rescheduling;
- consuming membership credits;
- recording a match plus both rating updates;
- selected payment/refund state transitions.

Responsibility split:

```text
TypeScript
→ decides what should happen

PostgreSQL transaction
→ guarantees required persistence happens atomically
```

Keep pricing, Elo, partner matching, entitlement rules and other application algorithms in TypeScript.

## Initial schema approach

Derive schema incrementally from implemented workflows.

Existing authentication/application identity uses:

```text
auth.users
public.users
public.roles
public.user_roles
public.player_profiles
```

`public.users` owns account and personal/contact data; `player_profiles` owns optional tennis data. Future `coach_profiles` is a sibling domain entity. The `/profile` Server Component authorizes through the user-scoped Auth client and reads through `loadProfile` and TypeORM repositories, and route-local Server Actions delegate mutations to TypeScript application functions. The private `profile-avatars` bucket stores uploaded player images; profile rows contain only object paths. Browser-side Supabase access is not introduced. See `profiles.md`.

Unreleased development schema is evolved in its owning migration, with focused migrations for new domains/infrastructure; released production migrations remain immutable. Rebuilding local history requires explicit approval for a destructive database reset.

Future domain entities are introduced when their workflow is implemented rather than creating the full future schema mechanically.

Likely domains include:

- locations/courts;
- court availability/exceptions;
- coaches/coach locations/availability;
- bookings/participants/rescheduling history;
- partner requests;
- matches/ratings/rating history;
- membership plans/subscriptions/credit ledger;
- payments/refunds/Stripe events;
- audit events.

## Current authentication flow

Authentication uses the Next.js App Router and a user-scoped Supabase server client. An `AFTER INSERT` trigger on `auth.users` creates the matching `public.users` row with no role assignments in the same transaction, before email confirmation. If provisioning fails, the Auth insert fails too.

```text
signup
→ unconfirmed Auth user without a session
→ /signup/check-email
→ confirmation email
→ /auth/callback
→ successful code exchange establishes the session
→ /account
```

The signup action does not treat a returned Auth user as a signed-in session. If Supabase unexpectedly returns a signup session, the action clears it and fails closed. A failed callback code exchange shows an invalid or expired link error.

Password recovery has its own callback destination:

```text
forgot password
→ recovery email
→ /auth/callback?next=/reset-password
→ successful code exchange establishes a recovery session
→ /reset-password
→ password update
```

Redirect-based auth messages use the global Sonner toaster. Field and form validation remains inline. The client removes consumed `message` and `error` URL parameters while preserving unrelated parameters.

## Customer booking mutations (Phase 6)

Owner/Admin cancellation and rescheduling, including focused edit/quote contexts,
use `src/lib/bookings/commands.ts` and TypeORM READ COMMITTED transactions. Identity
verification and structural validation precede transactions; no Auth, Supabase HTTP,
Stripe or mail request runs inside them. Upcoming/history, public loaders and
Admin operational/report reads also use TypeORM.

The lock order is optional configuration advisory SHARE → location UPDATE → booking
UPDATE → linked reservation UPDATE → selected attempt UPDATE → existing refund
UPDATE → ordered Admin/Coach assignments SHARE → account SHARE.
Reschedule uses the shared configuration advisory fence. Cancellation omits it and retries only changed parent discovery in a fresh
bounded transaction. Repositories perform focused persistence; TypeScript owns policy.

Ownership is exclusively `bookings.account_user_id` bound to the verified actor.
Owners require an active account; Admin commands require current active Admin status.
Owner cancellation ignores resource activation/publication and current pricing/currency.
New Admin cancellation and both reschedule scopes require active original resources,
with matching current location currency additionally required for reschedule. Guests
cannot self-manage; Admin reschedule may manage guests. Notice uses the booking snapshot
and current location timezone via `localStartInstant()`. Current Admin/Coach owners
bypass notice; all mutations must precede start. Post-lock `clock_timestamp()` is
compared at microsecond precision and rechecked immediately before writes.

Cancellation locks the earliest succeeded online Stripe attempt ordered by
`created_at,id`, then any existing refund. Owner cancellation always requests its full
attempt amount/currency; Admin must explicitly choose if a qualifying attempt exists.
Both cancelled lifecycle rows plus an existing refund yield the same replay ID; a
cancelled booking without a refund remains unavailable. Lifecycle, immutable financial
request commit atomically; notification delivery follows commit. `finishBookingCancellation()` and optional
`processBookingRefund()` still execute after commit using the Phase 8 boundary below.

Reschedule compares textual pre-hydration booking/reservation tokens using PostgreSQL
`timestamptz` equality. Authorization, lifecycle and original notice/resource eligibility
precede stale detection; stale precedes target/pricing checks. Occupancy precedes price
acknowledgement. Revision/location locks stabilize target court, hours, coverage and
pricing; active occupancy and unexpired holds exclude the current reservation. Existing
TypeScript court-state, half-hour pricing and rounding helpers remain authoritative.
Only exact `23P01` / `court_reservation_no_overlap` maps to court conflict. Other SQL
failures roll back and return safe failures, including deadlocks/serialization errors.

Save updates only reservation schedule and booking total. Payment attempts/refunds
remain unchanged, including original captured financial evidence after price increases
or decreases. Reservation `updated_at` retains the `greatest(clock_timestamp(), old +
1 microsecond)` floor. The booking repository explicitly persists transaction
`now()`; it is not made monotonic. Quotes never write. Unchanged schedules (including
price-only saves) update rows as before but send no reschedule email.

Email delivery follows aggregate commit. Cancellation uses `customer_cancelled` or
`admin_cancelled` and optional `refund_status: requested`. Reschedule uses
`customer_rescheduled` or `admin_rescheduled`, with previous/new schedule snapshots
and the immutable booking recipient. Failed, quoted, stale and replayed operations
send no email.
All booking mutations use TypeORM; email delivery uses Brevo HTTP. Command snapshots, actor comparisons and generic fingerprint SQL are absent.


## Payment settlement (Phase 7)

Webhook signature verification, event normalization/Zod validation and Stripe calls remain
outside persistence. Settlement discovers the metadata attempt's booking, then uses one
TypeORM READ COMMITTED transaction: booking FOR UPDATE → linked reservation FOR UPDATE →
selected attempt FOR UPDATE → global provider-event lookup → post-lock clock_timestamp().
No configuration, location, court, refund or actor locks are needed. Locked attempt snapshots
are financial authority, independent of rescheduled booking totals.
TypeScript chooses lifecycle/result/reconciliation against lossless effective deadlines and
rechecks wall time before writes. The attempt UPDATE fences deadline-sensitive transitions;
a crossed deadline is re-evaluated as expiry. Booking/reservation/attempt writes, provider
receipt and first confirmed email snapshot commit atomically. Receipt insertion uses the global
(provider,event_id) PK with ON CONFLICT DO NOTHING; a separate statement reads the winner.
Changed evidence throws and rolls back provisional lifecycle writes; identical evidence replays
stored result, preserving later Admin resolution. Late success/mismatch never reclaim occupancy.
Receiptless abandonment uses the same local transaction after provider-confirmed cancellation.
TypeScript hold expiry uses TypeORM.

## Refund execution and reconciliation (Phase 8)

Automatic post-cancellation processing uses refund-only FOR UPDATE preparation/result
transactions, separated by the Stripe request. It is intentionally unleased, short-circuits
failed/succeeded and conditionally overwrites only pending/pending_retry. It acquires no
aggregate locks afterward and does not clear Admin leases or resolve events.

Admin preparation discovers identity without locks, then locks booking → reservation →
selected attempt → provider events ordered by provider,event_id → refund FOR UPDATE,
followed by lockReservationActorFacts() roles ordered by role_code → account FOR SHARE.
TypeScript checks active Admin authority, exact original financial relationships and the
existing retry/late-capture policy. Missing requests use insertBookingRefundRequest() under
the booking lock. No configuration, location, court, hours or pricing locks are acquired.

An unexpired deadline strictly greater than clock_timestamp() is busy; equality/null/expiry
is reclaimable. Claims overwrite token, actor and a clock_timestamp()+5-minute deadline.
Text projections preserve microseconds; refund updated_at is explicitly persisted with now().
Preparation commits before Stripe. The unchanged adapter retrieves an established refund,
recovers matching metadata, or creates using court-payment-refund-<refund-id>; original
attempt/refund financial snapshots, never booking totals, determine the full amount.

The Admin result transaction discovers/verifies the aggregate and repeats booking →
reservation → selected attempt → ordered events → refund locks, with no actor fence.
It requires matching non-null token+actor and immutable financial tuple/reference, but
never checks expiry. Authority loss after claim does not block completion; replacement
tokens reject stale results. Stored success cannot downgrade. Result, compatible coalesced
provider ID, error, lease clearing and TypeScript-selected event resolution are atomic.
Resolution changes only required/resolved timestamp/actor, validates affected-row count and
preserves existing attribution on replay. Already-succeeded reconciliation resolves in
preparation without a new provider lease/call. Amount mismatch stays attention-required/manual.
No lifecycle, occupancy, financial receipt evidence or email is changed by reconciliation.

If Stripe accepts but local persistence fails, durable prior state remains and the service
returns pending_retry-style behavior; retry recovers the same financial identity. No
compensation, lease renewal or recovery worker is introduced.
The final schema contains no refund command RPCs.

## Booking email delivery

Booking confirmation, customer/Admin cancellation and customer/Admin rescheduling
capture the booking contact and schedule within the successful transaction, then
send the preserved text template through Brevo's transactional HTTP API after commit.
Use only the snapshotted `bookings.customer_email`, never the current account email.
Quote, stale, failed and unchanged-schedule saves send no rescheduling email;
pending/failed/expired checkout sends no confirmation. Transition and webhook receipt
checks prevent replayed operations from sending again. Delivery is best-effort with
a 10-second HTTP timeout, sanitized error logging, and no persistent queue or retries.
Email failure cannot change committed booking/payment state. Server-only
`BREVO_API_KEY` and a Brevo-verified `BOOKING_MAIL_FROM` are required.
Supabase Auth confirmation/recovery emails remain independent.
