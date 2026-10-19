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

`src/lib/db/data-source.ts` registers all 28 application entities and the
additional non-synchronized reference to Supabase-managed `auth.users`, and lazily initializes a module-scoped connection. This preserves constructor identity across Next.js route/action
bundles; do not move the connection into a process-global registry. `DATABASE_POOL_MAX`
defaults to 2. Synchronization, dropping schemas and automatic migrations are disabled.
The standalone migration CLI reuses the DataSource and TypeScript loader.

## Resource persistence

All application reads/writes use TypeORM Data Mapper repositories. Supabase verifies Auth identity and accesses
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
PK/FK/UNIQUE/CHECK integrity and the five GiST overlap exclusions, plus two for coach availability
and one for coach occupancy of coaching reservations.

Identity services preserve Admin self-management/final-active-Admin checks in TypeScript,
serialize authoritative role/account reads, and explicitly persist attribution/timestamps.
Booking/payment/refund commands explicitly expire hold aggregates, maintain timestamps,
preserve immutable provider/financial snapshots, validate capture evidence and fence
terminal refund success. Provider calls run between short transactions. No Auth, Storage or Stripe call runs
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

`public.users` owns account and personal/contact data; `player_profiles` owns optional tennis data. `coach_profiles` is its implemented sibling for public coaching data (see `coaching.md`). The `/profile` Server Component authorizes through the user-scoped Auth client and reads through `loadProfile` and TypeORM repositories, and route-local Server Actions delegate mutations to TypeScript application functions. The private `profile-avatars` bucket stores uploaded player images; profile rows contain only object paths. Browser-side Supabase access is not introduced. See `profiles.md`.

The three consolidated migrations are `InitialApplicationSchema1791462257924`,
`ApplicationNativeIntegrity1791462257925` and `SupabaseAuthStorage1791462257926`.
The initial migration is TypeORM-generated from the same metadata used at runtime,
including schedules, adjustments, adjustment holds/payment links and refund operations.
Its handwritten parts configure `btree_gist` and the transaction search path
before the generated exclusions and create the entity-less `booking_financial_exceptions` table. The native migration owns the email expression
index, minimal bootstrap records and ownership/revision/financial-context integrity guards; the integration migration owns Auth hooks,
Storage policies and browser-role restrictions. No business policy is added in SQL.

UUID defaults use generated-column metadata with the PostgreSQL `pgcrypto` UUID
strategy; extension installation remains migration-controlled. A non-synchronized
`AuthUserEntity` describes only the existing Supabase Auth identity needed by the
application FK. TypeORM never creates or changes `auth.users`. Exclusion decorators
and the non-synchronized expression-index declaration protect native objects during
schema comparison. The production entity-constructor naming safeguard remains.

Financial dependencies (adjustments, attempts, receipts, refunds and adjustment
fragments) use restrictive deletes rather than destructive cascades. Disposable
test fixtures explicitly delete children in dependency order; application workflows
remain unchanged. Immutable booking revisions and refund executions are implemented.

Unreleased development schema is evolved in its owning initial migration without
patch chains; released production migrations remain immutable. Rebuilding local history requires explicit approval for a destructive database reset.

Future domain entities are introduced when their workflow is implemented rather than creating the full future schema mechanically.

Likely domains include:

- locations/courts;
- court availability/exceptions;
- coaches/coach locations/availability (programs, coach profiles, assignments,
  prices and coach availability are implemented; see `coaching.md`);
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

## Booking revisions and owner/Admin boundaries

