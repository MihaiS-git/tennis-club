# AGENTS.md

## Project

`tennis-club` is a Next.js application for operating a single tennis club with multiple physical locations.

The platform will manage:

- locations and courts;
- coaches and coach availability;
- members;
- court and coaching bookings;
- memberships and subscriptions;
- Stripe payments and refunds;
- partner matching;
- match results;
- Elo-style player ratings and rankings;
- club administration.

Read `README.md` before making architectural or domain-level changes.

---

## Core stack

Use the existing stack unless a change is explicitly justified:

- Next.js 16 App Router
- React
- TypeScript
- Tailwind CSS
- Zod
- Supabase Auth
- Supabase PostgreSQL
- Supabase Row Level Security
- `supabase-js`
- Stripe
- PostgreSQL invariant/trigger functions and TypeORM transactions
- TanStack Query when interactive client-side server state is introduced; do not add it before a concrete workflow needs it

TypeORM is the approved persistence layer; do not introduce another ORM.

Do not introduce a separate NestJS, Express, or other backend application unless explicitly requested.

Do not introduce multi-tenancy. This application serves one tennis club with potentially multiple physical locations.

---

## Repository structure

Application source lives under `src/`.

Expected high-level structure:

```text
tennis-club/
├── src/
│   ├── app/
│   ├── components/
│   ├── lib/
│   │   └── supabase/
│   │       ├── server.ts
│   │       └── proxy.ts
│   └── proxy.ts
├── public/
├── supabase/
├── e2e/
├── scripts/
├── docs/
├── .github/
├── AGENTS.md
├── README.md
├── package.json
└── tsconfig.json
```

Not every directory needs to exist before it is needed.

Do not create speculative folders or abstractions.

Never delete, move, rename, clean, or replace user-provided assets under `public/` unless explicitly instructed.
---

## General implementation rules

Prefer incremental changes over rewrites.

Preserve:

- existing architecture;
- existing naming;
- existing folder structure;
- existing coding style;
- existing behavior unless the task explicitly changes it.

Do not rewrite unrelated code.

Do not introduce abstractions without a concrete current need.

Prefer:

1. correctness;
2. security;
3. maintainability;
4. testability;
5. performance;
6. simplicity.

Avoid clever solutions when a simpler explicit implementation is sufficient.

---

## Next.js conventions

Use the App Router.

Prefer Server Components by default.

Cache Components is enabled. Keep public/shared content prerenderable and isolate request-specific auth/account UI behind Suspense boundaries. Never persistently cache user-scoped Supabase clients, sessions, accounts, roles, status, or profile/avatar metadata. React `cache()` may deduplicate reads within one server request.

Add `"use client"` only when the component actually requires browser-side behavior such as:

- state;
- effects;
- browser APIs;
- event-driven interactive UI that cannot remain server-rendered.

Keep Client Component boundaries as small as practical.

Do not move an entire page or large component tree to the client just because one child requires interactivity.

Use:

- Server Components for data-oriented rendering and initial/simple reads;
- Server Actions for appropriate authenticated mutations originating from the application UI;
- Route Handlers for HTTP endpoints such as Stripe webhooks, integrations, and client-side query endpoints when needed;
- Client Components only for interactive browser behavior.

Supabase access is server-first. Do not query Supabase directly from Client Components unless a concrete browser-specific requirement has been explicitly introduced.

### Next.js Proxy

This project uses Next.js 16. Use the Next.js 16 Proxy convention for request interception and Supabase session refresh.

The application entrypoint is:

```text
src/proxy.ts
```

with an exported `proxy` function:

```ts
export async function proxy(request: NextRequest) {
  // delegate to the Supabase session-refresh helper
}
```

Do **not** create `middleware.ts` or export a `middleware` function for this project. Those names apply to Next.js 15 and earlier. On Next.js 16, a `middleware.ts`-only implementation will not provide the intended application proxy behavior.

Keep the Supabase-specific session-refresh implementation separate, for example:

```text
src/lib/supabase/proxy.ts
```

The root proxy should stay thin and delegate to that helper.

The proxy is responsible for authentication session maintenance, such as:

- reading Supabase auth cookies;
- refreshing/verifying the session when required;
- propagating updated cookies and response headers.

Do not put application authorization or domain rules in the proxy. In particular, do not put membership, pricing, booking, or role-specific business logic there. Next.js is the complete primary application authorization boundary; application table grants deny direct browser access and Storage RLS protects private objects.

When implementing Supabase SSR cookie handling, use the current `@supabase/ssr` `getAll()` / `setAll()` cookie API. Do not copy deprecated `get` / `set` / `remove` examples from older Supabase tutorials.

For server-side identity verification, prefer the current Supabase-recommended verified claims flow (for example `auth.getClaims()`) rather than treating an unverified session payload as authoritative.

If the project's Next.js major version changes, re-check the framework's proxy/middleware convention and update this file in the same change.

Do not put substantial business logic directly in:

- React components;
- Server Actions;
- Route Handlers.

These should delegate to application/domain functions.

---

## Application layering

Prefer these flows:

```text
Server-rendered read
↓
Server Component
↓
Application/domain logic
↓
TypeORM repositories
↓
PostgreSQL invariants
```

```text
Interactive client workflow
↓
Client Component
↓
TanStack Query, when introduced
↓
Next.js server boundary
↓
Application/domain logic
↓
TypeORM / Stripe integration
↓
PostgreSQL / Stripe
```

TanStack Query must not become a reason to move business logic or normal Supabase data access into the browser.

Examples of domain/application operations include:

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

Keep domain functions framework-light and unit-testable where practical.

---

## TypeScript

Use strict TypeScript.

Avoid:

- `any`;
- unsafe type assertions;
- duplicated domain types;
- casts used only to silence compiler errors.

Prefer deriving types from authoritative definitions where practical.

Use explicit domain types for important states such as:

- booking status;
- payment status;
- user role;
- membership status.

Model impossible or invalid states out of the application where reasonable.

---

## Validation

Treat all external input as untrusted.

Validate boundaries with Zod where appropriate, including:

