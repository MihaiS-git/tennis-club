# Authentication testing

Focused automated coverage includes signup action role-field exclusion, callback decisions, mandatory-confirmation signup decisions, preconfirmation auth-user/application-account/zero-role provisioning in the local database, account loading with zero elevated roles, denied browser database access, suspended-account behavior, query-error classification, auth validation/action state, current-password verification, recovery-session password reset and subsequent sign-in, production `APP_URL` safety, and flash-query cleanup. React Testing Library covers password visibility, rendered signup errors, stale-error clearing, pending submit behavior, Sonner success/error dispatch, preservation of unrelated URL parameters during flash consumption, and prevention of duplicate display while the same flash URL remains mounted. TypeScript integration tests verify application authorization, administrator grants and audit attribution, and suspended-user role restrictions.

Unit tests in `tests/unit/` own TypeScript validation and business logic. React component tests use Vitest, React Testing Library, and jsdom in `tests/components/`. Integration tests in `tests/integration/` own services, repositories, transactions, authorization, bookings, payments and concurrency. PostgreSQL-native integrity, denied database access and Auth/Storage behavior are covered by the existing integration tests; no separate pgTAP suite is required.

## Isolated local integration and E2E environment

The installed Supabase CLI supports a distinct local project with `--workdir`.
`tests/local/supabase/config.toml` defines `tennis-club-tests`, separate from
`supabase/config.toml` and the development project `tennis-club`. Docker is required.
The test project has its own database and Auth users, private Storage volume, JWT
secret/anon/service-role credentials and Mailpit inbox. Its API is `127.0.0.1:55321`,
PostgreSQL is `127.0.0.1:55322/postgres`, and Mailpit is `127.0.0.1:55324`.
Like the standard local CLI stack, the database uses the local `postgres` login.
The checked-in test JWT secret is disposable local configuration, never a production credential.

From the repository root:

```bash
npx supabase start --workdir tests/local
node --conditions=react-server --import=./scripts/ts-loader.mjs scripts/initialize-test-database.ts
npm run test:integration
npm run test:e2e
```

The initializer verifies the test stack endpoints and database identity before
applying pending migrations from the seven registered TypeORM migrations (924–930), atomically. It is
idempotent and checks for pending migrations. It never drops data or runs the
100-user development seed. Supabase application SQL migrations/seeding are disabled;
Auth and Storage infrastructure still comes from native Supabase startup.
Tests retain their existing fixtures, including the persistent integration Admin anchor.

Run integration and E2E suites sequentially, with no concurrent runs against this
shared disposable stack. Integration files use `--no-file-parallelism` because
final-admin tests temporarily suspend other test administrators; changes are restored
in `finally`. Unit/component tests remain independent: `npm test` needs no Supabase.
Integration provisioning checks require `psql`. E2E requires Google Chrome.

`tests/local/environment.mjs` reads credentials only from `supabase status --workdir
<absolute tests/local path> -o json`, using the installed CLI. It verifies the
project config and exact local API/database/Mailpit endpoints before connections.
Both npm runners override inherited connection values; neither loads `.env.local`.
The Vitest setup and privileged fixture helpers reject development ports, remote
hosts, missing test identity, mismatched database aliases and URL query overrides.
There is no fallback to development credentials or default database URLs. Use the
npm integration runner for focused tests too:

```bash
npm run test:integration -- tests/integration/db/migration-cutover.integration.test.ts
```

Playwright builds into `.next-test` and starts its own production Next.js server on
port 3100, leaving the development server and `.next` output untouched. Port 3100
must be free; `PLAYWRIGHT_USE_EXISTING_SERVER=1` is rejected.
The build and server inherit the verified test connections and `APP_URL` explicitly,
so Next.js cannot replace them with `.env.local` values. Real booking mail and
payment-provider environment credentials are explicitly blanked; tests opt into
mocked provider settings where needed. Auth confirmation/recovery mail uses the test
Mailpit URL. Build or startup failures fail the suite.

For a data-preserving stop/restart:

```bash
npx supabase stop --workdir tests/local
npx supabase start --workdir tests/local
```

To discard **only test data**, stop and reset only the explicit test project, then
reapply TypeORM migrations. Never omit `--workdir tests/local`:

```bash
npx supabase stop --workdir tests/local --no-backup
npx supabase start --workdir tests/local
node --conditions=react-server --import=./scripts/ts-loader.mjs scripts/initialize-test-database.ts
```

Do not use `db:dev:rebuild`, `db:dev:seed` or development `supabase db reset` for tests.
The normal development Supabase configuration, application environment and seed
scripts are independent of this workflow.

