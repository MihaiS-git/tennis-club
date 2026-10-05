# Booking notifications

Booking confirmation, customer cancellation, Admin cancellation, customer
rescheduling and Admin rescheduling write to `booking_email_outbox` inside their
successful mutation transaction. Each event snapshots `bookings.customer_email`,
customer name, reference, location, timezone, schedule and booking total. Reschedule
mail includes the previous and new schedules. Later account/contact/configuration
changes do not rewrite queued content. Direct reservations, Supabase Auth emails,
provider-specific payment messages and refunds are excluded. Confirmation is
enqueued only when a booking becomes confirmed: at Pay at club creation or trusted
online settlement. Pending, failed and expired checkout emit no confirmation email.

Failed mutations roll back their events. Quotes, price-change responses, stale
requests and saves that leave the schedule unchanged enqueue no reschedule email.
Unique event/version keys and the existing locked lifecycle/stale-token boundaries
prevent duplicate events from retried mutation requests.

## Local operation

Apply `20261005180000_booking_email_outbox.sql` incrementally after its preceding
booking migrations; do not reset the database. Local Supabase's `[local_smtp]`
exposes Mailpit SMTP on port 54325 and its inbox at http://127.0.0.1:54324.
An already running stack needs `supabase stop` followed by `supabase start` to expose
the new port; this preserves data. Supabase Auth email configuration is unchanged.

Add the server-only `BOOKING_*` variables from `.env.example` to `.env.local`,
including `BOOKING_MAIL_FROM`, `BOOKING_SMTP_HOST`, `BOOKING_SMTP_PORT`, and
`BOOKING_SMTP_SECURE`. The worker also needs `SUPABASE_URL` and
`SUPABASE_SECRET_KEY`. Optional SMTP username/password must both be supplied.

Run alongside `npm run dev`:

```sh
npm run mail:worker
```

For one pass through currently eligible messages:

```sh
npm run mail:worker -- --once
```

The worker polls every two seconds. It is separate from the web request, so mail
failures never reverse bookings or turn a successful booking into a UI error.
Restarting the worker resumes durable pending work. The same command can run under
a process supervisor later; no hosting or production mail provider is configured.
The `MailAdapter` interface accepts a stable event idempotency key and returns a
safe outcome. The SMTP adapter uses Nodemailer; another provider can implement the
same interface without changing booking mutations or email rendering.

## Retries and concurrency

Service-role-only RPCs claim one event using `FOR UPDATE SKIP LOCKED`, issue a
random lease token, then transition to `sending` before calling the adapter.
Other workers cannot send that event. Pending events for a booking wait for earlier
pending/in-flight events. A stale worker cannot start or finish another worker's
claim. SMTP transport timeouts are bounded below the two-minute lease duration.
Private outbox data has RLS enabled and no anonymous/authenticated table or RPC access.

Definite non-acceptance (connection failure before DATA or an explicit temporary
SMTP rejection) retries with exponential backoff from 30 seconds up to one hour,
with ten attempts maximum. Permanent rejection becomes `failed`. A crashed
`processing` claim can be reclaimed. A crashed `sending` claim or missing SMTP
acknowledgement becomes `uncertain`; the worker never automatically resends it.

SMTP cannot guarantee exactly-once receipt: acceptance can happen just before a
connection or process fails. A stable Message-ID is useful for tracing, but does
not force recipient deduplication. Quarantining ambiguous sends preserves the
no-duplicate automatic retry requirement at the cost of possible non-delivery.
Inspect `uncertain` rows against Mailpit/provider records using the event Message-ID
before deciding whether to mark delivered or explicitly requeue. Never blindly
requeue ambiguous events. `failed` rows need configuration/recipient diagnosis.
Outcome logs contain only event ID and safe codes, without recipient or message data.

## Verification

Focused coverage: `tests/unit/booking-email.test.ts` and
`tests/integration/booking-email-outbox.integration.test.ts`.

Manually verified local booking mutations through the real RPCs and delivery through
SMTP, then read all six Mailpit messages: two confirmations, customer and Admin
reschedules, and customer and Admin cancellations. Recipient snapshots, references,
location timezone, old/new schedules, totals and actor wording were checked.
The verification mailbox is `booking-notifications-local@example.test`; local
verification bookings are cancelled and therefore do not block availability.
No E2E/QA expansion or payment notifications were added.
