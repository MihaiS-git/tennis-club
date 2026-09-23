# Authentication testing

Focused automated coverage includes callback decisions, mandatory-confirmation signup decisions, application-profile/default-role provisioning through authenticated RLS, auth validation/action state, current-password verification, production `APP_URL` safety, and flash-query cleanup.

Run the focused checks with:

```bash
node --test --experimental-strip-types src/lib/auth/auth.test.ts src/lib/flash-messages.test.ts
node --env-file=.env.local --test --experimental-strip-types src/lib/auth/password-change.integration.test.ts
npx eslint src/app/layout.tsx 'src/app/(auth)/actions.ts' src/components/query-flash-messages.tsx src/lib/auth src/lib/flash-messages.ts src/lib/flash-messages.test.ts
```

Real email-flow validation still requires the local Supabase stack and Next.js application. Use a brand-new unique email, inspect the generated message and URL in Mailpit at `http://127.0.0.1:54324`, and verify both flows:

- signup reaches `/signup/check-email`, has no session before confirmation, cannot access `/account`, then establishes a session through `/auth/callback` only after the confirmation link is followed;
- recovery email returns through `/auth/callback?next=/reset-password`, permits the password update, and the new password can sign in.

Also verify redirect success/error messages appear in the bottom-right Sonner toaster and that only `message`/`error` are removed from the URL.
