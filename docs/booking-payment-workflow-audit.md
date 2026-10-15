# Implemented paid-booking modifications

The current implementation supports owner paid-booking changes through immutable
booking revisions and adjustment proposals. Admin management is cancellation-only
with automatic applicable online refunds. The earlier review and reported validation
are retained below as historical evidence, not current branch validation.

## Schema

Booking-adjustment schema is now included directly in the entity-generated
`1791462257924-InitialApplicationSchema.ts`; the development patch migration was removed.
It creates `booking_adjustments` with booking/actor/scope, stable submission identity,
original/new price, currency, immutable target and base-revision reference, outcome,
expiry and timestamps. Unique indexes permit one unresolved pending edit per booking
and one charge per adjustment; submission retries identify the existing operation.
Application browser grants are explicitly denied.

Existing `payment_attempts` gains nullable `adjustment_id`; NULL retains the original
checkout meaning. Existing `court_reservations` gains that link for held/released target
fragments. Ordinary reservation durations stay at least 60 minutes; only adjustment
fragments may be 30 minutes. Existing half-open GiST overlap exclusion is retained.
No separate occupancy table or business-policy trigger was introduced.

Existing `payment_refunds` replaces booking-wide and attempt-wide refund uniqueness
with `(payment_attempt_id, operation_key)` uniqueness and retains unique provider
refund identity. New adjustment linkage, original captured-amount snapshot, retry
generation and archived failed-provider reference history support repeated partial
refunds, compensation and later cancellation without overwriting captured transactions.
Refund obligations also retain immutable reasons and contractual revision references.
The current schema uses three consolidated development migrations, without backfills
or patch chains, on disposable development/test databases. The earlier populated-data
additive migration is historical validation described below, not the current setup.

## Services and lifecycle

The existing reschedule command still owns pricing, opening hours, ownership/roles,
fixed location, stale tokens, notice policy, timing and configuration/location locks.
A higher online total creates a durable pending adjustment plus a delta-only attempt
and target hold fragments. Original active occupancy and booking price remain unchanged.
The existing Stripe adapter, checkout initialization, status endpoint and signature-
verified webhook use common `processOnlinePaymentEvent` settlement and receipt identity.
No checked acknowledgement or browser Stripe response can apply a paid change.

Verified capture revalidates original tokens, current actor eligibility, target hours,
price/currency and occupancy, releases its own fragments, moves occupancy and appends
an applied revision/current pointer within one transaction. Both final writes fence the adjustment
expiry. A savepoint rolls back a failed move while retaining the captured financial
record and creating a durable compensation obligation. Expired/cancelled/invalid
operations never reclaim target occupancy or apply old edits. Refund processing runs
only after commit. Duplicate/reordered events and API retries use existing receipts
and provider idempotency; additional amounts remain independently auditable.

An eligible decrease applies the lower schedule/total and reserves the complete price
difference across captured funds, newest first, in the same transaction. Every existing
obligation reserves its amount, including pending and failed refunds. Cancellation
therefore requests only the remaining captured balance across all attempts. Owner
notice rules and current staff-owner bypass remain. Admins cannot reschedule other
customers' bookings; Coaches have no Admin customer-management rights. Applicable
online cancellation refunds are automatic. Old checkout capabilities cannot override
accepted cancellation or adjustment management. Pay-at-club changes append a contract
revision and change current debt; the original due request stays unchanged and no Stripe is used.
Same-price changes save directly under existing policy and concurrency checks.

Unknown provider outcomes retain their request identity and durable uncertainty.
An adjustment refund verified as failed can be retried by an authorized Admin with a
new provider generation; the previous failed reference is archived. Snapshot/lease /
generation checks reject late results from superseded retries. Current net paid counts
successfully settled attempts minus successful refund statuses; remaining refundable funds additionally subtract
all durable obligations. No refund can allocate an already-reserved captured balance.

## UI and recovery

The shared Edit dialog shows current total, new total, additional amount or eligible
refund, and the selected target interval. Surcharges use the existing Stripe Payment
Element. Pending operations do not close as successful saves; completion comes only
from authoritative backend status. Reductions show the durable refund status without
claiming a pending/failed refund is complete. Recoverable quote errors preserve drafts.

