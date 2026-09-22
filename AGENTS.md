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

- Next.js App Router
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
│   └── lib/
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
```

Do not introduce `NEXT_PUBLIC_SUPABASE_*` variables merely because Supabase examples use a browser client.

### Browser Supabase client

Do not create or use a browser Supabase client unless a concrete feature requires direct browser-to-Supabase communication.

A valid future example is Supabase Realtime. If such a feature is introduced:

- keep the scope narrow;
- expose only browser-safe values;
- retain RLS as the authorization boundary;
- document the new browser access path in both `README.md` and `AGENTS.md`.

### Privileged server client

A privileged Supabase server client uses a server-only secret credential and bypasses normal RLS protections.

Use it only when genuinely required, for example:

- Stripe webhook processing;
- trusted server-side synchronization;
- narrowly scoped system operations.

Introduce `SUPABASE_SECRET_KEY` only when a privileged workflow actually needs it.

Never use the privileged client merely because the code runs on the server.

Never expose the secret key to:

- browser code;
- Client Components;
- public environment variables;
- logs;
- responses.

---

## RLS and authorization

Supabase RLS is a primary security boundary, not optional defense-in-depth.

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

Do not mix publicly readable player information and sensitive/private account information without considering RLS implications.

Public tennis data may include:

- display name;
- rating;
- ranking;
- match statistics;
- public rating history.

Private data may include:

- contact information;
- billing metadata;
- account information;
- private preferences.

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

Do not edit an already-applied migration to represent a new production change. Add a new migration instead.

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
