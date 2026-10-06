# Payments and Memberships

## Implemented payment lifecycle foundation

Online payment is the default. Admin → Locations → Booking policy may enable
`allow_pay_at_club`, which defaults OFF for existing and new locations. The public
location read exposes this boolean, while the creation RPC rechecks it under a
location row lock. Contact, amount and currency snapshots still come from the
server-side booking service and existing public calendar pricing calculation.

`bookings.payment_method` snapshots `online` or `pay_at_club`. Historical bookings
retain their lifecycle with a NULL payment-method snapshot and no fabricated
payment attempt. NULL means historical payment method/collection is unknown; it
never implies either an outstanding debt or a collected payment. Online commits
atomically insert a `pending_payment` booking, its one `held` court reservation,
and a `pending` payment attempt. Pay at club inserts a `confirmed` booking, `active`
reservation and `due` payment record. Stripe checkout uses Payment Element inside
the existing confirmation dialog. A pending hold is never shown as a confirmed booking.

`payment_attempts` supports multiple attempts per booking. Each row stores method,
provider, provider reference, integer minor-unit amount, currency, lifecycle status,
expiry, creation/update and completion timestamps. Online attempts require a
snapshotted `stripe` or `netopia` provider. Admin → Payments → Settings explicitly selects
one provider for future attempts, with no default or automatic failover. Missing
selection or incomplete configuration makes online payment unavailable. Future
provider changes do not modify old attempts; a database trigger also forbids
changing an existing attempt’s method/provider. Pay at club has no provider/reference.
There is at most one pending attempt per booking, and provider references are unique
within each provider. Payment attempts have RLS enabled and no browser-role grants.

The initial hold duration is centralized as `paymentHoldDurationSeconds` in
`src/lib/payments/domain.ts` (10 minutes). PostgreSQL calculates expiry from its
wall clock. `held` and `active` reservation rows share the existing GiST overlap
constraint. All public/staff/edit occupancy reads use database-time expiry checks,
so expired holds disappear from availability without browser timers. A reservation
INSERT/schedule UPDATE trigger releases expired holds before the GiST check,
including direct staff reservations and rescheduling. Cleanup locks booking before
reservation, skips busy rows to avoid lock inversion, and updates the booking,
reservation and pending attempts atomically. A busy concurrent lifecycle operation
may cause a safe overlap rejection; a subsequent attempt retries cleanup. Stale
unlocked holds cannot permanently block a court. Cleanup is lazy; terminal expiry
rows are persisted at the next reservation mutation, or by the service-role-only
`expire_payment_holds` maintenance RPC. No background scheduler is required for
availability correctness.

`settleOnlinePayment` is a server-only operation for **verified** provider
adapters. The Stripe webhook calls the common event operation, which reuses this
settlement transaction; no browser-callable settlement action exists. Its service-role-only RPC locks
booking → reservation → attempt and validates the stored provider/reference.
A timely success confirms the same booking/reservation and enqueues one confirmation
email. Failure/expiry releases the same reservation and marks the booking/attempt
failed/expired. A late success cannot reclaim a released or replaced interval.
Duplicate settlement returns the existing terminal status and emits no extra email.
Pending/failed/expired checkouts never emit confirmation mail or appear as confirmed
personal bookings. Pay at club emits confirmation atomically at creation.

NETOPIA integration/refunds, credential UI, partial refunds, saved cards, deposits, subscriptions
and packages remain unimplemented. The sections below distinguish the current
one-time Stripe flow from future membership scope.

## Provider configuration

Stripe and NETOPIA may be configured at the same time. Secret values are server-only,
read through separate provider configuration modules implementing the shared
`PaymentProviderConfiguration` interface. Booking code resolves a provider identifier
through the payment settings service and never reads provider credentials directly.
No browser Supabase access is added, and no credential fields or values are returned
in Admin/page/action payloads. Only identifiers and configuration-status booleans
cross the browser boundary. Configuration checks are local completeness/format
checks; they do not verify credentials against either provider.

