# Payments and Memberships

Implemented one-time payments: checkout, Stripe, provider selection, captures, refunds,
adjustments, reconciliation and Admin payment actions. Memberships and subscriptions are
planned only (see [Memberships](#memberships-planned)). Booking lifecycle and identities are in
[booking domain](booking-domain.md).

## Implemented payment lifecycle foundation

Online payment is the default. Admin → Locations → Booking policy may enable
`allow_pay_at_club`, which defaults OFF for existing and new locations. The public
location read exposes this boolean, while TypeORM Transaction A rechecks it under a
location row lock. Contact, amount and currency snapshots still come from the
server-side booking service and existing TypeScript calendar pricing calculation using transaction-authoritative facts.

`checkout_records.current_revision_id` is a required same-booking reference to the immutable
`booking_revisions` row authoritative for commercial terms. Its `payment_method` is
required and constrained to `online` or `pay_at_club`; `payment_attempts.method` is
also required. There is no nullable legacy booking payment contract. Booking identity
and ownership are permanent; court occupancy remains separate and mutable.
See [booking contracts](booking-domain.md#immutable-booking-contracts).
Online commits
atomically insert a `pending_payment` internal checkout record, its one `held` court reservation,
and a `pending` payment attempt. No `bookings` row exists yet. Pay at club inserts a
confirmed checkout record, its `bookings` identity with immutable confirmation-revision proof,
an `active` reservation and a `due` payment record. Stripe checkout uses Payment Element inside
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
`src/lib/payments/domain.ts` (5 minutes, court and coaching alike). The countdown starts at
Continue to payment, which creates the hold; timetable selection stays client-side. The
deadline is fixed: no heartbeat or extension. Paid booking modifications keep
`modificationHoldDurationSeconds` (10 minutes). PostgreSQL calculates expiry from its
wall clock. `held` and `active` reservation rows share the existing GiST overlap
constraint. All public/staff/edit occupancy reads use database-time expiry checks,
so expired holds disappear from availability without browser timers. TypeScript releases
expired pending booking/attempt/hold aggregates before reservation writes, under
location-first TypeORM transactions. Polling uses bounded SKIP LOCKED expiry and never
calls a SQL lifecycle function. Busy rows can cause a safe overlap rejection and a
later attempt retries cleanup. Reads hide expired unprotected holds without any scheduler;
the [expiry Cron](#checkout-hold-expiry-sweep) resolves abandoned and registered checkouts.

`settleOnlinePayment` is a server-only operation for **verified** provider
adapters. The Stripe webhook calls the common event operation, which reuses this
settlement transaction; no browser-callable settlement action exists. Its TypeORM
READ COMMITTED transaction takes the shared configuration fence, then locks
location → booking → reservation → attempt and validates the stored provider/reference.
A timely verified capture confirms the same checkout/reservation and inserts exactly one
`bookings` identity in that transaction. Failure/expiry releases the reservation and
marks only the internal checkout/attempt failed/expired. A late success cannot reclaim a released or replaced interval.
Duplicate settlement returns the existing terminal status.
Pending/failed/expired checkouts never appear as confirmed
personal bookings. Pay at club records a confirmed revision at creation and sends
confirmation mail after commit.

NETOPIA integration/refunds, credential UI, saved cards, deposits, subscriptions
and packages remain unimplemented. The sections below distinguish the current
one-time Stripe flow from future membership scope.

## TypeORM checkout boundary

Transaction A takes shared configuration advisory fence → location FOR UPDATE, loads
publication/hours/coverage/pricing facts, then fences the linked active account and
locks online provider settings FOR SHARE. TypeScript calculates policy and price. The
reservation, booking and attempt insert atomically.
Guest name/email/phone remain required trimmed snapshots; email case is preserved.
Online creation shares one PostgreSQL deadline of `paymentHoldDurationSeconds` (5 minutes).

Stripe initialization uses the stored attempt after commit, outside any transaction.
Transaction B conditionally attaches provider reference/capability hash. Coupled policy
and capability reads use TypeORM. Polling runs the TypeScript hold-expiry service;
settlement, webhooks, refunds and reconciliation use TypeORM transactions.

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

The two consolidated development migrations contain no historical backfill or
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

### Manual capture and the checkout deadline

A browser holding a client secret can confirm a PaymentIntent at any time, so with
automatic capture no local deadline check could stop a charge after expiry. Booking
checkouts and modification surcharges therefore both create card PaymentIntents with
`capture_method: "manual"` (the adapter has no automatic option): the customer's
confirmation (including 3D Secure) only **authorizes** the card. Money is collected only
when the server captures:

1. The authorization is observed from a signed `payment_intent.amount_capturable_updated`
   webhook or the customer's status poll; Stripe is always re-read (`requires_capture`).
2. Under location → booking → reservation → attempt locks the server accepts it only if
   the attempt is pending, the booking is still `pending_payment`, the hold is still held,
   the authorized amount/currency match, and PostgreSQL time is before the deadline.
   Acceptance extends the reservation hold to exactly the attempt deadline plus
   `checkoutCaptureGraceSeconds` (120 s). Attempt facts stay immutable; that exact
   extension is the durable acceptance record, so the expiry sweep and a concurrent
   checkout cancellation cannot release the court while Stripe captures, even after
   the operational grace expires. Public and internal occupancy reads retain it.
3. After commit the server captures with idempotency key `court-capture-<attempt-id>`
   and settles the verified result through the normal settlement service. Only the
   request that persisted acceptance dispatches capture; concurrent webhook/poll requests
   read evidence. Stripe's bounded transport retries (including reconnect retries) use
   the same key and belong to this same logical operation. An interrupted capture is
   decided by re-reading the intent, never an application-level capture retry. After
   grace, polling or the Admin check attempts cancellation; occupancy stays held until
   Stripe confirms cancellation or capture. Capture winning that race settles normally.
4. An authorization that arrives after the deadline, for an ended booking, or with a
   mismatched amount is cancelled at Stripe: the card hold is released and nothing is
   charged.

An authorization accepted before the original deadline may complete after the grace:
network dispatch, retries and a delayed response do not invalidate that acceptance.
Occupancy remains held while its outcome is unresolved, and verified success confirms
without refunding solely because the response was late. Genuinely invalid captures
(such as unaccepted late payment or failed policy revalidation) retain compensation. Card authorizations that are never captured or
cancelled (for example if neither webhook nor poll ever reaches the server) are
released by Stripe automatically after its authorization validity period (7 days for
online card payments); they are never charged. Banks may show a released authorization
as pending for a few days. Modification surcharges use the same authorization/capture
service with their own deadline and checks (see Modification payment lifecycle).

`POST /api/payments/stripe/webhook` verifies the raw request body and Stripe signature,
translates supported PaymentIntent success/failure/cancellation events, and delegates
to `processOnlinePaymentEvent`. Other events and unrelated metadata are ignored.
The TypeORM transaction validates the registered intent, provider and
financial snapshot, locks in the existing booking/reservation order, and commits
settlement plus `payment_provider_events` receipt together. Same-event delivery and
different success events for the same attempt cannot duplicate confirmation mail.
Out-of-order failure cannot downgrade a settled success. A retryable card decline
(`requires_payment_method`) records a `retryable_failed` provider event but retains
the same pending attempt, checkout, hold, PaymentIntent and original expiry for modification retries. Initial court and coaching checkout instead re-read Stripe and cancel a still-unused failed intent before releasing the court (and coach) hold; a new card needs a new checkout. Authentication in progress, processing, authorization and unknown outcomes are never treated as a decline. Terminal Stripe cancellation records attempt status `cancelled`,
marks the internal checkout `expired`, and releases its reservation immediately.
Expiry also releases the hold
without creating customer activity; expiry cleanup during polling invalidates `/book`.
My Activity's owner projections include only confirmed/cancelled booking states,
and online rows require a succeeded payment attempt. An abandoned checkout has no booking identity, even if a late capture requires compensation, and never enters booking history.

Late successful charges and amount mismatches are durably recorded with
`reconciliation_required = true` and a structured server log. They do not reclaim
occupancy or send confirmation. An exact late capture (after expiry, failure or explicit
checkout cancellation) commits its full refund obligation in the same transaction as the
capture receipt and queues one `late_payment_refund` customer notice; the refund is
dispatched right after commit, and verified success clears the review flag. Amount
mismatches remain an Admin investigation shown under Needs attention.

The UI polls `POST /api/payments/checkout/status` using a random 256-bit checkout capability whose SHA-256
hash is stored on the attempt. The Route Handler delegates to the existing checkout service and returns only that checkout's lifecycle,
stored total/currency, confirmation policy, payment/refund status and uncertainty. Polling uses abortable ten-second requests outside the sequential Server Action dispatcher, so a stalled poll cannot queue cancellation behind it. Provider observation requests have a three-second timeout with no SDK retries. Pending or expired attempts are checked against Stripe outside database transactions, validating intent identity and metadata. Terminal provider observations pass through the same settlement service with stable durable receipt IDs, so a missing local webhook listener does not leave an open checkout waiting indefinitely. Delayed webhooks still deduplicate normally. It runs authoritative expiry cleanup;
Stripe's browser result alone never confirms a booking. No Supabase browser access
is introduced; browser-supplied payment status is never accepted. Both provider configurations remain
independent, but NETOPIA has no adapter yet, so selecting it makes customer online
checkout unavailable without falling back to Stripe. Pay at club stays independent.

Payment Element is never unmounted while `stripe.confirmPayment` (including a 3D Secure
challenge) is in flight, even if the checkout expires or a status poll fails meanwhile;
it is removed only after Stripe returns. Polls during authentication only act on a
server-decided outcome. After 30 seconds of authentication the loading indicator stops and
the customer is told to finish authenticating; the submit button stays disabled, so no
second submission is possible. Failed or cancelled authentication is a card error: an
initial booking checkout ends (as for a decline) and the customer selects a time again,
while a modification's intent accepts another card while it is open; a successful authentication
waits for the server's verified capture, and an authorization after expiry is cancelled
without a charge. The modification dialog uses wording that the original booking is
unchanged (never "cancelled") when its payment fails, expires or is refunded.

X, Close and Escape dismiss the checkout immediately, including during provider calls or cancellation. Dismissal makes no claim that payment was cancelled, clears loading feedback, and ignores late action/Stripe/polling callbacks. An uncertain outcome is shown without encouraging another payment. Closing, unmounting or `pagehide` attempts capability-bound cleanup of an unused checkout with a keepalive POST to `/api/payments/checkout/abandon`. A late checkout-creation response after dismissal also requests cleanup. Local submitted/unknown outcomes skip this request; the server independently skips submitted, authenticated or captured payments. React effect replay does not abandon the mounted checkout. If navigation loses the request, the existing hold deadline and Cron sweep remain authoritative.

Cancel payment has a separate confirmation. Confirmation unmounts the active payment form, preventing submissions and late UI confirmation. The capability-authorized command records internal checkout cancellation intent under location → booking → reservation → attempt locks before contacting Stripe. Once a booking is confirmed, this capability cannot cancel it, even within its original hold deadline. Confirmed bookings use normal booking-management authorization and refund-backed cancellation, preserving occupancy until required refunds succeed. No Auth or provider call occurs inside a transaction.

Checkout abandonment records internal checkout cancellation intent without a cancelled booking revision, preventing
new capture acceptance under the existing aggregate locks. Occupancy stays held until
Stripe confirms cancellation or the ordinary unaccepted hold expires; an accepted capture
rejects abandonment and remains protected until its financial outcome is known.
The attempt may remain pending while the provider outcome is uncertain. Navigation
uses processing-preserving dismissal and also preserves authentication/authorization
observed by that provider call. Explicit cancellation follows the existing cancellation
state machine. The adapter uses stable abandonment idempotency and retrieve-after-failure
recovery. An exact capture racing cancellation preserves that ended checkout,
records capture evidence and creates its compensation obligation, whose refund is
dispatched after commit (see [Payment recovery](#payment-recovery)). Guest requests use the same capability and
a nullable refund requester.

Expiry ends payment entry locally even when the status endpoint is unavailable. Server expiry retains the original release/late-capture reconciliation policy, including for held bookings with cancellation intent. Expired attempts cannot be reused; polling attempts provider cancellation when possible. Keep paying is available only for a usable checkout before cancellation starts. A definitive card failure ends a court or coaching checkout: the payment form stops accepting cards and requests the existing unused-checkout cleanup, and the signed failure webhook is re-read at Stripe; if the exact intent still awaits a card, server cancellation ends that checkout and releases its holds after provider confirmation. The customer is told to select a time again; Continue to payment rechecks availability. A checkout that expires with the form open shows "Your reservation has expired. Please select a time again." Close, X and Escape send the unused-checkout cleanup immediately and refresh the timetable after the server answers. Modification card declines retain their existing retry workflow; transport/unknown errors block further submissions. Payment loading feedback becomes a non-blocking uncertainty warning after 30 seconds; booking submission and cancellation loading are bounded at 15 seconds. Customers can always leave while Stripe webhooks (retried by Stripe for up to three days) settle the financial outcome.

Focused checks (external intent creation is mocked; signatures and local DB are real):

```sh
npx vitest run tests/unit/stripe-adapter.test.ts tests/unit/customer-booking-action.test.ts tests/components/online-payment.test.tsx tests/components/booking-calendar.test.tsx
npm run test:integration -- tests/integration/stripe-payment.integration.test.ts tests/integration/payment-foundation.integration.test.ts tests/integration/db/checkout.integration.test.ts tests/integration/stripe-refunds.integration.test.ts tests/integration/admin-stripe-reconciliation.integration.test.ts
```

For browser verification, configure actual account values
in ignored `.env.local`, not source code or chat:

- `STRIPE_SECRET_KEY=sk_test_…`
- `STRIPE_PUBLISHABLE_KEY=pk_test_…` from the same account
- `STRIPE_WEBHOOK_SECRET=whsec_…` from the local Stripe CLI listener
- `APP_URL=http://localhost:3000` and the existing local Supabase variables

For manual verification, run `stripe listen --events payment_intent.succeeded,payment_intent.payment_failed,payment_intent.canceled,payment_intent.processing,payment_intent.amount_capturable_updated,refund.created,refund.updated,refund.failed --forward-to http://localhost:3000/api/payments/stripe/webhook`,
copy that listener's signing secret into `.env.local`, and restart Next.js.
Select Stripe in Admin → Payments → Settings. Book an available
interval: another visitor must see it blocked, and the booking must stay pending
until successful settlement. Use Stripe test success card `4242 4242 4242 4242`
and decline card `4000 0000 0000 0002` with future expiry and any valid CVC (initial
checkout: the decline ends the checkout and releases the hold; select the time again).
Success must retain both internal row IDs and confirm the booking once;
a decline must end the checkout and release the interval without a History row. Cancel an unpaid PaymentIntent in Stripe: the
slot must become available immediately and both My Activity lists must omit it. Replay a captured success
webhook with Stripe CLI/dashboard resend and verify the booking is confirmed only once.
Leave an unpaid checkout beyond five minutes and verify availability returns with
no activity. After a successful payment, verify the booking
appears in Bookings; cancel that confirmed booking and verify it moves to History
as Cancelled.
A success after expiry must record reconciliation without displacing a replacement
booking. Test instructions follow [Stripe's testing guide](https://docs.stripe.com/testing).

## Payment state model

Booking, checkout, reservation, payment attempt, capture, adjustment and refund states are
distinct and never collapsed into one status:

- payment attempts: `pending`, `due` (pay at club), `succeeded`, `failed`, `cancelled`, `expired`;
- capture evidence: immutable `payment_capture_receipts`, one per provider capture;
- adjustments: proposals for paid modifications and refund-backed cancellations;
- refund obligations: `pending`, `pending_retry`, `succeeded`, `failed`, `voided`, each with
  immutable `refund_executions` for provider requests.

One booking can have several financial operations (original payment, surcharge, partial
refunds); never assume one booking equals one Stripe transaction. The browser is never
authoritative for price, refund amount or payment status. Webhooks verify signatures,
process only supported events, deduplicate by provider event ID and tolerate redelivery and
reordering. Refunds derive from verified historical captures, never current prices.

## Stripe cancellation refunds

The initial TypeORM migration defines `payment_refunds` with denied browser access,
per-attempt operation uniqueness, immutable obligation terms/reasons and a required
contractual revision reference. TypeScript allocates from verified captured funds,
reserving every existing obligation; amount may cover part or all of one capture.
Original payment requests remain unchanged; refund processing status is separate.

Owner cancellation uses existing ownership/notice/start guards and always requests a
refund of remaining captured funds after existing obligations. Admin cancellation
requires before-start eligibility and automatically creates applicable online
refund obligations. Pay-at-club cancellation (or nothing refundable) cancels at once.

A cancellation that must return money is a **request**, not a cancellation: one
transaction records a pending `booking_adjustments` row of kind `cancellation` (its
creation time preserves the eligibility decision) plus the refund obligations. The
booking, its revision and its active reservation stay unchanged. Refunds start
immediately after commit. When every obligation is terminal, one transaction under the
existing location → booking locks decides: when every refund is verified as succeeded,
it finalizes the cancellation (cancelled revision, occupancy released); when every
obligation definitively failed (no money returned), it voids the obligations, marks the
request `unsuccessful`, keeps the booking unchanged and records a `cancellation_rejected`
financial exception; the customer may request the cancellation again. If some
refunds succeeded and another definitively failed, partial repayment cannot be undone:
the request stays pending, the booking stays unchanged, completed refunds remain recorded
and each failed obligation is an explicit exception (`refund_failed` financial exception,
Admin attention) for external resolution.
A submitted or pending provider refund never cancels a booking. Post-commit processing
uses immutable `refund_executions` and five-minute execution leases. Preparation locks
booking → reservation → selected attempt → ordered capture receipts → refund obligation →
execution; Admin preparation additionally fences active-Admin roles/account. Dispatch initiation
commits before HTTP; completion fences updates and lease clearing with the current token.
Stale workers may record verified historical facts without clearing another worker's lease.

Lifecycle:

- `pending`: durable request or provider refund awaiting completion.
- `pending_retry`: either an incomplete/ambiguous result requiring evidence reconciliation,
  or an affirmative retryable failure/rejection. These are different recovery cases:
  uncertainty retains the execution/key; a replacement after retryable failure requires
  an explicit Admin **Check with Stripe**. Webhooks never create that replacement, and no
  financial scheduler retries it.
- `succeeded`: provider confirmed the full refund.
- `failed`: a definitive non-retryable provider failure/cancellation/rejection, or a verified
  reversal of a previously successful refund. No replacement execution is allowed. If the
  obligation remains owed (including after partial success), it requires external resolution
  and is recorded as a financial exception for Admin attention. An entirely refused change
  with no money moved is abandoned as described above.
- `voided`: a failed obligation of an abandoned change; no money moved and it no longer
  reserves captured funds.

`processBookingRefund(refundId)` is the server-only processing operation shared by
request threads, signed Stripe refund webhooks and the Admin "Check with Stripe" action;
it has no customer or public endpoint.
Repeating an authorized cancellation reuses the existing request and obligations.
Known provider refund IDs are retrieved; otherwise paginated metadata discovery uses
both `payment_refund_id` and `refund_execution_id`. Within 23 hours of dispatch (inside
Stripe's 24-hour idempotency-key retention) an unfound request is re-sent with its exact
stored key, so Stripe returns the original refund if the first request executed. After
that window an empty lookup never authorizes creation; the refund stays `pending_retry`
and appears under Admin attention.

New READY executions store `court-refund-execution-<execution-id>` as their exact key.
Dispatch initiation commits before the HTTP request. Pending acceptance is not money
refunded. Terminal evidence remains immutable. Ordinary processing short-circuits terminal
executions. Only affirmative transient evidence permits an explicit Admin check to allocate
a new execution/key: Stripe refund `failure_reason=insufficient_funds`, or request rejection
`code=balance_insufficient`. Other failures, unknown reasons and later provider reversals
never permit replacement. A pending provider refund is checked, never replaced.
Network uncertainty, local result-write failure, lease takeover and crash recovery
retain the same execution and key. The dispatch-to-HTTP crash gap is closed by the
idempotent replay window above; no replay relies on indefinite key retention.

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

`/admin/payments/transactions` shows persisted Transactions read-only. `/admin/payments/settings`
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
Transaction context uses the operation's historical revision or immutable proposal
(for refund-backed changes, the contract in force when the refund was requested),
while current totals and debt appear separately under Current booking summary.
Pay-at-club rows are uncollected requests, not captured money. Any booking without
an attempt uses its initial revision as request context; no attempt is fabricated.
Provider execution internals are not sent to the browser.

`/admin/payments/transactions/payment/<attempt-id>` and
`/admin/payments/transactions/refund/<refund-id>` are Admin-authorized details using the
same projection. Direct links, refresh and Back/Forward use actual financial identity;
list filters/sort/page are retained on the return link. Money display accepts zero
balances while payment/pricing input validation remains strictly positive.

The Admin financial control is **Check with Stripe**, for overdue unresolved payments
and unconfirmed refunds (active Admin only). Payment checks (`checkAdminPaymentWithProvider`)
retrieve the exact registered intent and never capture. After the original deadline plus
120 seconds they attempt cancellation of an unused or interrupted authorization. Stripe
cancellation releases accepted occupancy; capture winning the race settles normally.
Temporary unavailability or processing preserves acceptance and occupancy and remains
visible under Needs attention. Checkout polling uses the same cleanup decision, and
expired unpaid checkouts are cancelled remotely when possible; local expiry alone never
cancels a PaymentIntent. The existing Cron sweep also checks a bounded batch of overdue
registered Stripe intents, using the same reconciliation service without capture and
preserving processing payments. A captured attempt is never an overdue authorization,
whatever its local status: a late capture on an expired, failed or cancelled checkout
keeps its attempt status, but leaves Check with Stripe, the Cron batch and the payment
part of the currency-change blocker. Its compensation refund (and the captured-payment
reconciliation flag, cleared only by verified full compensation) carries the remaining
obligation, so an uncertain or failed refund stays in Needs attention and keeps blocking
currency changes, and a fully compensated one shows as `Expired · Fully refunded`.

The refund check (`checkAdminRefundWithProvider`) authorizes the active Admin and runs
`processBookingRefund` with `retryRejected: true` and strict error handling. It uses the
[execution and retry rules above](#stripe-cancellation-refunds): reconcile unknown outcomes
with the same identity, or allocate a replacement only for affirmative retryable failure.
There is no Refund captured payment action or manual state editing. Details distinguish
pending refunds, completed refunds, abandoned changes and pending/finalized cancellations.

Attention lists only genuine exceptions:

- a registered Stripe payment in `pending`, `expired` or `failed` after its deadline
  plus 120 seconds — no definitive provider cancellation/capture has been recorded;
  use Check with Stripe. Local expiry never proves remote cancellation;
- refund `failed` — Stripe definitively failed/declined money that is still owed; the
  application records the applicable customer/Admin notifications, but repayment requires
  external resolution;
- refund `pending` or `pending_retry` still unconfirmed 15 minutes after it was requested
  (`unconfirmedRefundMinutes`) — use Check with Stripe; never issue another refund in the
  Stripe Dashboard;
- an unresolved `payment_provider_events.reconciliation_required` event — exact late
  captures say a full refund was requested automatically; amount mismatches need review.

The TypeScript read model derives this flag; the database applies the same predicate
for the Attention filter before pagination. Resolved events remain visible with their
resolution timestamp.

Date, amount and stored transaction status can be sorted with deterministic kind/ID
tie-breaking. Search is a case-insensitive literal substring of customer name/email,
booking UUID, transaction UUID or provider payment/refund ID. Filters apply immediately and search
uses the existing debounced URL navigation pattern. Pagination/sort links preserve
filters. Payment timestamps display UTC; booking schedules retain location timezone.

## Payment recovery

The application runs on serverless hosting (Vercel) or `next start` alike. Refund execution
leases protect concurrent request-driven processing. Supabase Cron schedules notification
email delivery and the checkout cleanup below, which also reconciles overdue registered
Stripe intents. It never dispatches captures or replaces failed refund executions.
Financial outcomes pass through the existing services from the customer's checkout status
poll, cancellation or reschedule, an Admin action, the Cron check, or a signed Stripe webhook.
Stripe's own webhook redelivery (exponential backoff
for up to three days on a non-2xx response) is the retry mechanism for missed work.

| Situation | What resolves it |
| --- | --- |
| Card authorized inside the deadline | Webhook or status poll accepts it, extends the hold by the capture grace and captures; settlement confirms the booking. |
| Card authorized after the deadline | The authorization is cancelled at Stripe; no charge. |
| Payment succeeds, webhook delayed or missing | Customer status poll reads the PaymentIntent; Stripe redelivers the webhook. Both settle through `processOnlinePaymentEvent` with deduplicated receipts. |
| Card declined | Initial court/coaching checkout: `payment_intent.payment_failed` (re-read at Stripe) or the payment form's cleanup cancels the unused intent and releases the holds; another card needs a new checkout. Modification: the same intent and hold remain until the deadline for another card. |
| Abandoned checkout | Its immutable PostgreSQL deadline ends payment eligibility. Registered initial payments retain occupancy until a definitive provider outcome. The Cron hold sweep or the next polling/occupancy write settles it locally. Cron also checks a bounded, oldest-first batch of uncaptured overdue registered intents on every run, including locally expired/failed attempts, and cancels unused intents through the existing check service. Processing remains unresolved for a later check/webhook. Captured funds follow existing settlement/compensation rules. Polling and Admin Check with Stripe remain available. A later authorization is never captured. |
| Accepted capture interrupted before dispatch | During grace, observe only. After grace, polling or Admin Check with Stripe retrieves the intent and attempts cancellation, preserving occupancy until Stripe confirms capture or cancellation. Uncertainty remains visible to Admin. |
| Accepted capture completes after grace (booking or surcharge) | Accepted occupancy remains protected; verified success applies normally, without a refund solely for lateness. Later observations never dispatch another capture. |
| Unaccepted late capture, or an otherwise invalid capture | The settlement commits the receipt, the full refund obligation and a `late_capture` financial exception atomically, then dispatches the refund. Released occupancy is never reclaimed. |
| Refund request interrupted or response lost | The execution stays `pending_retry` with its original idempotency key. Stripe's `refund.created`/`refund.updated` webhook re-reads it; otherwise it appears under Admin attention after 15 minutes for Check with Stripe. |
| Refund pending at Stripe | `refund.updated`/`refund.failed` webhooks commit the final result and decide any waiting cancellation or price reduction. |
| Stripe fails a refund it had reported succeeded | The `refund.failed`/`refund.updated` webhook re-reads and verifies that exact refund. The success evidence is kept; the execution records `provider_refund_reversed`, the obligation becomes `failed` (Admin attention, no longer counted as refunded), and a `refund_reversed` financial exception is recorded. No replacement refund is ever issued. |
| Refund-backed change interrupted after the refund committed | Any later check of that refund (webhook redelivery or Admin) re-runs the transition-guarded decision. |

### Checkout hold expiry sweep

Unregistered initial checkout holds stop blocking availability at their PostgreSQL deadline.
Registered initial attempts retain their reservation while provider cancellation/capture is
unresolved, including after that deadline. This same protection applies in public, internal,
owner-edit and coach occupancy reads and in location-locked expiry before writes. Clock
expiry never overrides a possible provider outcome. Accepted modification protection is unchanged.

Supabase Cron calls `POST /api/payments/holds/expire` every minute with
`Authorization: Bearer <CHECKOUT_EXPIRY_CRON_SECRET>` (a server-only random value of at least
32 characters, independent of the notification secret). The endpoint runs the existing
`expirePaymentHolds` service once: at most 100 safe local expirations per call, using
location-first transactions and `SKIP LOCKED`. Unregistered unpaid attempts become
`expired`; their reservations become `released`. Registered initial attempts are resolved
through the provider check below instead of being blindly released. Definitive Stripe
cancellation settles the checkout as `expired`, the attempt as `cancelled`, and the physical
reservation as `released`, atomically under the existing aggregate locks. No actual booking,
cancellation revision or booking notification is created. Financial evidence is retained.
After those transactions commit, the endpoint selects at most five overdue registered
Stripe attempts (`pending`, `expired` or `failed`, without a capture receipt) and calls
`checkOnlinePayment` in processing-preserving mode. Three are the oldest by deadline, so
when checks succeed the pool drains first-in first-out and every attempt is reached within
a bounded number of runs. The other two are sampled from the remainder, so intents Stripe
persistently cannot resolve (processing, unreadable) cannot starve newer ones behind them.
While Stripe is unreachable nothing is released: those courts stay held and the attempts
appear in Needs attention until a later run or an Admin check confirms an outcome.
The existing aggregate-lock decisions protect accepted captures during grace; recovery
never captures. Stripe dismissal verifies identity/metadata, leaves processing alone,
and cancels unused intents idempotently, including authorizations awaiting capture.
Terminal evidence uses the existing settlement/receipt and late-capture compensation
services; a racing success is observed rather than cancelled or assumed refunded.
Failures and processing remain eligible on subsequent runs and visible to Admin.
No transaction spans Stripe HTTP. The request-driven expiry before occupancy writes
and during checkout polling uses the same protection. Admin booking reads remain restricted
to actual booking identities. Admin Calendar presents initial held rows as temporary
checkout holds with a deadline and payment-review link. Transaction reads include an
authoritative `bookings` existence flag so checkout references/statuses never link to or
claim an actual booking. An uncertain registered attempt remains Pending and appears in
Needs attention after the existing grace, with Check with Stripe available.
Cron must still be configured for cleanup on an otherwise idle deployment.

For local Supabase, set `CHECKOUT_EXPIRY_CRON_SECRET` and
`CHECKOUT_EXPIRY_CRON_URL=http://host.docker.internal:3000/api/payments/holds/expire` in
`.env.local` and run `npm run payments:expiry-cron:local` (guarded like
`notifications:cron:local`). For production, set `CHECKOUT_EXPIRY_CRON_SECRET` in Vercel
Production and, in a private SQL session on the production database, store the URL and
secret in Vault and schedule the job:

```sql
select vault.create_secret('https://<production-domain>/api/payments/holds/expire', 'tennis_club_checkout_expiry_cron_url');
select vault.create_secret('<CHECKOUT_EXPIRY_CRON_SECRET value>', 'tennis_club_checkout_expiry_cron_secret');

select cron.schedule(
  'tennis-club-checkout-hold-expiry',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'tennis_club_checkout_expiry_cron_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'tennis_club_checkout_expiry_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $$
);
```

Scheduling the same job name again replaces its schedule. To move an existing deployment
from every five minutes to every minute without re-sending the command, run
`select cron.alter_job((select jobid from cron.job where jobname = 'tennis-club-checkout-hold-expiry'), schedule := '* * * * *');`.
With the five-minute hold, an abandoned unpaid checkout is normally released about
five to six minutes after Continue to payment. That is not guaranteed while Stripe is
unreachable, a payment is processing or uncertain, or overdue attempts exceed the bounded
batch.

Check `cron.job_run_details` and `net._http_response` for results.

Webhook refund events are matched only by the `payment_refund_id` metadata this
application sets; Dashboard-created refunds are ignored. Webhooks run the payment and
refund services in strict mode: an internal persistence failure, a failed booking update
waiting on a refund, Stripe being unreachable during the check, or another request holding
the execution lease returns 503 so Stripe redelivers the event. A payment event whose
receipt already exists still re-drives that attempt's unfinished compensation refund, so
a redelivery is never a silent no-op. A retryable rejection is never retried from a
webhook, which prevents a refund loop.

Configure the Stripe webhook endpoint with `payment_intent.succeeded`,
`payment_intent.payment_failed`, `payment_intent.canceled`, `payment_intent.processing`,
`payment_intent.amount_capturable_updated`, `refund.created`, `refund.updated` and
`refund.failed`.

Known limitations: an authorization that no webhook or poll reports is never blindly
captured. Configured expiry Cron checks overdue registered intents and cancels eligible
authorizations; Stripe processing or transport uncertainty retains protection for later recovery. A refund whose request never reached Stripe produces
no webhook and needs the Admin check. A refund Stripe fails after success requires the
club to repay the customer outside the application. A process interrupted after acceptance
but before dispatch cannot safely be distinguished from a lost capture response with the
existing state: later requests never capture again. After grace they retrieve and attempt
provider cancellation. Occupancy remains protected while Stripe is unreachable or cannot
confirm cancellation; the payment remains visible in Admin Needs attention. No blind
capture retry or time-based release occurs. With no checkout request, webhook or Admin
check or configured expiry Cron, registered provider cleanup waits and its occupancy remains protected.

## TypeScript decision and persistence boundary

Application commands persist through TypeORM repositories. Checkout, cancellation/refunds, payment settlement, webhook
interpretation, rescheduling quotes and recovery eligibility are TypeScript decisions
using TypeORM transactions and focused repositories. No generic booking snapshot, actor snapshot or command RPC architecture remains. Stripe requests
remain outside transactions.

## Customer booking mutations

Owner rescheduling and owner/Admin cancellation use TypeORM READ COMMITTED transactions.
Reschedule holds shared configuration advisory fence then location UPDATE before booking/reservation UPDATE
locks. Cancellation omits the configuration advisory fence, then locks the booking's
payment attempts and refund obligations in ID order before ordered actor roles/account SHARE locks.
TypeScript makes policy/pricing/refund decisions against those locked facts; snapshot notice
uses the accepted revision's timezone and post-lock database wall time. See [architecture](architecture.md#booking-revisions-and-owneradmin-boundaries).

Cancellation without a refund appends an accepted revision and releases occupancy at
once; a cancellation that returns money is a pending request decided by verified refunds
(see Stripe cancellation refunds). Refund execution follows commit. The accepted
cancellation revision or pending request permits replay without another refund. Admins may
cancel other customers' bookings but cannot reschedule them or select refund/no-refund.
Owners, including Admin/Coach owners, use the same owner rescheduling rules. Same-price
and Pay-at-club saves append revisions directly; online price differences use the
adjustment workflow below. Original attempt facts stay unchanged. Revision UUID and
lossless reservation timestamp provide the contractual and occupancy stale tokens.

Booking mutations use scoped TypeORM commands; schedule-changing saves send the preserved
old/new schedule template after commit.

## TypeORM settlement boundary

Verified webhook input and trusted receiptless settlement share one transaction. Discover
attempt→booking→location under the shared configuration fence, then lock location → booking → reservation → selected attempt FOR UPDATE and recheck the parent. Validate identity, read the global receipt, then read PostgreSQL wall time. Exact late captures additionally lock/allocate compensation after receipt persistence. Adjustment application also fences its actor; no network calls occur inside this transaction. Financial evidence matches the original attempt amount/currency,
never a rescheduled booking total. Webhooks require an attached exact provider reference.
TypeScript preserves retryable pending, success, terminal failure/cancellation, effective expiry,
late-capture and mismatch decisions. Lossless deadline comparisons are rechecked before writes;
the attempt UPDATE also checks clock_timestamp() against the supplied deadline and lets
TypeScript re-evaluate expiry if crossed. Lifecycle and durable receipt are atomic. Late captures keep terminal lifecycle and flag reconciliation; financial mismatch
records evidence only and is not automatically refundable. Other outcomes do not confirm.
Global provider/event PK dedupe compares attempt, payment reference, outcome, amount and normalized
currency. Identical events replay stored result without touching Admin resolution. Concurrent
insert conflicts read the committed winner in a separate READ COMMITTED statement; changed
evidence rejects, rolling back provisional lifecycle writes. Distinct events preserve terminal
success and cannot duplicate confirmation.
Abandonment retains capability validation and retrieve/cancel/retrieve outside transactions;
a capability-bound transaction first records cancellation intent. Provider-confirmed cancellation runs the receiptless settlement command; verified captures use the common event transaction and existing full-refund operation. Cancellation intent prevents subsequent booking confirmation.
Payment/refund persistence uses TypeORM transactions with explicit authoritative locks.
TypeScript hold expiry runs under location-first TypeORM transactions.
Exceptional financial outcomes are recorded atomically as immutable
`booking_financial_exceptions` (created with its immutability guard by the initial schema baseline).
Booking/coaching transitions and relevant financial events record notification snapshots
in the deciding transaction; Brevo delivery happens separately after commit. See
[notification architecture and delivery](notifications-delivery.md).


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

A permitted decrease is a pending modification: it snapshots the accepted quote and
pricing evidence, holds target fragments outside the original occupancy until the target
start, and creates partial-refund obligations for the full price difference. The
original booking is unchanged until the refunds are verified; then the snapshotted
schedule/price is applied once (never repriced). When every obligation definitively fails
with no money returned, the change is abandoned (obligations voided, holds released,
`modification_rejected` financial exception recorded). Retryable or uncertain obligations
keep it pending under the refund recovery rules above. If some
refunds succeeded and another definitively failed, the change is not applied: the
original booking and holds remain, the modification stays pending, and each failed
obligation stays an explicit exception for external resolution. Allocation uses newest captures first, reserving
every non-voided obligation. Cancellation then allocates only the remainder. Original
captured amounts are never rewritten. Uncertain responses retain identity.

Refund allocation is defined once in `src/lib/payments/refund-allocation.ts`. It receives
typed payment requests, obligations and verified capture observations, preserves
newest-capture-first ordering and reserves every obligation regardless of processing
status. Pay-at-club debt and uncertain or mismatched captures cannot fund refunds.
`financials.ts` loads facts and persists the approved allocations through TypeORM within
the caller's existing transaction and booking lock; it never starts a transaction.
Reduction, cancellation, unapplied surcharge compensation, checkout cancellation and
late-capture compensation all use this path. Operation replay retains persisted IDs;
attempt-scoped recovery uses the existing attempt/operation identity. Financial summary
reads perform no provider reconciliation or persistence. Repositories only load/lock
facts and insert supplied amounts/provider identities; adjustment expiry orchestration
lives in the existing TypeScript hold-expiry service.

### Modification payment lifecycle

Edit always opens a fresh form; an earlier modification is never resumed and there is
no customer payment link. Only an exact replay of the same request returns its
modification. X on the dialog is the only dismissal: the owner Server Action revokes the
checkout capability, then reads the PaymentIntent. `requires_payment_method`,
`requires_confirmation` and `requires_action` are cancelled at Stripe and the
modification is discarded with its hold released at once (a cancel race re-reads the
intent and takes the live or succeeded branch). A `processing` intent is never cancelled:
the target hold lease is extended to the target slot start and the webhook decides.

Surcharges use manual capture through the same `resolveAuthorizedCheckoutPayment`
service as booking checkouts (signed `payment_intent.amount_capturable_updated` webhook or
status poll; Stripe is always re-read). Under location → booking → reservation → attempt
locks the server captures only when the attempt is pending, the authorized amount and
currency match exactly, the proposal is still `pending`, the checkout capability was not
revoked (X or a superseding request), the booking is still `confirmed` at the proposal's
base revision, every target hold is still held, and PostgreSQL time is before the
immutable cutoff. Acceptance writes the proposal's write-once `capture_accepted_at`
independently of occupancy fragments and extends any target holds to the cutoff plus
`checkoutCaptureGraceSeconds` (120 s). Expiry, X, cancellation and supersession preserve
an accepted capture until a definitive provider outcome, including modifications needing
no additional court hold. The original booking stays unchanged until successful settlement.
Only the request that persisted acceptance dispatches capture. Subsequent webhook/poll
requests read provider evidence and never re-dispatch capture. After grace they attempt
provider cancellation; they release accepted occupancy only on confirmed cancellation.
If capture wins the race, verified success still applies normally. Stripe transport retries use the same capture idempotency
key (`court-capture-<attempt-id>`), and settlement is deduplicated. Accepted captures may
complete after grace without a refund solely for lateness. A change that can no longer be
applied for another reason keeps the existing compensation refund. There is no financial scheduler.

`booking_adjustments.expires_at` is the immutable lateness cutoff
(`modificationHoldDurationSeconds`, 600 s). Payment attempt facts are immutable, so the
occupancy lease lives on the held target fragments: a `hold_expires_at` later than the
cutoff is verified evidence of a live payment (from X, status polling or a verified
`payment_intent.processing` webhook). Expiry releases a modification at its cutoff
unless such a lease is still running. Unaccepted success at or after the cutoff is late and refunded exactly once;
accepted capture may apply after its 120-second operational grace. A delayed decline
cannot undo an accepted capture. Before acceptance, a decline stays retryable only
while the customer still holds the capability and the cutoff has not passed; after
X or the cutoff, failure discards the modification, releases the hold and cancels
the failed intent after commit. While a live payment is unresolved,
My Activity hides Edit for that booking and refreshes until it resolves. A new request
discards an unpaid earlier proposal (closing its attempt like the cutoff sweep) unless
its payment is live. Capture acceptance also protects modifications whose target has no new fragment;
late completion of that accepted operation remains legitimate. The Stripe webhook endpoint must subscribe
to `payment_intent.processing` in addition to succeeded/payment_failed/canceled.

Admins cannot create surcharges for other customers; guest rescheduling is not
implemented. Repeated submissions of one request do not create a replacement charge.
A captured surcharge that cannot be applied (late or fenced) records one
`surcharge_unapplied` financial exception and is refunded automatically. Admin Financial history lists payment requests/refund
obligations with historical transaction context and separate current-booking totals,
read-only. Verified webhooks, checkout polling and the Admin refund check use the
same settlement/refund services.


### Staff operational price differences

`changeBookingOperationallyCommand` (internal entry point `runOperationalBookingChange`, no
Server Action or UI yet) compares the destination's authoritative price with the agreed
obligation (`operationalFinancialQuote` in `src/lib/bookings/operational-policy.ts`). A staff
change never increases what the customer owes, and a reduced obligation is never reinstated
by a later change because each change compares against the current obligation.

- Equal: the revision keeps the agreed total and pricing evidence.
- Higher: the club absorbs the difference. The revision keeps the agreed total and evidence;
  an `applied` `booking_adjustments` decision, linked by the revision's `adjustment_id`,
  records the destination evidence and `destinationTotalMinor`. No payment attempt or
  provider call is created. Admin Financial history shows the destination price and
  absorbed amount.
- Lower, online: the refund is `min(price difference, captured − non-voided refund obligations − new total)`,
  allocated newest capture first with reason `booking_price_reduction` through the
  refund-backed modification above (pending adjustment, target holds, apply on verified
  refunds, abandon on definitive failure). A lower price with nothing refundable only lowers
  the obligation. Captures in another currency or unresolved refund obligations return
  `financial_review_required`.
- Lower, pay-at-club: the revision lowers the amount due; nothing is refunded.
- Another currency is rejected (`cross_currency`).

The preview returns the quote (current amount, destination price, currency, refund, absorbed
amount, final obligation, consequence). A save with a consequence requires
`financialAcceptance` equal to the quote recomputed under lock; otherwise it returns
`financial_confirmation_required` or `financial_changed` with the current quote and writes
nothing. An exact replay reports the recorded outcome; a pending refund-backed change blocks
competing edits and cancellation.

A refund-backed lesson reassignment keeps the original reservation (court, time and coach)
until every refund is verified and holds the replacement coach over the whole target
(`reassignmentHoldFragments`): pieces outside the original court time hold the court and the
new coach; pieces the original reservation already occupies on the same court and date are
coach-only holds (`occupies_court = false`), exempt
from the court exclusion but not from the coach exclusion. Every scheduled destination has a
hold plan, so preview and save agree; the exclusions still arbitrate concurrent races
(`coach-booked`). Verified refunds release the holds and move the reservation and coach in one
transaction; a definitive failure releases them and abandons the change.
Reassigning only the coach (unchanged location, court, date and time) keeps the agreed
obligation and pricing evidence and never refunds, absorbs or charges, even when current
pricing differs from the agreed price.

## Known financial-model limitations

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
reconciliation remain future work.

Current reporting summaries still count successfully settled attempts and successful
refund statuses; reporting changes for receipt-only or mismatched captures are
intentionally deferred. Provider reconciliation is request- and webhook-driven (see
[Payment recovery](#payment-recovery)).


## Checkout and booking identity separation

`checkout_records` holds every checkout allocation; `bookings` holds only confirmed identities
with confirmation-revision proof (see [booking domain](booking-domain.md#checkout-records-and-booking-identities)).
Business lists, details, history, coach options and counts join real identities; Admin payment
review remains available for unsuccessful checkouts, and transaction reads carry an
authoritative `bookings` existence flag so checkout references never link to or claim a
booking. Direct-reservation guards use all checkout records. The initial schema baseline
creates both identities and their same-booking confirmation proof directly.

## Memberships (planned)

Not implemented: no membership, subscription, credit or discount tables, routes or Stripe
Subscriptions integration exist. When introduced, Stripe owns subscription billing state and
the application owns entitlement rules (discounts, included time, booking-ahead limits);
`subscription = active` is never complete authorization, and consumable credits use a ledger
consumed atomically with the protected workflow.