- form input;
- Server Action input;
- Route Handler input;
- URL/query parameters;
- webhook-derived application payloads after provider verification;
- data entering important domain operations.

Validation does not replace authorization.

---

## Supabase

All application persistence and application migrations use server-only TypeORM through
`DATABASE_URL`. Supabase runtime access is limited to Auth and private Storage.
Application tables have no anon/authenticated grants or application RLS policies;
Next.js authorization and explicit owner/public-visibility filters are required.
Storage retains RLS, with a secured active-account boolean helper that avoids browser
SELECT access to users. Auth provisioning and email synchronization hooks, the private
avatar bucket and its policies are installed by TypeORM migrations.

Do not create legacy coordination tables or business-policy triggers/functions.
Configuration writes take the exclusive transaction advisory fence `(1791462257, 1)`
before ordered location locks; configuration-dependent booking/reservation commands
use its shared counterpart. Keep existing actor fences, bounded parent retries and
location-first occupancy serialization. TypeScript owns policy, hold expiry and
explicit timestamps. PostgreSQL retains structural constraints and overlap exclusions.
The DataSource connection remains module-scoped for Next.js entity metadata identity.

For fresh databases start native Supabase infrastructure, then run TypeORM migrations.
Local development data is disposable: use the guarded
`npm run db:dev:rebuild -- --discard-local-data` workflow to replace its legacy schema.
Never run the initial migration against a populated remote/shared database: it requires
a separately authorized, data-preserving cutover. Supabase SQL is not an application
migration authority. See README.md for commands and docs/testing.md for disposable checks.

Supabase access is **server-first**. The initial application does not use a browser Supabase client.

### User-scoped server client

Use the authenticated user’s Supabase session for verified Auth identity and private Storage access. PostgreSQL operations use TypeORM after application authorization and explicit owner/visibility checks. Application tables deny browser-role access; Storage retains RLS.

```text
authenticated user
→ Next.js
→ verified Supabase Auth identity
→ TypeORM application persistence
→ PostgreSQL invariants
```

Use server-only environment variables for the current architecture:

```env
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
APP_URL=
```

Do not introduce `NEXT_PUBLIC_SUPABASE_*` variables merely because Supabase examples use a browser client.

### Browser Supabase client

Do not create or use a browser Supabase client unless a concrete feature requires direct browser-to-Supabase communication.

A valid future example is Supabase Realtime. If such a feature is introduced:

- keep the scope narrow;
- expose only browser-safe values;
- retain RLS as defense-in-depth and secondary security;
- document the new browser access path in both `README.md` and `AGENTS.md`.

### Local privileged tooling

Supabase secret/service-role credentials are limited to guarded local seed and test
fixtures. Production application persistence, Stripe webhooks use TypeORM.

`SUPABASE_SECRET_KEY` is not required by production application persistence.
Checkout creation/initialization and coupled reads use TypeORM. Payment settlement and Phase 8 refund/reconciliation use TypeORM transactions;
refund commands do not use that client. Polling expiry transport and confirmation-policy
reads use TypeORM.
The coupled personal direct-reservation service uses TypeORM after
`requireReservationRole`, with verified creator filters; private-column grants
and public occupancy projections remain explicitly restricted.
Internal timetable occupancy uses bounded TypeORM SELECTs after `requireReservationRole`,
restricted to requested courts/date and active or held reservations at active, unarchived
resources. TypeScript includes held rows only while their persisted deadline is later than
one shared `now`; reads never expire holds. Coach occupancy remains generic, with
customer/direct-reservation details confined to the existing Admin-only read.
Live personal activity/history uses bounded TypeORM projections after active-account authorization,
always filtered by verified booking owner or direct-reservation creator. Direct-reservation
activity requires an Admin/Coach role; classification, merge, sort and pagination remain in TypeScript.

Application database persistence has no Supabase writer or RPC fallback.

Never expose the secret key to:

- browser code;
- Client Components;
- public environment variables;
- logs;
- responses.

---

## RLS and authorization

Next.js is the complete primary application authorization boundary. Application tables must deny direct browser-role access; private Storage retains RLS.

Authorization must not rely only on:

- hidden UI;
- disabled buttons;
- client-provided roles;
- client-provided ownership identifiers.

Examples of required boundaries:

- members can access their own private data;
- members cannot access another member's private data;
- members can manage only permitted bookings;
- coaches can manage their own availability;
- coaches can access sessions assigned to them;
- admins can manage club resources according to their role.

Role information must come from authoritative application/database state.

When adding private/user-owned tables, preserve denied browser-role grants and explicit Next.js authorization.

---

## Public and private user data

Keep account/personal/contact information in `public.users` separate from tennis information in `public.player_profiles`. Tennis profiles are readable by active authenticated users, never anonymously. Owners may edit their own permitted fields; rating is system-managed. Future `coach_profiles` is a sibling domain entity, not an RBAC role or a required extension of player profiles.

Tennis data visible to active authenticated users may include:

- display name;
- rating;
- ranking;
- match statistics;
- rating history (when implemented).

Private data may include:

- contact information;
- billing metadata;
- account information;
- private preferences.

Player avatars use the private Supabase Storage bucket `profile-avatars`, through the user-scoped server client and Next.js avatar actions. Decode JPEG/PNG/WebP sources with Sharp, enforce the 5 MiB upload, 12,000-pixel side, and 40-million-pixel limits, and normalize to WebP within 512 × 512 without enlargement or cropping. Store only the canonical `<user-id>/avatar.webp` path in player profiles; the bucket accepts only `image/webp` objects. Lightweight browser file checks are UX only. No browser Supabase client is introduced. See `docs/profiles.md` for the implemented workflow.

Avatar mutations share one UI pending state. Phase 10 uses focused TypeORM avatar owner/reference/metadata persistence and short transactions with authoritative active-owner/profile rechecks. Storage remains user-scoped Supabase at the canonical private object. Never put Storage/network calls in a database transaction. No runtime avatar lease or backup/restore protocol remains: initial-upload DB failure attempts best-effort object deletion; replacements keep new bytes at the same path even if timestamp persistence fails; removal commits a NULL reference before best-effort Storage deletion and returns visible-removal success for UI revalidation. Storage/PostgreSQL are not atomic; rare orphan objects and ambiguous network/concurrent outcomes are accepted. See `docs/profiles.md`.