The three journeys cover signup through the actual Mailpit confirmation link and `/auth/callback` through `/account` to `/profile`; forgot-password through the actual Mailpit recovery link and `/auth/callback` to reset and subsequent sign-in; and unauthenticated account redirect, login, account access, logout, and renewed redirect. Each journey creates a unique test user. The recovery journey checks the `/forgot-password` destination after the notice is consumed, follows the recovery link to `/reset-password`, submits a new password, and signs in with it. The signup journey checks the account profile and empty role list after confirmation.

## Profile coverage

`tests/unit/profile/` covers personal/tennis validation, session-owned explicit mutations, active-account requirements, system-field rejection, actual avatar decoding, size/dimension limits, WebP normalization, aspect ratio, no enlargement, orientation/metadata removal, avatar compensation, and authenticated image delivery. `tests/components/profile-forms.test.tsx` covers inline errors, retained values, pending feedback, read-only rating, avatar controls, and client file-selection rejection/error clearing. `tests/components/user-navigation.test.tsx` covers the shared user sidebar (destinations, active links, Admin-identical styling, drawer, Sign out); `profile-unsaved-changes.test.tsx` covers per-page draft protection through the sidebar, navbar and Sign out; navbar tests cover the direct `/profile` avatar link.

`tests/integration/profile/profile.integration.test.ts` exercises real application saves and authorization; missing profile schema fails validation instead of skipping the test. `tests/integration/profile/avatar.integration.test.ts` separately exercises access/input rejection, authenticated image retrieval, and real Storage upload/replacement/removal. Only the request-cookie client factory is substituted for endpoint tests. `tests/integration/db/player-profiles.integration.test.ts` and `tests/integration/db/accounts.integration.test.ts` cover profile persistence and application-owned timestamps. Existing test fixtures do not automatically create player profiles.

## Persistence verification

Production PostgreSQL persistence is TypeORM; Supabase handles Auth and Storage.
`courts/public.integration.test.ts` verifies privileged public parent visibility and
active/live-held occupancy without read cleanup. `personal-history.integration.test.ts`
and `personal-customer-bookings.integration.test.ts` exercise live `activity-service.ts`,
including owner/role boundaries, archived history, options before filters, microsecond
history timestamps and continuation beyond 1,000 rows. Existing Admin payment,
reconciliation, operational and payment-foundation suites cover the migrated projections.
`payment-provider-settings.integration.test.ts` checks configuration rejection, stored
selection, nullable clearing, same-value no-op, concurrent updates, actor fences and
audit-failure rollback with real PostgreSQL locks. `db/migration-cutover.integration.test.ts` verifies denied browser grants; legacy SQL catalog, business-rule, RLS and command/read tests are removed. Development seeds use TypeORM for application data and Supabase Auth APIs for users;
the guarded rebuild rejects remote targets and production.

## TypeORM cutover validation

