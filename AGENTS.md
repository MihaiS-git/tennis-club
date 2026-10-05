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
- PostgreSQL functions/RPC only where transactional persistence requires them
- TanStack Query when interactive client-side server state is introduced; do not add it before a concrete workflow needs it

Do not introduce an ORM unless explicitly requested.

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

Do not put application authorization or domain rules in the proxy. In particular, do not put membership, pricing, booking, or role-specific business logic there. Next.js is the complete primary application authorization boundary; RLS provides defense-in-depth as secondary security.

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
Supabase server client
↓
PostgreSQL + RLS
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
Supabase / Stripe integration
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

Use `supabase-js` as the normal database access layer.

Do not add an ORM.

Supabase access is **server-first**. The initial application does not use a browser Supabase client.

### User-scoped server client

Use the authenticated user's session whenever an operation is performed on behalf of a user.

RLS must remain active. This is the default access mode.

```text
authenticated user
→ Next.js
→ user-scoped Supabase server client
→ PostgREST
→ PostgreSQL
→ RLS
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

### Privileged server client

A privileged Supabase server client uses a server-only secret credential and bypasses normal RLS protections.

Use it only when genuinely required, for example:

- Stripe webhook processing;
- trusted server-side synchronization;
- narrowly scoped system operations.

`SUPABASE_SECRET_KEY` is now required for the server-only customer booking writer.
Use that client only to call the service-role-only atomic booking creation RPC.

Never use the privileged client merely because the code runs on the server.

Never expose the secret key to:

- browser code;
- Client Components;
- public environment variables;
- logs;
- responses.

---

## RLS and authorization

Next.js is the complete primary application authorization boundary. Supabase RLS must remain active as defense-in-depth and secondary security.

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

When adding a table containing private or user-owned data, consider its RLS policies as part of the same change.

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

Avatar mutations share one UI pending state and a committed per-user database lease across Storage, persistence, and compensation. Preserve token-scoped acquisition/release, ownership-checked path persistence, and bounded transport deadlines shorter than lease expiry. Do not hold database transactions open during Storage HTTP requests or substitute an in-memory lock.

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

## Transactions and RPC

`supabase-js` operations made through PostgREST do not automatically create one transaction across several separate requests.

Use small PostgreSQL functions exposed through Supabase RPC when a workflow requires multiple database changes to commit atomically.

Examples may include:

- moving a booking during rescheduling;
- consuming membership credits;
- recording a match and both rating changes;
- selected payment/refund state transitions.

Keep RPC functions persistence-oriented.

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

Public location discovery for `/book` and `/courts` uses `listPublicLocationsWithCourts()` and the shared TypeScript eligibility rule in `src/lib/locations/publication.ts`. `locations.is_public` defaults to false and records explicit Admin publication intent; readiness is derived from valid location details, opening hours, active courts, and current or future base-state pricing for each active court. Admin enabling validates readiness server-side. Public RLS SELECT requires publication as defense-in-depth.

The public `/book` page reads opening hours, coverage periods, and pricing
rules for active public resources only after a valid location-local date is selected,
through user-scoped server Supabase access. Without a date it reads only the
locations, courts, and minimal opening-hours and pricing fields needed to derive
public eligibility for the controls.
Public RLS SELECT policies permit those reads; configuration writes remain
admin-only. Calendar availability is informational until bookings are implemented.
It also reads only reservation occupancy columns for the selected date and
active courts at that location. Only active reservation rows block their half-open
intervals; reservation identity, reason, creator, canceller, status, and timestamps are not publicly readable.

Internal `/reservations` is a separate direct court-reservation workflow for active
Admins and Coaches. It lists structurally ready locations without requiring publication.
The user-scoped Server Action validates location-local
time, a single opening-hours interval, 30-minute alignment, at least 60 minutes,
and a required trimmed reason of at most 255 characters. RLS permits staff INSERT
and the partial GiST exclusion constraint rejects concurrent active overlaps. Public `/book`
continues to read occupancy alone and never reads reservation reasons.
Customer booking persistence uses `public.bookings` for required historical contact
and server-calculated price/currency snapshots, with one unique reference to its
physical `court_reservations` row. The server-only `createCustomerBooking` operation
accepts only customer intent, resolves active account identity and public eligibility
through user-scoped reads, and reuses the `/book` calendar pricing calculation.
Location customer cancellation notice is configured in the shared Admin Create/Edit
location form, stored as 0–43,200 integer minutes with a 1,440-minute default.
The atomic customer booking RPC snapshots it from the selected court's location into
`bookings.cancellation_notice_minutes`; personal upcoming/history and Admin operational
reads use that booking snapshot. Location configuration reads use an Admin-only RPC;
public location SELECT keeps only its existing columns. The owner-only
`cancel_own_customer_booking(uuid)` RPC is called through the customer booking service
and My Activity Server Action. It requires an active account, confirmed owned booking,
active linked reservation and a start instant still in the future. Ordinary owners use
the snapshot cutoff, inclusive at `now <= cutoff`; current Admin/Coach owners bypass
notice only. It locks booking then reservation and checks wall-clock time after waiting;
both lifecycle updates commit atomically and preserve snapshots. Personal booking reads
return PostgreSQL's timezone-resolved `starts_at_instant` for consistent UI eligibility.
Explicit confirmation precedes cancellation; Upcoming refreshes and History retains the
cancelled row. Guest identity matching cannot grant access. Admin operational and direct
reservation cancellation remain separate.
Guests have a null account link; suspended authenticated users are rejected. A
service-role-only RPC inserts both rows atomically, leaving GiST authoritative for
overlaps. Browser roles cannot read or insert bookings or invoke the RPC. `/book`
uses a focused customer-details dialog and Server Action. Guests can confirm without
an account; active signed-in users receive editable contact defaults from Profile.
Contact edits affect only the booking snapshot. Availability conflicts clear the
selected interval, retain contact values, and refresh public occupancy. Success
shows the server-confirmed price. Customer payments and holds are not present.
Direct reservations store the authenticated creator in nullable
`court_reservations.created_by_user_id` (historical rows stay null). `/reservations`
reads occupancy for Admins and Coaches and creates new direct reservations. Active
Admins also read active direct-reservation identity, reason, and creator display name
through an Admin-only RPC for a whole-reservation details dialog. A distinct
Admin-only conditional cancellation RPC changes an active row to cancelled,
records the authenticated Admin as canceller, and preserves its creator and details.
The personal cancellation RPC remains owner-only. Coaches receive generic
occupied cells only; public `/book` remains occupancy-only.
Admin Edit on `/reservations` currently uses the shared reservation edit form and a
separate Admin-only availability read for the active reservation's fixed location.
It excludes the edited row from occupancy and includes other active reservations.
Admin Save uses a separate Admin-only same-row edit RPC with a row lock, an
`updated_at` stale token, fixed-location enforcement, and the active-row GiST
constraint. It preserves the creator and lifecycle fields and permits only
reason changes once an interval starts. The owner-only edit read and mutation
remain separate. `/profile` contains identity and settings;
`/my-activity` is the compact personal activity overview, and `/my-activity/bookings`
contains current/upcoming personal booking/reservation management. `/my-activity/bookings/history`
is a server-paginated archive of the current staff user's cancelled and elapsed court reservations.
The personal reservation reads remain bound to `auth.uid()` and use location-local time for lifecycle classification.
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
edit RPC locks the row, compares its `updated_at` token, and rejects a different location.
TypeScript reuses direct-creation validation for the fixed location, court, local time and opening
hours; PostgreSQL keeps the active-row GiST overlap constraint authoritative.

Admin pricing definitions apply to selected courts, not surfaces. One definition has
one stable `rule_set_id` and expands to one atomic `location_pricing_rules` row per
court × weekday. Create and Edit use the same multi-court, multi-weekday form; the
admin manages one logical table row per definition. Indoor courts allow only the
`indoor` state; outdoor courts allow `outdoor` or `covered`. Currency comes from the
court's location. Validate all selected court/day targets against that location's
opening hours before saving. User-scoped transactional RPCs create, replace and
delete complete rule sets; PostgreSQL enforces court/location/environment integrity
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
- pgTAP → PostgreSQL, RLS, and database tests.
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
- transactional RPC behavior;
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