Prefer schemas that make access boundaries explicit.

---

## Business logic

Keep domain algorithms in TypeScript.

Examples:

- booking eligibility;
- pricing;
- membership discounts;
- membership entitlements;
- cancellation policy;
- refund calculations;
- partner matching;
- Elo calculations;
- workflow decisions.

Do not implement these algorithms in SQL unless there is a specific demonstrated reason.

---

## PostgreSQL responsibilities

PostgreSQL should enforce data invariants that must remain correct regardless of application behavior.

Use database features where appropriate:

- primary keys;
- foreign keys;
- unique constraints;
- `NOT NULL`;
- `CHECK` constraints;
- indexes;
- exclusion/overlap protection;
- RLS;
- transactions.

Application-side checks are not sufficient for concurrency-sensitive invariants.

In particular, the database must ultimately prevent overlapping active reservations for:

- the same court;
- the same coach.

---

## Transactions

Repositories receive an explicit EntityManager and never start transactions themselves.

Use TypeORM `inTransaction` when multiple application persistence changes must commit atomically; repositories accept an explicit EntityManager and never start transactions.

Examples may include:

- moving a booking during rescheduling;
- consuming membership credits;
- recording a match and both rating changes;
- selected payment/refund state transitions.

Keep retained database functions integrity-oriented.

The intended separation is:

```text
TypeScript
→ decides what should happen

PostgreSQL transaction
→ guarantees the required persistence happens atomically
```

Do not turn PostgreSQL functions into a second application/business-logic layer.

---

## Court pricing rule sets

Public location discovery for `/book` and `/courts` uses `listPublicLocationsWithCourts()` and the shared TypeScript eligibility rule in `src/lib/locations/publication.ts`. `locations.is_public` defaults to false and records explicit Admin publication intent; readiness is derived from valid location details, opening hours, active courts, and current or future base-state pricing for each active court. Admin enabling validates readiness server-side. Public TypeORM SELECTs explicitly require publication.

The public `/book` page reads opening hours, coverage periods, and pricing
rules for active public resources for one valid location-local date through
explicit public TypeORM projections. Both `/book` and `/reservations` default to
location-local today when the URL omits a date; explicit invalid dates remain
rejected, and `/book` also rejects past dates. `/reservations` allows staff to
navigate to past dates with read-only occupancy details under the existing role
visibility rules. Past slots and records remain protected by mutation guards.
The default is resolved during server rendering, without a
client redirect or adjacent-day preload. Location discovery still uses only the
minimal opening-hours and pricing fields needed to derive public eligibility.
Public TypeORM projections supply those reads; configuration writes remain
admin-only. Calendar availability is informational until bookings are implemented.
It also reads only reservation occupancy columns for the selected date and
active courts at that location. Only active reservation rows block their half-open
intervals; reservation identity, reason, creator, canceller, status, and timestamps are not publicly readable.

Internal `/reservations` is a separate direct court-reservation workflow for active
Admins and Coaches. It lists structurally ready locations without requiring publication.
The user-scoped Server Action validates location-local
time, a single opening-hours interval, 30-minute alignment, at least 60 minutes,
and a required trimmed reason of at most 255 characters. TypeORM create transactions
recheck locked resources and staff facts; browser roles have no reservation INSERT grants
and the GiST exclusion constraint rejects concurrent active/held overlaps. Public `/book`
continues to read occupancy alone and never reads reservation reasons.
Customer booking persistence uses `public.bookings` for required historical contact
and server-calculated price/currency snapshots, with one unique reference to its
physical `court_reservations` row. The server-only `createCustomerBooking` operation
accepts only customer intent, resolves account identity before the transaction, then
uses authoritative TypeORM configuration reads and the existing `/book` pricing helpers.
Location customer cancellation notice is configured in the shared Admin Create/Edit
location form, stored as 0–43,200 integer minutes with a 1,440-minute default.
The TypeORM checkout transaction reads and stores the location policy snapshot in
`bookings.cancellation_notice_minutes`; personal upcoming/history and Admin operational
reads use that booking snapshot. Admin location configuration reads use active-Admin-authorized TypeORM persistence;
public location SELECT keeps only its existing columns. The server-only cancellation
service requires an active owner, confirmed booking and active linked reservation.
The shared TypeScript policy enforces the inclusive snapshot cutoff and Admin/Coach
notice bypass, while always rejecting booking start. The Phase 6 TypeORM cancellation transaction fences actor roles/account after location,
booking, reservation, selected attempt and existing refund locks; TypeScript evaluates
the snapshot deadline using post-lock database wall time, then persists lifecycle,
refund request atomically, followed by post-commit email.
Personal upcoming customer-booking reads authorize the active account, then use narrow
server-only TypeORM projections filtered by verified owner, confirmed booking and active
reservation. TypeScript uses existing location-time utilities for upcoming filtering
and `starts_at_instant` composition; browser grants remain unchanged.
Explicit confirmation precedes cancellation; Upcoming refreshes and History retains the
cancelled row. Guest identity matching cannot grant access. Admin operational and direct
reservation cancellation remain separate.
Guests have a null account link; suspended authenticated users are rejected. A
TypeORM checkout transaction inserts reservation, booking and payment attempt atomically, leaving GiST authoritative for
overlaps. Browser roles cannot read or insert bookings. `/book`
uses a focused customer-details dialog and Server Action. Guests can confirm without
an account; active signed-in users receive editable contact defaults from Profile.
Contact edits affect only the booking snapshot. Availability conflicts clear the
selected interval, retain contact values, and refresh public occupancy. Success
shows the server-confirmed price. Customer checkout now uses the provider-neutral payment/hold foundation described
in `docs/payments-memberships.md`. Online is the default; `locations.allow_pay_at_club`
defaults false and is rechecked by the TypeORM creation transaction. Snapshot the payment method on
bookings and provider on each online attempt. Keep `paymentHoldDurationSeconds`
centralized in the payment domain. Active and held reservations share GiST;
database-time occupancy filtering plus transactional lazy expiry cleanup before
reservation writes prevents stale holds from blocking indefinitely. Settlement is
service-role-only, retains both row IDs and emits confirmation only on confirmation.
Stripe uses the existing checkout/hold lifecycle through its isolated adapter and
signature-verified webhook. No browser-callable settlement endpoint exists.
Direct reservations store the authenticated creator in nullable
`court_reservations.created_by_user_id` (historical rows stay null). `/reservations`
reads occupancy for Admins and Coaches and creates new direct reservations. Active
Admins also read active direct-reservation identity, reason, and creator display name
through an Admin-authorized TypeORM projection for a whole-reservation details dialog. A distinct
Admin-only TypeORM cancellation transaction changes an active direct row to cancelled
strictly before start, records the verified Admin as canceller, and preserves its creator and details.
Personal cancellation remains owner-only and is allowed until reservation end. Coaches receive generic
occupied cells only; public `/book` remains occupancy-only.
Admin Edit on `/reservations` currently uses the shared reservation edit form and a
separate Admin-only availability read for the active reservation's fixed location.
It excludes the edited row from occupancy and includes other active reservations.
Admin Save uses an Admin-only TypeORM transaction with a row lock, a lossless
microsecond `updated_at` stale token, TypeScript fixed-location enforcement, and GiST
protection. It preserves the creator and lifecycle fields and permits only
reason changes once an interval starts. The owner-only edit read and mutation
remain separate. Admin customer-booking rescheduling uses the shared TypeScript
service and existing calendar court-state/pricing/rounding functions. Only active
Admins may change future confirmed bookings within their fixed location. The focused
Phase 6 TypeORM reschedule command holds shared configuration advisory fence then location UPDATE before
booking/reservation UPDATE locks, fences actor roles/account, and compares both tokens
in PostgreSQL before TypeScript target/pricing decisions and atomic writes.
Configuration writes take the exclusive advisory fence, so stale pricing,
coverage, hours and resource decisions cannot commit. Price acknowledgement and
reconfirmation belong only in TypeScript. Success uses `revalidateCourtActivity("edit")`.

