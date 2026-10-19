# Booking email notifications

Booking confirmations, cancellations and rescheduling retain their immutable booking
revisions. Financial exceptions additionally retain a focused immutable
`booking_financial_exceptions` fact: stable identity, occurrence time, original revision
and relevant payment/refund/adjustment references. Those references supply historical
contact, schedule, amount and currency; no current account email is substituted.
Financial transactions never render email, write notification projections or contact
Brevo. Failure to persist financial evidence still fails its financial transaction;
email construction and projection failures cannot affect financial state.

A unique event key identifies each revision notification, failed-modification payment,
late-payment refund or refund exception. Insert-on-conflict prevents duplicate records
during recovery retries and concurrent scheduler calls. A rolled-back financial
transition has no committed source to reconstruct. A paid modification's accepted
revision is its single successful-reschedule source.

The existing scheduler first reconstructs missing projections, then delivers due rows.
Each event is projected in its own transaction, serialized by event key. Rendering or
persistence failure is logged and leaves the immutable source eligible for a later
pass; other events continue. Migration `1791462257936-FairNotificationRecovery` adds
a single persisted circular scan position: selection advances before projection, so
failed events stay retryable without holding every later event behind the oldest batch.
Existing rendered snapshots are never overwritten. Missing
inbox copies are repaired from the retained delivery snapshot, including its financial
acknowledgment. Repair and acknowledgment lock delivery before inbox, with fresh
READ COMMITTED statements after lock acquisition. Existing inbox read/deletion/
acknowledgment timestamps remain unchanged.
Brevo HTTP calls run outside database transactions with a five-second timeout, using
five-minute leases, SKIP LOCKED claims and stable submission keys. Booking, payment,
webhook, cancellation, rescheduling and refund requests never deliver mail. Explicit
Admin Retry remains available for undismissed rows.

## Forward-only cutover

Apply additive migration `1791462257935-IndependentNotificationEvidence` before deploying
the new writers and scheduler. Only revisions/adjustment requests explicitly written
with `recovery_version=1`, and exceptions recorded by the new mechanism, participate.
Existing rows have NULL versions; there is no historical backfill or timestamp-based
inference. Legacy deliveries/inbox entries remain untouched, and physically deleted
legacy emails are not reconstructed. New financial outcomes on old bookings can opt in
through a new revision or new exception fact.

All future Admin email deletion is permanent soft dismissal using `dismissed_at`, for
ordinary as well as financial mail. The retained event key prevents recreation and
resending; projection repair can still restore a missing customer inbox copy. Dismissal
does not acknowledge or delete the customer's notice. No new queue or scheduler is used.

