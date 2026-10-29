# Court checkout lifecycle correction

## Investigation

The existing feature branch created a `bookings` identity, initial pending revision,
held `court_reservations` row and pending payment attempt in the first checkout
transaction. Explicit cancellation or best-effort unused-navigation cleanup appended a
`cancelled` booking revision with `checkout_abandoned` before contacting Stripe.
Admin queried all these identities, so unpaid attempts appeared as cancelled bookings.
This flow uses embedded Stripe Payment Element with manual-capture PaymentIntents;
it does not create hosted Stripe Checkout Sessions.
The business model had no separate persisted identity proving that confirmation had occurred.

A read-only inspection of the local development database found:

- Checkout `9689aa3a-0cae-49cc-9559-25b6c50c0d3d`, Central Club, Court 1,
  October 31, 2026, minutes 960–1020 (16:00–17:00).
- Current reservation `b1e0e06e-066a-4125-9596-71a3461fc471` was `released`,
  with NULL hold deadline. The payment attempt was `cancelled`, completed at
  `2026-10-29T10:19:07.548Z`; its original expiry was `10:28:36.915Z`.
- The current revision was `cancelled`, cause `checkout_abandoned`.
- This was the only persisted reservation for that court/date. No other reservation
  currently explains the occupied slot.

The cancelled identity cannot itself block availability: occupancy reads use the
reservation's active/live-held state, not the booking label. No request trace or
historical browser snapshot exists to reconstruct whether the observed screen showed
an unreleased hold or stale data at that instant. The source does contain a stale-data
race: Close dismisses and refreshes immediately, while a later unmount microtask sends
unused-checkout cleanup asynchronously. The refreshed timetable can therefore include
the hold that cleanup subsequently releases. Previously it did not refresh again.

## Persistence and transitions

The focused migration `SeparateCheckoutBookings1791462257927` renames the old aggregate
to `checkout_records`. Existing financial `booking_id` values continue referencing that
same UUID and the renamed parent. Attempts, immutable revisions, capture receipts,
refunds, executions, financial exceptions, ownership and reservations are preserved.
The earlier baseline migrations are unchanged. No rebuild or data deletion is needed.
This is a new persisted separation of checkout and booking identity, rather than a
presentation filter or a cleanup patch for old abandoned rows.

The new `bookings` table contains only `id` and `confirmation_revision_id`, with a
primary key, checkout FK and same-aggregate immutable revision FK. Migration backfill
requires a confirmed `created` or `confirmed` revision, preserving genuine historical
bookings even after cancellation while excluding abandoned checkouts. Internal quote
revisions may exist without a business booking. Their existing names and financial
column names retain the shared aggregate identity.

| Operation | Internal checkout | Reservation | Actual booking |
| --- | --- | --- | --- |
| Select interval | None | None | None |
| Start online checkout | Pending, immutable quote and attempt | Held for 10 minutes | None |
| Accept timely authorization | Pending, acceptance marker | Protected through capture/recovery | None |
| Verified valid capture | Confirmed revision | Active | Insert exactly once in same transaction |
| Pay at club | Confirmed creation, due payment | Active | Insert in creation transaction |
| Explicit unpaid cancellation | Cancellation intent, no cancellation revision | Held until definitive provider cancellation or safe expiry | None |
| Definitive initial court card failure | Failed checkout after fresh provider read | Released after provider cancellation | None |
| Abandon without server request | Pending, then expired after provider resolution | Cron checks Stripe; definitive unpaid cancellation releases it transactionally | None |
| Cancel a confirmed booking | Cancelled revision after normal policy/refund workflow | Cancelled after necessary refunds | Original booking retained |

Admin lists/details, coach filter options, counts and customer activity/history join
actual persisted booking identities. Payment review still reads technical checkout and
financial evidence. Staff-reservation predicates exclude *all* checkout aggregates,
so a temporary customer allocation cannot turn into a staff reservation. Staff creation,
editing, cancellation and GiST overlap protection are retained.

Promotion retains the same court reservation and holds the same location/aggregate
locks throughout. There is no release-and-reacquire gap. The booking primary key,
existing receipt uniqueness and manual-capture idempotency prevent duplicate promotion
or collection. Confirmation insertion, reservation activation, revision advancement and
notification recording share the transaction and roll back together on failure.

## Cancellation, failure and recovery

