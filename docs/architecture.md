# Authentication architecture

Authentication remains server-first through the Next.js App Router and the user-scoped Supabase server client.

An `AFTER INSERT` trigger on `auth.users` provisions the matching `public.users` row and default `member` assignment in the same database transaction. This happens before email confirmation; if either insert fails, the Auth user insert fails instead of leaving a partially provisioned account.

Signup follows this sequence:

```text
signup
→ Supabase creates an unconfirmed user without a session
→ /signup/check-email
→ confirmation email
→ /auth/callback
→ code exchange establishes the session
→ /account
```

The signup action never manually signs in the user and never treats the returned user object as proof of authentication. If Supabase unexpectedly returns a signup session, the action clears it and fails closed.

Password recovery follows the existing separate flow:

```text
forgot password
→ recovery email
→ /auth/callback?next=/reset-password
→ code exchange establishes a recovery session
→ /reset-password
→ password update
```

Redirect-based auth status messages use the global Sonner toaster. Field and form validation stays inline. After displaying a flash message, the client removes only the consumed `message` and `error` query parameters and preserves unrelated parameters.
