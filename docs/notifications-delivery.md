# Notification architecture and delivery

The application sends persisted `email_deliveries` through the Brevo transactional HTTP API. A successful API response records `accepted` or `sandbox_accepted`; it does not establish that a recipient received the email. Supabase Auth email configuration is separate.

## Events, recipients and persistence

`src/lib/notifications/events.ts` records booking confirmations, cancellations and
reschedules (court bookings and lessons), successful compensation refunds and relevant
financial exceptions. A staff operational change states its financial consequence in the
customer's reschedule message (unchanged price, club-absorbed difference, or reduced amount
due); a refund-backed reduction records `booking.change_refund_requested` with the requested
amount, then the reschedule message with the verified refund amount, or the existing
`modification_rejected`/`refund_failed` exceptions. Recording requires the caller-owned TypeORM domain transaction;
financial exception evidence and notification snapshots commit with the deciding state.
`record.ts` and `notifications.repository.ts` persist `user_messages` and `email_deliveries`;
stable event keys and per-recipient unique constraints deduplicate replay. No browser-role
application table grants are introduced. Reading/deleting a message never alters a booking,
payment, refund or delivery outcome.

Customer recipient resolution uses the contract's contact email and authoritative application
and Supabase Auth account facts. In-app customer messages require an active, email-confirmed
account with matching application and Auth emails; contact matching never grants booking
ownership. Eligible ordinary customers receive in-app plus email, guests receive email only.
An Admin/Coach match on either application or Auth email suppresses customer application
email, including when that staff account is inactive or unverified. Admin and Coach accounts
receive application notifications in-app only. Assigned active Coaches receive lesson
transition messages; a completed reassignment instead tells the replacement coach of the new
assignment and the previous coach that the lesson is no longer theirs. Coach messages carry
lesson details only, never the customer's prices, payments or refunds; active Admins receive financial exception and delivery-failure alerts.
`refund_unresolved` alerts are Admin-only; other relevant financial outcomes also notify
eligible customers. Supabase Auth confirmation/recovery mail follows its separate Auth setup.

The `/messages` inbox and `/messages/[messageId]` detail routes resolve the verified account
(including suspended accounts reading their existing messages) and filter every read,
read-state change and soft deletion by recipient ID. Stable
event keys preserve deduplication after deletion. Notifications are event snapshots, not
permission to view another account's booking; linked pages enforce their own authorization.

## Application configuration

Set server-only `BREVO_API_KEY`, `NOTIFICATION_EMAIL_MODE=live`, `NOTIFICATION_CRON_SECRET`, and `BREVO_WEBHOOK_SECRET` for manual local development and production. Use independent random values of at least 32 characters for the two Bearer secrets. The isolated automated test runners force sandbox mode even when `.env.local` selects live; live delivery is rejected in test processes and Vercel deployments without `VERCEL_ENV=production`. Sandbox requests include `X-Sib-Sandbox: drop` in the Brevo JSON `headers` object and send no real email. Configure the official email address and sender display name in Admin → Club (`/admin/club`) and enable transactional emails. No environment-defined sender is used. The sender must be authorized in Brevo; saving it validates syntax only. Configuration errors stop processing before any claim is taken. A separate `sandbox_accepted` status is never treated as live acceptance or replayed automatically.

For deliberate live local delivery, use `npm run dev`. A local production build
(`npm run build` followed by `npm run start`) sets `NODE_ENV=production`; live delivery
with a loopback `APP_URL` (`localhost` or `127.0.0.1`) is intentionally rejected with
`Live Brevo delivery is not permitted in this environment`. Use sandbox mode for
local production-build checks, and the real canonical HTTPS `APP_URL` in production.
Preflight configuration failures return HTTP 503 before claiming deliveries, so they
do not create per-delivery Admin failure alerts. The invocation log records the
exception message and stack under `err` with event `notifications.delivery_failed`.

The delivery endpoint is `POST /api/notifications/deliver` with `Authorization: Bearer <NOTIFICATION_CRON_SECRET>`. It takes at most 20 due/expired deliveries per call. Run it every five minutes. A lost response, timeout, malformed acceptance response or expired processing lease can mean Brevo accepted an email. These unresolved outcomes are never reclaimed for sending. Explicit HTTP rejections retain the existing bounded automatic retry schedule for transient errors (429/5xx); HTTP 408 is treated as unresolved. Delivery status is acceptance, not inbox receipt.

## Supabase Cron and pg_net

Install the notification tables through the authorized TypeORM migration workflow before enabling the job. Do not run the initial application migration against a populated remote database. Enable the Supabase Cron (`pg_cron`) and `pg_net` extensions for the target Supabase database. Configure `NOTIFICATION_CRON_URL` for the **Cron setup**: locally use `http://host.docker.internal:3000/api/notifications/deliver` while Next.js runs on port 3000; in production use `https://<production-domain>/api/notifications/deliver`. The application endpoint does not read this variable. When switching an existing local database from sandbox, set `NOTIFICATION_DELIVERY_NOT_BEFORE` to the current UTC ISO timestamp before starting live delivery. Earlier pending records remain untouched, including any created during sandbox development; accepted sandbox records are never claimed. Leave this setting empty on a fresh production database unless a deliberate cutover needs it.