Cancel payment sends the existing capability-bound Server Action after explicit
confirmation. The server verifies the hashed capability and records internal cancellation
intent under location → checkout → reservation → attempt locks, blocking subsequent
capture acceptance. No booking cancellation revision or notification is created.
The Stripe adapter retrieves/cancels the exact registered PaymentIntent, using the existing
stable idempotency key and retrieve-after-error behavior. A definitive cancellation
settles the attempt and releases occupancy. Only then does the UI report success,
close and refresh availability. Closing the dialog alone makes no cancellation claim.

Timeouts/processing retain protection while required. Accepted authorization rejects
checkout abandonment; the original capture decides confirmation. If cancellation
intent won first, a later capture cannot promote a booking: verified capture evidence
and a unique full-refund compensation obligation commit together. Released occupancy
is never reclaimed. Late or duplicate webhooks retain existing receipt idempotency,
refund execution identity and strict redelivery behavior.

A signed initial court card-failure event may be stale. The server first records its
receipt, then re-reads Stripe. A newer authorization, processing state or completed
capture is observed normally. If the exact intent still awaits a card, the server
records failed-checkout intent and requests provider cancellation. Unknown outcomes
keep the hold; provider cancellation releases it. Coaching and modification retryable
card declines retain their previous retry workflow; genuine terminal failure/expiry
still releases their allocations through shared settlement.

The existing ten-minute deadline uses the database clock. Unregistered holds expire
locally. Registered initial payments retain occupancy until Stripe confirms cancellation
or capture; the existing Cron resolves browser abandonment without a browser. Every
occupancy mutation locks the location and releases safely expired aggregates before checking/inserting; this makes the
GiST constraint agree with displayed availability. Polling and the existing bounded
expiry Cron provide additional cleanup/reconciliation. No new worker, queue or service
is introduced. Visible schedulers refresh every 15 seconds and on focus, outside an
open confirmation dialog, so released/expired snapshots are eventually refreshed.