Customer self-rescheduling from `/my-activity/bookings` uses the shared Admin booking
edit timetable, availability loader, price confirmation form, and same-row transactional
reschedule implementation. The server-only service and scoped persistence command require
an active account and strictly bind the booking account to the verified actor. Ordinary owners
must remain within the booking's snapshotted cancellation-notice window (inclusive
cutoff); current Admin/Coach owners bypass notice only. Every owner must be before
booking start. The fixed location, both IDs, owner/contact/policy snapshots and creation
timestamps are preserved. Both stale tokens, server pricing with explicit changed-price
acknowledgement/reconfirmation, and the active-row GiST constraint remain authoritative.
Owner-scoped availability excludes its own reservation and returns only active courts,
opening hours and occupancy for its fixed location, independent of public publication.
Focused TypeORM command/edit reads retain separate owner and Admin authorization
boundaries against locked authoritative facts. Success calls `revalidateCourtActivity("edit")`
for `/book`, `/reservations`, and `/my-activity/bookings`. Full Stripe cancellation
refunds are implemented; guest self-management is not implemented. Booking lifecycle notifications are
post-commit Brevo delivery; see `docs/booking-notifications.md`.

 `/profile` contains identity and settings;
`/my-activity` redirects to `/my-activity/bookings`, which
contains current/upcoming personal booking/reservation management. `/my-activity/history`
is the current account's completed/cancelled bookings and staff-owned direct reservations. Both pages retain the My Activity heading and Admin-style submenu. The server activity service authorizes the active account before bounded, privileged owner-filtered SELECTs; direct reservations require an Admin/Coach role. TypeScript classifies, filters and sorts the combined dataset before fixed 20-row pagination, with kind/ID tie-breakers. URL controls preserve filters/sort across pages and reset page 1 when changed.
Coupled personal reservation reads bind explicitly to the verified actor UUID through TypeORM and use location-local time for lifecycle classification. Activity/history reads use owner-filtered TypeORM projections through the current activity service.
Active Admins and Coaches can cancel
only their own active Upcoming reservations after explicit confirmation. Server authorization and database checks
require ownership, an active, unarchived location and active court. Cancellation atomically
sets status to `cancelled`, `cancelled_at`, and the authenticated
`cancelled_by_user_id`; the original row and creator remain. Cancelled rows free
occupancy and remain stored for future history. No pricing or refund is involved.
`/my-activity/bookings` also edits the same owned active row: future reservations may change date,
court within the existing location, time and reason through the shared direct-reservation timetable;
in-progress reservations may change reason only. The personal edit availability read excludes
the edited row from occupancy and returns no other reservation metadata. The personal
edit transaction locks the row; TypeScript compares its lossless `updated_at` token and rejects a different location.
TypeScript reuses direct-creation validation for the fixed location, court, local time and opening
hours; PostgreSQL keeps the active-row GiST overlap constraint authoritative.

Direct reservation commands use `inTransaction` at READ COMMITTED. Create and schedule
edit acquire `shared configuration advisory fence` then `locations FOR UPDATE`.
Existing-row commands discover the location, lock it before the reservation FOR UPDATE,
then fence the actor with ordered Admin/Coach `user_roles FOR SHARE` followed by
`users FOR SHARE`. A changed parent retries in a fresh transaction at most three times.
Reason-only edits and cancellation omit the configuration advisory fence. TypeScript owns
all role, ownership, lifecycle, timing and schedule decisions. Owner reason-only
edits retain the inactive-resource exception; Admin edits require active resources.
Edits use transaction `now()` for database lifecycle decisions and PostgreSQL
`greatest(clock_timestamp(), updated_at + interval '1 microsecond')` for tokens.
Owner cancellation stores transaction `now()`; Admin cancellation checks database
`clock_timestamp()` after locking against the DST-compatible local start instant.
All trusted direct commands explicitly reject a linked `bookings` row. Keep customer
commands, TypeScript hold expiry, GiST, grant restrictions, advisory fencing and
direct-reservation database invariants unchanged. No Auth/network calls occur in transactions.

