# Tennis Club — Claude Code instructions

## Scope and stack

- One tennis club, potentially multiple physical locations; do not introduce multi-tenancy or a separate backend.
- Next.js 16 App Router, React, strict TypeScript, Tailwind CSS, Zod, Supabase Auth/private Storage, PostgreSQL, TypeORM, Stripe. Preserve the installed stack.
- Before architecture or domain work, inspect `README.md`, relevant source files, and tests. Use installed Next.js documentation under `node_modules/next/dist/docs/` for version-sensitive APIs.
- Work incrementally. Preserve existing architecture, names, layout, UX, and behavior outside the task. Avoid unrelated refactors, speculative abstractions, or new dependencies.
- Never delete or replace user assets in `public/` without explicit instruction. Do not commit, reset, clean, or perform destructive Git operations unless requested.

## Architecture and security

- Keep the flow: Next.js Server Component/Action/Route Handler -> TypeScript application/domain service -> TypeORM repository -> PostgreSQL.
- Server Actions and Route Handlers validate, authorize, and delegate; business rules and workflows belong in TypeScript, not components or SQL.
- Use Server Components by default. Keep client boundaries small. `src/proxy.ts` handles Supabase session refresh, not authorization or business policy. Never introduce legacy `middleware.ts`.
- Supabase at runtime is for verified Auth identity and private Storage; application data uses server-only TypeORM with `DATABASE_URL`. No browser Supabase client, PostgREST/RPC persistence fallback, or browser access to application tables.
- Next.js is the primary application authorization boundary. Check active account, authoritative roles, ownership, and public visibility on the server. Deny application-table browser grants; keep private Storage RLS.
- Treat all form, URL, webhook, and model/external inputs as untrusted. Use Zod at boundaries, provider signature checks, server-authoritative prices/status, and explicit database write allowlists. Never expose secrets or sensitive internals.
- Never cache user-scoped clients, sessions, roles, permissions, or private profile data across requests. Follow existing Cache Components/Suspense conventions.

## Persistence and concurrency

- TypeORM is the sole application ORM and migration authority. Supabase provides native Auth/Storage infrastructure only. Repositories take an explicit `EntityManager` and do not start transactions.
- Application services own decisions and transaction orchestration; PostgreSQL owns structural constraints, uniqueness, overlap exclusions, and atomic persistence. Do not move policy to SQL functions/triggers.
- Preserve existing location-first occupancy locking, actor/configuration fences, bounded retries, and stable lock order for booking and configuration changes. Read the relevant service and architecture docs before modifying concurrency-sensitive code.
- Never perform Auth, Storage, Stripe, Brevo, or other network requests while a database transaction is open.
- For unreleased local schema, prefer clean, domain-focused migrations over corrective patch piles. Never edit applied shared/production migrations. Never reset/rebuild a database or discard data without explicit approval.

## Bookings and payments: non-negotiable invariants

- Guest and authenticated bookings are both supported. Availability checks alone cannot guarantee a reservation; preserve transactional/GiST overlap protection and temporary checkout holds.
- Keep booking, reservation, payment-attempt, capture, adjustment, and refund states distinct. Price/currency/payment method/provider and cancellation rules are server-validated and snapshotted at the appropriate boundary.
- Payment confirmation requires verified provider evidence; never trust browser-reported payment success. Verify Stripe webhook signatures and process events idempotently. A duplicate or late payment must not reclaim released court occupancy.
- Refunds and adjustments are provider-bound, idempotent, and based on verified historical captures—not recalculated current prices. Do not create another provider refund when the result of a previous attempt is unknown. Preserve immutable financial evidence and existing recovery rules.
- Preserve already defined booking/payment lifecycles, locking, auditability, and post-commit notifications. Before modifying these workflows, read `docs/payments-memberships.md` and the relevant implementation/tests.

## UI and tests

- Match existing Tailwind conventions. Use compact management tables, inline editing for safe scalar values, focused dialogs for compound edits, one Create/Edit interaction model, and progressive disclosure. Avoid exposing technical persistence internals to end users.
- Validate changes with relevant commands from `package.json` and `docs/testing.md`; normally include applicable lint, tests, and build checks. Add regression tests for bug fixes. Never claim a check passed unless executed.
- Report: why the change, how to validate locally, assumptions, checks actually run, and exact files changed. Prefer focused unified diffs.

## Read only when relevant

- `docs/architecture.md` — domain boundaries, TypeORM persistence and transaction/locking design.
- `docs/payments-memberships.md` — checkout, Stripe, provider selection, captures, refunds, adjustments, reconciliation, and Admin payment actions.
- `docs/profiles.md` — player profile and avatar/Storage rules.
- `docs/booking-notifications.md` — Brevo booking email lifecycle and post-commit delivery.
- `docs/testing.md` — local database setup and test/verification procedures.
- `README.md` — current setup and development commands.

These are navigation references, NOT `@` imports: open only the files relevant to the current task. If a cited file or rule differs from implemented code, inspect the code and tests and raise the discrepancy; do not silently change behavior.