Fresh application schema comes exclusively from TypeORM; native Supabase startup
must not apply application SQL migrations. See [fresh setup](../README.md#application-migrations-and-fresh-local-setup).
Use the isolated test initialization and npm runners above for final-migration
validation. `db/migration-cutover.integration.test.ts` requires the test project
identity and ports, and verifies native constraints, grants, Auth and Storage through
real connections. Application workflows, authorization and database integrity retain
integration coverage; development seed/rebuild scripts are not test initialization.

```bash
npm run test:integration -- tests/integration/db/migration-cutover.integration.test.ts
npm run typecheck
npm run lint
```

These checks cover native overlap and financial integrity, Auth provisioning/email
timestamps, private avatar security,
application table/default privileges, configuration/publication and booking/payment/refund
concurrency. Integration fixtures use
privileged local-only PostgREST for setup where retained service-role grants allow it;
production routes use TypeORM only.

## Database-native protection

`tests/integration/db/migration-cutover.integration.test.ts` directly attempts invalid
persistence to verify all five overlap exclusions (reservations, coverage, opening
hours, schedule validity and pricing), valid adjacent intervals, partial payment uniqueness, positive
payment/capture/refund amounts, capture identity/deduplication, immutable payment-request/provider-event/capture
facts, refund/adjustment foreign keys, operation/request uniqueness, adjustment hold-fragment
duration/state and restrictive financial deletes. It also requires the seven registered
migrations (924–930) and an empty TypeORM schema-builder diff. Security coverage includes
browser-role table/column and future-table privileges, real denied reads, Auth signup
and email synchronization, and private active-account avatar Storage access.
Reservation, configuration, payment and profile integration suites provide additional
workflow and concurrency coverage. Static table/function/key/CHECK/index inventories
and the redundant pgTAP suite are removed; migrations define those schema objects.

Run the focused native integrity and security checks through the existing runner:

```bash
npm run test:integration -- tests/integration/db/migration-cutover.integration.test.ts
```

Use only the isolated `tennis-club-tests` project. Fixtures are cleaned up or rolled
back; never run them against development, remote, production or shared databases.


## Booking adjustment validation

The existing db/booking-mutations integration suite now covers surcharge capture,
retryable failure/unknown outcome, cancellation/expiry, target/pricing/actor invalidation,
compensation, partial refund retry (including a verified failed execution and distinct retry identity), repeated
50 → 75 → 100 → 75 → cancellation, concurrent edits/recovery, role boundaries and
expiry at the final SQL write. Existing Stripe/cancellation/Admin suites remain required.

`tests/e2e/booking-adjustments.e2e.ts` exercises My Activity Edit, original/new/difference
prices, X discarding an unpaid modification, a fresh Edit, an additional payment and a partial refund through the real
Next.js/TypeORM services. Playwright starts a loopback Stripe HTTP fixture on 3111,
uses intentionally fake fixture credentials and intercepts Stripe.js in this test.
It makes no real Stripe transaction. Production routing to the fixture is rejected
unless the exact isolated test database, project marker, fake secret and URL match.
Test environment setup clears inherited Stripe fixture/provider variables before
Playwright opts into these explicit fake credentials. Application server/build remain
isolated on port 3100 and .next-test; the development server is not reused.

### Real Stripe test-mode modification lifecycle

`tests/e2e-live/booking-modification-lifecycle.e2e.ts` drives real Chromium against real
Stripe test mode, real webhooks and the isolated test Supabase project (no production
build). Requirements: test Supabase running, the Stripe CLI logged in to the same test
account, and `.env.local` holding Stripe test keys whose `STRIPE_WEBHOOK_SECRET` equals
`stripe listen --print-secret`. The spec starts and stops its own `stripe listen`
forwarding to port 3100 and uses `stripe events resend` to deliver delayed/duplicate events.

```bash
node tests/e2e-live/dev-server.mjs            # next dev on :3100, .next-test
npx playwright test -c playwright.stripe-live.config.ts
# Late success: restart the server with the test-only hold override
E2E_ALLOW_HOLD_OVERRIDE=1 BOOKING_HOLD_SECONDS_OVERRIDE=60 node tests/e2e-live/dev-server.mjs
LIVE_LATE=1 npx playwright test -c playwright.stripe-live.config.ts
```

`BOOKING_HOLD_SECONDS_OVERRIDE` (15–600) is honored only when `NODE_ENV=test` or
`E2E_ALLOW_HOLD_OVERRIDE=1`, and never when `NODE_ENV=production`. Card payments settle
synchronously, so browser "pending" is a delayed webhook; processing branches are
covered by `tests/integration/db/booking-mutations.integration.test.ts`.

## Consolidated schema generation

Regenerate the editable initial migration with the existing shared DataSource and
loader, against a positively verified empty disposable local database (never an
arbitrary inherited `DATABASE_URL`):

```bash
DATABASE_URL=<verified-isolated-empty-database-url> node --conditions=react-server --import=./scripts/ts-loader.mjs node_modules/typeorm/cli.js migration:generate src/lib/db/migrations/InitialApplicationSchema -d src/lib/db/migration-data-source.mjs -t 1791462257924
```

Review generated DDL, then put `CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA
extensions` and `SET LOCAL search_path = public, extensions` at the beginning of
`up()` before the entity-generated exclusions. Retain the extension on rollback.
Ordinary tables, checks, indexes, keys and all exclusions come from entity metadata.
The Auth reference is non-synchronized, and the email expression index is declared
with `synchronize: false`; a post-initialization schema comparison must propose zero
changes, including no native-object drops. Do not preserve the removed effective-hours
or booking-adjustment patch migrations. No legacy data backfills are required.

Supabase integration rollback opts into the installed Storage SQL delete guard
inside the migration transaction; the native bucket/object FK still refuses a
nonempty bucket. Runtime Storage access and policies are unchanged.


## Booking revision validation

The migration-cutover suite checks the seven-migration history (924–930), zero schema diff,
non-synchronized Auth reference, composite current/predecessor relationships,
strict linear numbering, atomic head advancement and revision UPDATE/DELETE/TRUNCATE
rejection. Ownership checks reject guest/account reassignment in every direction,
permit unchanged values and verify aggregate rollback and restrictive account deletion.
Existing browser/Auth/Storage and overlap checks remain required.
Checkout tests assert online pending/confirmed revision count, duplicate confirmation,
Pay-at-club confirmed creation and unchanged original debt requests after edits.
Booking-mutation tests assert exact RON 50 → 75 → 100 → 75 → cancellation snapshots,
predecessors/current pointer, occupancy, captures and refund obligations. They also
cover no-ops, intent-key replay/conflicts, concurrency, failed paid applications,
owner/staff boundaries, cancellation without refunds and compensation.

Fixture inserts create identity/revision records atomically through the test helpers;
no fixture depends on obsolete mutable booking columns. Controlled contract changes
append real fixture revisions. Teardown explicitly removes financial dependencies,
adjustments, revisions and identities in one guarded isolated-test transaction.
Only teardown temporarily disables the revision DELETE guard with privileged DDL,
flushes deferred checks, then re-enables it before commit. Production has no bypass
setting. Integration/E2E remain sequential against the verified test stack.


## Refund execution cutover validation

`db/refund-executions.integration.test.ts` checks real PostgreSQL uniqueness,
immutability, lease fencing, stale provider facts, browser grants and transactional
rollback, plus mocked Stripe dispatch/recovery through the live refund service.
The affected Stripe refunds, Admin reconciliation, booking-mutations and financial
history suites retain cancellation idempotency, atomic receipt resolution, failed
adjustment compensation and RON 50 → 75 → 100 → 75 → cancellation coverage.
Regenerate the existing initial migration only against verified empty isolated
infrastructure; apply all seven registered migrations (924–930) and verify zero metadata drift.
No provider calls occur inside transactions, and no real Stripe/Brevo calls or
normal development reset are part of these checks.

## Request-driven payment recovery

When switching an existing local checkout from the removed scheduler, stop its Next.js
development servers and remove stale generated `dev/server/instrumentation.js` entrypoints
from `.next` and `.next-test` before restarting. Otherwise Next.js can load the deleted
instrumentation from an earlier compilation and start the obsolete timer. This concerns
generated local output only; do not restore the removed source or change database data.

No financial scheduler runs (Supabase Cron only retries emails; tests call
`POST /api/notifications/deliver` directly and never schedule jobs in the test database). Integration tests drive each outcome the way production does: the
checkout status poll, `processOnlinePaymentEvent` (signed webhook), and
`processBookingRefund` with `{ strict: true, providerChanged: true }` (Stripe refund webhook) or
`{ actorId, retryRejected: true, strict: true }` (Admin "Check with Stripe").
Apply migrations `1791462257929-RequestDrivenPaymentRecovery` and
`1791462257930-SurchargeCaptureAcceptance` with the guarded test initializer before running them against the isolated test database.
`tests/integration/booking-notifications.integration.test.ts` covers post-commit email
delivery, retries, concurrency and in-app acknowledgement.

Focused surcharge/Cron regressions (no reset, full suites or build):

```bash
node --conditions=react-server --import=./scripts/ts-loader.mjs scripts/initialize-test-database.ts
node node_modules/vitest/vitest.mjs run tests/unit/notification-cron-target.test.ts
node node_modules/vitest/vitest.mjs run tests/unit/booking-notification-commit.test.ts -t 'paid|surcharge|adjustment|modification'
node tests/run-integration.mjs tests/integration/db/booking-mutations.integration.test.ts -t 'accepted surcharge|a surcharge is authorized only|a surcharge authorization rejected|a surcharge whose capture fails'
```

The initializer applies pending additive migrations only to the verified isolated test
project. Surcharge tests cover the capture deadline, acceptance with and without extra
court holds, and capture racing expiry, dismissal, supersession and delayed provider
signals. Cron guard tests do not connect, schedule jobs or contact external services.

## Coaching coverage

`tests/unit/coaching/` covers price resolution (override, default, missing, currency
change), validation, the public and coach-profile projections, Admin authorization before
any database access, and the development seed's local-only guard. Component tests cover the public `/coaching` page, Admin coaching tables and
dialogs, homepage coaching programs, coach profile pages, and the shared public hero and
section menu (`public-page-layout.test.tsx`). `coaching-seed.integration.test.ts` covers seed
idempotency, preserved Admin edits, duplicate-free prices, coach eligibility and public coach reads. `tests/integration/admin/coaching.integration.test.ts`
exercises real Admin saves, coach eligibility, dependency rejection, unique/composite FK
constraints, public visibility, currency handling and denied browser grants.