Admin pricing definitions apply to selected courts, not surfaces. One definition has
one stable `rule_set_id` and expands to one atomic `location_pricing_rules` row per
court × weekday. Create and Edit use the same multi-court, multi-weekday form; the
admin manages one logical table row per definition. Indoor courts allow only the
`indoor` state; outdoor courts allow `outdoor` or `covered`. Currency comes from the
court's location. Validate all selected court/day targets against that location's
opening hours before saving. Active-Admin-authorized TypeORM transactions create,
replace and delete complete rule sets; PostgreSQL enforces court/location/environment integrity
and per-court/state/day/date/time overlap exclusion. Times are half-open `[start,
end)`, so adjacent intervals are valid and the boundary belongs to the later rule.
The resolver uses court ID, derived state, date, weekday and minute, never surface.

---

## Booking rules

Bookings are concurrency-sensitive.

Never rely only on a prior availability query such as:

```text
check availability
→ insert booking
```

because another request may reserve the resource between those operations.

Booking implementation must account for concurrent requests.

### Booking holds

Paid checkout should use temporary holds so the same resource cannot be sold to another user while payment is in progress.

Conceptually:

```text
available
→ held
→ confirmed
```

or:

```text
available
→ held
→ expired
```

The exact hold duration belongs in application configuration/domain policy.

Do not hard-code policy values throughout UI components.

---

## Booking state

Keep booking state separate from payment state.

Expected booking states may include:

```text
held
confirmed
cancelled
completed
expired
```

Rescheduling should normally be represented as booking history rather than as a permanent `rescheduled` state.

---

## Payment state

Payment state is independent from booking state.

Expected payment states may include:

```text
unpaid
processing
paid
failed
partially_refunded
refunded
```

Do not assume:

```text
one booking = one financial transaction
```

A booking may have:

- initial payment;
- rescheduling surcharge;
- partial refund;
- additional refund.

---

## Stripe

Stripe operations must be server-side.

The browser must never be authoritative for:

- price;
- discount;
- refund amount;
- payment status;
- membership entitlement;
- remaining credits.

The server must independently calculate or retrieve authoritative values.

### Webhooks

Stripe webhooks are authoritative for asynchronous Stripe state changes.

Always:

1. verify the Stripe signature;
2. process only supported event types;
3. make webhook processing idempotent;
4. persist processed Stripe event IDs where appropriate;
5. handle duplicate webhook delivery safely.

Never assume Stripe delivers an event exactly once.

Use Stripe idempotency mechanisms for operations that can be retried.

---

## Memberships

Stripe owns subscription billing state.

Application code owns membership entitlements.

Do not infer complete application authorization from only:

```text
Stripe subscription = active
```

Instead resolve application rules such as:

- booking discount;
- included court time;
- coaching credits;
- booking-ahead limits;
- priority booking.

If consumable credits are introduced, prefer a ledger/transaction approach over relying solely on a mutable balance field.

---

## Rankings

Initial player rankings use an Elo-style system.

Elo calculations belong in TypeScript.

A ranked match update must persist atomically:

```text
match
+
player A rating
+
player B rating
+
player A rating history
+
player B rating history
```

Never leave partially applied rating changes.

Elo calculation code should be deterministic and covered by unit tests.

---

## Security

Treat client-controlled values as untrusted.

The browser must not determine authoritative:

- prices;
- discounts;
- roles;
- membership entitlements;
- credits;
- booking availability;
- payment status;
- refund amounts;
- rating changes.

Prevent mass assignment.

Do not blindly pass objects received from clients into database insert/update operations.

Select explicitly which fields may be changed.

Do not expose secrets through:

- `NEXT_PUBLIC_*`;
- client bundles;
- logs;
- error messages;
- API responses.

The current project intentionally keeps the Supabase URL and publishable key server-only because there is no browser Supabase client. Do not add `NEXT_PUBLIC_SUPABASE_*` variables without a concrete browser-side requirement.

---

## Environment variables

Do not commit secrets.

Keep a committed `.env.example` containing variable names and safe placeholder values.

Local secrets belong in `.env.local` or another ignored environment file.

Clearly distinguish browser-safe variables from server-only values and secrets.

Current Supabase configuration uses:

```env
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
```

These values are server-only in the current architecture because direct browser-to-Supabase access is not used.

`APP_URL` is the canonical server-side application origin used for authentication email redirects. Production must define it; production code must not silently fall back to localhost.

Signup must require email confirmation. Do not treat a user returned by `auth.signUp()` as authenticated, and do not allow a signup session before confirmation. Signup confirmation uses `/auth/callback`; password recovery uses `/auth/callback?next=/reset-password`.

For local development, the application origin is `http://localhost:3000`, the Supabase API is `http://127.0.0.1:54321`, and Auth emails are captured by Mailpit at `http://127.0.0.1:54324`. Mailpit is not a production email transport. Hosted Supabase projects must enable email confirmation, allow the environment-configured callback URLs, and configure production email delivery in the Supabase Dashboard.

Add `SUPABASE_SECRET_KEY` only when a privileged server workflow is implemented.

Any variable prefixed with:

```text
NEXT_PUBLIC_
```

must be safe to expose publicly.

Never prefix server secrets with `NEXT_PUBLIC_`.

---

## Error handling

Do not expose raw database, Supabase, Stripe, or internal stack errors to users.

Log enough information server-side for diagnosis without leaking:

- secrets;
- access tokens;
- payment-sensitive data;
- unnecessary personal information.

Use domain-appropriate errors at application boundaries.

Do not silently swallow errors.

---

## Logging and observability

Important workflows should be diagnosable.

Pay particular attention to:

- booking creation;
- booking conflicts;
- payment creation;
- Stripe webhook processing;
- cancellations;
- refunds;
- rescheduling;
- subscription changes;
- rating updates.

Use structured context where logging exists.

Never log credentials or raw authentication tokens.

---

## Audit trail

Sensitive administrative or financial actions should be auditable.

Examples:

- role changes;
- manual booking changes;
- cancellations;
- refunds;
- membership overrides;
- rating adjustments.

Audit data should make it possible to determine:

```text
who
did what
to which entity
when
```

