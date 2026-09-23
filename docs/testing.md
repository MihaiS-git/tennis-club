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

Real email-flow validation still requires the local Supabase stack and Next.js application. Use a brand-new unique email, inspect the generated message and URL in Mailpit at `http://127.0.0.1:54324`, and verify both flows:

- signup reaches `/signup/check-email`, has no session before confirmation, cannot access `/account`, then establishes a session through `/auth/callback` only after the confirmation link is followed;
- recovery email returns through `/auth/callback?next=/reset-password` (email delivery and callback wiring are manual checks; token verification, password update, and new-password sign-in are automated).

Also verify redirect success/error messages appear in the bottom-right Sonner toaster and that only `message`/`error` are removed from the URL.
