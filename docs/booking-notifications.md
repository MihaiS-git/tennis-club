# Booking email notifications

Booking confirmations, cancellations, rescheduling and financial exceptions persist
rendered email work in `public.booking_notification_deliveries` in the same TypeORM
transaction as the corresponding state change or verified financial observation.
The immutable revision supplies the booking contact, schedule, price and historical
names. The current account email is never substituted. Direct reservations and
Supabase Auth email remain separate.

A unique event key identifies each revision notification, failed-modification payment,
late-payment refund or refund exception. Insert-on-conflict prevents duplicate records
during retries, webhook replay and concurrent requests. A rollback also removes its
provisional email. A successful paid modification queues its revision email in the shared
command only; settlement does not queue it a second time.

The request that committed the state change delivers after commit: payment settlement
(signed webhook, checkout status poll, checkout cancellation), refund processing (request
thread, signed Stripe refund webhook, Admin "Check with Stripe"), customer/Admin
cancellation, rescheduling and Pay-at-club booking all call
`deliverPendingBookingNotifications()` once their transaction has committed. Each call
claims up to 10 due rows within an eight-second budget, using five-minute leases and row
locks with SKIP LOCKED, so concurrent requests never submit one row twice; it also drains
earlier rows that are due. Brevo HTTP delivery happens outside all database transactions,
with a five-second timeout. Accepted submissions are acknowledged using the lease token.
No customer message can be sent before its financial transaction commits, and delivery
never throws into the committed operation.

Every attempt records its exact outcome in `last_error`: `null` with `delivered_at` when
Brevo accepted it (not proof of inbox delivery), `rejected` when Brevo refused it
permanently (HTTP 4xx other than 408/429), `unavailable` for a temporary Brevo error
(408, 429 or 5xx; not sent), `unconfirmed` when Brevo did not answer (it may have been
sent), and `not_configured` when `BREVO_API_KEY`/`BOOKING_MAIL_FROM` are missing. Nothing
is skipped silently.

## Scheduled retries (Supabase Cron)

For a quiet club, a failed guest confirmation must not wait for the next booking. Supabase
Cron (`pg_cron`) runs every five minutes and `pg_net` POSTs to
`/api/notifications/deliver`, authenticated with `Authorization: Bearer
<NOTIFICATION_CRON_SECRET>`, a dedicated server-to-server secret (32+ characters,
compared in constant time). The Route Handler only calls the same
`deliverPendingBookingNotifications()` with one bounded batch (10 emails, 25-second
budget, `maxDuration` 60 s), so concurrent cron runs and request-driven delivery share
the same leases and SKIP LOCKED claims and never send one row at the same time. It
returns 200 with `{ checked, failed }`, 401 for a missing/wrong secret, and 503 when the
secret is not configured or delivery was interrupted (pg_net simply tries again five
minutes later). Logs contain counts only, never recipients, content or credentials.
The endpoint is for notification delivery only: it never touches payments, refunds,
reconciliation or booking expiry. All business logic stays in TypeScript; PostgreSQL
only schedules the HTTP call.

Retry policy: a temporary failure (`unavailable`, `unconfirmed`, `not_configured`) is
retried with exponential backoff (2, 4, 8, 16, 32, then 60 minutes) for at most
`maxAutomaticDeliveryAttempts` (8) attempts, spread over about three hours. A permanent `rejected`
answer is not retried automatically. A stopped row (permanent or exhausted) keeps
`delivered_at` empty and `next_attempt_at = 'infinity'`, stays in Admin → Payments →
Notifications as "Stopped; retry manually", and is never picked up by cron again. Rows
Brevo accepted are never resent. Guest notifications are delivered the same way.

### Configuration

The endpoint URL and the secret are stored in Supabase Vault (`notification_cron_url`,
`notification_cron_secret`); the scheduled SQL command reads them at run time and contains
no credential. `scripts/configure-notification-cron.ts` creates `pg_cron`/`pg_net` if
needed, upserts both Vault secrets and (re)schedules job `booking-notification-delivery`
idempotently. It refuses test ports and the test Docker hostname, rejects connection-string
query overrides (only `sslmode=require` or `verify-full` is accepted), and requires the
direct database host to match `SUPABASE_URL`. Local setup accepts only the development
ports 54321/54322 and verifies the connected server's PostgreSQL system identifier
against `supabase_db_tennis-club` through Docker before any operation. Hosted setup uses
certificate-verified TLS and checks database/user plus native Auth/Storage schemas.
Unverified targets fail closed, including `--check`, `--status` and `--remove`.
Tests call the endpoint directly instead. Inputs come from the environment, never from source or migrations:

- `SUPABASE_URL`: the intended project origin (also required by the application);
- `CRON_DATABASE_URL` (empty/unset defaults to `DATABASE_URL`): direct Postgres URL of that same project;
- `NOTIFICATION_CRON_URL`: full endpoint URL as reachable **from the database**;
- `NOTIFICATION_CRON_SECRET`: the same value the Next.js server uses.