---

## Styling

Use the existing Tailwind CSS setup.

Preserve existing design conventions.

### Global application UX contract

- Present dense management data in compact tables instead of repeated large cards.
- Allow safe direct editing of simple scalar fields such as status, enum/select values, booleans, and ordering values. Use focused dialogs, popovers, or forms for compound and structural data.
- Support bulk operations for predictably repetitive work.
- Use the same form, field semantics, validation, and interaction model for Create and Edit of one business object.
- Present logical business objects to users; do not expose atomic persistence rows as UI entities.
- Make time and timezone controls mouse-selectable while allowing typing where appropriate.
- Show prominent validation and operation errors inside or immediately beside the failed operation. Preserve submitted values, translate infrastructure/database errors into safe messages, and reserve space where needed to prevent nearby controls from moving.
- Apply filter and context selections immediately when the selection itself is sufficient; omit redundant View or Apply steps.
- Use progressive disclosure so secondary configuration and actions do not overpower the primary entity.
- Prefer deactivate/archive/restore over destructive deletion for long-lived entities with historical relationships, when appropriate.
- Keep shared application and section navigation stable through route transitions. Never replace a whole application shell with a bare loading message; keep loading feedback within the smallest data-dependent region.
- Keep UX changes server-first and within existing Tailwind/design-system conventions. Add no UI framework or generalized abstraction without a concrete need.

Do not introduce an additional styling framework without a concrete requirement.

Keep responsive behavior intentional.

For booking UI:

- desktop may use a resource/timeline layout;
- mobile should use appropriate mobile interactions rather than simply shrinking the desktop timeline.

---

## Dependencies

Do not add dependencies without a concrete need.

Before adding a package, check whether:

- the platform already provides the capability;
- existing dependencies can solve the problem cleanly;
- a small local implementation is simpler;
- the dependency creates security or maintenance cost.

Do not replace existing libraries merely because another library is preferred personally.

TanStack Query is intentionally planned but not required for the Supabase foundation. Add it when the first interactive client-side server-state workflow benefits from caching, invalidation, background refetching, or mutation state. When it is introduced, update both `README.md` and `AGENTS.md` in the same change.

---

## Testing

Behavior changes should be tested.

### Testing Stack

- Vitest → unit and application integration tests.
- React Testing Library → React component tests.
- Local Supabase → real integration tests.
- Local Supabase integration tests → PostgreSQL-native integrity, denied database access, Auth provisioning, and private Storage protection.
- Use normal extensionless TypeScript/Next.js imports; never add `.ts` extensions as a test-runner workaround.

### Unit tests

Use unit tests for deterministic TypeScript domain logic such as:

- pricing;
- discounts;
- membership entitlements;
- cancellation rules;
- refund calculation;
- partner compatibility;
- Elo calculation.

### Database/integration tests

Use integration tests for:

- RLS;
- database constraints;
- booking overlap prevention;
- coach overlap prevention;
- transactional TypeORM behavior;
- privileged vs user-scoped access.

### Stripe integration tests

Cover important cases such as:

- successful payment;
- failed payment;
- duplicate webhook;
- full refund;
- partial refund;
- duplicate refund protection;
- subscription lifecycle;
- rescheduling price differences.

### End-to-end tests

Critical user workflows should eventually include:

```text
sign in
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

When fixing a bug, add a regression test where practical.

---

## Verification

Before considering a coding task complete, run the relevant checks available in `package.json`.

At minimum, for application changes, expect to run the applicable equivalents of:

```bash
npm run lint
npm run build
```

Run unit, integration, or E2E tests relevant to the changed behavior when those test suites exist.

Do not claim a command passed unless it was actually run successfully.

If a required test cannot be run, state why.

---

## Database changes

Database schema changes should be committed as Supabase migrations.

Do not make untracked/manual production database changes.

When changing database structure:

1. create/update the migration;
2. update relevant RLS policies;
3. update generated/application types if applicable;
4. update application code;
5. add or update tests;
6. verify the migration from a clean local database when practical.

This project currently uses a development database. For unreleased schema, maintain clean, scope-focused migration history: edit the migration that naturally owns the schema and add focused migrations for new domains/infrastructure. Do not accumulate corrective patch migrations for unreleased schema. Never run `supabase db reset` without explicit user approval.

For released production schema, do not edit an already-applied migration to represent a new change; add a new migration instead.

---

## Scope discipline

Implement only what the current task requires.

Do not opportunistically:

- rename unrelated files;
- reorganize unrelated directories;
- rewrite working code;
- migrate libraries;
- reformat the whole repository;
- introduce speculative infrastructure.

If a broader refactor would materially improve the requested change, explain it before expanding scope.

---

## Current non-goals

Unless explicitly requested, do not introduce:

- multi-tenancy;
- microservices;
- a separate backend service;
- an ORM;
- event sourcing;
- AI-based partner matching;
- complex dynamic pricing;
- generic multi-sport abstractions;
- tournament infrastructure.

---

## Coding-agent workflow

Before making significant changes:

1. read `README.md`;
2. inspect the existing implementation;
3. inspect relevant tests;
4. preserve current architecture and conventions;
5. identify security and concurrency implications;
6. make the smallest coherent change;
7. add/update tests where behavior changes;
8. run relevant validation commands;
9. update `README.md` and/or `AGENTS.md` when architecture, tooling, security boundaries, or development conventions change;
10. summarize what changed and any remaining assumptions.

Do not infer missing requirements when they materially affect architecture or behavior. Ask for clarification instead.

---

## Response expectations

When describing completed code changes, include:

### Why this change

Explain the reason for the implementation.

### How to validate locally

Provide the exact relevant commands or manual verification steps.

### Assumptions

State any assumptions made during implementation.

When practical, present code changes as unified diffs or identify exact file paths changed.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Booking email notifications

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

The `/book` confirmation UI reads only the selected eligible public location’s cancellation-notice value through a narrow TypeORM read. After atomic creation, a read bound to the returned booking ID retrieves its stored policy snapshot; authenticated success uses the existing TypeScript timezone utility for start instant and cutoff display. Guest success shows the stored notice without inferring a timezone-resolved cutoff. Failed post-commit display reads are logged and never report the committed booking as a failed submission. No browser database access or public database grants are added.

## Payment provider configuration

Admin → Payments → Settings (`/admin/payments/settings`) is the sole active-provider selection UI. Stripe and NETOPIA
configuration modules stay behind `PaymentProviderConfiguration`; booking/domain
code resolves only an identifier. All credentials are server-only environment values:
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NETOPIA_API_KEY`,
`NETOPIA_POS_SIGNATURE`, `NETOPIA_ENVIRONMENT`. `STRIPE_PUBLISHABLE_KEY` is
browser-safe and must match secret key mode. Admin receives only provider IDs and
configured booleans; never secret values or validation payloads. Stripe SDK/types
stay inside `src/lib/payments/providers/stripe`. NETOPIA has no adapter yet.