Every attempt records its exact outcome in `last_error`: `null` with `delivered_at` when
Brevo accepted it (not proof of inbox delivery; see [Brevo delivery webhook](#brevo-delivery-webhook)), `rejected` when Brevo refused it
permanently (HTTP 4xx other than 408/429), `unavailable` for a temporary Brevo error
(408, 429 or 5xx; not sent), `unconfirmed` when Brevo did not answer (it may have been
sent), and `not_configured` when `BREVO_API_KEY`/`BOOKING_MAIL_FROM` are missing. Nothing
is skipped silently.

## Scheduled retries (Supabase Cron)

For a quiet club, a failed guest confirmation must not wait for the next booking. Supabase
Cron (`pg_cron`) runs every five minutes and `pg_net` POSTs to
`/api/notifications/deliver`, authenticated with `Authorization: Bearer
<NOTIFICATION_CRON_SECRET>`, a dedicated server-to-server secret (32+ characters,
compared in constant time). The Route Handler calls `recoverBookingNotifications()`
(up to 100 missing projections/repairs), then `deliverPendingBookingNotifications()`
(up to 10 emails). Recovery gets eight seconds of the 25-second invocation budget,
reserving time for delivery even when discovery fails. Recovery uses a separate
one-connection TypeORM pool with 500 ms connection/statement timeouts and a 250 ms
lock timeout; it cannot occupy the delivery pool. `maxDuration` remains 60 s. Concurrent cron
runs and explicit Admin retries share leases and SKIP LOCKED claims. It
returns 200 with `{ checked, failed }`, 401 for a missing/wrong secret, and 503 when the
secret is not configured, reconstruction failed, or delivery was interrupted (delivery
is still attempted after recovery failure; pg_net simply tries again five
minutes later). Logs contain counts only, never recipients, content or credentials.
The endpoint reads committed financial evidence but never mutates payments, refunds,
booking lifecycle or expiry. All business logic stays in TypeScript; PostgreSQL
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

## Brevo delivery webhook

API acceptance (`delivered_at`) is not delivery. `POST /api/notifications/brevo` receives
Brevo's transactional email webhook and records, per delivery row, Brevo's evidence for the
**current submission** (migration `1791462257932-BrevoDeliveryEvents`): `provider_message_id`
(the `messageId` Brevo returned on acceptance), `provider_status` (`deferred`, `delivered` or
`failed`), `provider_event`, `provider_reason` and `provider_event_at`. `submission_key`
(NULL = the row id) is the Brevo idempotency key and is also sent as `X-Mailin-custom:
booking-notification:<key>`, which Brevo echoes in every event.

Delivery states: accepted, awaiting confirmation (`delivered_at` set, no provider status, or
`deferred`); confirmed delivered (`delivered`); delivery failed (`soft_bounce`, `hard_bounce`,
`invalid_email`, `blocked`, `error`); queued/sending/retrying/stopped as before for API-level
outcomes. `deferred` is a temporary delay Brevo keeps retrying and never raises an alert.

- **Correlation**: by recorded `message-id`; before the API answer is recorded, by the
  current submission key from `X-Mailin-custom`. Never by recipient or booking. Anything
  else (earlier submissions, dismissed rows, other senders) is "unknown", acknowledged with
  200 and ignored; webhooks never create or restore a row.
- **Ordering** (TypeScript, `brevo-events.ts`): a final outcome (delivered/failed) replaces a
  deferral; between final outcomes only a strictly later event time (`ts_epoch`, else
  `ts_event`/`ts`) wins; a deferral never replaces a final outcome. Duplicates change nothing.
  Each event runs in its own short transaction with the row locked; no network I/O inside.
- **Failure**: the row becomes undelivered with `last_error` = the Brevo event,
  `next_attempt_at = 'infinity'` (never resent automatically), state `failed` ("Delivery
  failed") in Admin → Payments → Notifications with the failure type, Brevo reason and time.
  It activates the Admin bell like a stopped row. Customer inbox copies are unaffected.
- **Retry now** claims the row with the existing lease and gives the new submission a new
  key, so Brevo cannot deduplicate it into the bounced message and the old message's late
  events no longer match. Accepted again, it returns to "awaiting confirmation" (not listed,
  no alert) until Brevo confirms; another failure reactivates the alert.
- **Delete** (dismiss) is allowed for `failed` rows exactly like stopped rows; later events
  for the dismissed message are unknown. Every email row is only marked
  `dismissed_at` (hidden from the Admin list and bell, never sent again); the customer's
  banner, inbox copy and **OK** acknowledgement are unchanged. Deleting never acknowledges
  an exception or changes bookings, payments or refunds.
- An event that arrives while the submission is still being recorded wins over the API
  result; only the lease is released.

Authentication: `BREVO_WEBHOOK_SECRET` (32+ characters, constant-time comparison), as
`Authorization: Bearer <secret>` (webhook `auth` of type `bearer`) or as the basic-auth
password (`https://brevo:<secret>@<host>/api/notifications/brevo`). Responses: 200 with
counts, 401 wrong/missing credentials, 400 invalid payload, 413 over 1 MB, 503 not
configured, 429 when processing failed (Brevo retries only timeouts and 429). Logs contain
counts only, never recipients, reasons or payloads.

Limitation: when Brevo answers a retry with its idempotency duplicate response it returns no
`messageId`; such a row stays "awaiting confirmation" unless the event carries the matching
`X-Mailin-custom` key, which Brevo includes for messages sent with it.

### Configuring the webhook in Brevo

1. Generate a secret (`openssl rand -hex 32`), set `BREVO_WEBHOOK_SECRET` in the server
   environment (Vercel project settings / `.env.local`) and redeploy. Apply migration
   `1791462257932-BrevoDeliveryEvents` first.
2. Create a **transactional** webhook. With the API (bearer token, preferred):
   `curl -X POST https://api.brevo.com/v3/webhooks -H "api-key: $BREVO_API_KEY"
   -H 'Content-Type: application/json' -d '{"type":"transactional","description":"Tennis Club
   delivery","url":"https://<your-domain>/api/notifications/brevo","events":["delivered",
   "softBounce","hardBounce","invalid","blocked","deferred"],
   "auth":{"type":"bearer","token":"<BREVO_WEBHOOK_SECRET>"}}'`.
   In the Brevo UI (Transactional → Settings → Webhook → Add a new webhook) use the URL
   `https://brevo:<BREVO_WEBHOOK_SECRET>@<your-domain>/api/notifications/brevo` and tick
   Delivered, Soft bounce, Hard bounce, Invalid email, Blocked and Deferred (and Error where
   offered; the API has no separate subscription for it, but `error` events are handled).
3. Check: an unauthenticated `curl -X POST https://<your-domain>/api/notifications/brevo`
   returns 401; Brevo's webhook test / a real send returns 200 (`{"applied":…}`).
   For local development expose the dev server through an HTTPS tunnel; Brevo cannot reach
   `localhost`.

Emails accepted before this change have no recorded `messageId` or `X-Mailin-custom`; their
events are unknown and ignored.

## Undelivered email visibility and retry

Admin → Payments → **Notifications** lists every booking email Brevo has not accepted, or
accepted and then reported undeliverable,
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

Every customer email event also has a durable in-app copy for the booking’s associated
account. Admins see every failed email, including guests’, in Admin → Payments → Notifications.

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
refund request; it says the refund was requested, never that it completed. Changes
whose every obligation definitively fails retain a rejected cancellation/
modification fact in the final refund-result transaction, before later change resolution.
Resolution reuses the same adjustment event key and cannot create a second rejection.
Refund obligations of a pending refund-backed cancellation or price reduction whose provider
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
schedule, automatic reconstruction and delivery stop; financial requests do not provide
a fallback. Explicit Admin Retry can submit an existing undismissed delivery.
Application-table browser grants remain denied.


## Persistent customer inbox

Migration `1791462257931-CustomerNotificationHistory` adds `customer_notifications` and
backfills retained deliveries, including existing financial acknowledgments. Already
removed email records cannot be recovered. Supabase Auth confirmation/recovery emails
remain provider-managed and separate from these application-generated customer events.

Scheduled recovery renders each missing message and inserts its email delivery and
customer copy in a projection transaction, independently of financial processing. It
covers `confirmed`, `customer_cancelled`, `admin_cancelled`, `customer_rescheduled`,
`cancellation_failed`, `modification_failed`, `refund_incomplete` and `late_payment_refund`.
The inbox stores subject, complete text, event kind, booking UUID and generation timestamp.
Only the booking’s non-null `account_user_id` associates an owner; email addresses never
establish ownership. Guests remain email-only.

The inbox has a unique event key and no foreign key to delivery records. Retries do not
write inbox rows. Replays, including after Admin delivery deletion, cannot duplicate or
replace the original inbox snapshot. User deletion sets `deleted_at`, retaining the event
key and financial acknowledgment history. It never deletes deliveries, bookings, payments
or refunds. Application table grants deny direct browser access.

My Activity → Notifications searches subjects and message bodies across all visible
history, with a 350ms debounce, read/unread and event filters, newest/oldest ordering,
and server-side pages of 25. URL parameters preserve controls between pages. Each row
shows its type, preview, timestamp and read state. Each subject links to
`/my-activity/notifications/[notificationId]`, displaying the complete subject/message,
type, creation time, read state and booking reference. Back to Notifications preserves
search, filters, sort and page. Opening the inbox or details does not change read state;
the explicit read/unread action controls it. Missing, deleted and foreign IDs show the
same unavailable message. Details reuse the inbox mutation service and confirmed deletion.
Individual and page-selection bulk actions support read,
unread and inbox deletion; deletion requires confirmation. All queries and updates are
restricted to the active verified account UUID. Read messages remain in history.

Unresolved financial alerts remain separately visible above the inbox, even when their
copy is filtered, read or deleted. Reading/deleting is never financial acknowledgment.
Only **OK** acknowledges the operational record and its inbox copy atomically. Marking
an acknowledged notification unread does not reopen the financial exception.

Authenticated navbar controls include a Lucide bell beside the desktop profile and
immediately beside the mobile hamburger, outside the drawer. Both share one client
unread store and display a green dot when unread inbox copies exist. The private,
non-cached `GET /api/notifications/unread` endpoint returns only a boolean, using an
owner-filtered TypeORM EXISTS query after active-account authorization. The store loads
on mount, refreshes on focus/visibility restoration and successful inbox/acknowledgment
actions, and polls every 60 seconds while visible. Hidden tabs stop polling; unmounting
the last bell removes timers/listeners and clears state. Failed requests retain the last
known value until the next refresh. No WebSockets or Supabase browser access is used.
