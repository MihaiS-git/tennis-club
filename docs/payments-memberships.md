# Payments and Memberships

## Implemented payment lifecycle foundation

Online payment is the default. Admin → Locations → Booking policy may enable
`allow_pay_at_club`, which defaults OFF for existing and new locations. The public
location read exposes this boolean, while TypeORM Transaction A rechecks it under a
location row lock. Contact, amount and currency snapshots still come from the
server-side booking service and existing TypeScript calendar pricing calculation using transaction-authoritative facts.

The current `booking_revisions` row is authoritative for commercial terms,
including the required `online` or `pay_at_club` payment method. Booking identity
and ownership are permanent; court occupancy remains separate and mutable.
See [booking contracts](booking-domain.md#implemented-immutable-booking-contracts).
Online commits
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
provider changes do not modify old attempts; focused TypeScript commands preserve
an existing attempt’s method/provider. Pay at club has no provider/reference.
There is at most one pending attempt per booking and one charge
per adjustment; provider references are unique
within each provider. Payment attempts have no browser-role grants.

The initial hold duration is centralized as `paymentHoldDurationSeconds` in
`src/lib/payments/domain.ts` (10 minutes). PostgreSQL calculates expiry from its
wall clock. `held` and `active` reservation rows share the existing GiST overlap
constraint. All public/staff/edit occupancy reads use database-time expiry checks,
so expired holds disappear from availability without browser timers. TypeScript releases
expired pending booking/attempt/hold aggregates before reservation writes, under
location-first TypeORM transactions. Polling uses bounded SKIP LOCKED expiry and never
calls a SQL lifecycle function. Busy rows can cause a safe overlap rejection and a
later attempt retries cleanup. No background scheduler is required for availability.

`settleOnlinePayment` is a server-only operation for **verified** provider
adapters. The Stripe webhook calls the common event operation, which reuses this
settlement transaction; no browser-callable settlement action exists. Its TypeORM
READ COMMITTED transaction takes the shared configuration fence, then locks
location → booking → reservation → attempt and validates the stored provider/reference.
A timely success confirms the same booking/reservation and sends one post-commit confirmation
email. Failure/expiry releases the same reservation and marks the booking/attempt
failed/expired. A late success cannot reclaim a released or replaced interval.
Duplicate settlement returns the existing terminal status and emits no extra email.
Pending/failed/expired checkouts never emit confirmation mail or appear as confirmed
personal bookings. Pay at club records a confirmed revision at creation and sends
confirmation mail after commit.

NETOPIA integration/refunds, credential UI, saved cards, deposits, subscriptions
and packages remain unimplemented. The sections below distinguish the current
one-time Stripe flow from future membership scope.

## TypeORM checkout boundary

Transaction A takes shared configuration advisory fence → location FOR UPDATE, loads
publication/hours/coverage/pricing facts, then fences the linked active account and
locks online provider settings FOR SHARE. TypeScript calculates policy and price. The
reservation, booking and attempt insert atomically; Pay-at-club confirmation email follows commit.
Guest name/email/phone remain required trimmed snapshots; email case is preserved.
Online creation emits no confirmation email and shares one PostgreSQL +600-second deadline.

Stripe initialization uses the stored attempt after commit, outside any transaction.
Transaction B conditionally attaches provider reference/capability hash. Coupled policy
and capability reads use TypeORM. Polling runs the TypeScript hold-expiry service;
settlement/webhooks use Phase 7 TypeORM transactions; refunds/reconciliation use TypeORM (Phase 8), and booking emails use post-commit Brevo HTTP delivery.
Public `/book` discovery/calendar use bounded TypeORM projections (Phase 11).

There is no customer-submission idempotency key: identical same-slot submissions compete
and GiST decides the winner. Stripe's attempt-derived idempotency key does not make booking
submission idempotent. Provider success followed by local attachment failure has no complete
automatic recovery/resume workflow. No client secret is exposed on initialization failure;
the committed hold expires normally. There is no replacement booking/attempt or new recovery
worker. A lost attachment acknowledgement may leave a registered capability unavailable to
the caller; this limitation is preserved, not fixed.

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
selection or Stripe fallback. Only active Admins can read it through TypeORM after explicit authorization.
The server-only READ COMMITTED transaction fences actor roles/account before locking
the singleton FOR UPDATE and records changes atomically in `payment_provider_changes`.
Same-value selection preserves its timestamp and creates no audit row; missing singleton
fails safely. Stored selection remains visible even when the provider is unconfigured.
Browser roles cannot write provider settings. The Next.js Admin service rejects unconfigured activation. Configuration
status is always derived from current server environment, never from stored flags.

Each online commit resolves the selected provider and rechecks configuration. The
TypeORM creation transaction takes a shared lock on the singleton and rejects an absent,
unconfigured or unsupported selection before inserting any rows. Provider switching takes an exclusive
lock on the same row, giving new attempts a consistent provider snapshot. A selection
race is serialized by the settings row lock; it never silently routes the payment elsewhere.
Removing a selected provider’s credentials disables online payment, even when the
other provider is configured. Existing attempts and trusted settlement keep using
their stored provider. Pay at club availability remains independent and location-scoped.

The three consolidated development migrations contain no historical backfill or
legacy commercial columns. Checkout rows carry explicit revision method and attempt provider
snapshots. Genuine payment attempts must be preserved during any data correction.

## Local validation

Use only the disposable `tennis-club-tests` project and guarded runner described in
[testing](testing.md#isolated-local-integration-and-e2e-environment). Do not load
development `.env.local` or rebuild the development database for these checks.

```sh
npm run test:integration -- tests/integration/payment-foundation.integration.test.ts
npm run test:integration -- tests/integration/payment-provider-settings.integration.test.ts
npx vitest run tests/unit/customer-booking.test.ts tests/unit/customer-booking-action.test.ts tests/components/booking-calendar.test.tsx tests/components/admin-locations.test.tsx
```

## Stripe one-time checkout

The server-only Stripe module lives under `src/lib/payments/providers/stripe`.
`OnlinePaymentAdapter` exposes provider-neutral intent creation inputs/results;
booking code never imports Stripe SDK types. The installed Stripe SDK v23 uses
`allowed_payment_method_types: ["card"]`; card-only Payment Element keeps this
short-hold flow free of delayed bank-payment methods. See [PaymentIntent creation](https://docs.stripe.com/api/payment_intents/create)
and [raw-body webhook verification](https://docs.stripe.com/webhooks).

`commitCustomerCheckout` wraps TypeORM Transaction A. After commit,
`startOnlineCheckout` rereads the stored attempt's provider, amount and currency,
creates an intent with stable idempotency key `court-payment-<attempt-id>` and
metadata `payment_attempt_id`, and registers the intent before exposing its client
secret through TypeORM Transaction B (booking FOR UPDATE → attempt FOR UPDATE). Attachment
can retain the provider reference after expiry without reopening occupancy. A final attempt/deadline recheck withholds the client secret and attempts provider cancellation when initialization outlives the hold. It does not extend the hold. Failed/ambiguous intent creation leaves the
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
and online rows require a succeeded payment attempt. A cancellation that races capture may appear in Cancelled history; an uncharged checkout does not. Normal owner/Admin booking cancellation retains its existing cancellation notification.

Late successful charges and amount mismatches are durably recorded with
`reconciliation_required = true` and a structured server log. They do not reclaim
occupancy or send confirmation. Inspect these private ledger rows through trusted
operations and use the existing Admin reconciliation/refund actions. Exact captures after an explicit checkout cancellation also prepare and execute the existing full refund automatically. Amount mismatches remain an Admin investigation.

The UI polls `POST /api/payments/checkout/status` using a random 256-bit checkout capability whose SHA-256
hash is stored on the attempt. The Route Handler delegates to the existing checkout service and returns only that checkout's lifecycle,
stored total/currency, confirmation policy, payment/refund status and uncertainty. Polling uses abortable ten-second requests outside the sequential Server Action dispatcher, so a stalled poll cannot queue cancellation behind it. Provider observation requests have a three-second timeout with no SDK retries. Pending or expired attempts are checked against Stripe outside database transactions, validating intent identity and metadata. Terminal provider observations pass through the same settlement service with stable durable receipt IDs, so a missing local webhook listener does not leave an open checkout waiting indefinitely. Delayed webhooks still deduplicate normally. It runs authoritative expiry cleanup;
Stripe's browser result alone never confirms a booking. No Supabase browser access
is introduced; browser-supplied payment status is never accepted. Both provider configurations remain
independent, but NETOPIA has no adapter yet, so selecting it makes customer online
checkout unavailable without falling back to Stripe. Pay at club stays independent.

X, Close and Escape dismiss the checkout immediately, including during provider calls or cancellation. Dismissal makes no claim that payment was cancelled, clears loading feedback, and ignores late action/Stripe/polling callbacks. An uncertain outcome is shown without encouraging another payment.

Cancel payment has a separate confirmation. Confirmation unmounts the active payment form, preventing submissions and late UI confirmation. The capability-authorized command records booking cancellation intent under location → booking → reservation → attempt locks before contacting Stripe. A completed booking may be undone through this capability only within its original hold deadline; later cancellation uses the normal booking-management authorization and policy. No Auth or provider call occurs inside a transaction.

Checkout abandonment records a cancelled revision and releases occupancy before
contacting Stripe; the attempt may remain pending while the provider outcome is
uncertain. The adapter uses stable abandonment idempotency and retrieve-after-failure
recovery. An exact capture racing cancellation preserves that cancelled contract,
records capture evidence and creates its compensation obligation. Refund retry and
Admin reconciliation remain available. Guest requests use the same capability and
a nullable refund requester. This operation sends no confirmation or customer-
cancellation email after cancellation intent commits.

Expiry ends payment entry locally even when the status endpoint is unavailable. Server expiry retains the original release/late-capture reconciliation policy, including for held bookings with cancellation intent. Expired attempts cannot be reused; polling attempts provider cancellation when possible. Keep paying is available only for a usable checkout before cancellation starts. A definite card decline permits retry on the original unexpired intent; transport/unknown errors block further submissions. Payment loading feedback becomes a non-blocking uncertainty warning after 30 seconds; booking submission and cancellation loading are bounded at 15 seconds. Customers can always leave while webhooks and existing server/Admin reconciliation handle the financial outcome.

Focused checks (external intent creation is mocked; signatures and local DB are real):

```sh
npx vitest run tests/unit/stripe-adapter.test.ts tests/unit/customer-booking-action.test.ts tests/components/online-payment.test.tsx tests/components/booking-calendar.test.tsx
npm run test:integration -- tests/integration/stripe-payment.integration.test.ts tests/integration/payment-foundation.integration.test.ts tests/integration/db/checkout.integration.test.ts tests/integration/stripe-refunds.integration.test.ts tests/integration/admin-stripe-reconciliation.integration.test.ts
```

Manual service-level verification used real Stripe test-mode PaymentIntents against
isolated local Supabase fixtures: declined card retained the intent/hold, a second
card confirmed the same booking, terminal cancellation released occupancy, simulated
hold expiry hid the checkout, and only cancellation after confirmation produced
Cancelled History and a post-commit cancellation email. Browser Payment Element entry and
live Stripe webhook forwarding were not exercised in that verification; focused
integration tests cover raw signature verification and webhook handling.

For browser verification, configure actual account values
in ignored `.env.local`, not source code or chat:

- `STRIPE_SECRET_KEY=sk_test_…`
- `STRIPE_PUBLISHABLE_KEY=pk_test_…` from the same account
- `STRIPE_WEBHOOK_SECRET=whsec_…` from the local Stripe CLI listener
- `APP_URL=http://localhost:3000` and the existing local Supabase variables
- server-only `BREVO_API_KEY` and Brevo-verified `BOOKING_MAIL_FROM` for notifications

For the future authorized verification, run `stripe listen --events payment_intent.succeeded,payment_intent.payment_failed,payment_intent.canceled --forward-to http://localhost:3000/api/payments/stripe/webhook`,
copy that listener's signing secret into `.env.local`, and restart Next.js.
Select Stripe in Admin → Payments → Settings. Book an available
interval: another visitor must see it blocked, and no confirmation email may exist
before successful settlement. Use Stripe test success card `4242 4242 4242 4242`
and decline card `4000 0000 0000 0002` with future expiry and any valid CVC.
Success must retain both internal row IDs and create one Mailpit confirmation;
a decline must stay pending, retain occupancy and permit a different card on the
same intent without a History row. Cancel an unpaid PaymentIntent in Stripe: the
slot must become available immediately and both My Activity lists must omit it. Replay a captured success
webhook with Stripe CLI/dashboard resend and verify one confirmation email.
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

The initial TypeORM migration defines `payment_refunds` with denied browser access,
per-attempt operation uniqueness, immutable obligation terms/reasons and a required
contractual revision reference. TypeScript allocates from verified captured funds,
reserving every existing obligation; amount may cover part or all of one capture.
Original payment requests remain unchanged; refund processing status is separate.

Owner cancellation uses existing ownership/notice/start guards and always requests a
refund of remaining captured funds after existing obligations. Admin cancellation
requires before-start eligibility and automatically creates applicable online
refund obligations. Pay-at-club cancellation creates no refund.

Cancellation, occupancy release, refund request and existing cancellation email commit
in one transaction. Mail snapshots say the full refund was requested, without promising
provider completion. Post-commit processing uses the shared execution protocol described
in [architecture](architecture.md#refund-execution-and-reconciliation-phase-8).

Lifecycle:

- `pending`: durable request or provider refund awaiting completion.
- `pending_retry`: provider/read/write response was incomplete or ambiguous; safe to retry.
- `succeeded`: provider confirmed the full refund.
- `failed`: provider returned a terminal failed/cancelled refund; contact the club.

`processBookingRefund(refundId)` is the server-only retry/reconciliation operation; it
has no customer/public retry endpoint or scheduled worker. Focused Admin recovery
actions are described below. Repeating an authorized
cancellation reuses the existing obligation and execution. Known provider refund IDs
are retrieved; otherwise paginated metadata discovery uses both `payment_refund_id` and
`refund_execution_id`. Empty recovery and lookup failure never authorize creation.

New READY executions store `court-refund-execution-<execution-id>` as their exact key.
Dispatch initiation commits before the HTTP request. Pending acceptance is not money
refunded. Verified failure/rejection remains immutable and permits an authorized Admin
retry using a distinct execution/key for the same obligation. Automatic terminal results
short-circuit. Network uncertainty, local result-write failure, lease takeover and crash
recovery retain the same execution. The dispatch-to-HTTP crash gap can remain unresolved;
no application creation replay relies on indefinite provider idempotency retention.

No payment attempt/provider history is rewritten. No current pricing or client amount
is accepted. Partial booking-reduction refunds are supported; NETOPIA refunds are not.

Focused verification:
```bash
npx vitest run tests/unit/stripe-refund-adapter.test.ts tests/unit/customer-self-cancellation-service.test.ts tests/components/reservation-calendar.test.tsx
npm run test:integration -- tests/integration/stripe-refunds.integration.test.ts
npm run typecheck
```
The adapter test mocks Stripe SDK calls; the integration test uses local PostgreSQL and
a mocked provider adapter, with no fake Stripe secret keys or configuration assertions.

## Admin transaction review

`/admin/payments/transactions` shows persisted Transactions with focused Stripe recovery actions. `/admin/payments/settings`
contains the existing provider configuration/selection UI. Both use the shared
Payments submenu and require an active Admin account.

`listAdminPaymentTransactions` authorizes with `requireActiveAdmin`, then executes a
parameterized TypeORM projection/count query over every payment attempt and refund.
Each operation retains its own ID, captured/requested amount, currency, provider,
status and timestamps. Original and adjustment payments are separate rows; reduction
refunds are identified as partial booking refunds even when they exhaust one additional
capture. A payment is marked fully refunded only when successful refunds against that
attempt cover its entire captured amount. Booking totals, captured/refunded/net amounts
and outstanding/refund obligations remain visible in the shared financial details.
Transaction context uses the operation's historical revision or immutable proposal,
while current totals and debt appear separately under Current booking summary.
Pay-at-club rows are uncollected requests, not captured money. Any booking without
an attempt uses its initial revision as request context; no attempt is fabricated.

`/admin/payments/transactions/payment/<attempt-id>` and
`/admin/payments/transactions/refund/<refund-id>` are Admin-authorized details using the
same projection and recovery components. Direct links, refresh and Back/Forward use
actual financial identity; list filters/sort/page are retained on the return link.
Refund retries re-read the selected refund, never an arbitrary booking-level row.
Money display accepts zero balances while payment/pricing input validation remains
strictly positive.

Attention means refund `pending_retry` or `failed`, or at least one persisted
`payment_provider_events.reconciliation_required = true` event. Normal paid, pending
refund, failed-card, abandoned and expired checkout states do not independently
require attention. The TypeScript read model derives this flag; the database applies
the same predicate for the Attention filter before pagination.

Date, amount and stored transaction status can be sorted with deterministic kind/ID
tie-breaking. Search is a case-insensitive literal substring of customer name/email,
booking UUID, transaction UUID or provider payment/refund ID. Filters apply immediately and search
uses the existing debounced URL navigation pattern. Pagination/sort links preserve
filters. Payment timestamps display UTC; booking schedules retain location timezone.

Rows open URL-addressable details with payment/booking/refund fields and recorded
attention reasons. Persisted refund error codes are translated to safe descriptions.
The only recovery controls are the focused Stripe actions described below; there is
no generic manual state editing.

Focused verification:
```bash
npx vitest run tests/components/admin-payment-transactions.test.tsx
npm run test:integration -- tests/integration/admin-payment-transactions.integration.test.ts
npm run typecheck
```

## Admin Stripe refund recovery

The initial TypeORM migration adds `resolved_at` and
`resolved_by_user_id` to provider events, and token/until/actor lease columns on
refunds. It extends full-refund validation only for verified late Stripe captures:
matching original attempt/payment ID/amount/currency, succeeded provider evidence,
expired/cancelled/failed settlement, non-confirmed booking and released/cancelled
original reservation. Amount mismatches and other reconciliation problems are
ineligible. Historic attempts and occupancy never change.

The detail dialog offers Retry refund only for Stripe pending_retry/failed records.
The service reauthorizes an active Admin and applies the shared TypeScript Stripe
refund policy. TypeORM preparation locks booking → reservation → selected attempt →
events ordered by provider,event_id → refund FOR UPDATE, then roles ordered by role_code →
account FOR SHARE. It rechecks active Admin authority and financial relationships and
claims a five-minute token/actor lease using PostgreSQL clock_timestamp(). Refund captured payment is offered only for the verified
late-capture condition and creates/reuses the unique full-refund record. Inputs are
IDs only. A concurrent live claim returns an in-progress error; an interrupted claim
can be reclaimed after expiry. No transaction spans a Stripe HTTP request.

Automatic and Admin processing share immutable refund executions and five-minute
execution leases. Preparation locks booking → reservation → selected attempt → ordered
capture receipts → refund obligation → execution; Admin preparation also fences the
active Admin's roles/account. A READY execution's dispatch timestamp commits in a
separate transaction before Stripe is contacted. The adapter uses its stored request,
exact idempotency key, obligation ID and execution ID metadata. Previously dispatched
executions use retrieval or metadata discovery only; lookup failure, an empty search,
lease expiry and a crash do not authorize another creation.

Result transactions retain write-once identity, uncertainty and terminal evidence.
Current lease tokens fence error/check updates and lease clearing; stale workers may
record valid historical provider facts without clearing a newer lease. Verified success
cannot regress. Eligible receipt resolution commits atomically with completion; existing
automatic adjustment and Admin reconciliation attribution rules remain. Admin retry may
allocate a distinct execution only after verified failure or definitive rejection.
Automatic processing retains terminal short-circuits. PaymentRefund stores immutable
obligation terms plus status/timestamps; provider references/errors come from executions.
No refund notifications, scheduled worker, dual writes or provider history JSON remain.

The dialog reloads its authoritative transaction after every handled action, shows
inline feedback, disables actions while pending and refreshes the filtered table.
Resolved events remain visible with their resolution timestamp; resolved flags no
longer contribute to Attention. Filtering/sorting/pagination semantics are unchanged.

Focused verification:
```bash
npx vitest run tests/unit/stripe-refund-adapter.test.ts tests/components/admin-payment-transactions.test.tsx
npm run test:integration -- tests/integration/admin-stripe-reconciliation.integration.test.ts tests/integration/admin-payment-transactions.integration.test.ts tests/integration/stripe-refunds.integration.test.ts
npm run typecheck
```

## TypeScript decision and persistence boundary

Application commands persist through TypeORM repositories. Checkout, cancellation/refunds, payment settlement, webhook
interpretation, rescheduling quotes and recovery eligibility are TypeScript decisions.
Checkout (Phase 5), owner rescheduling and owner/Admin cancellation (Phase 6) now
use TypeORM transactions and focused repositories, as do Phase 7 settlement and Phase 8
refund execution/reconciliation. No generic booking snapshot, actor snapshot or command RPC architecture remains. Stripe requests
remain outside transactions. Refund completion sends no email.

## Customer booking mutations (Phase 6)

Owner rescheduling and owner/Admin cancellation use TypeORM READ COMMITTED transactions.
Reschedule holds shared configuration advisory fence then location UPDATE before booking/reservation UPDATE
locks. Cancellation omits the configuration advisory fence, then locks the booking's
payment attempts and refund obligations in ID order before ordered actor roles/account SHARE locks.
TypeScript makes policy/pricing/refund decisions against those locked facts; snapshot notice
uses the accepted revision's timezone and post-lock database wall time. See [architecture](architecture.md#booking-revisions-and-owneradmin-boundaries).

Cancellation appends an accepted revision, releases occupancy and allocates applicable
remaining captured-funds obligations atomically; email and refund execution follow commit.
The accepted cancellation revision permits replay even without a refund. Admins may
cancel other customers' bookings but cannot reschedule them or select refund/no-refund.
Owners, including Admin/Coach owners, use the same owner rescheduling rules. Same-price
and Pay-at-club saves append revisions directly; online price differences use the
adjustment workflow below. Original attempt facts stay unchanged. Revision UUID and
lossless reservation timestamp provide the contractual and occupancy stale tokens.

Booking mutations use scoped TypeORM commands; schedule-changing saves send the preserved
old/new schedule template after commit.

## TypeORM settlement boundary (Phase 7)

Verified webhook input and trusted receiptless settlement share one transaction. Discover
attempt→booking→location under the shared configuration fence, then lock location → booking → reservation → selected attempt FOR UPDATE and recheck the parent. Validate identity, read the global receipt, then read PostgreSQL wall time. Exact late captures additionally lock/allocate compensation after receipt persistence. Adjustment application also fences its actor; no network calls occur inside this transaction. Financial evidence matches the original attempt amount/currency,
never a rescheduled booking total. Webhooks require an attached exact provider reference.
TypeScript preserves retryable pending, success, terminal failure/cancellation, effective expiry,
late-capture and mismatch decisions. Lossless deadline comparisons are rechecked before writes;
the attempt UPDATE also checks clock_timestamp() against the supplied deadline and lets
TypeScript re-evaluate expiry if crossed. Lifecycle and durable receipt are atomic; first confirmation email follows commit. Late captures keep terminal lifecycle and flag reconciliation; financial mismatch
records evidence only and is not automatically refundable. Other outcomes emit no confirmation.
Global provider/event PK dedupe compares attempt, payment reference, outcome, amount and normalized
currency. Identical events replay stored result without touching Admin resolution. Concurrent
insert conflicts read the committed winner in a separate READ COMMITTED statement; changed
evidence rejects, rolling back provisional lifecycle writes. Distinct events preserve terminal
success and cannot duplicate confirmation.
Abandonment retains capability validation and retrieve/cancel/retrieve outside transactions;
a capability-bound transaction first records cancellation intent. Provider-confirmed cancellation runs the receiptless settlement command; verified captures use the common event transaction and existing full-refund operation. Cancellation intent prevents subsequent booking confirmation.
Payment/refund persistence uses TypeORM transactions with explicit authoritative locks.
TypeScript hold expiry runs under location-first TypeORM transactions.
Booking emails use best-effort Brevo HTTP delivery after commit, without delivery leases or retries.


## Paid-booking price adjustments

Confirmed online bookings use a durable adjustment per requested edit. Each surcharge
is a separate existing payment_attempts row, with its own Stripe reference and stable
idempotency identity. The original booking and captured amounts are preserved while
payment is unresolved. Existing reservation holds protect only target fragments outside
original occupancy; all rows share the existing GiST exclusion. Common authoritative
Stripe observation/webhook settlement rechecks policy, tokens, target price and
availability. Successful verified settlement commits the original-row move and price
atomically; expired/invalid changes keep the original and create durable surcharge
refund obligations. No network call stays in a database transaction.

A permitted decrease creates a partial-refund obligation for the full price difference
and commits the lower booking price/schedule atomically. Allocation uses newest captures
first, reserving every existing pending/failed/successful obligation. Cancellation then
automatically allocates only the remainder for owner or Admin cancellation. Original
captured amounts are never rewritten. Existing refund processing and Admin retry handle
partial obligations; a definitively failed execution retains its immutable provider
reference before an Admin retry allocates a new execution. Uncertain responses retain identity.

Refund allocation is defined once in `src/lib/payments/refund-allocation.ts`. It receives
typed payment requests, obligations and verified capture observations, preserves
newest-capture-first ordering and reserves every obligation regardless of processing
status. Pay-at-club debt and uncertain or mismatched captures cannot fund refunds.
`financials.ts` loads facts and persists the approved allocations through TypeORM within
the caller's existing transaction and booking lock; it never starts a transaction.
Reduction, cancellation, unapplied surcharge compensation, checkout cancellation and
Admin late-capture recovery all use this path. Operation replay retains persisted IDs;
attempt-scoped recovery uses the existing attempt/operation identity. Financial summary
reads perform no provider reconciliation or persistence. Repositories only load/lock
facts and insert supplied amounts/provider identities; adjustment expiry orchestration
lives in the existing TypeScript hold-expiry service.

Authenticated owners reopen My Activity → Edit to recover the same registered intent.
Admins cannot create surcharges for other customers; guest rescheduling is not
implemented. Refresh and repeated submissions do not create a replacement charge.
Admin Financial history lists payment requests/refund obligations with historical
transaction context and separate current-booking totals, supports
refund retry and can check modification payments after the scheduling edit window closes.
There is no background reconciliation worker; verified webhooks, polling, authenticated
recovery and explicit Admin checks use the same settlement/refund services.

See [full implementation report](booking-payment-workflow-audit.md).

## Remaining financial-model work (Task 4)

Immutable booking revisions, refund obligation terms and separate refund executions
are implemented. Obligation summaries retain only status/timestamps. Provider requests,
IDs, uncertainty and terminal evidence are stored on executions.
Authoritative payment captures are now stored separately in
`payment_capture_receipts`. One immutable row represents one provider capture and
records its attempt, provider/payment/capture identities, actual amount/currency and
first/last local observation times. The provider/capture key deduplicates signed
webhooks and verified API reads; successful provider events reference the resulting
receipt. Exact receipt-only late captures survive attempt expiry or booking
cancellation and remain available to the existing compensation/refund allocator.
Payment-request facts, provider-event facts and capture facts have PostgreSQL
immutability guards while their defined processing/status fields remain writable.
An online attempt cannot transition to successful settlement without verified capture
evidence through the common TypeScript settlement service.

Complete immutable refund/return observations and all actual-capture mismatch
reconciliation remain future Task 4 work.

Current reporting summaries still count successfully settled attempts and successful
refund statuses; reporting changes for receipt-only or mismatched captures are
intentionally deferred. Independent scheduled
provider reconciliation is not implemented; recovery uses webhooks, checkout
polling, owner recovery and explicit Admin actions. See the
[historical design and deferred financial proposal](booking-financial-immutability-design.md).