Set independent optional environment values from `.env.example`:

- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` and `STRIPE_WEBHOOK_SECRET`.
  Secret/publishable keys must have matching test/live prefixes. The publishable key
  is browser-safe and sent only to Payment Element. The other two remain server-only.
- NETOPIA API v2: `NETOPIA_API_KEY`, `NETOPIA_POS_SIGNATURE`, and explicit
  `NETOPIA_ENVIRONMENT=sandbox` or `live`.

These credential requirements follow [Stripe authentication](https://docs.stripe.com/api/authentication)
and [NETOPIA’s API v2 merchant configuration](https://github.com/netopiapayments/composer#steps-for-start).
Configuration checks verify format and completeness, not remote credential validity.

Admin → Payments → Settings displays each provider as Configured/Not configured. Its single
selector offers configured providers and allows clearing selection to disable online
payment. Selection applies immediately through an authenticated Server Action;
there is no customer-facing provider choice. `payment_provider_settings` is a
singleton starting with NULL `active_provider`; there is no environment-provider
selection or Stripe fallback. Only active Admins can read it through user-scoped
access. The server-only selection RPC rechecks the authoritative actor and records
changes in `payment_provider_changes`; browser roles cannot write settings or call
that RPC. The Next.js Admin service rejects unconfigured activation. Configuration
status is always derived from current server environment, never from stored flags.

Each online commit resolves the selected provider and rechecks configuration. The
atomic creation RPC takes a shared lock on the singleton and rejects an absent or
different selection before inserting any rows. Provider switching takes an exclusive
lock on the same row, giving new attempts a consistent provider snapshot. A selection
race returns a safe retry message; it never silently routes the payment elsewhere.
Removing a selected provider’s credentials disables online payment, even when the
other provider is configured. Existing attempts and trusted settlement keep using
their stored provider. Pay at club availability remains independent and location-scoped.

The unreleased foundation migration leaves legacy method/collection unknown
and creates no legacy `due` records. New checkout rows carry explicit method/provider
snapshots. Genuine payment attempts must be preserved during any data correction.

## Local validation

Apply migrations in order with `supabase migration up --local` (no reset).
Run `npm run lint` and `npm run build`, then the focused lifecycle check:

```sh
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run tests/integration/payment-foundation.integration.test.ts --no-file-parallelism
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run tests/integration/payment-provider-settings.integration.test.ts --no-file-parallelism
npx vitest run tests/unit/payment-provider-configuration.test.ts tests/unit/customer-booking.test.ts tests/unit/customer-booking-action.test.ts tests/components/booking-calendar.test.tsx tests/components/admin-locations.test.tsx
```

## Stripe one-time checkout

The server-only Stripe module lives under `src/lib/payments/providers/stripe`.
`OnlinePaymentAdapter` exposes provider-neutral intent creation inputs/results;
booking code never imports Stripe SDK types. The installed Stripe SDK v23 uses
`allowed_payment_method_types: ["card"]`; card-only Payment Element keeps this
short-hold flow free of delayed bank-payment methods. See [PaymentIntent creation](https://docs.stripe.com/api/payment_intents/create)
and [raw-body webhook verification](https://docs.stripe.com/webhooks).

`commitCustomerCheckout` wraps the existing atomic booking writer. After commit,
`startOnlineCheckout` rereads the stored attempt's provider, amount and currency,
creates an intent with stable idempotency key `court-payment-<attempt-id>` and
metadata `payment_attempt_id`, and registers the intent before exposing its client
secret. It does not extend the hold. Failed/ambiguous intent creation leaves the
unconfirmed hold to expire; no success or external total is inferred.

`POST /api/payments/stripe/webhook` verifies the raw request body and Stripe signature,
translates supported PaymentIntent success/failure/cancellation events, and delegates
to `processOnlinePaymentEvent`. Other events and unrelated metadata are ignored.
The service-role-only transaction validates the registered intent, provider and
financial snapshot, locks in the existing booking/reservation order, and commits
settlement plus `payment_provider_events` receipt together. Same-event delivery and
different success events for the same attempt cannot duplicate confirmation mail.
Out-of-order failure cannot downgrade a settled success. A retryable card decline
(`requires_payment_method`) records a `retryable_failed` provider event but retains
the same pending attempt, booking, hold, PaymentIntent and original expiry so another
card can be entered. Terminal Stripe cancellation records attempt status `cancelled`,
marks the internal booking `expired`, and releases its reservation immediately.
Neither transition sends a booking cancellation email. Expiry also releases the hold
without creating customer activity; expiry cleanup during polling invalidates `/book`.
My Activity's owner projections include only confirmed/cancelled booking states,
and online rows require a succeeded payment attempt. Only subsequent cancellation
of a confirmed booking creates Cancelled history and a cancellation notification.

Late successful charges and amount mismatches are durably recorded with
`reconciliation_required = true` and a structured server log. They do not reclaim
occupancy or send confirmation. Inspect these private ledger rows through trusted
operations and reconcile the financial outcome manually. This implementation has
no refund or automated reconciliation action.

The UI polls a Server Action using a random 256-bit checkout capability whose SHA-256
hash is stored on the attempt. The action returns only that checkout's lifecycle,
stored total/currency and confirmation policy. It runs authoritative expiry cleanup;
Stripe's browser result alone never confirms a booking. No Supabase browser access
is introduced; browser-supplied payment status is never accepted. Both provider configurations remain
independent, but NETOPIA has no adapter yet, so selecting it makes customer online
checkout unavailable without falling back to Stripe. Pay at club stays independent.

Closing the payment dialog (including Escape) or choosing Cancel payment asks:
“Cancel payment? Your held court will be released.” Confirmation calls a
capability-verified Server Action. The adapter cancels the stored Stripe PaymentIntent
with stable abandonment idempotency before the existing same-row settlement transaction
marks the internal booking expired and releases the hold. The attempt remains stored;
no customer cancellation, History activity or cancellation email is created. The action
revalidates `/book`, then the UI clears the checkout/selection and refreshes the calendar.
Declines or choosing Keep paying retain the same checkout and original expiry. Provider
failure keeps the dialog open with an error; processing/completed payment cannot be
abandoned or have its occupancy released by this action.

Focused checks (external intent creation is mocked; signatures and local DB are real):

```sh
npx vitest run tests/unit/stripe-adapter.test.ts tests/unit/payment-provider-configuration.test.ts tests/unit/customer-booking-action.test.ts tests/components/booking-calendar.test.tsx
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run tests/integration/stripe-payment.integration.test.ts tests/integration/payment-foundation.integration.test.ts tests/integration/payment-provider-settings.integration.test.ts --no-file-parallelism
```

Manual service-level verification used real Stripe test-mode PaymentIntents against
isolated local Supabase fixtures: declined card retained the intent/hold, a second
card confirmed the same booking, terminal cancellation released occupancy, simulated
hold expiry hid the checkout, and only cancellation after confirmation produced
Cancelled History and a cancellation outbox event. Browser Payment Element entry and
live Stripe webhook forwarding were not exercised in that verification; focused
integration tests cover raw signature verification and webhook handling.

For browser verification, configure actual account values
in ignored `.env.local`, not source code or chat:

- `STRIPE_SECRET_KEY=sk_test_…`
- `STRIPE_PUBLISHABLE_KEY=pk_test_…` from the same account
- `STRIPE_WEBHOOK_SECRET=whsec_…` from the local Stripe CLI listener
- `APP_URL=http://localhost:3000` and the existing local Supabase variables
- existing `BOOKING_MAIL_FROM`, `BOOKING_SMTP_HOST`, `BOOKING_SMTP_PORT` and
  `BOOKING_SMTP_SECURE` for the separate notification worker

