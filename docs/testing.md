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
applying the existing three registered TypeORM migrations, atomically. It is
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

Playwright always builds and starts a fresh production Next.js server on port 3000.
Stop any server on that port first; `PLAYWRIGHT_USE_EXISTING_SERVER=1` is rejected.
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

`tests/unit/profile/` covers personal/tennis validation, session-owned explicit mutations, active-account requirements, system-field rejection, actual avatar decoding, size/dimension limits, WebP normalization, aspect ratio, no enlargement, orientation/metadata removal, avatar compensation, and authenticated image delivery. `tests/components/profile-forms.test.tsx` covers inline errors, retained values, pending feedback, read-only rating, avatar controls, and client file-selection rejection/error clearing. Page and navbar component tests cover the consolidated Profile settings and removal of separate Account navigation.

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
persistence to verify all four overlap exclusions (reservations, coverage, opening
hours and pricing), valid adjacent intervals, partial payment uniqueness, positive
payment/refund amounts, refund foreign keys and refund uniqueness. It also verifies
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
