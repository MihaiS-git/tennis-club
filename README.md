# Tennis Club

A web platform for operating a **single tennis club with multiple physical locations**.

The application manages courts, coaching, club facilities, members, bookings, memberships and payments across all club locations. Matches, partner matching and rankings are deferred indefinitely (see [Partner matching](#partner-matching)).

## Product scope

The club operates one shared system for:

- members;
- memberships;
- payments.

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
- TanStack Query is planned and not installed; introduce it only when a concrete workflow needs interactive client-side server state

### Backend services

- Supabase Auth
- Supabase PostgreSQL
- Supabase Storage for uploaded player avatars, protected by Storage RLS (application tables have no browser grants or RLS policies)
- Supabase Realtime where useful

### Payments

- Stripe
- Stripe PaymentIntents
- Stripe Subscriptions
- Stripe Refunds
- Stripe Webhooks

### Database access

All production application persistence uses server-only TypeORM through `DATABASE_URL`.
Supabase runtime access is limited to verified Auth and private Storage. TypeORM is
also the sole application migration system. Application tables have no browser-role
grants or application RLS policies; Next.js checks authoritative accounts, roles,
ownership and public visibility before trusted persistence. Storage retains RLS.
Development seeds use TypeORM for application data and Supabase Auth Admin APIs for
accounts. Local-only test fixtures may use privileged Supabase database APIs and reject
production. PostgreSQL retains structural constraints, indexes and overlap exclusions.

Configuration writes acquire an exclusive transaction-scoped advisory fence before
ordered location locks; booking configuration readers acquire its shared counterpart.
TypeScript handles publication, pricing/hours compatibility, hold expiry, lifecycle,
refund integrity and explicit timestamps. See [architecture](docs/architecture.md#resource-persistence).

Supabase access is **server-first**. The browser does not access Supabase directly.

A browser Supabase client should be introduced only for a concrete browser-specific requirement, such as Supabase Realtime.

TypeORM is the approved persistence layer; do not introduce another ORM.

No separate NestJS or Express backend is required initially.

---

## Architecture

```text
Browser
   │
   ▼
Next.js
├── Server Components      ← server-side reads / initial rendering
├── Server Actions         ← application UI mutations
├── Route Handlers         ← webhooks and external HTTP boundaries
└── Client Components
    └── calls Next.js server boundaries (TanStack Query remains planned)
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
TypeORM repositories ◄────┘
   │
   ▼
PostgreSQL
├── restricted application table grants / Storage RLS
├── constraints
├── indexes
└── transactions and Auth integration hooks
```

The main architectural rule is:

> **Next.js is the complete primary application authorization boundary, TypeScript decides business behavior, PostgreSQL guarantees data integrity, Storage RLS protects private objects and application table grants deny direct browser access, and Stripe owns payment processing.**

Direct browser-to-Supabase access is not part of the initial architecture. It may be added later only for a concrete feature that benefits from it.

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

### Normal user

Every authenticated application account is a normal user and needs no RBAC role. Active users can:

- manage their profile;
- book courts;
- book courts with coaches;
- manage bookings;
- reschedule eligible bookings;
- cancel eligible bookings;
- manage membership information;
- manage payment-related information.

The RBAC roles are `admin` and `coach`; both are optional and may be combined. Normal users have `roles = []`. Future club membership/subscription is a separate business concept.

---

## Security model

Next.js is the complete primary application authorization boundary. Application tables deny direct browser-role access; Storage retains RLS.

Typical authorization rules include:

- members can access their own private data;
- members cannot access another member's private data;
- members can manage only their permitted bookings;
- coaches can manage their own availability;
- coaches can view sessions assigned to them;
- admins can manage club resources;
- public player information can be visible to members;
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

Supabase access is **server-first**.

The initial application does not create a browser Supabase client. Normal application reads and writes flow through Next.js and server-side application logic.

### User-scoped server client

Use the authenticated user’s Supabase session for Auth and private Storage. PostgreSQL operations use TypeORM after explicit application authorization and owner/visibility checks. Application tables deny direct browser-role access.

```text
Authenticated user
→ Next.js
→ verified Supabase Auth identity
→ TypeORM application persistence
→ PostgreSQL invariants
```

Current server-only environment variables:

```env
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
APP_URL=
GOOGLE_MAPS_EMBED_API_KEY=
```

These variables are intentionally not prefixed with `NEXT_PUBLIC_` because the browser does not currently need direct Supabase access.

`APP_URL` is the canonical server-side application origin used for authentication email redirects. Signup requires email confirmation and returns through `${APP_URL}/auth/callback`; password recovery returns through `${APP_URL}/auth/callback?next=/reset-password`. Production must set `APP_URL` explicitly.
It is also the origin of canonical URLs, `/sitemap.xml` and the sitemap reference in `/robots.txt`.

`GOOGLE_MAPS_EMBED_API_KEY` is optional. When it is set, the Contact page offers an embedded Google map of each location, loaded only after the visitor asks for it; without it, the page shows addresses and directions links only.

Local development uses the Supabase stack at `http://127.0.0.1:54321`, the Next.js app at `http://localhost:3000`, and Mailpit at `http://127.0.0.1:54324`. Mailpit is local-only; production email delivery is configured in the hosted Supabase project. See [auth architecture](docs/architecture.md), [security configuration](docs/security.md), and [auth testing](docs/testing.md).

### Browser Supabase client

Do not introduce a browser Supabase client by default.

If a future feature has a concrete browser-side requirement, such as Supabase Realtime, add the browser client intentionally and expose only the browser-safe project URL and publishable key required for that feature.

### Local privileged tooling

Supabase secret/service-role credentials are limited to guarded local seed and test
fixtures. Production application persistence, Stripe webhooks use TypeORM.

`SUPABASE_SECRET_KEY` has no production persistence consumer. Checkout creation and initialization use TypeORM; settlement and Phase 8 refund/reconciliation use TypeORM transactions, without a Supabase secret.
The coupled personal direct-reservation list and edit reads use TypeORM after
`requireReservationRole`, with verified-owner filters. Live personal activity/history uses bounded joined TypeORM projections after active-account
authorization, with the verified booking owner or staff direct-reservation creator UUID.
TypeScript classifies completion using location-local time, merges, sorts and paginates.
Public occupancy is served only through explicit TypeORM projections.
Internal timetable occupancy uses bounded TypeORM SELECTs after `requireReservationRole`,
restricted to requested courts/date and active or held reservations at active, unarchived
resources. TypeScript includes held rows only while their persisted deadline is later than
one shared `now`; reads never expire holds. Active Admins and Coaches receive the same direct-reservation and customer/guest
booking detail projection; management mutations remain Admin-only.

Never expose the secret key to:

- browser code;
- Client Components;
- public environment variables;
- logs;
- responses.

No privileged Supabase database writer remains in the application.

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
TypeORM / Stripe adapter
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
```

These should remain framework-light and unit-testable where practical.

### TanStack Query

TanStack Query is planned for interactive client-side server state, but it is not required for the Supabase foundation itself.

Use it when client interactions benefit from caching, invalidation, background refetching, or mutation state, for example:

- court availability by location/date;
- coach availability;
- booking lists and booking state;
- interactive admin screens.

TanStack Query must call the Next.js server boundary rather than query Supabase directly. Server Components remain the default for initial/simple reads.

When TanStack Query is introduced, update both `README.md` and `AGENTS.md` together with the implementation.

---

## Locations and resources

A court belongs to exactly one location.

`locations` represent physical locations of the same club; `courts` belong to those locations. This foundation supports one initial location and later multiple locations, not multi-tenancy. `is_public` is the administrator's explicit intent to publish a location and defaults to false for both existing and new rows. Public `/book` and `/courts` use the server-only `listPublicLocationsWithCourts()` read model. It returns only active, unarchived, published locations with valid name, slug, timezone and currency, opening hours, an active court, and current or future base-state pricing for every active court. The rule is derived in `src/lib/locations/publication.ts`; no readiness flag is stored. Public SELECT policies hide private locations and their courts; active administrators retain separate management access. No browser database client or public mutation access is introduced.

A coach may work at multiple locations.

Customer cancellation notice is configured in Admin → Locations → Create/Edit,
under Booking policy. `locations.customer_cancellation_notice_minutes` stores
0–43,200 elapsed minutes (up to 30 days), defaulting to 1,440 (24 hours).
The final schema stores the configured location default and the authoritative booking snapshot.
The TypeORM checkout transaction reads and stores the selected location policy as
`booking_revisions.cancellation_notice_minutes`; later location changes leave that snapshot
unchanged. Personal upcoming/history and Admin operational reads return the booking's
own snapshot. The configuration read is Admin-only; public location reads retain
their previous columns. Customer intent cannot supply a policy value.
Eligible owners can cancel future confirmed bookings from `/my-activity/bookings` after
confirmation; Admins may cancel eligible customer/guest bookings. Guest contact matching never
grants ownership. See [cancellation and refunds](#cancellation-and-refunds) for the implemented flow.

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

Private and Semi-private lessons are bookable at `/book?mode=coaching`, using the shared
court timetable, customer dialog and Stripe checkout. A lesson reserves both court and
Coach and snapshots its program-specific price, participants, duration and court-rental terms.
Customer lesson rescheduling preserves the program, Coach, court and duration while changing
date/start. Group and Junior sessions are organized by staff, with informational public rates;
coaching packages remain planned. See [coaching configuration, availability and booking](docs/coaching.md).

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

Eligible authenticated owners reschedule from `/my-activity/bookings`, including Admin/Coach
owners. Court bookings keep their location; coaching lessons additionally keep their court,
program, Coach, duration and agreed coaching terms. Ordinary owners must meet the snapshotted
notice cutoff; staff owners bypass notice only, and every owner must be before start.
Admins cannot reschedule other customers' bookings; guest self-management is unimplemented.

Same-price changes append an immutable revision directly. Online increases collect only the
positive difference while protecting the target interval; reductions wait for verified refunds
before changing the booking. Pay-at-club edits revise current debt and preserve the original
payment request. See [payment adjustments](docs/payments-memberships.md#paid-booking-price-adjustments)
and [lesson rescheduling](docs/coaching.md#lesson-rescheduling).

---

## Cancellation and refunds

Owner cancellation enforces ownership, snapshotted notice and before-start rules. Admins may
cancel eligible customer/guest bookings before start. Refund-backed cancellation keeps the
booking and occupancy intact until every required refund succeeds; pay-at-club or zero-refundable
cancellation completes immediately. Pending or uncertain refunds require reconciliation;
affirmative retryable failures permit a replacement only through an explicit Admin **Check
with Stripe**. If every refund is definitively refused with no money returned, the change is abandoned;
a definitive refusal after partial success leaves money owed for external resolution. Original financial evidence is preserved.

Admins review payments and refunds at `/admin/payments/transactions`; provider settings are at
`/admin/payments/settings`. See [refund states and recovery](docs/payments-memberships.md#stripe-cancellation-refunds)
for precise retry conditions, idempotency, partial success and subsequent actions.

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

Matches, partner matching/matchmaking, match results and rankings are deferred indefinitely. There are no `/matches` or `/rankings` routes or related tables. Player profiles, Sportya levels and player ratings remain in scope.

---

## Player profiles

`public.users` stores application identity/status and optional personal/contact information. `public.player_profiles` stores tennis information independently of RBAC. A player profile is created on the first tennis save, not at signup. Future `coach_profiles` will be a sibling domain entity; users may have either, both, or neither.

`/profile` is for identity and settings: separate personal and tennis saves, player-avatar upload/removal, account/email information, roles, and password change. JPEG, PNG, and WebP avatar uploads (maximum 5 MiB) are decoded and normalized server-side with Sharp into metadata-free WebP images fitting within 512 × 512 without enlargement or cropping. Source dimensions are limited to 12,000 pixels per side and 40 million pixels. Only `<user-id>/avatar.webp` is stored in the private bucket and served through the authenticated avatar endpoint. `/account` redirects to `/profile`. Tennis information is readable only by active authenticated users, never anonymously. See [Profile implementation](docs/profiles.md).

Personal and tennis forms independently compare editable values against their last successful save. Explicit shared navigation links and sign-out submissions warn through Sonner when leaving a dirty Profile visit; moving between Profile pages is such a departure. Reload/close/document departures use native `beforeunload` protection while dirty. Same-document browser back/forward has no supported App Router blocker and retains the existing fresh-visit behavior without a warning. See [Profile visit protection and browser limitations](docs/profiles.md#unsaved-changes-and-visit-lifecycle).

`/my-activity` redirects to `/my-activity/bookings`, which contains current and upcoming personal court activity. `/my-activity/history` contains completed/cancelled owned bookings and staff-owned direct reservations. The retired `/my-activity/bookings/history` URL redirects with its search parameters. My Activity and Profile pages share the user sidebar, built from the same component, layout and mobile drawer as the Admin sidebar; Sign out is in its footer and the navbar avatar links directly to `/profile`. See [User area navigation](docs/profiles.md#user-area-navigation).

Both lists authorize the active account before bounded, owner-filtered TypeORM projections. TypeScript combines owned bookings and Admin/Coach-owned direct reservations, applies type/location/court/date filters (plus History status), sorts globally, and then returns 20 rows per page. Date/time defaults to ascending for Bookings and descending for History; kind/ID tie-breakers make ordering deterministic. Location, court, type, duration and History status are also sortable. URL controls reset page 1 when changed; pagination preserves the query. Controls derive location/court choices from the full owner-scoped eligible dataset, with courts narrowed to the selected location. Bookings require an active physical interval that has not ended in the location's timezone. Details preserve contact and price snapshots; guest and other users' bookings remain excluded without granting booking-table SELECT. Customer cancellation/rescheduling use the Phase 6 TypeORM commands; direct reservations use the TypeORM transactions described below.

A direct-reservation details dialog lets the owner edit or cancel an active Upcoming reservation; archive details are read-only. Future direct reservations keep their location fixed and use the direct-reservation timetable to choose a date, active court at that location, and interval; a server read excludes the edited row from occupancy while preserving other booked cells. In-progress direct reservations can change only reason. Editing updates the same row through a TypeORM transaction; TypeScript verifies ownership, lifecycle, the lossless `updated_at` token and fixed location before persistence. Stale edits and GiST conflicts preserve the original. Reads bind explicitly to the verified actor UUID; private reservation metadata stays out of public occupancy reads.

Avatar upload and removal share one UI pending state. Phase 10 uses focused TypeORM persistence for avatar references and navigation metadata, with authenticated Supabase Storage at one canonical private object per user. No runtime lease or replacement backup/restore remains. Initial-upload database failure attempts object cleanup; removal clears the database first, then best-effort deletes Storage. Storage/PostgreSQL are not atomic; rare orphan objects and ambiguous network/race outcomes are accepted. See [Avatar workflow](docs/profiles.md#avatar-workflow).

### Tennis information for active authenticated users

Potentially includes:

- display name;
- rating;
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

## Transactional operations

Application database operations use TypeORM repositories.

Some operations require database transactions.

Examples:

- confirming bookings;
- rescheduling;
- consuming membership credits;
- certain payment/refund state transitions.

Use the existing TypeORM `inTransaction` helper for atomic application persistence. TypeScript owns hold expiry; PostgreSQL enforces structural constraints and overlap exclusions.

The responsibility split remains:

```text
TypeScript
→ decides what should happen

PostgreSQL transaction
→ guarantees all required changes happen atomically
```

Do not move domain algorithms such as pricing or membership rules into SQL.

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
- denied browser-role table grants;
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
- Stripe orchestration;
- workflow decisions.

---

## Initial data model

The three baseline migrations in `src/lib/db/migrations/` define the current schema.
Supabase manages `auth.users`; TypeORM creates these application tables in `public`:

```text
users
user_messages
email_deliveries
player_profiles
roles
user_roles
locations
booking_adjustments
coach_profiles
courts
court_reservations
bookings
coaching_programs
booking_revisions
payment_attempts
payment_capture_receipts
payment_provider_changes
payment_provider_events
payment_provider_settings
club_settings
payment_refunds
refund_executions
court_coverage_periods
opening_hours_schedules
location_opening_hours
pricing_rule_sets
location_pricing_rules
coach_locations
coach_programs
coach_availability_exceptions
coach_weekly_availability
coaching_program_durations
coaching_prices
booking_financial_exceptions
```

Membership plans, subscriptions and credits remain future work. Matches, partner
requests, rankings and rating history are deferred indefinitely and have no tables.

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

## Local development database tooling

Fresh schema initialization uses Supabase infrastructure startup followed by TypeORM migrations; see Application migrations and fresh local setup below.

Run `npm run db:dev:seed` for 100 confirmed Auth accounts: `dev-admin@example.test`
(Admin), `dev-coach@example.test` plus `dev-coach-002@example.test` through
`dev-coach-009@example.test` (9 Coaches), and `dev-player-001@example.test` through
`dev-player-090@example.test` (90 players without elevated roles). The shared password
is `Local-Tennis-Dev-2026!`. `npm run seed:users` seeds only those accounts/roles.
Auth provisioning creates active application accounts; player profiles remain absent
until users save them. Reruns preserve existing Auth passwords and account metadata,
repair missing fixture roles, and reject suspended accounts or unexpected roles.

The seed preserves two active București locations, `dev-central-club` and
`dev-riverside-club`, in `Europe/Bucharest` with RON currency. Central opens daily
07:00–22:00; Riverside opens Monday–Friday 08:00–12:00 and 14:00–21:00, weekends
08:00–20:00 (19 weekly intervals). Central has three outdoor clay courts and one
indoor hard court; Riverside has outdoor clay and hard courts, with Court 2 inactive.
Central Court 1 is covered from 2026-10-01 through 2027-03-31.

Both locations are published after readiness validation. Six pricing definitions
expand to 73 court/day rows matching opening intervals: outdoor 50 RON/hour, covered
70 RON/hour and indoor 80 RON/hour, with unbounded pricing dates. Covered pricing
applies to Central outdoor courts; only Court 1 currently has coverage. Pay at club
is enabled at both locations so local checkout works without Stripe credentials;
the cancellation notice is 1,440 minutes. No reservations, bookings, payment attempts,
refunds or Storage objects are seeded. The migrations provide the
Admin/Coach roles and the payment-settings singleton with no online provider selected.

Coaching demo data is separate and explicit: `npm run db:dev:seed:coaching` creates four
`demo-coach-*@example.test` Coach accounts (password `StrongPassword123!`), four
programs, public coach profiles on the existing locations and RON prices. It inserts
only missing records and never changes existing ones; see [Coaching](docs/coaching.md#development-seed).

Seeds require non-production mode, a loopback Supabase API on port 54321 and the
trusted local `postgres` database on port 54322. Auth uses the local service credential
from `LOCAL_SUPABASE_SERVICE_ROLE_KEY` or captured `supabase status -o json`; it is
never printed. All application fixture writes use TypeScript/TypeORM. Configuration
seeding runs atomically under the exclusive configuration fence and ordered location
locks. Reruns reuse records and stable pricing definition IDs; divergent fixtures
fail rather than overwrite user edits.

To discard this project's disposable local data and recreate the environment:

```bash
npx supabase start
npm run db:dev:rebuild -- --discard-local-data
npm run db:dev:seed
```

The explicit discard flag is mandatory. The rebuild checks database/API endpoints
against this project's Supabase status, empties/removes the avatar bucket through
Storage, drops obsolete `public` application schema and `supabase_migrations` history,
recreates `public` with Supabase's stock usage-only schema grants,
removes Auth users through Auth Admin APIs, then applies all registered TypeORM migrations
without seeding. Run `npm run db:dev:seed` separately. Native Auth, Storage and extension schemas and their infrastructure
migration ledgers remain. This is local-only; remote/shared/production databases are
rejected. Stop the app before rebuilding. Do not use `supabase db reset`
for application initialization. No backup or data reconciliation is performed.

## Admin UI

`/admin/locations` opens a location workspace at `/admin/locations/[locationId]`.
Its Courts tab (`?tab=courts`) lists that location’s courts, including inactive resources.
The legacy `/admin/courts?location=<id>` route redirects to this tab; without a valid
current location it redirects to `/admin/locations`.
Active administrators create, edit, move, and activate/deactivate courts through
user-scoped Server Actions. Each court has a clay/hard/grass/carpet surface, an
outdoor/indoor environment, and a lighting flag. Counts are derived from records.
Slugs are generated on creation, preserved on edits (including moves), and unique
within the selected location. Next.js authorizes Admin mutations and TypeORM persists them. Temporary balloon capability/installation flags have
been removed. Outdoor courts have exact, inclusive calendar-date coverage periods
managed within the location workspace’s Courts tab (add, edit, remove). Coverage periods for active
public courts are readable for the public calendar; writes remain admin-only. A GiST exclusion
constraint prevents overlaps for the same court. TypeScript validates outdoor coverage and rejects changing a court to indoor until
its periods are removed, under the shared configuration/location locking protocol. `updated_at`
is application-controlled; configuration intervals may be hard deleted.
`getCourtStateForDate(environment, periods, date)` in `src/lib/courts/state.ts`
returns indoor, outdoor, or covered from inclusive date intervals, with no seasonal
inference. Callers supply a calendar date explicitly. Public `/courts` uses the
shared publication and readiness read model.

`/admin/locations` shows current locations in a compact table. Clicking or keyboard
activating a row opens the full Location form for name, address, city, postal code,
country, timezone, currency, status, and Public booking. The same interaction applies to the mobile
item. Archive and Restore are inside that dialog, including in the archived view.
Archiving sets `archived_at` and deactivates the location;
restoring clears the archive timestamp but leaves it inactive until explicitly activated.
Current admin selectors omit archived locations. These operations use user-scoped
Server Actions. Each location stores its IANA timezone and one currency (EUR, USD, GBP, RON, or CHF;
default EUR), selected at creation. An existing location's currency changes only without unfinished
bookings, unresolved financial operations or court pricing rules;
the Details form lists each blocker and the server enforces them under the configuration fence. See
[location currency changes](docs/architecture.md#location-currency-changes). Slugs are generated from names on creation and preserved on edits;
collisions require a different name. Location counts are derived from records.
Next.js authorizes active administrators before TypeORM persistence. The database prevents an archived location from being active. Public discovery
requires explicit publication and derived configuration readiness. Enabling Public booking is checked server-side and returns a useful missing-configuration error; disabling it retains all Admin configuration.

Location opening hours are managed in `/admin/locations/[locationId]?tab=opening-hours`.
One full-width editable table shows the selected weekly schedule. Each interval has
independent weekdays and inline time comboboxes. Current is selected by default;
scheduled policies use the selector and expired policies appear read-only in History.
Add and Delete change only the draft; Save changes commits the entire policy and
Cancel edit restores authoritative saved values. New schedules copy the selected
policy into the same table and require a start date.
Validity dates apply to the whole weekly schedule. Both boundaries are inclusive;
an absent end date is unlimited. Unsaved drafts survive server refreshes, selection
changes require discard confirmation, and revisions reject stale saves. Creating a future
schedule automatically ends the overlapping current schedule on the preceding calendar
day, preserving both schedules and their intervals. The editor explains the cutoff
before saving; overlaps with independently scheduled policies require an explicit edit.
The cutoff, revision increment, creation and pricing reconciliation commit atomically.

`opening_hours_schedules` owns each location's validity period;
`location_opening_hours.schedule_id` associates the existing weekday intervals.
The consolidated initial TypeORM migration creates schedules and their weekday
intervals directly. No legacy baseline backfill or patch migration is retained.
PostgreSQL excludes overlapping schedule periods for a location and overlapping intervals within a schedule/weekday.
Minutes retain the 0–1440 convention, including 24:00. Closed weekdays have no intervals.
Reads use the requested playing date in the location's IANA timezone; a date without
an applicable schedule is closed for new reservations. Future schedules apply to
future playing dates even before the schedule's start date is reached.

Opening hours take priority over pricing. A TypeScript service changes hours and
reconciles prices atomically under the exclusive configuration fence then location
locks. Reconciliation splits existing pricing validity at affected date boundaries,
trims/splits/removes time coverage, and inherits compatible adjacent prices for newly
opened time (maximum across a gap). Historical and unaffected periods remain intact.
Dates without a schedule retain dormant pricing, which cannot make them bookable.
Missing adjacent prices remain unconfigured. Readiness requires compatible current
or future pricing coverage within each applicable schedule; it does not require
perpetual pricing.

Policy changes never edit or block existing confirmed reservations. Their playing
intervals, prices, currency, payment method, cancellation notice, payment and refund
records remain unchanged. Calendars include existing occupancy outside new opening
hours. Pending payment attempts revalidate current policy before confirmation under
the shared configuration fence; invalid captured attempts expire and enter the
existing provider refund/reconciliation path. Guest and signed-in checkout still
recalculate stale quotes transactionally. Archived locations retain their existing
hours and must be restored before edits.

The location workspace’s Pricing tab (`/admin/locations/[locationId]?tab=pricing`) manages logical hourly rule sets for one or more specific courts at a
location. Each definition selects a compatible operational state (outdoor or covered
for outdoor courts; indoor for indoor courts), weekdays, a half-open local minute
interval `[start, end)`, optional inclusive calendar-date bounds, and a price in
the location's currency. The same form creates and edits a whole definition. One
`rule_set_id` joins its atomic court/day rows, and the admin table shows one row
per definition. An active-Admin-authorized TypeORM transaction creates, replaces or
removes the entire set under configuration advisory then location locks; the per-court/state/day GiST exclusion constraint prevents overlapping
date/time applicability and permits adjacent intervals. Next.js validates every
selected court and weekday against environment and configured opening hours inside
that transaction before persistence. Direct browser grants are denied. Later opening-hours edits reconcile affected pricing validity and time coverage atomically;
consumers still check applicable opening hours independently. The resolver uses
court, derived state, date, weekday and local minute. Public `/courts` discovers
only eligible locations and courts. See [Pricing](docs/pricing.md).

`/book` and the staff calendars (`/admin/bookings?view=calendar` and `/coach/bookings?view=calendar`) default to the selected location's current calendar
date when the URL omits a date. An explicit valid date overrides that default;
malformed explicit dates retain the validation error, and `/book` also rejects past dates.
Admins and Coaches can navigate to past dates in their respective staff calendars using Prev or the
date picker. Past occupancy opens read-only details with existing role visibility;
past slots cannot be reserved and past activity cannot be edited or cancelled. The server renders
only the chosen day, without a client redirect or adjacent-day preload.
Public `/book` discovers eligible locations and courts using only the small
opening-hours and pricing fields needed to check readiness. For the selected
location-local date it reads the location's opening
hours, coverage and applicable pricing for all active courts, and only that date's
reservation occupancy. Each court has one compact 30-minute timetable with hourly
prices in available cells. Closed gaps, booked, no-pricing, and past cells remain
unavailable. Visitors select a minimum 60-minute interval within one court and can
adjust it in 30-minute steps. The selected-interval Total uses integer minor units
and rounds once after adding each cell's hourly rate. Selection exists only in
browser state until Continue opens a customer-details dialog. Guests enter name,
email, and phone; active signed-in accounts receive available profile contact
values as editable defaults. Confirm calls a Server Action with only contact and
interval intent. It never changes the Profile. The action delegates to the booking
service, which recalculates price and creates the booking atomically. Availability
conflicts clear the selected interval and refresh the timetable while preserving
contact values. Success shows the server-confirmed total and refreshes occupancy.
There is no browser Supabase client.

The reservation persistence foundation is `court_reservations`: one court,
location-local date, and half-open minute interval per row. PostgreSQL requires
at least 60 minutes with start and end on 30-minute boundaries, within one local
calendar day, and uses a partial GiST exclusion constraint to reject overlapping
active intervals for the same court/date. An optional `reason` (up to 255 characters)
describes direct reservations; customer bookings have their own commercial record.
Reservations have `active`, `cancelled`, `held` or `released` status; active rows and
non-expired payment holds block occupancy. Active Admins
and Coaches can create direct reservations in their respective staff calendars for active courts at
structurally ready locations, including unpublished locations.
The Server Action checks the account, resources, location-local time, opening hours,
duration and required trimmed reason before a TypeORM transaction rechecks locked facts and inserts. The GiST
constraint resolves concurrent overlaps; the UI shows a contextual conflict error.
Customer booking persistence is available through `/book`. `checkout_records` stores one unique reservation reference, an optional
application account ID, checkout lifecycle status and a required current immutable revision.
Contact, payment method, policy and integer price/currency snapshots live in that revision.
`bookings` stores only genuinely confirmed identities and their confirmation-revision proof. Guests have no account link; active authenticated
users are resolved server-side, including Admins and Coaches. The service reuses the
publication and calendar pricing helpers using transaction-authoritative facts. TypeORM Transaction A locks
the shared configuration advisory fence, then location FOR UPDATE, active account when linked, and online provider settings FOR SHARE.
It inserts the physical reservation, checkout record and payment attempt atomically.
Online creates a temporary hold with no business booking identity; allowed Pay at club
confirms immediately and inserts its booking identity with the confirmation notification. GiST overlap errors roll back the complete creation write set and
return a safe availability message. Browser roles have no booking table read/write
grants; public occupancy remains limited to court and interval fields.
See [payment lifecycle foundation](docs/payments-memberships.md) for the centralized
10-minute hold, provider snapshots, expiry cleanup and trusted same-row settlement.
Admin → Payments displays Stripe/NETOPIA configuration status and selects one active
provider for new attempts. No provider is selected by default; an unconfigured or
unselected provider disables online payment, with no failover or customer provider
choice. Stripe configuration requires `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
and `STRIPE_WEBHOOK_SECRET`; only the publishable key is browser-safe. NETOPIA uses
server-only `NETOPIA_API_KEY`, `NETOPIA_POS_SIGNATURE` and `NETOPIA_ENVIRONMENT`
and has no checkout adapter yet. Stripe Payment Element uses the existing ten-minute
hold and a server-created PaymentIntent outside database transactions. TypeORM Transaction B locks booking then attempt
and attaches the provider reference/capability before exposing payment presentation. Polling/capability and confirmation-policy
reads use TypeORM; polling invokes the TypeScript hold-expiry service. Customer submissions have no idempotency key.
Provider success followed by attachment failure has no complete automatic recovery/resume workflow; the hold expires normally.
Settlement/webhooks use TypeORM transactions (Phase 7); refund execution/reconciliation use TypeORM (Phase 8). Public `/book` loaders use bounded TypeORM projections (Phase 11). Verified webhooks settle the same internal
rows; duplicate events cannot duplicate confirmation, and late success is recorded
for reconciliation. Existing attempt providers are immutable. Every booking's current revision
has a required payment method (`online` or `pay_at_club`); original payment attempts remain
financial evidence. Pay at club defaults OFF per location and is edited in Booking policy.
Direct reservations have no price or payment flow. Next.js permits only active Admins
and Coaches to create rows with a reason and their verified user ID as creator. Existing rows can have a null creator. The staff calendars read active occupancy
for all staff; active Admins and Coaches receive the same narrow staff-authorized
TypeORM projection of direct-reservation identity, reason and creator contact, plus
authenticated customer and guest booking contact, price, currency and payment details.
Staff occupied cells reuse the same details dialogs. After explicit confirmation,
an active Admin may cancel an active direct reservation strictly before its start
through a TypeORM transaction. Its lifecycle update records the Admin as canceller,
preserves the creator and reservation row, and releases occupancy. A missing or
already-cancelled row returns a safe result. Coaches receive operational details through the same read projection, while edit,
cancellation and refund management remain Admin-only on the server and in the dialogs.
The Admin details dialog also opens a shared reservation edit form. Its Admin-only
availability read resolves the active reservation's fixed location, reads active
courts and opening hours there, and excludes that reservation from occupancy while
leaving other active reservations blocked. Future reservations can preview another
date, court, time, and reason; in-progress reservations can save reason only. A
TypeORM transaction locks and updates the same row; TypeScript checks its microsecond `updated_at`
token and fixed location, leaving it unchanged on a stale edit or GiST conflict.
The creator and lifecycle fields remain intact. The personal owner-only edit
mutation remains separate.

Booking modifications are owner-only, including Coach/Admin owners. Admins can
cancel customer/guest bookings with automatic refunds of captured online funds;
they cannot reschedule other customers' bookings. Admin editing of direct court
reservations remains available. The owner timetable keeps location fixed, uses the
current revision UUID plus the lossless occupancy token, and retains authoritative
pricing, acknowledgement, notice and concurrency checks. Applied changes append
immutable contracts and move occupancy atomically. Identical saves are no-ops;
Pay-at-club request amounts remain unchanged while current debt comes from the
current revision. See [booking revisions](docs/booking-domain.md#implemented-immutable-booking-contracts).

On `/my-activity/bookings`, active Admins and Coaches can cancel only their own active Upcoming
reservations after explicit confirmation. The Server Action rechecks staff authorization,
and the TypeORM transaction fences staff status/roles, verifies ownership and requires an active court and location. Owner cancellation remains allowed during the interval until its end.
A missing, elapsed, or already-cancelled row returns a safe error. Cancellation preserves the row, creator,
and original details while recording the authenticated canceller and time; it releases
the occupied interval. The public `/book` server read can select only court ID, booking
date, and start/end minutes for active public courts for the selected date;
reservation identity, reason, creator, canceller, and timestamps remain private. Anonymous users and
ordinary authenticated users cannot insert or cancel direct reservations. Every active reservation row marks
overlapping 30-minute cells booked on `/book`, which remains read-only.

`/admin/users` uses TypeORM reads after authoritative active-Admin authorization. Search, filtering,
sorting, and pagination are URL-driven and applied before pagination. Interactive
filter controls update the URL without introducing direct browser-to-Supabase access.

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
- denied browser table grants and Storage RLS;
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

- expanded player-profile features (basic `/profile` is implemented);

Deferred indefinitely (not planned):

- partner matching;
- match recording;
- Elo rating;
- rankings;
- rating history;
- match history.

### V3 — Possible expansion

Group/Junior program configuration, public rates and staff-reserved sessions are implemented;
online Group/Junior booking remains unavailable. Booking/financial notifications and guest
court/lesson checkout are implemented (guest self-management remains unavailable).

- tournaments;
- club leagues;
- recurring bookings;
- waiting lists;
- advanced membership credits;
- advanced player statistics;
- club events.

---

## Non-goals for V1

Do not introduce prematurely:

- multi-tenancy;
- microservices;
- separate NestJS backend;
- another ORM;
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
- workflow decisions.

### Database/integration tests

Verify:

- denied browser-role table grants and Storage RLS boundaries;
- foreign key integrity;
- court overlap protection;
- coach overlap protection;
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
signup
→ email confirmation
→ sign in
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
2. Authentication, application users, player profiles, roles and access control (denied browser table grants, Storage RLS)
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
```

The goal is to prove the difficult architectural constraints before adding secondary tennis features.

---

## Migration history

The three pre-production TypeORM baseline migrations define the intended final schema.
Changes to these definitions require a later explicitly authorized local rebuild;
existing local records are not migrated automatically. Application schema changes use
reviewed TypeORM migrations. Applied remote/shared migrations remain immutable. Validate initial schema changes in a separate disposable Supabase project; populated remote/shared databases require an explicitly authorized cutover.

## Local validation

`npm test` runs the unit and component suites. Integration and E2E tests use only the
separate disposable `tennis-club-tests` Supabase project in `tests/local/`, with its
own PostgreSQL, Auth users, Storage volumes, JWT credentials and Mailpit. The
normal development project and `.env.local` remain unchanged.

From the repository root, initialize once (or after recreating the test stack):

```bash
npx supabase start --workdir tests/local
node --conditions=react-server --import=./scripts/ts-loader.mjs scripts/initialize-test-database.ts
```

Then run the suites sequentially:

```bash
npm run test:integration
npm run test:e2e
```

Both commands discover and verify test credentials automatically. Integration files
are serialized because final-admin tests modify shared test administrator statuses.
Playwright builds and starts its own production Next.js server on port 3100 with
those same isolated connections; stop any application server on that port first.
Existing servers cannot be reused. No development seed or rebuild command is needed.
See [test setup and safeguards](docs/testing.md).

Before expanding the platform, prove the following cases locally:

- a member cannot access another member's private information;
- browser payload manipulation cannot change authoritative prices;
- browser payload manipulation cannot grant roles or discounts;
- Admin, Coach, and normal-user authorization boundaries behave correctly;
- two concurrent users cannot successfully reserve the same court/time;
- two overlapping bookings cannot use the same coach;
- abandoned checkout releases its booking hold;
- failed payment does not produce a confirmed booking;
- duplicate Stripe webhooks do not repeat operations;
- rescheduling cannot create an overlapping reservation;
- rescheduling correctly charges/refunds price differences;
- cancellation policy produces the expected refund;
- refunds cannot be issued twice.

---

## Assumptions

- One tennis club owns the platform.
- The club may operate multiple physical locations.
- Courts belong to one location.
- Coaches may work across multiple locations.
- Members have one club-wide identity.
- Memberships are club-wide unless explicitly restricted.
- Rankings, if ever introduced, would be club-wide (currently deferred indefinitely).
- Court and coach availability are location-specific.
- Stripe is the payment provider.
- Supabase Auth is the authentication provider.
- PostgreSQL is the primary application database.
- TypeORM is the production PostgreSQL persistence mechanism; `supabase-js` handles Auth and Storage.
- Supabase access is server-first; no browser Supabase client is used initially.
- TanStack Query will be introduced when interactive client-side server state justifies it, and it will call the Next.js server boundary rather than Supabase directly.
- TypeORM is the approved persistence layer; do not introduce another ORM.
- No separate backend framework is required initially.
- Next.js is the complete primary application authorization boundary; Storage RLS protects private objects and application table grants deny direct browser access.
- Domain algorithms remain in TypeScript.
- All application persistence uses TypeORM; TypeScript handles hold expiry, with PostgreSQL enforcing structural constraints and overlap exclusions.

---

## Design principles

1. **Security is enforced server-side and in PostgreSQL, never only in the UI.**
2. **Business rules remain explicit and testable in TypeScript.**
3. **Database constraints protect invariants that application checks alone cannot guarantee.**
4. **Payments and bookings have separate state machines.**
5. **Stripe webhooks must be idempotent.**
6. **Application tables deny direct browser access; private Storage retains RLS.**
7. **Privileged Supabase access is narrowly scoped.**
8. **Supabase access is server-first; direct browser access is introduced only for a concrete requirement.**
9. **Features are added incrementally from real workflows instead of speculative schema design.**
10. **The system remains a modular monolith unless scale or complexity creates a concrete reason to change it.**
11. **README.md and AGENTS.md are updated when architectural or tooling decisions change.**
12. **Correctness, security, and maintainability take priority over architectural complexity.**

## Notifications

Booking and coaching confirmations, cancellations and reschedules, plus relevant financial
events, generate persisted notifications. Eligible authenticated recipients have an owner-scoped
in-app inbox at `/messages`; Admin and Coach accounts receive application notifications in-app
only. Brevo delivers eligible customer/guest transactional emails, independently of Supabase
Auth confirmation/recovery mail.

Admin → Club (`/admin/club`) manages the official sender and transactional email switch.
Persisted delivery state and bounded retries use Supabase Cron calling the existing delivery
endpoint. See [notification architecture, recipient policies and delivery setup](docs/notifications-delivery.md).

## Application migrations and fresh local setup

TypeORM migrations in `src/lib/db/migrations/` are the only application schema history.
Supabase CLI starts native PostgreSQL, Auth and Storage infrastructure; application
SQL migrations and automatic SQL seeding are disabled in `supabase/config.toml`.

For a **fresh, empty** local project:

1. Run `npx supabase start` and verify the project/ports with `npx supabase status`.
2. Set server-only `DATABASE_URL` to that database's trusted `postgres` connection,
   plus the Auth URL/publishable key from status in `.env.local`.
3. Run `npm run db:dev:rebuild -- --discard-local-data` to initialize the local application schema.
4. Run `npm run db:dev:seed` separately if fixtures are needed.

The initial migration is generated from the shared TypeORM metadata and creates all
34 application tables in their final form, including effective opening hours, booking adjustments,
immutable booking revisions, refund executions, coaching programs/prices/availability and the
entity-less `booking_financial_exceptions` evidence table, the `club_settings` singleton,
`email_deliveries.suppressed_at` suppression evidence and the 60/90/120 coaching duration CHECK.
It configures `btree_gist` before the eight entity-declared overlap exclusions. The
Auth user FK is generated from a non-synchronized reference entity: Supabase alone
owns `auth.users`. The native integrity migration installs the case-insensitive
email expression index, payment/capture/refund/financial-exception immutability guards,
permanent-ownership and revision immutability/linear-head guards, `admin`/`coach` roles,
the provider-settings singleton and the disabled club-settings singleton. The
Supabase integration migration installs browser-role restrictions, the two Auth provisioning/email-sync hooks,
explicit email-change timestamps, private WebP avatar bucket and Storage policies.
A secured active-account boolean helper keeps Storage working without browser
SELECT on `public.users`. Ordinary accounts receive no RBAC roles.

Coaching prices are lesson prices/person per program, duration, participant count, currency and
Club/Coach scope in one `coaching_prices` table, created directly by the initial baseline; no
coaching repair migration or runtime legacy conversion is registered. Rebuild the local
development database from the baseline after baseline edits; see [coaching](docs/coaching.md#baseline-and-legacy-preservation).

The registered TypeORM migrations and their DataSource registry remain the schema source. Transactional
email starts disabled with empty sender fields. The guarded development rebuild applies them; there are no npm migration
management commands. Production migration execution will be addressed with deployment.
Schema synchronization and automatic runtime migrations are off.

The local development data is disposable. Use the guarded
`npm run db:dev:rebuild -- --discard-local-data` workflow above when replacing the
legacy local schema. Populated remote/shared databases still require a separately
authorized data-preserving cutover; the development rebuild cannot target them.

Configuration fencing now uses advisory key `(1791462257, 1)`: exclusive for
configuration writes, shared for configuration-dependent booking/reservation writes,
always before location locks. Occupancy writes lock location FOR UPDATE before
booking/reservation/payment rows; read-only configuration uses location SHARE.
Changed-parent discovery retries in at most three fresh transactions. TypeScript
expires pending hold aggregates before occupancy writes and uses bounded location-first
SKIP LOCKED expiry for polling. Services preserve original financial snapshots and
terminal refund success; all network calls remain outside transactions.

See [focused disposable validation](docs/testing.md#typeorm-cutover-validation).

Management routing uses `/admin/bookings` ("Bookings & Reservations") for active Admins,
with URL-backed Calendar (`?view=calendar`, the existing day scheduler) and List (default,
the customer booking list) tabs; Admin requests to `/admin/reservations` redirect to the
Calendar tab with their location and date. Coach requests redirect to `/coach/bookings?view=calendar`, preserving location and date.
Both views open `/admin/bookings/[bookingId]`, whose Back link restores the originating
Calendar (location/date) or List (filters/sort/page). Booking Details offers the existing
Admin cancellation (`cancelCustomerBookingAsAdmin`) only for confirmed bookings before start
with no change in progress; cancellation never deletes booking or financial records.
Its Edit booking opens the owner form only for the signed-in Admin's own court bookings;
lesson owners reschedule through My Activity. Other customers' and guest bookings cannot be rescheduled there.
The List also includes direct staff reservations (Type "Staff reservation", status Active or
Cancelled) from `court_reservations` rows without a customer booking, read alongside bookings in
one database-sorted, paginated query; they remain separate free records with no price or payment.
Calendar and List open them at `/admin/bookings/reservations/[reservationId]`, which shows
location, court, date/time, duration, creator, reason and status (cancelled ones keep who
cancelled them) and offers the existing Admin Edit (`editDirectReservationAsAdmin`, reason-only
once started) and Cancel (`cancelDirectReservationAsAdmin`, before start) on active resources.
Coaches have their own Bookings & Reservations area at `/coach/bookings` (`/admin` and
`/admin/reservations` redirect there; `/admin/bookings` stays Admin-only). Its Calendar tab is the
existing court occupancy calendar. Its List reuses the same database query, scoped by the query to the
Coach's own confirmed or cancelled coaching lessons and their own staff reservations, with no prices.
`/coach/bookings/lessons/[bookingId]` shows the lesson schedule and customer contact read-only
(no payment, refund or booking actions), and `/coach/bookings/reservations/[reservationId]` offers
the existing owner Edit and Cancel (`editOwnDirectReservation`/`cancelOwnDirectReservation`, until
it ends). Another Coach's records are not found.
`/admin/payments/transactions` serves Admin transaction management; provider settings
remain at `/admin/payments/settings`. The shared management shell requires an active
Admin or Coach. Locations, Courts, Pricing, Payments and Users retain Admin-only
server guards; Coaches access Reservations with shared staff details and may edit/cancel their own
direct reservations and reschedule/cancel their own authenticated customer bookings through
the existing owner services. Ownership uses creator/account user IDs, never contact email.
Direct reservations retain reason-only editing in progress and owner cancellation until end.
Customer bookings retain staff-owner notice bypass, before-start mutations, current-price
acknowledgement and automatic refunds. Other records remain read-only for Coaches;
Admin management permissions remain unchanged. The desktop/mobile Admin link is staff-only, targets
`/admin`, and stays active throughout `/admin/**`; no separate Reservations primary
link remains. `/admin` redirects Admins
to Locations and Coaches to `/coach/bookings`. Legacy `/reservations` and `/admin/payments`
redirect to their canonical destinations while preserving query parameters.

Coaching management lists support URL-based search, filters, sorting and server-side
pagination. Shared Admin/Coach availability stores inclusive time-off date ranges as one
record, with single-day partial absences and separate extra availability. Existing
coaching bookings/live holds block conflicting changes. The final-state initial migration
now requires `coach_availability_exceptions.until_date`; applied local schemas require an
explicitly authorized rebuild before using these changes. See [coaching](docs/coaching.md).


Checkout attempts and actual bookings are separate persisted concepts. `checkout_records`
owns the temporary allocation, immutable quote revisions and payment audit references.
`bookings` contains only permanent confirmed-booking identities and their original
confirmation-revision proof. Online settlement inserts that identity atomically with
confirmation; pay-at-club does so at creation. Failed, expired and abandoned checkouts
have no booking identity or booking cancellation revision. All business booking reads
require that identity; payment audit and staff occupancy guards retain all checkout
records. The focused, data-preserving TypeORM migration
`SeparateCheckoutBookings1791462257927` follows the three original baseline migrations.
No earlier migration is rewritten and no development data is discarded. See
[checkout lifecycle correction](docs/checkout-lifecycle-correction.md).


Browser abandonment uses the existing five-minute checkout expiry Cron and ten-minute
payment deadline. Unregistered holds expire locally; registered initial payments keep
occupancy until Stripe confirms cancellation or capture. Cancellation failure leaves a
visible, retryable Admin payment exception. Safe release updates the physical reservation
under existing locks, so GiST permits a replacement. Calendar identifies temporary holds;
Transactions distinguishes checkout references from actual booking identities. See
[abandonment investigation and validation](docs/browser-abandoned-checkout.md).