Local development (existing Supabase Docker stack, no reset or restart needed): add
`NOTIFICATION_CRON_SECRET=<openssl rand -hex 32>` and
`NOTIFICATION_CRON_URL=http://host.docker.internal:3000/api/notifications/deliver` to
`.env.local` (inside the database container `localhost` is the container itself;
`host.docker.internal` maps to the host gateway in Supabase's containers). Run Next.js
listening on all interfaces (`npm run dev -- -H 0.0.0.0`), then:

```bash
npm run notifications:cron              # schedule or update
npm run notifications:cron -- --check   # one immediate pg_net request; expects HTTP 200
npm run notifications:cron -- --status  # job, recent runs and pg_net response codes
npm run notifications:cron -- --remove  # unschedule and delete the Vault secrets
```

Connectivity can also be checked directly from the container:
`docker exec supabase_db_tennis-club curl -s -o /dev/null -w '%{http_code}' -X POST
http://host.docker.internal:3000/api/notifications/deliver -H 'Authorization: Bearer wrong'`
must print `401`.

Hosted Supabase and Vercel: set `NOTIFICATION_CRON_SECRET` in the Vercel project
environment and redeploy. Enable `pg_cron` and `pg_net` (Database → Extensions; the script
also creates them when permitted). Run the script once from a trusted machine with the
project's direct connection string (Settings → Database), for example
`SUPABASE_URL=https://<ref>.supabase.co
CRON_DATABASE_URL='postgresql://postgres:…@db.<ref>.supabase.co:5432/postgres'
NOTIFICATION_CRON_URL=https://<your-domain>/api/notifications/deliver
NOTIFICATION_CRON_SECRET=… node --import=./scripts/ts-loader.mjs scripts/configure-notification-cron.ts`,
then `--check`. Rotating the secret means updating Vercel, redeploying and re-running the
script. If you prefer the SQL editor, use `vault.create_secret(...)` for both names and
`cron.schedule('booking-notification-delivery', '*/5 * * * *', …)` with the same command
the script uses. Recent results: `cron.job_run_details` and `net._http_response`.

## Undelivered email visibility and retry

Admin → Payments → **Notifications** lists every booking email Brevo has not accepted,
with recipient, subject, booking, status, attempt count and next retry time (or "Stopped;
retry manually"), and marks financial exceptions. It is paginated on the server (25 per
page, `?page=N`; invalid or out-of-range pages fall back to valid ones) in a stable order:
unacknowledged financial exceptions first, then newest first, with the row ID as the
final tie-breaker. No number of ordinary failed emails can push an unacknowledged
exception off the first page. The header counts all undelivered emails and the
unacknowledged exceptions. **Retry now** (active Admin only) submits that one email
immediately, ignoring its backoff and any stopped state, with the same Brevo idempotency
key; a row another request is sending is left alone. The result shown is the recorded
outcome.

`listOwnFinancialNotices` still returns a signed-in owner's failed ordinary emails (up to
30 days) after their unacknowledged important notices, but the customer
`/my-activity/notifications` page shows only the important financial notices; ordinary
booking emails and delivery status are not shown to customers. Admins see every failed
email, including guests', in Admin → Payments → Notifications.

Each delivery UUID is passed as Brevo's `headers.idempotencyKey`. A matching provider
idempotency rejection acknowledges the original submission. Brevo documents a
[30-minute retention window](https://developers.brevo.com/docs/heterogenous-versions-batch-emails)
(older documentation specified 15 minutes); this implementation does not rely on
indefinite retention. After a timeout or a crash between acceptance and database
acknowledgement, a later retry can duplicate email once retention expires. The guarantee
is durable at-least-once submission attempts, with bounded provider deduplication,
not exactly-once email or guaranteed inbox delivery. Permanent email rejection remains
visible as an undelivered record and sanitized log; retries cannot fix an invalid
recipient or missing provider credentials.

Refund-backed cancellation and price reduction notify completion only after **every**
required refund succeeds. During partial refunds the original booking, revision and
reservation remain, and already successful refunds remain recorded. A permanently failed
obligation or unresolved provider evidence queues one `refund_incomplete` message per
obligation and stays visible for external resolution. A failed surcharge application
notifies that the original booking remains and its compensation is being refunded. A
payment captured after its checkout expired or was cancelled queues one
`late_payment_refund` message ("Payment received after checkout ended") with the full
refund request; it says the refund was requested, never that it completed. Refund
obligations of a pending refund-backed cancellation or price reduction whose provider
evidence is unresolved notify `refund_incomplete` at once (the change stays pending); a
refund Stripe fails after reporting success notifies `refund_incomplete` under its own
`refund:<id>:reversed` key. That cause is kept for every later check of the reversed refund
(Stripe webhook redelivery, Admin "Check with Stripe"), so a duplicate event never adds a
second `refund:<id>:exception` notice; definitive failures and unresolved evidence of a
refund share the single `refund:<id>:exception` key.

## Important in-app financial notices

`refund_incomplete`, `cancellation_failed`, `modification_failed` and
`late_payment_refund` rows are stored with `requires_acknowledgement` and the booking ID.
For bookings owned by an account they are shown on My activity → Notifications
(`/my-activity/notifications`) until the owner presses **OK**; the acknowledgement time is
persisted. A delivered email is not treated as acknowledgement. Ownership is checked on
the server in the conditional update (booking `account_user_id` = current active account);
another account's notice cannot be read or acknowledged. Guest bookings have no account,
so their notices are email-only (the checkout dialog shows the payment/refund outcome).

Deployment requires migrations `1791462257928-DurableBookingNotifications` and
`1791462257929-RequestDrivenPaymentRecovery`, `BREVO_API_KEY`, a verified
`BOOKING_MAIL_FROM`, `NOTIFICATION_CRON_SECRET` and the Supabase Cron schedule above. No
Node.js worker or queue runs; this works on serverless hosting such as Vercel. Without the
schedule, emails are still delivered by later requests and Admin retries, as before.
Application-table browser grants remain denied.