Active owners, including Admin/Coach owners, reopen Edit to recover the registered intent after
refresh/closure, using verified identity rather than contact matching. Resume retrieves
the same PaymentIntent and reissues a narrow checkout capability; it does not create a
replacement charge. Admin management cannot create customer surcharges; guest
rescheduling is not implemented. Initial creation uncertainty remains tied to the same
attempt/idempotency key. Uncertain cancelled/expired payments stay recoverable rather
than permanently blocking edits or triggering a new charge. Admin Financial history
can check provider outcomes after the booking scheduling edit window closes.

Admin financial views use each transaction's historical revision/proposal context,
with current-booking totals shown separately, refund retry and payment-recovery actions. No guest
self-management of arbitrary bookings or account ownership by email was added. No
background reconciliation worker was introduced; verified webhooks, polling, recovery
and Admin checks remain the reconciliation transports. Inconsistent pre-existing
ledgers are rejected visibly for review rather than silently charging against an
unexplained balance. Complete immutable financial observations, refund executions,
receipt-only capture summaries and independent scheduled reconciliation remain
[Task 4 work](payments-memberships.md#remaining-financial-model-work-task-4).

## Files

- Schema/registry: booking-adjustment/revision entities and three consolidated migrations; attempt, refund,
  reservation entities and DataSource.
- Persistence: booking-adjustments repository; existing payments, bookings and
  reservations repositories.
- Application: existing booking commands/reschedule; payments booking-adjustments
  orchestration, settlement, checkout, hold expiry, refund integrity/commands/processing,
  provider adapter/types and Admin financial query/reconciliation.
- UI: shared booking edit and reservation edit forms; existing payment component;
  capability-bound `/book/adjustments/[adjustmentId]`; Admin transaction/recovery actions.
- Validation: existing component and db/booking-mutation tests; paid-edit Playwright
  journey and isolated HTTP Stripe fixture; existing integration regressions. One
  activity fixture that had become elapsed on the current date now uses a future date.

## Historical validation of the earlier paid-adjustment implementation

The PostgreSQL tests use simulated Stripe responses with real isolated persistence.
The browser test uses simulated Stripe.js/local HTTP Stripe responses with real Next.js
and PostgreSQL. No actual Stripe test-mode or live transaction was initiated. Email
credentials stay blank in isolated tests; the Brevo code and text templates are intact.

Final validation on `fix/admin-location-reservation-ui`:

- `npm test`: 617 unit/component tests passed in 84 files.
- `npm run test:integration`: 213 PostgreSQL integration tests passed in 37 files.
- `npm run typecheck`, `npm run lint`, `npm run knip` and `git diff --check`: passed.
- Production `npm run build`: passed as part of the isolated Playwright server startup.
- `npm run test:e2e -- tests/e2e/booking-adjustments.e2e.ts tests/e2e/navigation.e2e.ts tests/e2e/opening-hours-workflow.e2e.ts`:
  all 4 browser tests passed. The paid-booking journey verifies original occupancy
  and price while payment is pending, refresh recovery using the same provider intent,
  verified surcharge settlement, updated My Activity interval/total, and the reverse
  edit with a successful partial refund. Navigation and opening-hours/concurrent-edit
  browser regressions also pass.

At that earlier stage, the additive adjustment migration was applied to the local development
database at port 54322. Before/after counts remained 10 bookings, 10 payment attempts
and 2 refund records. Only this migration was executed; no reset, initial cutover,
development-server restart or deployment to a remote database occurred.

---

## Historical audit before financial-model authorization

The findings, old file paths and command results below describe the earlier mutable
model. They are retained as audit evidence; current behavior is described above and
in [booking contracts](booking-domain.md#implemented-immutable-booking-contracts).

# Booking and payment workflow review

This task stops before financial schema changes, as requested. No migration, database
reset, real Stripe transaction, email implementation or email template change was made.
The existing uncommitted workspace changes and branch are preserved.

## 1. Paid booking edits: safety fix; adjustments awaiting architectural review

Root cause: `rescheduleCustomerBookingCommand` checked recalculated pricing and
acknowledgement, then changed the booking price and reservation schedule without a
charge or refund. Original attempt amounts remained unchanged. Consequently an
increase granted unpaid court time; a decrease created no refund obligation. The
cancellation service refunds the original captured attempt, independently of current
booking price, so simply changing that amount would destroy existing audit semantics.

Changed application files:

- `src/lib/bookings/commands.ts`: under existing configuration/location/aggregate
  locks, reject any changed total for online and unknown legacy bookings, regardless
  of acknowledgement, owner/Admin scope or staff notice bypass. Same-price edits
  retain availability, policy, ownership, tokens, timing and GiST checks.
- `src/lib/db/repositories/bookings.repository.ts`: include authoritative payment
  method in the locked booking projection.
- `src/lib/db/repositories/payments.repository.ts`: lock pay-at-club due attempts
  before actor fencing and update only uncollected due amounts in the same transaction.
  Original captured online payments are excluded.

Before: acknowledged changed prices saved without financial settlement. After:
online/legacy price changes fail visibly and preserve original rows and occupancy;
club-debt increases/decreases remain available and keep debt and booking total aligned.
No additional charge or partial refund is implemented yet. Existing cancellation
refunds, explicit Admin refund choices and grandfathered bookings are preserved.
Previously committed underpayments/refund omissions are not retroactively repaired.

### Smallest coherent financial model requiring review

Existing `payment_attempts` permits multiple rows but has no purpose/adjustment link.
`payment_refunds` has UNIQUE booking ID and UNIQUE attempt ID, so one partial refund
would prevent a later change refund or final cancellation refund. Settlement currently
interprets an attempt as the initial checkout; Admin projections select one attempt
and one refund. Reusing those fields without a structural change is unsafe.

Proposed entity changes (not implemented):

1. One durable booking-adjustment entity for the actual edit operation: booking/actor,
   stable client request key, original booking/reservation tokens and schedule/price,
   target schedule/price/currency, server delta, policy/Admin refund-decision snapshot,
   operation outcome and timestamps. Enforce one unresolved adjustment per booking
   and uniqueness of the submission key. This is the missing domain operation, not
   a parallel financial service or a replacement payment state machine.
2. Add nullable adjustment FK to existing payment attempts. NULL denotes the initial
   checkout; linked attempts capture only the surcharge with their own immutable
   amount, provider identity, existing receipt handling and idempotency key.
3. Extend existing refund records with a durable operation/idempotency identity and
   adjustment linkage. Replace booking-wide and attempt-wide uniqueness with
   uniqueness per obligation/allocation against a captured attempt; retain unique
   provider refund identity. Multiple partial refunds and later cancellation must
   fit the same original payment without refunding an already-refunded or obligated
   balance. A cancellation after multiple captures needs allocations across attempts.
4. Extend existing settlement/refund/reconciliation services and Admin projections
   to distinguish initial checkout from adjustment and aggregate all captures,
   obligations and provider results. Do not overwrite original captured amounts or
   create a duplicate financial orchestration service.

Suggested increased-price orchestration: preserve original confirmed booking and
occupancy while the linked surcharge is pending. On verified Stripe capture, lock
and revalidate the original tokens, actor/policy, pricing and target availability
before atomically applying the edit. Target occupancy is not promised while pending.
If the target or original edit becomes invalid, preserve the original booking and
atomically create an auditable surcharge-refund obligation. No silent loss of funds.
Duplicates/delayed webhooks use the persisted adjustment identity and existing provider
receipts. No Stripe call belongs in a database transaction.

Decisions required before implementation:

- Approve the entity/uniqueness changes above and the cancellation/refund allocation
  rules across initial and additional captures.
- Specify the eligible price-decrease refund policy. The current owner notice window
  and staff bypass exist, but there is no change-refund policy or Admin refund-choice
  input for rescheduling. Confirm whether an Admin may explicitly retain a decrease
  and how that retained amount is represented. Do not infer a new financial policy.
- Approve whether pending adjustments reserve no target occupancy as proposed, and
  how cancellation or another edit supersedes a pending adjustment. A captured,
  superseded surcharge must become a durable refund obligation.

## 2. Stripe recovery: authoritative settlement verified; resume remains incomplete

No settlement source defect was found in the observed no-listener confirmation.
`src/lib/payments/checkout.ts` retrieves the stored PaymentIntent through
`stripeAdapter.readPayment`; the adapter checks provider ID and attempt metadata.
`processOnlinePaymentEvent` validates amount/currency/linkage, records a stable
observation receipt and reuses common settlement. Signature-verified webhook events
remain independently idempotent. Cancellation intent and late capture reconciliation
remain authoritative. Network failures retain uncertainty rather than inventing an
outcome. Status access requires the random checkout capability, hashed in PostgreSQL;
forged IDs or tokens cannot retrieve another checkout.

Remaining UI defect: checkout token/presentation are only in `BookingConfirmation`
client state. Refresh/browser closure loses access; Stripe's return URL is the current
page URL without a durable resume contract. My Activity reads confirmed bookings,
so an unresolved checkout is not accessible there. Backend polling recovery works
while the original capability survives; browser/cross-device recovery is not fixed.
No new payment is created by the safety/navigation changes.

A follow-up must reuse the existing status endpoint, adapter and settlement service:
active-account owner-scoped pending-attempt recovery in the existing booking workflow,
and a deliberate guest capability retention/return mechanism. Never use contact email
for guest ownership, accept a browser Stripe success as settlement, or create a new
PaymentIntent merely because the browser lost the old one. Initial provider creation /
local attachment ambiguity also remains as documented in AGENTS.md.

## 3. Stale confirmation: fixed

Root cause: Next.js Cache Components retains route `useState` inside React Activity.
Navigating away hides the component and cleans its effects without discarding state.
The calendar's `committed` state therefore reappeared when returning to `/book`.

Changed `src/app/book/booking-calendar.tsx`: a layout-effect cleanup discards the
completed confirmation on route departure, following the installed Next.js
`preserving-ui-state.md` guidance. Active `router.refresh()` still preserves the
original successful confirmation; Book another court returns to the scheduler.
Unresolved checkout state is not reset by this cleanup. Hard refresh starts the
scheduler; the resume limitation in issue 2 still applies. No booking record changes.

## 4. Loading booking notification: lifecycle already correct

`src/app/admin/reservations/booking-edit-form.tsx` dismisses loading on success,
replaces it with an error on failure, and dismisses it during effect cleanup.
A disposed flag ignores late responses. No persistent-loading defect was reproduced
in completed loads; a screenshot alone cannot distinguish a normal pending request.
No notification-system or toast implementation change was needed.

## Tests and validation

Extended existing tests rather than introducing a new suite:

- Owner/Admin integration edits: acknowledged online/legacy increases and decreases,
  simultaneous repeated submissions, unchanged booking/reservation/payment/refund
  evidence, same-price edits, ownership/role boundaries and existing notice/stale/
  overlap checks; club debt increases and Admin decreases.
- Database booking-mutation tests: changed paid totals must fail; ordinary cancellation
  still refunds the original captured amount.
- Booking-calendar component: active refresh versus Activity hide/show navigation;
  existing guest/authenticated confirmation and Book another court tests.
- Booking-edit component: loading dismissal after completion/unmount and ignored late
  completion; existing rejected-load and error paths.
- Opening-hours Playwright journey: successful booking → My Activity → navbar booking,
  Back/Forward and refresh without stale confirmation.
- Existing Stripe integration suite simulates provider retrieval without webhook,
  duplicate/reordered notifications, cancellation races, uncertainty and refund recovery.
  These are mocked Stripe responses, not real Stripe test-mode transactions.

The requested surcharge, partial-refund and target-after-surcharge failure scenarios
cannot be validated as implemented behavior before the model/policy approval. The
current regression assertions verify safe rejection instead. Validation results are recorded below.


Final validation:

| Command | Result |
| --- | --- |
| `npm test` | 84 files, 614 tests passed; includes final application changes |
| `npx vitest run tests/components/admin-booking-edit-form.test.tsx` | 9 passed after adding the final failure-toast regression |
| `npm run test:integration` | 37 files, 198 tests passed |
| `npm run test:integration -- tests/integration/db/booking-mutations.integration.test.ts tests/integration/owner-customer-booking-reschedule.integration.test.ts tests/integration/admin-customer-booking-reschedule.integration.test.ts` | 64 passed after final amount-due lock ordering change |
| `npm run test:e2e -- tests/e2e/opening-hours-workflow.e2e.ts tests/e2e/navigation.e2e.ts` | Both navigation tests passed; new booking locator initially failed |
| `npm run test:e2e -- tests/e2e/opening-hours-workflow.e2e.ts` | Final booking journey passed after scoping the navbar link to the banner (the footer has another link) |
| `npm run build` | Passed through Playwright's isolated production-build command (`npm run --silent build`), output `.next-test` |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed; changed E2E/test files also checked after the final locator fix |
| `npm run knip` | Passed |
| `git diff --check` | Passed |

The first integration run had two outdated expectations that allowed the paid-price
exploit; updating those expectations yielded the full 198-test pass. Integration and
E2E runs used the verified separate test Supabase stack, sequentially, without resets.
The production development server and its `.next` directory were not touched.

No claim is made that the requested RON 50 surcharge/refund workflows or durable
customer/guest browser recovery are complete. Those remain outstanding at this review
boundary. Approval of the financial model and explicit change-refund policy is required
before any migration or adjustment implementation.
