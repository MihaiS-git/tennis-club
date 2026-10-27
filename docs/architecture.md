# Architecture

## System boundary

The application is a modular Next.js application for one tennis club with multiple locations. The diagram below shows the current architecture, including court/coaching bookings, Stripe payments/refunds, notifications, staff management, authentication and profiles with private Storage avatars.

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

`src/lib/db/data-source.ts` registers the application entities and the
additional non-synchronized reference to Supabase-managed `auth.users`, and lazily initializes a module-scoped connection. This preserves constructor identity across Next.js route/action
bundles; do not move the connection into a process-global registry. `DATABASE_POOL_MAX`
defaults to 2. Synchronization, dropping schemas and automatic migrations are disabled.
The standalone migration CLI reuses the DataSource and TypeScript loader.

## Management routes

Admin Courts and Pricing are tabs at `/admin/locations/[locationId]?tab=courts`
and `?tab=pricing`. Legacy `/admin/courts` and `/admin/pricing` redirect to the
workspace when a valid current location is supplied, otherwise to Locations.
Admins use `/admin/bookings` and Coaches use `/coach/bookings`; both default to
List and expose Calendar at `?view=calendar`. `/admin/reservations` redirects to
the role’s Calendar with location/date preserved.

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

## Location currency changes

The Admin selects a location's currency at creation. Court pricing rules store minor units
without a currency, so `saveAdminLocation` (`src/lib/admin/locations.ts`) accepts a different
currency for an existing location only when none of these blockers applies:

- **Unfinished bookings**: any `held` reservation (a pending checkout or modification hold),
  or an `active` court booking, coaching booking or staff reservation whose end, resolved in
  the location timezone with `localStartInstant`, is still in the future. Cancelled, released
  and ended (completed) occupancy is history and never blocks.
- **Unresolved financial operations** at the booking's contractual location: a `pending`
  payment attempt, a registered Stripe intent whose attempt is locally `expired` or `failed`,
  a `pending` booking adjustment, a `pending`/`pending_retry` refund, or a provider event
  requiring reconciliation. Local expiry/failure does not prove provider cancellation;
  Admin → Payments → Transactions → Check with Stripe resolves the registered intent.
  Verified cancellation/settlement, failed refunds and pay-at-club amounts due do not block.
  The query follows each booking's current revision, preserving the contractual location
  even if its court moves, without scanning all historical revisions or deduplicating them.
- **Court pricing**: any `location_pricing_rules` row for the location. The Admin removes the
  rules and configures new prices after the change; nothing is converted or deleted automatically.

The rules apply only when the requested currency differs from the persisted one; every other
location edit is unaffected. Inside the existing update transaction (exclusive configuration
fence → location `FOR UPDATE` → Admin fence), the service first runs the standard expiry of
unpaid holds at the location (`expirePaymentHoldsAtLocation`, skip-locked), then evaluates the
blockers. Every booking, reservation, coaching and settlement writer takes the shared
configuration fence, so no booking can appear between the check and the commit. Online
provider selection and Pay at club do not restrict currency changes and are left configured.
A rejection returns `{ reason: "currency-locked", blockers }`.

The location Details form receives the same evaluation (`readAdminLocationCurrencyChange`,
after request-driven hold expiry) and disables the currency control, listing every blocker
with its instruction; a server rejection of a stale form is shown in place without losing the
draft. Only `locations.currency` changes: booking revisions, payment attempts, captures,
refunds and adjustments keep their own snapshotted currencies and amounts, and coaching
prices stay keyed by their explicit currency. Any broader currency migration is a separate,
manual, backed-up operation outside the application.

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
- denied browser-role table grants;
- transactions.

Application-side checks are not enough for concurrency-sensitive invariants.

## Transactions

Application persistence uses repositories with an explicit EntityManager.

Use TypeORM `inTransaction` when several persistence changes must commit atomically.

Examples:

- moving a booking during rescheduling;
- consuming membership credits;
- selected payment/refund state transitions.

Responsibility split:

```text
TypeScript
→ decides what should happen

PostgreSQL transaction
→ guarantees required persistence happens atomically
```

Keep pricing, entitlement rules and other application algorithms in TypeScript.

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

Implemented domains include locations/courts, coaching, booking revisions, payments/refunds
and notifications. Memberships, subscriptions and credits remain planned; Matches/Rankings
are deferred indefinitely. Other future domains may include:

