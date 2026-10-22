# Notification email delivery setup (Phase 4)

The application sends persisted `email_deliveries` through the Brevo transactional HTTP API. A successful API response records `accepted` or `sandbox_accepted`; it does not establish that a recipient received the email. Supabase Auth email configuration is separate.

## Application configuration

Set server-only `BREVO_API_KEY`, a Brevo-verified email address in `BOOKING_MAIL_FROM`, `NOTIFICATION_EMAIL_MODE=live`, `NOTIFICATION_CRON_SECRET`, and `BREVO_WEBHOOK_SECRET` for manual local development and production. Use independent random values of at least 32 characters for the two Bearer secrets. The isolated automated test runners force sandbox mode even when `.env.local` selects live; live delivery is rejected in test processes and Vercel deployments without `VERCEL_ENV=production`. Sandbox requests include `X-Sib-Sandbox: drop` in the Brevo JSON `headers` object and send no real email. Configuration errors stop processing before any claim is taken. A separate `sandbox_accepted` status is never treated as live acceptance or replayed automatically.

The delivery endpoint is `POST /api/notifications/deliver` with `Authorization: Bearer <NOTIFICATION_CRON_SECRET>`. It takes at most 20 due/expired deliveries per call. Run it every five minutes. A lost response or timeout can mean Brevo accepted an email; retries can therefore duplicate provider delivery. Delivery status is acceptance, not inbox receipt.

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
