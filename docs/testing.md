# Authentication testing

Focused automated coverage includes signup action role-field exclusion, callback decisions, mandatory-confirmation signup decisions, preconfirmation auth-user/profile/default-role provisioning in the local database, account loading and member role, cross-user profile/role RLS denial, suspended-account behavior, query-error classification, auth validation/action state, current-password verification, recovery-session password reset and subsequent sign-in, production `APP_URL` safety, and flash-query cleanup. React Testing Library covers password visibility, rendered signup errors, stale-error clearing, pending submit behavior, Sonner success/error dispatch, preservation of unrelated URL parameters during flash consumption, and prevention of duplicate display while the same flash URL remains mounted. pgTAP directly verifies auth-user provisioning, anonymous access denial, profile and role RLS, member self-assignment/revocation denial, administrator grants and audit attribution, and suspended-user role restrictions.

Unit tests live in `tests/unit/`; React component tests use Vitest, React Testing Library, and jsdom in `tests/components/`; integration tests that use the local Supabase stack live in `tests/integration/`. Supabase pgTAP/database tests live in `supabase/tests/database/`. The pgTAP file runs in a transaction and rolls back its fixtures.

Run the unit, integration, or complete application suite with Vitest. Integration tests require `.env.local` and the running local Supabase stack. The provisioning check also requires `psql` and uses the default local database URL, overridable with `LOCAL_SUPABASE_DB_URL`. The recovery and account integration tests use the local Supabase CLI service-role key (or `LOCAL_SUPABASE_SERVICE_ROLE_KEY`) to create test fixtures and set suspension; application account reads run with a user-scoped client:

```bash
npm run test:unit
npx vitest run tests/components/auth-forms.test.tsx
npx vitest run tests/unit/flash-messages.test.ts tests/components/query-flash-messages.test.tsx
npm run test:integration
npm test
npx eslint src/app/layout.tsx 'src/app/(auth)/actions.ts' src/components/query-flash-messages.tsx src/lib/auth src/lib/flash-messages.ts tests/unit tests/integration
supabase test db --local supabase/tests/database
```

Playwright auth journeys live in `tests/e2e/`. They use the real Next.js application at `http://localhost:3000`, local Supabase at `http://127.0.0.1:54321`, and Mailpit at `http://127.0.0.1:54324`. Have the local Supabase stack, `.env.local`, the Supabase CLI (or `LOCAL_SUPABASE_SERVICE_ROLE_KEY`), and Google Chrome available. Use PostgREST 16.3 or later: the local CLI's 16.2 image has an intermittent `PGRST303` JWT clock bug. If needed, pin `v16.3` in the ignored `supabase/.temp/rest-version` file and restart Supabase with the data-preserving `supabase stop` and `supabase start` commands. Playwright starts the application with `npm run dev` if it is not already running. Run only this suite with:

```bash
npm run test:e2e:auth
```

The three journeys cover signup through the actual Mailpit confirmation link and `/auth/callback` to `/account`; forgot-password through the actual Mailpit recovery link and `/auth/callback` to reset and subsequent sign-in; and unauthenticated account redirect, login, account access, logout, and renewed redirect. Each journey creates a unique test user. The protected-route login/logout journey passed, and the signup-confirmation journey passed on local PostgREST 16.3 with the account profile and `member` role visible. The recovery journey stopped at a test assertion expecting a flash query parameter that the application had already consumed, so its later steps have not yet been verified by E2E.