- court availability exceptions;
- booking participant management;
- membership plans/subscriptions/credit ledger;
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
global provider-event receipt and PostgreSQL wall time. Court-only confirmation revalidates current
hours, pricing and publication under that fence; coaching validates its held contract
(see Coaching programs and prices below). Adjustment application also fences
its actor. Exact late captures lock or allocate their compensation obligation before
commit. Changed parents retry in a fresh transaction at most three times. Locked attempt snapshots
are financial authority, independent of rescheduled booking totals.
TypeScript chooses lifecycle/result/reconciliation against lossless effective deadlines and
rechecks wall time before writes. The attempt UPDATE fences deadline-sensitive transitions;
a crossed deadline is re-evaluated as expiry. Booking/reservation/attempt writes, provider
receipt and eligible confirmation notification snapshots commit atomically. Receipt insertion uses the global
(provider,event_id) PK with ON CONFLICT DO NOTHING; a separate statement reads the winner.
Changed evidence throws and rolls back provisional lifecycle writes; identical evidence replays
stored result, preserving later Admin resolution. Late success/mismatch never reclaim occupancy.
Receiptless abandonment uses the same local transaction after provider-confirmed cancellation.
TypeScript hold expiry uses TypeORM.

Booking revision history is implemented; the remaining financial-model work is
described in [Task 4 limitations](payments-memberships.md#remaining-financial-model-work-task-4).

## Refund execution and reconciliation (Phase 8)

Refund obligations preserve their captured-funds allocation and historical contract context;
individual provider requests use immutable `refund_executions` and five-minute leases.
Preparation locks booking → reservation → selected attempt → ordered capture receipts →
refund obligation → execution; Admin preparation also fences authoritative active-Admin
roles/account. Dispatch initiation commits before the provider request; completion records
provider identity and evidence under the execution lease. Provider calls never run inside
transactions.

Refund-backed cancellations and reductions retain the current booking and occupancy until
all obligations succeed. Requests, signed Stripe webhooks and the Admin **Check with Stripe**
action drive recovery; there is no payment/refund scheduler. Unknown outcomes retain the
same execution and exact key, with replay limited to 23 hours after dispatch and evidence-only
lookup thereafter. A replacement execution requires affirmative retryable provider failure
and an explicit Admin check; definitive non-retryable failures require subsequent resolution.
Success evidence is retained even if Stripe later reverses the refund; that reversal becomes
an explicit financial exception and never authorizes replacement.

See [payments and refunds](payments-memberships.md#stripe-cancellation-refunds) for status
semantics, retry conditions, abandoned changes, partial-success recovery and idempotency.

## Notifications and financial exceptions

Booking confirmations, cancellations and reschedules (including coaching lessons), successful
compensation refunds and relevant financial exceptions generate persisted notifications.
`src/lib/notifications/events.ts` records event-keyed inbox messages and eligible email delivery
snapshots through TypeORM in the caller-owned domain transaction. Replay deduplicates by event
and recipient. Immutable `booking_financial_exceptions` preserve historical revision and
payment/refund/adjustment evidence atomically with financial state; their Admin visibility
includes Payments → Transactions and in-app alerts.

Authenticated recipients use the owner-scoped `/messages` inbox; new customer messages
require active, email-confirmed matching accounts. Admin and
Coach accounts receive application notifications in-app only; eligible customer/guest
transactional email uses Brevo. Supabase Auth confirmation/recovery mail remains separate.
Persisted delivery state supports bounded retries through Supabase Cron calling
`POST /api/notifications/deliver`; the Brevo webhook records terminal delivery failures.
Notification delivery scheduling is independent of payment/refund recovery.
A separate Supabase Cron job calls `POST /api/payments/holds/expire` to settle expired
checkout holds through the existing hold-expiry service; see
[checkout hold expiry sweep](payments-memberships.md#checkout-hold-expiry-sweep).
See [notification architecture and delivery](notifications-delivery.md) for recipient policy,
settings, authorization, delivery evidence and retry rules.

## Coaching programs and prices

Coaching modules under `src/lib/coaching` own program configuration, coach assignments,
availability resolution and program-specific pricing. `coach_profiles` remains a sibling
of player profiles, separate from RBAC roles. TypeScript authorizes configuration and
resolves coach overrides before club defaults in the booking currency; PostgreSQL enforces
structural relationships and availability overlap constraints.

Court and coaching bookings share booking identities, immutable revisions, payment attempts,
Stripe checkout/settlement, cancellation, refund and adjustment infrastructure. Coaching
additionally reserves the assigned Coach on the court reservation; court and Coach GiST
exclusions arbitrate conflicting active reservations and live holds, including across locations.
Creation validates resolved Coach availability and the complete lesson interval. Revision
terms retain the program, Coach, participants, duration, agreed coaching fee and court-rental
inclusion; settlement honors that held contract rather than repricing the lesson.

Customer lesson rescheduling uses the owner-authorized booking adjustment flow. It changes
date/start only, preserving the location, court, program, Coach, participants, duration and
agreed coaching terms; eligible court-rental differences use shared surcharge/refund handling.
Private and Semi-private lessons are bookable at `/book?mode=coaching`; Group and Junior
sessions are organized by staff with informational public rates. Packages remain planned.
See [coaching](coaching.md) for configuration, availability, contractual terms and rescheduling.