For local Supabase, set the values in `.env.local` and run `npm run notifications:cron:local`. This guarded setup enables `pg_cron` and `pg_net`, stores the URL and Bearer secret in local Vault, and schedules the existing endpoint every five minutes. Re-running it updates the two local Vault values and the named job. Run Next.js on port 3000. The job does not send while the app is stopped; it resumes when the app is running. The local test database uses different ports and cannot be changed by this command.

In the SQL editor or a direct Postgres session for that database, store the URL and secret in Supabase Vault, then schedule the call. Substitute the actual values only in your private SQL session, never in source control. Vault is the supported secret store for hosted Supabase:

```sql
select vault.create_secret('<NOTIFICATION_CRON_URL value>', 'tennis_club_notification_cron_url');
select vault.create_secret('<NOTIFICATION_CRON_SECRET value>', 'tennis_club_notification_cron_secret');

select cron.schedule(
  'tennis-club-notification-delivery',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'tennis_club_notification_cron_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'tennis_club_notification_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $$
);
```

Use a separate local Supabase database and local secret for development. Confirm that the local database can reach `host.docker.internal:3000` and that the application is running. For production, use the production HTTPS URL and production secret in that database's Vault. If Vault is unavailable in the local stack, use the same `cron.schedule` statement with the local URL and Bearer secret literals in a private local SQL session; treat that local job definition as sensitive. Check `cron.job_run_details` and `net._http_response` for execution and HTTP results. Do not put the Cron secret in a public environment variable.

## Brevo terminal failure webhook

Create a Brevo **transactional email** webhook with URL `https://<production-domain>/api/notifications/brevo-webhook`, events `hardBounce`, `invalid`, and `blocked`, and Bearer authentication using `BREVO_WEBHOOK_SECRET` as its token (`auth: {"type":"bearer","token":"..."}`). Brevo emits payload event names `hard_bounce`, `invalid_email`, and `blocked`; the endpoint also accepts `invalid`. For local webhook testing, expose the local app through a reachable HTTPS tunnel and configure a separate test webhook/token. Other event types are ignored.

Each outbound message carries `X-Mailin-custom: email_delivery_id:<UUID>`. The webhook matches the provider message ID and recipient email, using the UUID for correlation when the provider ID is not yet stored. A terminal event marks the delivery failed and adds one in-app message per active Admin with event key `email.delivery-failed:<UUID>`. Sandbox-accepted records are excluded from webhook failure updates. The webhook does not send Admin email.

## Admin delivery review and manual retry

An active Admin opening an `email.delivery_failed` notification at `/messages/[messageId]`
sees the associated recipient, email type, current persisted status, error, attempt count,
latest delivery update and any scheduled automatic retry, with a link to Admin booking details.
The existing persisted `email.delivery-failed:<delivery-id>` event key is the association,
including for older UUID-only notifications. No message-body parsing is used. The schema
has no separate last-attempt timestamp; the UI explicitly labels the displayed time as the
latest recorded delivery update, which can also reflect a later webhook.

**Retry now** immediately claims only that delivery using the same claim/lease and HTTP
pipeline as Cron. An authoritative active-Admin check is fenced inside the claim transaction;
the Brevo request starts after commit. A definitive HTTP rejection without a provider ID
permits manual retry, including after the automatic attempt budget is exhausted. Attempts
continue increasing. Accepted, sandbox-accepted, processing, ambiguous and pre-cutoff
records cannot be resent; staff email suppression is rechecked. Existing alert event keys
continue deduplicating incident notifications, including after message deletion. Read/unread
and deletion do not resolve delivery failures or change booking/payment state.


## Club-wide email settings

Only active Admins may read or update `/admin/club`. One TypeORM-managed
`club_settings` record applies across all locations; it starts disabled with empty
sender fields. Saving requires a valid email and a trimmed sender name of 1–100
characters. Credentials remain exclusively in server environment variables.
The Admin-only test action sends directly to the authenticated Auth user's verified
email, with no booking/payment event or retry queue. It reports Brevo's actual rejection
or acceptance (including sandbox mode); acceptance never establishes inbox delivery.

Disabling email leaves in-app channels and Supabase Auth mail unchanged. Notification
recording takes a shared settings lock before enqueueing eligible customer/guest mail;
Admin changes take the exclusive singleton lock. Disable atomically marks pending,
processing and failed rows with `suppressed_at`, retaining their content/status and
provider evidence. Cron and manual claims exclude that marker permanently. Re-enabling
never clears it. Every dispatch rechecks current settings and suppression after claim,
using the saved official address and sender name. Already in-flight HTTP requests can
complete; their acceptance/failure evidence is retained and suppressed retries stay
ineligible. Accepted, sandbox-accepted and ambiguous deliveries retain the existing
no-resend rules. No network calls run inside database transactions.

The initial TypeORM schema defines `club_settings` and `email_deliveries.suppressed_at`;
the initial schema baseline inserts the disabled singleton and the Supabase migration
denies browser-role access. Configure the sender and deliberately enable email after a
fresh install. Removing the suppression marker could resurrect old mail.
