# Authentication security configuration

## Local development

The repository's `supabase/config.toml` configures:

- Next.js application origin: `http://localhost:3000`;
- local Supabase API: `http://127.0.0.1:54321`;
- confirmation callback: `http://localhost:3000/auth/callback`;
- recovery callback: `http://localhost:3000/auth/callback?next=/reset-password`;
- mandatory email confirmation;
- local email capture in Mailpit at `http://127.0.0.1:54324`.

Mailpit is part of the local Supabase stack only. It is not used by production.

## Production

`APP_URL` is the canonical production application origin. Callback URLs are derived from it, and the application fails rather than silently using localhost when `APP_URL` is missing in production. Do not commit SMTP credentials or other production secrets.

The hosted Supabase project must be configured manually in the Supabase Dashboard because `supabase/config.toml` controls the local stack only:

- set **Site URL** to the production application origin;
- add `https://<production-domain>/auth/callback` and the recovery callback with `?next=/reset-password` to **Redirect URLs**;
- enable **Confirm email** for email/password signup;
- configure a production SMTP provider or the intended hosted Supabase email delivery service.

Confirmation and recovery must continue through `/auth/callback`; `/auth/confirm` is not used.