An accepted capture with an unknown provider outcome is deliberately exempt from
ordinary expiry, including beyond the operational 120-second grace. Finite automatic
release and guaranteed payment safety cannot both be promised during an indefinite
provider outage. After grace, existing polling/Admin/provider recovery attempts exact
intent cancellation; only definitive cancellation releases that protection, while a
successful capture settles it. Unaccepted late authorizations are never captured by
the application; an externally captured invalid/late payment is compensated.
Stripe permits cancellation only in specific states, with limited support while
processing; the implementation follows the provider result rather than browser state.
See [Stripe cancellation reference](https://docs.stripe.com/api/payment_intents/cancel).

Booking confirmations remain recorded only on confirmed creation/settlement. Genuine
subsequent booking cancellations retain their notifications and history. Abandoned
checkouts create neither booking confirmation nor cancellation notifications. Brevo,
Auth, recipient policy and delivery infrastructure are unchanged by this task.

## Local manual validation

Stop the development Next.js server before changing its schema. Apply only pending
TypeORM migrations to the configured local development database, preserving data:

```bash
node --conditions=react-server --env-file=.env.local --import=./scripts/ts-loader.mjs node_modules/typeorm/cli.js migration:run -d src/lib/db/migration-data-source.mjs
npm run dev
```

Do not rebuild/reset the development database for this change. The data-preserving migration was applied during this implementation to both the
verified isolated test database and the verified local development database. The
command is idempotent and will report no pending migration here. Restart any existing
development server so its TypeORM metadata matches the new schema.

1. With Stripe test mode configured and its webhook forwarded to the existing local
   endpoint, open `/book` as a guest. Select a future published court interval and
   continue to payment. Another browser must see a held interval, but Admin List
   and customer history must contain no booking for this checkout.
2. Click **Cancel payment**, then confirm **Cancel payment**. Wait for the server's
   success message. The same interval must be selectable immediately; Admin must
   still have no booking. Repeat while signed in as an ordinary active account and
   check `/my-activity/history`.
3. Start another checkout and close the browser without cancelling. Before expiry
   another customer must be blocked. After ten minutes, reload availability or wait
   for its refresh. The interval must be selectable and a new checkout must succeed;
   no old checkout may appear in Admin or personal history.
4. Complete a fresh Stripe test-mode payment. Check exactly one confirmed booking,
   an active reservation, one succeeded attempt/capture and the confirmation event.
   Duplicate webhook delivery must not add another booking/capture/notification.
5. Cancel that confirmed booking through normal owner/Admin management, respecting
   its snapshot notice cutoff. Wait for any captured-funds refund. Its reservation
   must release and its booking/history must remain Cancelled, with a cancellation event.
6. Enable pay at club on a test location and confirm a booking. It must create a
   confirmed booking immediately and a due payment without Stripe.
7. Repeat a staff direct reservation and coaching checkout. Staff reservations stay
   separate; a paid coaching booking still protects both coach and court.

For fully isolated automated browser validation with **no live Stripe/Brevo**, use:

```bash
node --conditions=react-server --import=./scripts/ts-loader.mjs scripts/initialize-test-database.ts
npm run test:integration
npx playwright test tests/e2e/initial-checkout.e2e.ts
npm test
npm run typecheck
npm run lint
```

The browser suite uses the existing fake loopback Stripe API/Stripe.js and a fresh
production build on port 3100. Its guest and ordinary authenticated cancellation cases
assert actual database absence of a booking, released occupancy and availability;
its court/coaching payment cases assert persisted confirmed outcomes.


## Executed validation and remaining limits

Final validation on this branch:

- `npm test -- --reporter=dot`: **189 files, 2,056 tests passed**.
- `npm run test:integration`: **526 passed, 3 failed, 529 total**, across 56 files.
  All booking/payment/coaching/staff/history/notification suites passed. The failures
  are the two tests in `auth/password-change.integration.test.ts` and the Auth/Storage
  workflow test in `db/migration-cutover.integration.test.ts`: Auth cannot send signup
  email and the Mailpit API refuses `127.0.0.1:55324`. The isolated Mailpit container
  reports healthy with configured port bindings but empty runtime port mappings;
  starting the test stack and restarting that container did not restore the endpoint.
  These checks have not been marked passed or disabled.
- The other nine migration-cutover tests passed, including the four registered
  migrations, zero TypeORM metadata diff, browser-role restrictions and native integrity.
- Focused rerun of Stripe payment/refund, booking mutations, activity pagination and
  checkout abandonment: **200 tests passed**.
- `npx playwright test tests/e2e/initial-checkout.e2e.ts`: **4 passed**, including
  guest/account explicit cancellation and guest court/coaching success. Successful
  checkouts assert exactly one persisted booking and one confirmation email event;
  unpaid cancellations assert no booking/cancellation revision/email, immediate
  availability and absence from the authenticated customer's history.
- The Playwright run built and started the isolated production application successfully.
- `npm run typecheck`, `npm run lint`, and `git diff --check`: passed.
- New migration applied to the existing isolated test database and local development
  database, without a reset. Development recheck of `#9689aa3a` returned
  `actual_booking: null`, `reservation_status: released`.

Automated tests used mocked provider I/O or the guarded local Stripe HTTP/Stripe.js
fixture. No live Stripe or Brevo was contacted. A live Stripe test-mode payment,
real bank authentication, actual email inbox delivery, remote migration and production
deployment were not performed. Accepted-capture uncertainty may retain occupancy until
provider recovery, as required for safety; ordinary abandoned holds remain finite.
The historical UI snapshot for the originally reported incident cannot be recovered.

Coverage against the requested scenarios:

| Scenarios | Exercised coverage |
| --- | --- |
| 1–3: guest/account cancellation and provider-confirmed release | Checkout abandonment integration and both new browser cancellation cases |
| 4: definitive failed payment release | Real Stripe adapter/webhook integration plus failure/timeout checkout tests |
| 5–6: abandonment, expired reads and replacement insertion | Checkout, public-court, hold-expiry and staff reservation integration |
| 7–8: genuine cancelled history versus unsuccessful checkout absence | Personal history/activity, Admin booking records, abandonment and browser assertions |
| 9–10: one online confirmation and pay at club | Checkout duplicate receipts, guest browser success, pay-at-club creation/mutation integration |
| 11: concurrent allocations | Checkout location-lock races, GiST insertion, staff and coaching concurrency integration |
| 12–14: duplicate/late webhook, authorization/cancellation race, ambiguity | Stripe payment, checkout abandonment and 185 booking-mutation tests |
| 15: notification transitions | Notification integration, zero abandonment-notification assertions and paid browser event persistence |
| 16: coaching and staff preservation | 62 coaching-booking tests plus direct-reservation, operational, coach and reservation suites |

## Exact files changed for this task

The entity/repository changes separate the two persisted identities. Most test-file
changes update technical SQL/fixture references to the renamed aggregate. Existing
uncommitted notification-delivery/logger changes were present before this task and
were preserved; they are excluded from this inventory.

- `AGENTS.md`
- `README.md`
- `docs/booking-domain.md`
- `docs/checkout-lifecycle-correction.md`
- `docs/payments-memberships.md`
- `docs/testing.md`
- `src/app/api/payments/stripe/webhook/route.ts`
- `src/app/book/booking-calendar.tsx`
- `src/app/book/booking-confirmation.tsx`
- `src/app/book/online-payment.tsx`
- `src/lib/bookings/admin-query.ts`
- `src/lib/db/data-source.ts`
- `src/lib/db/entities/booking-adjustment.entity.ts`
- `src/lib/db/entities/booking-revision.entity.ts`
- `src/lib/db/entities/booking.entity.ts`
- `src/lib/db/entities/checkout-record.entity.ts`
- `src/lib/db/entities/payment-attempt.entity.ts`
- `src/lib/db/entities/payment-refund.entity.ts`
- `src/lib/db/migrations/1791462257927-SeparateCheckoutBookings.ts`
- `src/lib/db/repositories/booking-adjustments.repository.ts`
- `src/lib/db/repositories/booking-revisions.repository.ts`
- `src/lib/db/repositories/bookings.repository.ts`
- `src/lib/db/repositories/clubs.repository.ts`
- `src/lib/db/repositories/court-activity.repository.ts`
- `src/lib/db/repositories/payments.repository.ts`
- `src/lib/db/repositories/reservations.repository.ts`
- `src/lib/payments/checkout.ts`
- `src/lib/payments/domain.ts`
- `src/lib/payments/hold-expiry.ts`
- `tests/components/admin-bookings.test.tsx`
- `tests/e2e-live/booking-modification-lifecycle.e2e.ts`
- `tests/e2e/admin-booking-management.e2e.ts`
- `tests/e2e/booking-adjustments.e2e.ts`
- `tests/e2e/booking-refund-recovery.e2e.ts`
- `tests/e2e/initial-checkout.e2e.ts`
- `tests/e2e/opening-hours-workflow.e2e.ts`
- `tests/integration/activity-pagination.integration.test.ts`
- `tests/integration/admin-booking-records.integration.test.ts`
- `tests/integration/admin-bookings.integration.test.ts`
- `tests/integration/admin-operational-bookings.integration.test.ts`
- `tests/integration/admin-payment-transactions.integration.test.ts`
- `tests/integration/admin-stripe-reconciliation.integration.test.ts`
- `tests/integration/admin/locations.integration.test.ts`
- `tests/integration/admin/opening-hours.integration.test.ts`
- `tests/integration/booking-financial-exceptions.integration.test.ts`
- `tests/integration/checkout-abandonment.integration.test.ts`
- `tests/integration/checkout-fixtures.ts`
- `tests/integration/coaching-booking.integration.test.ts`
- `tests/integration/db/booking-fixtures.integration.test.ts`
- `tests/integration/db/booking-mutations.integration.test.ts`
- `tests/integration/db/checkout.integration.test.ts`
- `tests/integration/db/coaching-reservations.integration.test.ts`
- `tests/integration/db/migration-cutover.integration.test.ts`
- `tests/integration/db/refund-executions.integration.test.ts`
- `tests/integration/db/reservations.integration.test.ts`
- `tests/integration/notifications.integration.test.ts`
- `tests/integration/owner-customer-booking-reschedule.integration.test.ts`
- `tests/integration/personal-customer-bookings.integration.test.ts`
- `tests/integration/personal-history.integration.test.ts`
- `tests/integration/stripe-payment.integration.test.ts`
- `tests/integration/stripe-refunds.integration.test.ts`
- `tests/local/booking-fixtures.ts`
- `tests/unit/activity-service.test.ts`
- `tests/unit/admin-bookings.test.ts`
- `tests/unit/admin-reservation-edit-service.test.ts`
- `tests/unit/personal-reservation-service.test.ts`
- `tests/unit/stripe-webhook-route.test.ts`
