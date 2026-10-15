# Booking email notifications

Booking confirmation, customer/Admin cancellation and owner rescheduling
map the accepted immutable booking revision within the successful transaction, then
send the preserved text template through Brevo's transactional HTTP API after commit.
Use only the revision's customer email, never the current account email. The same
revision supplies historical location/court names, timezone, contractual schedule,
total and currency. Online confirmation copies the checkout revision's terms;
resource renames do not replace them. Rescheduling uses the newly applied revision
and its predecessor for old/new schedule text. Pending paid adjustments send nothing;
successful application returns its notification to the existing post-commit settlement
workflow. Cancellation copies the current contract into its cancellation revision.
Quote, stale, failed and unchanged-schedule saves send no rescheduling email;
pending/failed/expired checkout sends no confirmation. Transition and webhook receipt
checks prevent replayed operations from sending again. Delivery is best-effort with
a 10-second HTTP timeout, sanitized error logging, and no persistent queue or retries.
Email failure cannot change committed booking/payment state. Server-only
`BREVO_API_KEY` and a Brevo-verified `BOOKING_MAIL_FROM` are required.
Supabase Auth confirmation/recovery emails remain independent.

The Next.js backend awaits one request to
[Brevo's transactional email endpoint](https://developers.brevo.com/reference/send-transac-email).
Pay-at-club creation sends confirmation after the creation commit; online payment
sends confirmation only when settlement first transitions the booking to confirmed.
Cancellation includes the existing refund-request wording when a refund is requested,
without claiming completion. Rescheduling preserves the old/new schedule text.
Direct reservations and refund completion have no email notifications.

No worker, cron, database polling, delivery locks or SMTP adapter is required.
A process interruption or provider failure can lose an email; replay does not retry it.
Provider acceptance is not a guarantee of inbox delivery.

Unit tests mock HTTP success, rejection, timeout and missing configuration.
Transaction integration tests mock the notification boundary and verify snapshots,
commit ordering, rollback behavior and duplicate transition suppression without
calling Brevo. Existing local databases may retain unused email tables until the
next explicitly authorized development rebuild; the three final-state migrations
no longer create them. This cleanup does not run a rebuild.
