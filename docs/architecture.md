# Architecture

## System boundary

The application is a modular Next.js application for one tennis club with multiple locations. The diagram below shows the intended architecture as booking and payment features are added; the current implementation is the authentication and account foundation.

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
Supabase server client
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

Architectural rule:

> Next.js is the application boundary, TypeScript decides business behavior, PostgreSQL guarantees data integrity, RLS protects data access, and Stripe owns payment processing.

## Next.js responsibilities

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
Supabase / Stripe integration
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

## Supabase access

Supabase access is server-first.

Normal user operations:

```text
authenticated user
→ Next.js
→ user-scoped Supabase server client
→ PostgREST
→ PostgreSQL
→ RLS
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

## Transactions and RPC

Separate `supabase-js`/PostgREST calls do not automatically form one database transaction.

Use a small PostgreSQL RPC when several persistence changes must commit atomically.

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

Do not move pricing, Elo, partner matching, entitlement rules, or other application algorithms into SQL merely because RPC is available.

## Initial schema approach

Derive schema incrementally from implemented workflows.

Existing authentication/application identity uses:

```text
auth.users
public.users
public.roles
public.user_roles
```

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

Authentication uses the Next.js App Router and a user-scoped Supabase server client. An `AFTER INSERT` trigger on `auth.users` creates the matching `public.users` row and default `member` role in the same transaction, before email confirmation. If provisioning fails, the Auth insert fails too.

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