See [the implemented booking contract](booking-domain.md#implemented-immutable-booking-contracts).
The permanent identity contains ID, reservation/account links, processing status,
current-revision reference and timestamps. Commercial terms exist only in immutable
`BookingRevisionEntity` rows. Current reads join that pointer, and personal activity
uses historical names and schedules from the current contract. No booking-history
side table or legacy mutable commercial columns remain.

Creation, confirmation, owner modification and owner/Admin cancellation use the
focused pure `buildBookingRevision()` snapshot builder. TypeScript decides the
state, price, eligibility, no-op and refund allocation. Repositories perform inserts,
pointer advancement, queries and locks with an explicit EntityManager. Confirmation,
occupancy changes, revision/pointer changes and applicable financial obligations
commit atomically; provider calls remain post-commit.

The existing configuration/location/booking/reservation/financial/actor lock order,
role fences, bounded changed-parent retries and reservation microsecond token remain.
Owner edits compare the current revision identity rather than a booking timestamp.
Same intent replays; changed intent with a reused key rejects. No-op saves do not
write. Pay-at-club requests remain original evidence while current debt
comes from the current contract. The existing refund allocator remains the only
newest-capture-first allocation implementation.

Admin management rescheduling services, actions and UI controls are removed.
Admins and Coaches may still modify their own bookings through the owner boundary;
Admins may cancel customer/guest bookings with automatic captured-funds refunds.
Direct-reservation editing remains separate. Cancellation is replayable independently
of whether a refund was needed. Shared owner booking editing lives in
`src/components/booking-edit-form.tsx`.

The initial migration remains TypeORM-generated. It includes the deferred composite
current-pointer FK, all revision checks/keys and adjustment-base/source relationships.
The native migration adds permanent-ownership and append-only/linear-history/current-head integrity guards,
the expression index and bootstrap records. Supabase integration and browser-role
restrictions remain the third migration. The Auth reference stays non-synchronized;
no application schema generation manages `auth.users`. No patch migration or backfill
is introduced. Refund executions are implemented; expanded capture/return observations remain deferred.

## Payment settlement (Phase 7)

Webhook signature verification, event normalization/Zod validation and Stripe calls remain
outside persistence. The TypeORM READ COMMITTED transaction takes the shared configuration
advisory fence, discovers attempt → booking → location, then locks location → booking →
linked reservation → selected attempt FOR UPDATE and rechecks the parent. It reads the
global provider-event receipt and PostgreSQL wall time. Confirmation revalidates current
hours, pricing and publication under that fence; adjustment application also fences
its actor. Exact late captures lock or allocate their compensation obligation before
commit. Changed parents retry in a fresh transaction at most three times. Locked attempt snapshots
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

Booking revision history is implemented; the remaining financial-model work is
described in [Task 4 limitations](payments-memberships.md#remaining-financial-model-work-task-4).

## Refund execution and reconciliation (Phase 8)

Automatic and Admin processing share immutable refund executions and five-minute
execution leases. Preparation locks booking → reservation → selected attempt → ordered
capture receipts → refund obligation → execution; Admin preparation also fences the
active Admin's roles/account. A READY execution's dispatch timestamp commits in a
separate transaction before Stripe is contacted. The adapter uses its stored request,
exact idempotency key, obligation ID and execution ID metadata. Previously dispatched
executions use retrieval or metadata discovery only; lookup failure, an empty search,
lease expiry and a crash do not authorize another creation.

Result transactions retain write-once identity, uncertainty and terminal evidence.
Current lease tokens fence error/check updates and lease clearing; stale workers may
record valid historical provider facts without clearing a newer lease. Verified success
cannot regress. Full verified compensation of an ended request's capture resolves its
review events atomically with completion. Processing retains terminal short-circuits:
no execution is replaced after verified failure or definitive rejection. Within 23 hours
of dispatch an unfound execution is re-sent with its exact idempotency key (Stripe keeps
keys 24 hours), closing the dispatch-to-HTTP crash gap without duplicates. PaymentRefund
stores immutable obligation terms plus status/timestamps (`voided` releases a failed
obligation of an abandoned change); provider references/errors come from executions.

Refund-backed booking changes (cancellation with refund, price reduction) are pending
`booking_adjustments` rows; the booking is unchanged until a single transaction under the
existing configuration fence → location → booking → reservation → attempts → refunds order
applies or abandons them after every obligation is terminal. There is no background
worker: requests, signed Stripe webhooks (payment and refund events) and the Admin
"Check with Stripe" action drive these decisions; see
[payments](payments-memberships.md#recovery-without-a-scheduler). Admin payment/refund
checks retrieve the registered provider operation; payment checks
can cancel overdue unused authorizations but never initiate capture. There are no dual
writes or provider history JSON.

## Notifications and financial exceptions

The application has no notification subsystem: no booking emails, inbox, delivery queue,
scheduled delivery or Brevo integration. Booking and payment workflows have no
notification side effects. Exceptional financial outcomes (rejected refund-backed changes,
unapplied surcharges, late captures, failed/unresolved/reversed refunds) are recorded as
immutable `booking_financial_exceptions` rows inside the deciding financial transaction;
a failed insert rolls that transaction back. The rows reference the historical revision
and the payment, refund or adjustment involved, and replay reuses a stable event key.
Admin visibility comes from the existing refund/payment states in Payments → Transactions.
Supabase Auth confirmation/recovery emails remain independent.

## Coaching programs and prices

Coaching Phase 1 adds programs, program durations, coach profiles, coach
location/program assignments and coaching prices; see [coaching](coaching.md).
Admin services validate, authorize and decide in TypeScript; deterministic price
resolution (coach override, then club default, never re-denominated after a location
currency change) is pure TypeScript. PostgreSQL enforces uniqueness and composite FKs
that require an override's coach to offer the program at that location. Coach saves
lock their profile, then locations under the shared configuration fence; price saves
lock location → program → profile, all shared. Coach availability (weekly intervals and
date exceptions) uses the coach-save lock order, composite assignment FKs and GiST overlap
exclusions; resolution is pure TypeScript. No booking or payment workflow touches coaching
tables yet, and availability alone never makes a lesson bookable.
