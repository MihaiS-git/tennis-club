# Browser-abandoned checkout investigation

## Exact observed attempt

On 2026-10-29, the local development app served `/book` successfully on port 3000.
Its Next.js development lock identified PID 361512, started at 10:57 UTC; development
chunks/logs had been updated after startup. The database had all four registered
TypeORM migrations, including `SeparateCheckoutBookings1791462257927`. The observed
runtime data followed that migrated model. An older production artifact existed
alongside the active development output; the running app used development output.

Checkout `cc914b62-bd20-4cef-b267-011634f28090` was created at 11:00:42.221 UTC.
Its held court row and payment attempt expired at 11:10:42.239 UTC. The initial
11:08:42 UTC inspection was before the deadline: occupancy and Pending were valid.
The ID was a `checkout_records` identity, with **no row in `bookings`**. The joined
resource snapshot verified Central Club, Court 2, November 1, 2026, 18:00–19:00,
an authenticated account link and RON 50.

Attempt `88405f06-e3b1-4389-8174-137bfb49c6ca` referenced Stripe test-mode PaymentIntent
`pi_3UVr4Y0XKEh1Hj0o1UtAveQy`. Read-only provider inspection returned
`requires_payment_method`, manual capture, RON 50, zero received and zero capturable.
This app uses Payment Element and PaymentIntents, not Stripe Checkout Sessions;
the application's ten-minute deadline is independent of Stripe session expiry.

At 11:14:55 UTC, the deadline had passed but the persisted checkout/attempt still
showed pending/held. The configured existing Cron runs every five minutes: its
11:10 invocation preceded the deadline. At 11:15 the existing Cron returned HTTP
200 and resolved the aggregate without any customer action. At 11:15:22 UTC:

- checkout: `expired`;
- reservation: `released`;
- payment attempt: `cancelled`;
- Stripe: `canceled`, zero received;
- actual booking: absent.

No mutation of this observed attempt or manual Stripe cancellation was performed
by this investigation. Scheduled application cleanup performed the transition.

## Root cause and correction

The prior persistence refactor correctly separated temporary checkout identities
from actual bookings. Browser abandonment already had server cleanup through the
existing Supabase Cron, local expiry before occupancy writes and provider checks.
The reproduction did not demonstrate an indefinitely stuck checkout: the first
inspection preceded expiry, and the next eligible Cron run resolved it.

Two read paths remained incomplete. Staff availability included live holds while
staff detail projections returned only active bookings/reservations, causing the
bare occupied-slot dialog. The financial ledger retained checkout audit references
but presented them as booking links/statuses. The new projection includes an explicit
hold kind, deadline, customer snapshot and payment-review link for Admin. Coach
privacy remains enforced. Financial reporting derives an actual-booking boolean
from persisted `bookings` existence and labels technical checkout references,
quote/status and payment operations accordingly. Actual booking links remain intact.

Comparison against repository HEAD confirms that active-only staff details and
accepted-capture-only protection predated the checkout-separation refactor. That
refactor left these lifecycle paths incomplete; its identity separation itself
worked for the reported attempt.

A separate payment-safety gap existed: local expiry could release an unaccepted,
registered initial payment before Stripe cancellation succeeded. This fix applies
one shared payment-protection predicate to expiry and all affected occupancy reads.
A registered pending initial attempt retains its held row until definitive provider
settlement. Unregistered attempts can still expire locally without HTTP. No new
migration, queue or worker is introduced.

## Lifecycle and payment races

The ten-minute deadline still ends eligibility for new authorization/capture
acceptance. The existing five-minute Supabase Cron samples overdue registered
Stripe attempts through `checkOnlinePayment`, never initiating capture. It runs
provider HTTP outside transactions. A definitive cancellation enters the common
location-first settlement transaction: the checkout becomes expired, the payment
attempt becomes cancelled, and the physical reservation becomes released. The
partial GiST overlap exclusion no longer includes that row, permitting a new
reservation. No actual booking or booking-cancellation revision is inserted.
Financial references, attempts, immutable quote revisions and provider evidence remain.

Cancellation failure, processing and ambiguous responses preserve Pending and
occupancy. Existing Cron retries and Admin Needs attention / Check with Stripe
provide the resolution path. Deadline alone does not establish that money was not
captured. A prolonged Stripe outage can therefore prolong a protected hold.

Authorization acceptance shares location/checkout/reservation/attempt locks with
expiry and settlement. Timely accepted capture remains protected beyond its 120-second
grace; a verified success confirms exactly once. Unaccepted late authorization is
cancelled rather than captured. Capture winning cancellation is observed through the
same settlement path. Invalid/late captures preserve receipts and compensation
obligations; duplicate/late webhooks never reclaim released occupancy or insert a
second booking. Confirmed cancellation/refund, coaching, staff reservations and
pay-at-club workflows retain their existing commands.