For the future authorized verification, run `stripe listen --events payment_intent.succeeded,payment_intent.payment_failed,payment_intent.canceled --forward-to http://localhost:3000/api/payments/stripe/webhook`,
copy that listener's signing secret into `.env.local`, and restart Next.js.
Select Stripe in Admin → Payments → Settings and run `npm run mail:worker`. Book an available
interval: another visitor must see it blocked, and no confirmation email may exist
before successful settlement. Use Stripe test success card `4242 4242 4242 4242`
and decline card `4000 0000 0000 0002` with future expiry and any valid CVC.
Success must retain both internal row IDs and create one Mailpit confirmation;
a decline must stay pending, retain occupancy and permit a different card on the
same intent without a History row. Cancel an unpaid PaymentIntent in Stripe: the
slot must become available immediately and both My Activity lists must omit it. Replay a captured success
webhook with Stripe CLI/dashboard resend and verify one outbox confirmation.
Leave an unpaid checkout beyond ten minutes and verify availability returns with
no activity or cancellation email. After a successful payment, verify the booking
appears in Bookings; cancel that confirmed booking and verify it moves to History
as Cancelled with one cancellation notification.
A success after expiry must record reconciliation without displacing a replacement
booking. Test instructions follow [Stripe's testing guide](https://docs.stripe.com/testing).

## Separation of booking and payment state

Booking state and payment state are independent.

Expected payment states may include:

```text
unpaid
processing
paid
failed
partially_refunded
refunded
```

Do not assume:

```text
one booking = one financial transaction
```

A booking may have multiple financial operations:

```text
Booking
├── original payment
├── rescheduling surcharge
└── partial refund
```

## Stripe responsibilities

Stripe owns payment processing and subscription billing state.

The browser must not determine authoritative:

- price;
- discount;
- refund amount;
- payment status;
- membership entitlement;
- remaining credits.

The server independently calculates or retrieves authoritative values.

Use Stripe idempotency mechanisms for retryable operations.

## Webhooks

Stripe webhooks are authoritative for asynchronous Stripe state changes.

Potential event categories include:

- payment succeeded;
- payment failed;
- refund created/updated;
- subscription created/updated/cancelled;
- invoice paid;
- invoice payment failed.

Webhook processing must:

1. verify the Stripe signature;
2. process only supported event types;
3. be idempotent;
4. persist processed event IDs where appropriate;
5. safely handle duplicate delivery.

Conceptual flow:

```text
Stripe webhook
→ verify signature
→ inspect event ID
→ already processed?
    yes → acknowledge
    no  → process
→ persist state
→ store event ID
```

Never assume Stripe delivers an event exactly once.

## Refunds

Refund logic is an application decision derived from booking/payment state and cancellation policy.

Protect against:

- duplicate refunds;
- refunds greater than paid amount;
- refunds for unpaid transactions;
- unauthorized refund operations.

Use transactional persistence where multiple local state changes must remain atomic.

## Memberships

Potential plan categories:

- Standard;
- Premium;
- Coaching;
- Court Credits.

Possible benefits:

- booking discounts;
- included court time;
- coaching credits;
- advance booking access;
- priority booking;
- other configurable entitlements.

Stripe handles subscription billing.

Application code determines the actual entitlement rules.

Example:

```text
Stripe:
subscription active

Application:
Premium Membership
├── court discount
├── coaching credits
└── booking-ahead limit
```

Do not treat `Stripe subscription = active` as complete application authorization.

## Membership credits

If consumable credits are introduced, prefer a ledger/transaction model rather than relying only on one mutable balance field.

Credit consumption may require an atomic database operation together with booking confirmation or another protected workflow.

## Stripe cancellation refunds

Migration `20261006100000_stripe_booking_refunds.sql` adds `payment_refunds`, RLS with
no browser database access, unique booking/attempt references and immutable financial
snapshots. Amount/currency/provider/payment ID must exactly match a succeeded original
Stripe attempt. Historical attempt status remains succeeded; refund status is separate.

Owner cancellation uses existing ownership/notice/start guards and always requests a
full Stripe refund. Admin cancellation still requires before-start eligibility and an
explicit Refund full payment checkbox decision. No cutoff-based Admin refund inference
occurs. Pay-at-club and legacy unpaid cancellations create no refund.

Cancellation, occupancy release, refund request and existing cancellation email commit
in one transaction. Mail snapshots say the full refund was requested, without promising
provider completion. The post-commit server-only service reads the refund snapshot and
uses the original provider adapter, independent of current provider selection.

Lifecycle:

- `pending`: durable request or provider refund awaiting completion.
- `pending_retry`: provider/read/write response was incomplete or ambiguous; safe to retry.
- `succeeded`: provider confirmed the full refund.
- `failed`: provider returned a terminal failed/cancelled refund; contact the club.

`processBookingRefund(refundId)` is the server-only retry/reconciliation operation; it
has no customer/public retry endpoint or scheduled worker. Focused Admin recovery
actions are described below. Repeating an authorized
cancellation reuses the existing refund and invokes this operation. Accepted provider
refund IDs are retrieved on subsequent attempts, never replaced. No replacement provider refund is created after a terminal failure. Admin may
explicitly retry the same record and recheck a known provider refund. Booking and reservation stay cancelled in every state.

Stripe creation uses `court-payment-refund-<persisted-refund-id>` and metadata
`payment_refund_id`. Before creation, the adapter paginates refunds for the original
PaymentIntent to recover an accepted response even beyond Stripe's 24-hour idempotency
retention. It always requests the entire captured amount, so Stripe's remaining-amount
validation additionally prevents a duplicate full refund. Pending refunds become final
on a later invocation; asynchronous refund webhook processing is not part of this flow.
No payment attempt/provider history is rewritten. No current pricing or client amount
is accepted. NETOPIA refunds and partial refunds are not supported.

Focused verification:
```bash
npx vitest run tests/unit/stripe-refund-adapter.test.ts tests/unit/customer-self-cancellation-service.test.ts tests/components/reservation-calendar.test.tsx
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run tests/integration/stripe-refunds.integration.test.ts --no-file-parallelism
npm run typecheck
```
The adapter test mocks Stripe SDK calls; the integration test uses local PostgreSQL and
a mocked provider adapter, with no fake Stripe secret keys or configuration assertions.

## Admin transaction review

`/admin/payments` shows persisted Transactions with focused Stripe recovery actions. `/admin/payments/settings`
contains the existing provider configuration/selection UI. Both use the shared
Payments submenu and require an active Admin account.

`listAdminPaymentTransactions` uses a user-scoped server client and the Admin-only
`list_admin_payment_transactions` read RPC added by
`20261006110000_admin_payment_transactions.sql`. No financial table SELECT grants,
privileged transaction reader or browser Supabase client are introduced.
The helper is needed to select one logical lifecycle, join its refund and filter/sort
before fixed 20-row pagination. It returns only explicitly selected payment,
customer, reservation and refund snapshots plus reconciliation outcomes/reasons.
It never returns checkout tokens, provider event payloads or credentials.

Selection prefers the refund's original payment attempt, otherwise the earliest
succeeded attempt, otherwise the newest attempt, with an ID tie-breaker. Legacy
bookings without attempts retain their persisted booking amount/currency and unknown
payment status/provider; no payment history is fabricated. Any explicitly flagged
provider event across the booking's attempts is included for review.

Attention means refund `pending_retry` or `failed`, or at least one persisted
`payment_provider_events.reconciliation_required = true` event. Normal paid, pending
refund, failed-card, abandoned and expired checkout states do not independently
require attention. The TypeScript read model derives this flag; the database applies
the same predicate for the Attention filter before pagination.

Date, amount and stored payment status can be sorted with deterministic booking-ID
tie-breaking. Search is a case-insensitive literal substring of customer name/email,
booking UUID or selected provider payment ID. Filters apply immediately and search
uses the existing debounced URL navigation pattern. Pagination/sort links preserve
filters. Payment timestamps display UTC; booking schedules retain location timezone.

Rows open shared dialogs with read-only fields with payment/booking/refund details and recorded
attention reasons. Persisted refund error codes are translated to safe descriptions.
The only recovery controls are the focused Stripe actions described below; there is
no generic manual state editing.

Focused verification:
```bash
npx vitest run tests/components/admin-payment-transactions.test.tsx
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run tests/integration/admin-payment-transactions.integration.test.ts --no-file-parallelism
npm run typecheck
```

## Admin Stripe refund recovery

Migration `20261006120000_admin_stripe_reconciliation.sql` adds `resolved_at` and
`resolved_by_user_id` to provider events, and token/until/actor lease columns on
refunds. It extends full-refund validation only for verified late Stripe captures:
matching original attempt/payment ID/amount/currency, succeeded provider evidence,
expired/cancelled/failed settlement, non-confirmed booking and released/cancelled
original reservation. Amount mismatches and other reconciliation problems are
ineligible. Historic attempts and occupancy never change.

The detail dialog offers Retry refund only for Stripe pending_retry/failed records.
The service reauthorizes an active Admin and applies the shared TypeScript Stripe
refund policy. `claim_refund_command` locks booking, reservation, original attempt/event
and refund, fences the expected snapshots, validates the relationships and claims
a lease using the duration supplied by TypeScript. Refund captured payment is offered only for the verified
late-capture condition and creates/reuses the unique full-refund record. Inputs are
IDs only. A concurrent live claim returns an in-progress error; an interrupted claim
can be reclaimed after expiry. No transaction spans a Stripe HTTP request.

The existing adapter uses the same original PaymentIntent, refund financial snapshot,
metadata recovery and `court-payment-refund-<refund-id>` idempotency key. A known
provider refund is retrieved rather than replaced, including a terminal failed
provider refund; it remains failed if the provider still reports failure. Definite
invalid Stripe refund requests persist failed, ambiguous failures persist pending_retry,
and accepted pending refunds persist pending. Customer/default refund behavior is
unchanged. These actions introduce no NETOPIA flow or background retries.

The service-only, token-scoped `commit_refund_result` atomically persists the supplied
provider result and explicit event-resolution IDs selected by TypeScript after success.
It checks immutable captured evidence and records the verified requesting Admin's identity. Refund failure
or pending keeps event flags true. Repeated late-success resolution after success
reuses the completed refund and does not rewrite resolution timestamps/actors.
Browser database roles cannot submit provider evidence or invoke the finish RPC.

The dialog reloads its authoritative transaction after every handled action, shows
inline feedback, disables actions while pending and refreshes the filtered table.
Resolved events remain visible with their resolution timestamp; resolved flags no
longer contribute to Attention. Filtering/sorting/pagination semantics are unchanged.

Focused verification:
```bash
npx vitest run tests/unit/stripe-refund-adapter.test.ts tests/components/admin-payment-transactions.test.tsx
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run tests/integration/admin-stripe-reconciliation.integration.test.ts tests/integration/admin-payment-transactions.integration.test.ts tests/integration/stripe-refunds.integration.test.ts --no-file-parallelism
npm run typecheck
```

## TypeScript decision and persistence boundary

The final command API is established by migrations `20261006130000` through
`20261006170000`. Checkout, cancellation/refunds, payment settlement, webhook
interpretation, rescheduling quotes and recovery eligibility are TypeScript decisions.
The RPCs `commit_checkout`, `commit_booking_cancellation`,
`commit_payment_transition`, `commit_booking_reschedule`, `claim_refund_command` and
`commit_refund_result` accept authoritative server commands and optional supplied
outbox snapshots. They preserve row locks, expected-state/actor/configuration fences,
financial immutability, uniqueness, GiST protection and atomic multi-row persistence.
Webhook receipts and lifecycle changes commit together; duplicate evidence is immutable.
All mutation commands are service-role-only. Stripe requests remain outside transactions.
The retired workflow RPCs are dropped; there is no fallback path.
