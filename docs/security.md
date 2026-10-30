# Security

## Security model

Next.js is the complete primary application authorization boundary. Application tables are reached only through server-side TypeORM; browser roles have no application-table grants and no application RLS policies exist. Supabase Auth and private Storage retain their native security, including Storage RLS.

Authorization must not rely only on:

- hidden UI;
- disabled buttons;
- client-provided roles;
- client-provided ownership identifiers.

The browser must never be authoritative for:

- prices;
- discounts;
- roles;
- membership entitlements;
- credits;
- booking availability;
- payment status;
- refund amounts;
- rating changes.

Treat client-controlled data as untrusted input.

## Authentication and application users

Supabase owns:

```text
auth.users
```

The application-owned account and optional personal/contact record is:

```text
public.users
```

Database provisioning creates the application user with no role assignments for email-based Auth users and synchronizes relevant Auth identity changes.

Fixed roles:

```text
admin
coach
```

Both elevated roles are optional. Normal authenticated accounts have no roles; ordinary access requires a valid active application account. Future club membership is a separate business concept.

## Role and status administration

Ordinary users cannot assign roles or change account status. Next.js Admin services
validate verified actors and self-management restrictions, then serialize authoritative
role/account facts in TypeORM transactions. TypeScript rejects loss of the final active
Admin and explicitly persists assignment attribution and user timestamps. Suspended
accounts cannot receive active authorization. No role/status policy triggers are installed.

## Database permissions

Application tables are accessed only by the trusted server TypeORM connection.
Anon/authenticated have no table, column or sequence grants. The integration migration
also revokes public-schema default grants for its owner and `postgres`, and no application
RLS policies are installed. Next.js is the application authorization boundary: private
reads require explicit verified owner filters and public reads enforce parent visibility.
New private tables must preserve these grant restrictions. Native Supabase Auth and
private Storage retain their own security; no browser table access is restored for avatars.

The development rebuild recreates `public` with Supabase's stock usage-only schema ACL,
so effective schema, table, sequence and function privileges match the isolated test
database. Default-privilege entries still differ: `DROP SCHEMA` removes schema-scoped
entries, so the rebuilt schema lacks the stock `supabase_admin` and `postgres` function
defaults. The stock `supabase_admin` entry grants browser roles everything on objects that
role creates in `public`; `postgres` cannot alter it. It stays harmless because migrations
run as `postgres` and `supabase_admin` (image initialization, Realtime, Analytics) creates
no `public` objects. `migration-cutover.integration.test.ts` requires `postgres` ownership
of every `public` object, no global or `public` browser defaults for it, and a rolled-back
probe table without browser grants. Every application function's grants are set
explicitly by migrations, because PostgreSQL's built-in default grants `PUBLIC` EXECUTE on
new functions and a schema-level revoke cannot remove it.

## Public and private player data

Keep tennis information in `public.player_profiles` separate from sensitive account/personal/contact information in `public.users`. Player profiles are readable by active authenticated users, never anonymous users. Suspended accounts do not receive player-profile reads or mutations. Rating is system-managed and never accepted from form input. Owners cannot target another user or change ownership. Coach profiles are a separate public sibling domain (see `coaching.md`); membership remains separate from RBAC.

Tennis data visible to active authenticated users: display name, rating, Sportya level and tennis preferences. Private data: contact information, account information and booking contact snapshots. Server read projections select explicit columns for each audience.

## Player avatar storage

`profile-avatars` is private, with active-user reads and owner-only writes to the sole canonical `<user-id>/avatar.webp` path; the bucket accepts only `image/webp`. Next.js preserves JPEG/PNG/WebP validation, the 5 MiB input limit and Sharp normalization. Verified active owners alone mutate their existing profile; active Admins may retrieve a requested target's avatar but cannot mutate it. TypeORM reads references and navigation metadata and rechecks the active owner/profile inside short mutation transactions; persisted paths must exactly match the owner/target canonical path. Auth and Storage remain user-scoped Supabase operations under unchanged policies. Secure GET retains 401/403/404/503, private no-store and nosniff responses. No public/signed URLs or browser Supabase access is introduced. No runtime avatar lease or replacement backup remains; first uploads use best-effort cleanup on DB failure, removal clears DB before best-effort Storage deletion, and non-atomic Storage/database outcomes can leave rare orphans or ambiguous races.  See `profiles.md`.

## Supabase clients

The user-scoped server client (request cookies) verifies Auth identity and performs private
Storage operations under Storage RLS. Application persistence uses TypeORM after Next.js
authorization; there is no browser Supabase client and no PostgREST/RPC persistence path.

Supabase secret/service-role credentials are used only by guarded local seed and test
fixtures, which reject non-local targets and production. No production code path uses them:
checkout, Stripe webhooks, settlement and refunds use TypeORM. Never expose such credentials
to browser code, public environment variables, logs or responses.

Webhook and Cron endpoints authenticate separately: Stripe signature verification on the raw
body, Bearer secrets for `/api/notifications/deliver`, `/api/payments/holds/expire` and the
Brevo webhook.

## Environment variables

Current server-side Supabase variables:

```env
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
```

The current architecture intentionally does not expose them through `NEXT_PUBLIC_*` because there is no direct browser Supabase client.

If direct browser access is introduced later, expose only the browser-safe values actually required for that feature.

`APP_URL` is the canonical server-side application origin for authentication redirects. Production requires it; the application must not silently fall back to localhost there.

## Email confirmation and recovery configuration

Local `supabase/config.toml` uses `http://localhost:3000` for the application, `http://127.0.0.1:54321` for the Supabase API, and Mailpit at `http://127.0.0.1:54324` for captured Auth email. Signup requires email confirmation. Confirmation and recovery both return through `/auth/callback`; recovery uses `?next=/reset-password`. Mailpit is local only.

For hosted Supabase, set the production Site URL and allowed callback URLs, enable email confirmation, and configure production email delivery in the Supabase Dashboard. The local config does not configure hosted Auth. Do not commit email transport credentials or other secrets.

## Validation

Treat external input as untrusted.

Use Zod where appropriate for:

- forms;
- Server Actions;
- Route Handlers;
- query parameters;
- provider payloads after provider verification;
- domain operation boundaries.

Validation does not replace authorization.

Prevent mass assignment: explicitly select fields that a caller is allowed to change.

## Error handling

Do not expose raw:

- database errors;
- Supabase errors;
- Stripe errors;
- stack traces;
- internal implementation details.

Log enough context for diagnosis without logging:

- credentials;
- raw authentication tokens;
- payment-sensitive data;
- unnecessary personal information.

Server logs should contain selected safe fields only. Never log passwords, FormData, Supabase sessions, tokens, cookies, Authorization headers, or complete user/auth objects. The Pino logger redacts common sensitive property names as a secondary safeguard; redaction does not make logging those objects safe.

## Audit trail

Sensitive administrative or financial operations must be auditable. Current records:
role-assignment attribution, `payment_provider_changes`, booking revisions (actor scope and
time), direct-reservation creator/canceller, refund executions, provider event receipts and
immutable `booking_financial_exceptions`. New sensitive operations must make it possible to
determine:

```text
who
did what
to which entity
when
```