The singleton `payment_provider_settings.active_provider` starts NULL. Next.js Admin
service verifies complete configuration and the verified actor before a READ COMMITTED
TypeORM transaction. It fences actor roles/account, then locks the settings singleton
FOR UPDATE. Same-value selection preserves updated_at and inserts no audit; changed
selection updates with database wall time and inserts the audit atomically. Browser database roles have no settings writes.
Atomic checkout locks/rechecks selection before storing the attempt provider. There
is no Stripe default, automatic failover, or customer provider choice. If selection
or the selected provider’s configuration is absent, online payment is unavailable.
Pay at club remains independently controlled per location. Never rewrite stored
attempt providers when settings change; focused TypeScript persistence preserves this.

Legacy booking payment method/collection is unknown: leave the method NULL and
create no fabricated Pay at club due payment. New checkout always snapshots the
selected method, and every online attempt snapshots its provider.


## Stripe one-time payments

`commitCustomerCheckout` wraps TypeORM atomic booking creation; never add another booking
or availability flow. Persist the attempt before creating its PaymentIntent using
the stored provider/amount/currency. Use stable attempt idempotency and register the
provider reference before returning client-secret presentation. Card-only Payment
Element stays inside the existing confirmation dialog. Keep the ten-minute expiry
unchanged. Checkout capability polling is server-only, hashes a random token on the
attempt, and never trusts browser status or totals.

`/api/payments/stripe/webhook` verifies the raw body signature, translates events and
calls common `processOnlinePaymentEvent`. Its service-only transaction records event
receipt and reuses existing same-row settlement atomically. Preserve location-first
lock order, application occupancy validation, retained GiST and notification timing.
Late paid events or financial
mismatches must set private `payment_provider_events.reconciliation_required` and
must never reclaim a released court. Full Stripe cancellation refunds are implemented as described below; failover and automatic reconciliation
are not implemented. See `docs/payments-memberships.md` for configuration and verification.

## Stripe cancellation refunds

Phase 6 TypeORM cancellation preserves existing owner cutoff and Admin-before-start
rules, locks the authoritative aggregate and original successful Stripe attempt, cancels
occupancy and creates one full `payment_refunds` snapshot atomically. Customer cancellation
requires a full refund; Admin supplies an explicit boolean choice. Pay-at-club creates no
refund. Lifecycle helpers are not browser-executable. Never calculate refunds from current booking prices.

The server-only refund service uses TypeORM for refund reads/result persistence.
Automatic refunds are intentionally unleased and lock only the refund row. Stripe SDK access stays in its adapter, uses the original PaymentIntent and
`court-payment-refund-<refund-id>`, and recovers matching refund metadata before creating
on retries. Pending/network failure never restores occupancy or changes historical payment
attempts. Refund records use pending/pending_retry/succeeded/failed; no partial or NETOPIA
refunds are implemented; focused Admin reconciliation is described below. See `docs/payments-memberships.md`.

## Admin Payments

`/admin/payments` shows Transactions; `/admin/payments/settings` preserves provider
settings. `listAdminPaymentTransactions` authorizes with `requireActiveAdmin` and calls
a focused parameterized TypeORM projection after active-Admin authorization. Keep filtering, sorting
and fixed 20-row pagination inside this read projection; never fetch all financial
records to filter in the browser. Prefer the refund-linked original attempt, then
the earliest succeeded attempt, then the newest attempt. Preserve historic snapshots.
Attention is refund pending_retry/failed or persisted reconciliation_required events
across the booking's attempts; ordinary failed/expired checkout is not attention.
Dialog fields are read-only; only the focused Stripe recovery actions below may mutate
financial recovery state. No transaction/refund tables gain browser SELECT access.
See `docs/payments-memberships.md` for selection, search and review semantics.

## Admin Stripe reconciliation actions

Only active Admins can retry existing pending_retry/failed Stripe refunds or refund
verified late captures whose hold could not confirm the booking. TypeScript selects
eligible persisted evidence. Phase 8 preparation uses TypeORM: booking UPDATE →
reservation UPDATE → selected attempt UPDATE → events UPDATE ordered by provider,event_id →
refund UPDATE → ordered role SHARE → account SHARE. It checks active Admin authority,
original financial relationships and claims a five-minute token/actor lease using
clock_timestamp(); equality/expiry is reclaimable. Automatic refunds never claim a lease.
No configuration/resource locks, occupancy or historical payment changes are permitted.

Stripe runs after preparation commits, using the unchanged adapter and refund UUID.
The result TypeORM transaction takes the same aggregate/event/refund locks without a
fresh actor fence. Matching token+actor may complete after expiry or Admin authority loss;
a replacement token rejects stale results. Success cannot downgrade; established provider
refund IDs are immutable. Refund success, lease clearing and qualifying event resolution
commit atomically. Already-resolved attribution is preserved; amount_mismatch stays manual.
No refund completion emails, replacement refund, generic mark-resolved or worker is introduced.
See `docs/payments-memberships.md` for the exact late-capture predicate and lifecycle.

## Customer checkout persistence (Phase 5)

