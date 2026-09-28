# Authentication testing

Focused automated coverage includes signup action role-field exclusion, callback decisions, mandatory-confirmation signup decisions, preconfirmation auth-user/application-account/zero-role provisioning in the local database, account loading with zero elevated roles, cross-user account/role RLS denial, suspended-account behavior, query-error classification, auth validation/action state, current-password verification, recovery-session password reset and subsequent sign-in, production `APP_URL` safety, and flash-query cleanup. React Testing Library covers password visibility, rendered signup errors, stale-error clearing, pending submit behavior, Sonner success/error dispatch, preservation of unrelated URL parameters during flash consumption, and prevention of duplicate display while the same flash URL remains mounted. pgTAP directly verifies auth-user provisioning, anonymous access denial, account and role RLS, normal-user elevated-role mutation denial, administrator grants and audit attribution, and suspended-user role restrictions.

Unit tests live in `tests/unit/`; React component tests use Vitest, React Testing Library, and jsdom in `tests/components/`; integration tests that use the local Supabase stack live in `tests/integration/`. Supabase pgTAP/database tests live in `supabase/tests/database/`. The pgTAP file runs in a transaction and rolls back its fixtures.

Run `npm test` to execute unit, component, and integration suites sequentially in separate Vitest processes. Unit and component files retain normal parallel execution; integration files use `--no-file-parallelism` because final-admin tests temporarily suspend other active administrators in the shared local database. Do not run integration suites concurrently. The deterministic `integration-admin-anchor@example.test` survives fixture cleanup, and temporary status changes are restored in `finally`. `npm test` does not include Playwright E2E or reset/start/stop Supabase. Integration tests require `.env.local` and the running local Supabase stack. The provisioning check also requires `psql` and uses the default local database URL, overridable with `LOCAL_SUPABASE_DB_URL`. The recovery and account integration tests use the local Supabase CLI service-role key (or `LOCAL_SUPABASE_SERVICE_ROLE_KEY`) to create test fixtures and set suspension; application account reads run with a user-scoped client:

```bash
npm run test:unit
npm run test:components
npx vitest run tests/components/auth-forms.test.tsx
npx vitest run tests/unit/flash-messages.test.ts tests/components/query-flash-messages.test.tsx
npm run test:integration
npm test
npx eslint src/app/layout.tsx 'src/app/(auth)/actions.ts' src/components/query-flash-messages.tsx src/lib/auth src/lib/flash-messages.ts tests/unit tests/integration
supabase test db --local supabase/tests/database
```

Playwright auth journeys live in `tests/e2e/`. They use the real Next.js application at `http://localhost:3000`, local Supabase at `http://127.0.0.1:54321`, and Mailpit at `http://127.0.0.1:54324`. Have the local Supabase stack, `.env.local`, the Supabase CLI (or `LOCAL_SUPABASE_SERVICE_ROLE_KEY`), and Google Chrome available. Local auth/E2E testing requires PostgREST 16.3 or later. PostgREST 16.2 has an intermittent `PGRST303` JWT clock issue (`JWT issued at future`) that can reject valid authenticated requests; it was fixed in 16.3. If needed, pin `v16.3` in `supabase/.temp/rest-version` and restart Supabase with the data-preserving `supabase stop` and `supabase start` commands. That version file is local and ignored, so the repository does not currently enforce the minimum version. Playwright starts the application with `npm run dev` if it is not already running. Run only this suite with:

```bash
npm run test:e2e:auth
```

The three journeys cover signup through the actual Mailpit confirmation link and `/auth/callback` through `/account` to `/profile`; forgot-password through the actual Mailpit recovery link and `/auth/callback` to reset and subsequent sign-in; and unauthenticated account redirect, login, account access, logout, and renewed redirect. Each journey creates a unique test user. The recovery journey checks the `/forgot-password` destination after the notice is consumed, follows the recovery link to `/reset-password`, submits a new password, and signs in with it. The signup journey checks the account profile and empty role list after confirmation.

## Profile coverage

`tests/unit/profile/` covers personal/tennis validation, session-owned explicit mutations, active-account requirements, system-field rejection, image signatures/size, avatar compensation, and authenticated image delivery. `tests/components/profile-forms.test.tsx` covers inline errors, retained values, pending feedback, read-only rating, and avatar controls. Page and navbar component tests cover the consolidated Profile settings and removal of separate Account navigation.

`tests/integration/profile/profile.integration.test.ts` exercises real application saves and RLS; missing profile schema fails validation instead of skipping the test. `tests/integration/profile/avatar.integration.test.ts` separately exercises access/input rejection, authenticated image retrieval, and real Storage upload/replacement/removal. Only the request-cookie client factory is substituted for endpoint tests. `supabase/tests/database/profiles.sql` covers personal/player/Storage boundaries and the application-owned player timestamp contract; run it together with the existing auth/RBAC pgTAP suite after the revised migrations are installed. Do not reset Supabase without explicit approval. Existing test fixtures do not automatically create player profiles.