Stripe's cancellation state rules are documented in the
[PaymentIntent cancellation reference](https://docs.stripe.com/api/payment_intents/cancel).

## Manual validation

1. Run the latest app with migrated TypeORM schema. Ensure the existing
   `tennis-club-checkout-hold-expiry` Cron targets the running app and returns HTTP
   200; Cron SQL success alone only proves HTTP was enqueued. Local setup:
   `npm run payments:expiry-cron:local` with the documented local URL and secret.
2. Sign in as a customer, select a future court interval, continue until the Stripe
   payment form is visible, then close that browser without Pay or Cancel.
3. Before the stored deadline, use a separate Admin browser. Calendar should label
   the slot Temporary checkout hold, show its deadline and payment-review link,
   and provide no booking management controls. Transactions should show a Checkout
   reference and Current checkout status, with no booking-details link.
4. After the stored deadline and next five-minute sweep, verify definitive unpaid
   cancellation: expired checkout, cancelled attempt, released court row and no
   actual booking identity/cancellation revision. Refresh availability; the slot
   can be reserved again. Admin/customer booking history contains no booking.
5. With a simulated provider failure in isolated tests, verify the hold remains
   protected and recoverable. Restore provider responses and run the same existing
   expiry endpoint or Admin Check with Stripe; verify safe release.

See `docs/testing.md` for isolated automated commands. Automated tests use fake
Stripe only; provider retrieval of the reported real test-mode intent was read-only.

## Files changed for this follow-up

Pre-existing uncommitted checkout-separation work was preserved. This follow-up changes:

- `src/lib/db/repositories/reservations.repository.ts`: shared initial-payment occupancy protection and staff hold projection.
- `src/lib/db/repositories/payments.repository.ts`: use that protection during expiry and project actual booking identity in the ledger.
- `src/lib/reservations/service.ts`: explicit hold type and Admin projection, preserving Coach privacy.
- `src/lib/payments/financial-history.ts`: authoritative identity validation and Checkout payment label.
- `src/app/admin/reservations/reservation-calendar.tsx`: temporary-hold dialog, deadline and payment-review link.
- `src/app/admin/payments/transaction-detail.tsx`, `transaction-row.tsx`, `transactions/page.tsx`: checkout versus booking reference, quote and status presentation.
- `src/app/api/payments/holds/expire/route.ts`: correct lifecycle documentation comment.
- `tests/integration/checkout-abandonment.integration.test.ts`: valid lifetime, expiry, provider failure, physical overlap release, authorization/expiry races and duplicate events.
- `tests/integration/db/checkout.integration.test.ts`: concurrency expectation now requires definitive provider cancellation before replacement insertion.
- `tests/integration/stripe-payment.integration.test.ts`: unknown provider outcome preserves occupancy before late-capture compensation.
- `tests/integration/db/booking-mutations.integration.test.ts`, `coaching-booking.integration.test.ts`, `admin-stripe-reconciliation.integration.test.ts`: retain coverage of safe unregistered expiry, delayed provider registration, registered coaching resolution and modification-lease independence.
- `tests/integration/admin-payment-transactions.integration.test.ts`: identity and checkout-operation reporting assertions.
- `tests/components/admin-payment-transactions.test.tsx`, `admin-booking-transaction-navigation.test.tsx`, `reservation-calendar.test.tsx`: checkout presentation and preserved actual-booking navigation.
- `tests/e2e/initial-checkout.e2e.ts`, `playwright.config.ts`: separate customer browser closure, real deadline acceptance and isolated expiry endpoint secret.
- `README.md`, `AGENTS.md`, `docs/payments-memberships.md`, `docs/checkout-lifecycle-correction.md`, `docs/testing.md`, this report: corrected operating and testing guidance.

No new migration is part of this follow-up. No commit was made.

## Validation results

- `npm test`: 189 files, **2,058 unit/component tests passed**.
- `npm run test:e2e -- tests/e2e/initial-checkout.e2e.ts`: **5 passed**. The browser-close case took 10.1 minutes, using the actual ten-minute deadline; the full file took 10.6 minutes including its isolated production build. Court, semi-private coaching, guest cancellation and authenticated cancellation also passed.
- Production build completed successfully. Final lint/TypeScript and expanded isolated integration results are recorded below.

Final expanded integration command:

```bash
npm run test:integration -- tests/integration/checkout-abandonment.integration.test.ts tests/integration/admin-operational-bookings.integration.test.ts tests/integration/admin-payment-transactions.integration.test.ts tests/integration/admin-stripe-reconciliation.integration.test.ts tests/integration/stripe-payment.integration.test.ts tests/integration/db/checkout.integration.test.ts tests/integration/db/booking-mutations.integration.test.ts tests/integration/stripe-refunds.integration.test.ts tests/integration/coaching-booking.integration.test.ts tests/integration/db/reservations.integration.test.ts tests/integration/personal-history.integration.test.ts tests/integration/payment-foundation.integration.test.ts
```

**12 files / 323 tests passed**, including the 185 booking mutation tests and 62
coaching tests. The revised fixtures explicitly distinguish safe unregistered expiry
from registered attempts awaiting provider resolution. Final `npm run typecheck`,
`npm run lint`, production build and `git diff --check` passed.

`npm run test:e2e -- tests/e2e/admin-booking-management.e2e.ts`: **3 passed**
(29.8 seconds, including a fresh production build), covering confirmed booking
Calendar/List details and cancellation, owner-only editing, and staff reservation
Calendar/List editing/cancellation. Total focused browser acceptance: **8 passed**.
