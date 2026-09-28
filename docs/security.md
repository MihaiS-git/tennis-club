# Security

## Security model

Supabase Row Level Security is a primary application security boundary.

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

Ordinary authenticated users cannot assign or revoke roles or change account status. Active administrators may insert/delete role assignments and update another account’s `status` through the user-scoped client. Active owners may update only their own permitted personal/contact fields. Column grants and field-specific security triggers keep these UPDATE policy boundaries separate; identity/email/timestamps remain unavailable for direct updates. The role-assignment trigger records the actual authenticated administrator as `assigned_by`.

A suspended user may retain role rows but must not receive active admin authorization.

Database triggers protect the final active administrator against suspension or admin-role revocation. RLS prevents self-status changes and self-admin assignment/revocation. Initial administrator assignment requires a trusted database operation.

## RLS expectations

Typical boundaries:

- members can access their own private data;
- members cannot access another member's private data;
- members can manage only permitted bookings;
- coaches can manage their own availability;
- coaches can access sessions assigned to them;
- admins can manage club resources according to role;
- player-profile tennis data is visible only to active authenticated users;
- account/payment/private information remains restricted.

When adding a private or user-owned table, design its RLS policies as part of the same change.

## Public and private player data

Keep tennis information in `public.player_profiles` separate from sensitive account/personal/contact information in `public.users`. Player profiles are readable by active authenticated users, never anonymous users. Suspended accounts do not receive player-profile reads or mutations. Rating has no authenticated INSERT/UPDATE grant. Owners cannot target another user or change ownership. Future coach profiles are a separate sibling domain; membership remains separate from RBAC.

Tennis data for active authenticated users:

- display name;
- rating;
- ranking;
- match statistics;
- rating history (future);
- optional tennis preferences.

Private data:

- contact information;
- billing metadata;
- account information;
- private preferences.

This separation matters because PostgreSQL RLS primarily controls rows, not arbitrary per-column visibility.

## Player avatar storage

`profile-avatars` is private, with active-user reads and owner-only writes to `<user-id>/avatar.jpg`, `.png`, or `.webp`. Next.js validates MIME, signature and a 5 MiB maximum before upload. The authenticated `/profile/avatar` endpoint checks active account status and downloads the current user’s image on the server, with private, no-store response headers. No browser-to-Supabase access or privileged application client is used. See `profiles.md` for compensation and failure limitations.

## User-scoped Supabase client

Use the authenticated user session for normal application operations.

RLS remains active.

This is the default access mode.

## Privileged Supabase client

A privileged client bypasses normal RLS protections.

Use it only for trusted system workflows that genuinely require elevated access, such as:

- Stripe webhook synchronization;
- controlled server-side synchronization;
- narrowly scoped system operations.

Introduce `SUPABASE_SECRET_KEY` only when such a workflow exists.

Never expose it to:

- browser code;
- Client Components;
- public environment variables;
- logs;
- responses.

Server execution alone is not a reason to use privileged access.

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

Sensitive administrative or financial operations should be auditable.

Examples:

- role changes;
- manual booking changes;
- cancellations;
- refunds;
- membership overrides;
- rating adjustments.

Audit data should make it possible to determine:

```text
who
did what
to which entity
when
```
