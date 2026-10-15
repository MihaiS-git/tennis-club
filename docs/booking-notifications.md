# Booking email notifications

Booking confirmations, cancellations, rescheduling and financial exceptions persist
rendered email work in `public.booking_notification_deliveries` in the same TypeORM
transaction as the corresponding state change or verified financial observation.
The immutable revision supplies the booking contact, schedule, price and historical
names. The current account email is never substituted. Direct reservations and
Supabase Auth email remain separate.

A unique event key identifies each revision notification, failed-modification payment
or refund exception. Insert-on-conflict prevents duplicate records during retries,
webhook replay and concurrent recovery. A rollback also removes its provisional email.
A successful paid modification queues its revision email in the shared command only;
settlement does not queue it a second time.

The existing payment recovery scheduler claims up to 25 due notifications per run,
using five-minute leases and row locks with SKIP LOCKED. Brevo HTTP delivery happens
outside all database transactions, with a ten-second timeout. Accepted submissions
are acknowledged using the lease token. Configuration errors, rejection, transport
uncertainty and crashes leave durable work for automatic retry with bounded backoff.
No customer message can be sent before its financial transaction commits.

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
notifies that the original booking remains and its compensation is being refunded.

Deployment requires the additive `1791462257928-DurableBookingNotifications` migration
following `1791462257927-AutomaticFinancialRecovery`, `BREVO_API_KEY`, a verified
`BOOKING_MAIL_FROM`, and a running Node recovery scheduler (interval must not be zero).
Application-table browser grants remain denied. No historical email is reconstructed:
transitions committed before this change without durable work may already have lost email.