Auth/account resolution happens before TypeORM Transaction A. It locks the configuration
configuration advisory SHARE, discovers the court parent, then locks that location FOR UPDATE.
Configuration facts feed the existing TypeScript publication/calendar/pricing helpers;
checkout preserves per-half-hour opening-hours validation. Authenticated checkout fences
only `users.status FOR SHARE`, without a role fence. Online checkout separately locks
`payment_provider_settings FOR SHARE`; there is no provider fallback or NETOPIA adapter.
Reservation, booking and attempt commit atomically; Pay-at-club confirmation email follows commit.
Online holds share one PostgreSQL wall-clock +600-second deadline on reservation/attempt.

Stripe initialization runs after commit using stored attempt/provider/amount/currency.
Transaction B locks booking FOR UPDATE then attempt FOR UPDATE and conditionally attaches
provider ID/capability hash, including after expiry without reopening occupancy. No network
call belongs inside either transaction. Polling/capability and policy reads use TypeORM;
polling invokes TypeScript `expirePaymentHolds` through TypeORM transactions. TypeScript expires holds before occupancy writes; public `/book` loaders use TypeORM projections (Phase 11). Settlement/webhooks use
Phase 7 TypeORM transactions; Phase 8 refunds/reconciliation also use TypeORM. Booking emails use post-commit Brevo HTTP delivery.

There is no customer-submission idempotency key or duplicate-success contract. Location
FOR UPDATE plus authoritative TypeScript occupancy validation serializes same-slot submissions.
Provider success/local-attachment failure has no complete
automatic recovery/resume workflow. Initialization failure withholds presentation and leaves
the committed hold to expire; do not invent compensation/replacement or claim recovery is fixed.
Checkout and attachment fixtures use transactional TypeORM persistence.

## Customer booking mutations (Phase 6)

Owner/Admin cancellation and reschedule, including focused edit/quote context, use
`bookings/commands.ts` TypeORM READ COMMITTED transactions. Verified identity and
structural validation precede transactions; no network calls occur inside them.
Lock order: optional configuration advisory SHARE → location UPDATE → booking UPDATE → reservation
UPDATE → selected attempt UPDATE → existing refund UPDATE → ordered Admin/Coach
assignments SHARE → account SHARE. Only reschedule takes the shared configuration advisory fence;
only changed parent discovery retries, in a fresh bounded transaction.

TypeScript owns ownership (`account_user_id` only), active account/Admin checks,
lifecycle, snapshotted notice/current timezone, target policy, pricing and notifications.
Owner cancellation ignores current resource activation/publication; Admin cancellation
and reschedule retain active original-resource requirements. Current staff owners bypass
notice only. Post-lock database wall clock is compared losslessly and rechecked before
writes. Browser booking/reservation tokens use textual projections and DB timestamptz
equality. Preserve reservation monotonic +1 microsecond and explicit booking transaction
now() timestamps exactly. Reschedule never changes attempts/refunds.

Cancellation atomically inserts the original attempt's full refund request when required;
existing-refund replay preserves the ID, actor and timestamps. Post-commit refund execution
remains Phase 8. Booking emails use best-effort post-commit Brevo HTTP delivery.
Legacy command RPCs, generic fingerprints and actor snapshots are absent from the final schema.
See docs/architecture.md.



## Payment settlement (Phase 7)

Verified provider settlement and receiptless abandonment's final local settlement use
TypeORM READ COMMITTED transactions. Signature verification, normalization/Zod validation,
capability validation and every Stripe network call remain outside transactions.
Discover attempt → booking → authoritative location, then lock location UPDATE → booking
UPDATE → linked reservation UPDATE → selected attempt UPDATE; revalidate the discovered parent.
Revalidate online method, linkage, provider/reference and original attempt
amount/currency; webhook requires an already-attached exact reference, while bare trusted
settlement retains the NULL-reference allowance. No configuration advisory, court, refund
or actor locks are acquired. Explicit cleanup may lock expired neighboring booking aggregates
under the same location mutex. Held-to-active transitions recheck occupancy excluding themselves.
TypeScript owns lifecycle, effective expiry, mismatch and reconciliation policy. Read PostgreSQL
wall time after lock waits with lossless deadlines, recheck before lifecycle writes and fence
the deadline at the attempt UPDATE. Lifecycle and immutable provider-event evidence commit atomically; first confirmation
email follows commit. Global (provider,event_id) PK conflicts require winner
evidence comparison and rollback of any provisional loser writes. Identical replay returns
stored result without resetting Admin resolution fields. Late success never reclaims occupancy;
mismatch never mutates lifecycle or becomes automatically refundable.
Payment settlement has no application RPC transport. TypeScript hold expiry remains authoritative; email delivery uses Brevo HTTP after commit.


## Identity and persistence cutover

Every production role assignment/removal and suspension/reactivation transaction locks
`roles.code = 'admin' FOR UPDATE` before actor/target locks, rechecks authoritative facts,
and rejects final-active-Admin loss in TypeScript. Attribution and transaction-time user
timestamps are explicit; no-op role mutations preserve timestamps. Auth email hooks
explicitly maintain timestamps. No application business-policy triggers are required.

Configuration advisory fencing and location-first booking/payment/refund serialization
are described above and in docs/architecture.md. Retain those protocols when changing
persistence. Local development data is disposable and uses the guarded
`npm run db:dev:rebuild -- --discard-local-data` workflow: preserve native Supabase
infrastructure, replace obsolete application schema/history, run TypeORM migrations,
then seed Auth accounts via Supabase Auth APIs and application data via TypeORM.
Remote/shared populated databases still require a separately authorized data-preserving cutover.

## Automated test isolation

Integration and E2E tests use only the disposable `tennis-club-tests` Supabase
project under `tests/local/` (API 55321, PostgreSQL 55322, Mailpit 55324). Start it
with `npx supabase start --workdir tests/local`; initialize with
`node --conditions=react-server --import=./scripts/ts-loader.mjs scripts/initialize-test-database.ts`.
The existing TypeORM migrations are authoritative; never duplicate them or run
development seeds/rebuilds for tests. Use `npm run test:integration` and
`npm run test:e2e` sequentially. Runners discover and verify isolated credentials,
and Playwright must start its own server with those settings. Never bypass the
test connection guards or point fixtures at development/remote environments.
See `docs/testing.md` for disposal and focused runs.
