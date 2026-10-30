# Tennis Club

A web application for operating a **single tennis club with multiple physical locations**:
courts, opening hours and pricing, court bookings, coaching lessons, staff reservations,
online payments and refunds, player profiles, notifications and club administration.

This is **not** a multi-tenant SaaS platform. One club owns and operates the application.
Memberships and subscriptions are planned; matches, partner matching and rankings are
deferred indefinitely. See the [roadmap](docs/roadmap.md) for implementation status.

All operational locations share one canonical IANA timezone. The first configured
location establishes it; subsequent configuration must match current, unarchived
locations. Legacy disagreement among active locations blocks new scheduling until
an Admin reconciles configuration. Historical bookings and accepted payments remain intact.

## Technology

- Next.js 16 App Router, React, strict TypeScript, Tailwind CSS v4, Zod
- PostgreSQL through server-only TypeORM (`DATABASE_URL`) — the sole application ORM and
  migration authority
- Supabase Auth (verified identity) and private Supabase Storage (player avatars)
- Stripe PaymentIntents with manual capture, Stripe refunds and webhooks
- Brevo transactional email; Supabase Cron + `pg_net` for scheduled endpoints
- Vitest, React Testing Library, Playwright

## Architecture in brief

```text
Browser → Next.js (Server Components, Server Actions, Route Handlers)
        → TypeScript application/domain services → TypeORM repositories → PostgreSQL
                                                 ↘ Stripe / Brevo / Supabase Auth & Storage
```

- Next.js is the primary application authorization boundary: active account, roles,
  ownership and public visibility are checked on the server.
- TypeScript decides business behavior; PostgreSQL enforces structural integrity, GiST
  overlap exclusions and atomic persistence; Stripe owns payment processing.
- There is no browser Supabase client. Application tables have no browser-role grants and no
  application RLS policies; Storage keeps RLS.
- `src/proxy.ts` only refreshes the Supabase session (Next.js 16 Proxy; no `middleware.ts`).

Roles: `admin` and `coach` are optional and combinable; ordinary accounts have no roles.
See [architecture](docs/architecture.md) and [security](docs/security.md).

## Documentation

| Document | Responsibility |
| --- | --- |
| [architecture](docs/architecture.md) | System boundaries, persistence, locking, Admin configuration restrictions |
| [booking domain](docs/booking-domain.md) | Availability, checkout holds, bookings, reservations, rescheduling, cancellation |
| [coaching](docs/coaching.md) | Programs, coach profiles, prices, availability, lesson booking |
| [payments](docs/payments-memberships.md) | Checkout, Stripe, captures, refunds, adjustments, reconciliation, expiry Cron |
| [pricing](docs/pricing.md) | Court pricing and opening-hours interaction |
| [profiles](docs/profiles.md) | Accounts, personal information, player profiles, avatars |
| [notifications](docs/notifications-delivery.md) | In-app notifications, Brevo, delivery Cron |
| [security](docs/security.md) | Authentication, authorization, database permissions |
| [testing](docs/testing.md) | Test infrastructure, isolation, commands |
| [design system](docs/design-system.md) | UI conventions |
| [roadmap](docs/roadmap.md) | Implemented, partial, planned and deferred scope |

AI coding agents follow [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md).

## Local setup

Requirements: Node.js, Docker and the Supabase CLI (`npx supabase`).

1. Start the development Supabase stack and check its ports:

   ```bash
   npx supabase start
   npx supabase status
   ```

   Local URLs: app `http://localhost:3000`, Supabase API `http://127.0.0.1:54321`,
   PostgreSQL `127.0.0.1:54322`, Mailpit (Auth email) `http://127.0.0.1:54324`.

2. Create `.env.local` from `.env.example`. Server-only values include:
   - `DATABASE_URL` — the trusted local `postgres` connection (`DATABASE_POOL_MAX`, default 2);
   - `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` — kept server-only, never `NEXT_PUBLIC_`;
   - `APP_URL` — canonical origin for Auth redirects, canonical URLs and the sitemap
     (required in production);
   - optional `GOOGLE_MAPS_EMBED_API_KEY` (Contact page map), `LOG_LEVEL`;
   - payments: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`,
     `NETOPIA_*` ([payments](docs/payments-memberships.md#provider-configuration));
   - email and Cron: `BREVO_API_KEY`, `NOTIFICATION_EMAIL_MODE`, `NOTIFICATION_CRON_SECRET`,
     `BREVO_WEBHOOK_SECRET`, `CHECKOUT_EXPIRY_CRON_SECRET` and the Cron URLs
     ([notifications](docs/notifications-delivery.md), [payments](docs/payments-memberships.md#checkout-hold-expiry-sweep)).

3. Initialize the schema and seed fixtures (see [Database setup](#database-setup-and-migrations)):

   ```bash
   npm run db:dev:rebuild -- --discard-local-data
   npm run db:dev:seed
   npm run db:dev:seed:coaching   # optional demo coaching data
   ```

4. Optionally schedule the local Cron jobs (they call the app on port 3000):

   ```bash
   npm run payments:expiry-cron:local      # checkout-expiry reconciliation, every minute
   npm run notifications:cron:local        # notification delivery, every five minutes
   ```

5. Run `npm run dev`. Without Stripe credentials, use the seeded Pay at club option.

### Development seed

`npm run db:dev:seed` creates 100 confirmed accounts with password `Local-Tennis-Dev-2026!`:
`dev-admin@example.test` (Admin), `dev-coach@example.test` and `dev-coach-002…009@example.test`
(Coaches), and `dev-player-001…090@example.test`. It also creates two published București
locations (`dev-central-club`, `dev-riverside-club`, `Europe/Bucharest`, RON) with courts,
opening hours, court pricing, a coverage period, Pay at club enabled and a 24-hour cancellation
notice. No bookings, payments or Storage objects are seeded. `npm run seed:users` seeds only
accounts and roles.

`npm run db:dev:seed:coaching` adds four `demo-coach-*@example.test` coaches (password
`StrongPassword123!`), four programs, public coach profiles and RON prices; see
[coaching](docs/coaching.md#development-seed).

Seeds run only against the local Supabase stack (ports 54321/54322), insert missing records,
fail on divergent fixtures rather than overwriting edits, and never print credentials.

## Database setup and migrations

TypeORM migrations in `src/lib/db/migrations/` are the only application schema history:

- `1791462257924-InitialApplicationSchema.ts`: final application tables, keys, indexes,
  exclusions, integrity functions/triggers and required reference records.
- `1791462257926-SupabaseAuthStorage.ts`: Auth hooks, private avatar Storage policies,
  table/sequence/default privileges and browser-role restrictions.

These two pre-production baselines replace the former five-migration history. The timestamp
gap is intentional. Supabase CLI provides native PostgreSQL, Auth and Storage only;
application SQL migrations and seeding are disabled in `supabase/config.toml`. Schema
synchronization and automatic runtime migrations are off; there are no npm migration commands.
See [baseline consolidation](docs/database-baseline.md) for the audit and verification.

- **Fresh or disposable local database:** `npm run db:dev:rebuild -- --discard-local-data`
  verifies the target is this project's local stack, empties the avatar bucket, recreates the
  `public` schema, removes Auth users and applies both migrations without seeding. The flag is
  mandatory; stop the app first. Never use `supabase db reset` for application initialization.
- **Existing development database with the former five migrations:** leave it untouched
  until you explicitly choose to discard its local data. Stop the app, preserve anything you
  need, run the guarded rebuild command above, then `npm run db:dev:seed` and optionally
  `npm run db:dev:seed:coaching`. Verify the two migration names and no pending migrations
  as described in [the transition procedure](docs/database-baseline.md#development-database-transition).
  Do not run pending migrations over the old history or edit its tracking rows: retained
  migration names now contain the final baseline, which cannot upgrade that history.
- **Future pending migrations on this new history:** stop the dev server, then run

  ```bash
  node --conditions=react-server --env-file=.env.local --import=./scripts/ts-loader.mjs node_modules/typeorm/cli.js migration:run -d src/lib/db/migration-data-source.mjs
  ```

- **Remote/shared/production databases, or any database whose data must be retained:** do not
  apply this rewritten history. A data-preserving cutover requires a separate plan and explicit
  authorization; applied shared/production migrations remain immutable.

## Commands

```bash
npm run dev            # development server
npm run lint           # ESLint
npm run typecheck      # tsc --noEmit
npm run build          # production build
npm test               # unit + component tests (no Supabase needed)
npm run test:integration   # isolated test Supabase required
npm run test:e2e           # Playwright, isolated production build on port 3100
```

Integration and E2E tests use only the separate `tennis-club-tests` Supabase project in
`tests/local/`; they never touch `.env.local` or the development database. Initialize it once:

```bash
npx supabase start --workdir tests/local
node --conditions=react-server --import=./scripts/ts-loader.mjs scripts/initialize-test-database.ts
```

Runs are serialized by a database lock. See [testing](docs/testing.md).

## Deployment notes

- Set `APP_URL` and all server-only secrets in the hosting environment; configure Supabase Auth
  Site URL, callback URLs, email confirmation and production email delivery.
- Configure the Stripe webhook at `/api/payments/stripe/webhook` with the events listed in
  [payments](docs/payments-memberships.md#checkout-hold-expiry-sweep).
- Schedule both Supabase Cron jobs in the production database (Vault secrets): checkout expiry
  **every minute** and notification delivery **every five minutes**. Changing a repository
  script does not change an already-scheduled production job; verify with `cron.job` and
  `cron.job_run_details`/`net._http_response` (a successful Cron run only proves the HTTP call
  was enqueued).
- Configure the Brevo terminal-failure webhook and the club sender in Admin → Club.
