# Stripe 3DS2 validation — 2026-10-28

Branch: `perf/route-prefetch`. Real Chrome, real Stripe TEST API and Stripe.js,
real Stripe CLI webhook forwarding, and the isolated `tennis-club-tests` database.
The live harness ran Next.js on port 3100 with `.next-test`. No development
server restart, default `.next` build, real payment, or production credential was used.
Existing uncommitted changes were preserved; this work remains uncommitted.

Card: `4000 0000 0000 3220`, the required-3DS2 card in
[Stripe's official testing guide](https://docs.stripe.com/testing#regulatory-cards).
All three final live browser tests passed together. Stripe charge evidence reported
`authentication_flow=challenge`, `result=authenticated`, and `version=2.1.0`.
Fixture database rows were removed by the existing isolated teardown; the Stripe
test PaymentIntent IDs below identify the successful verification run.

## 1. Successful authentication — PASS

- Browser: public `/book` selected a court, opened the dynamically loaded contact
  dialog, then loaded the payment form. No Stripe.js script request occurred
  before checkout; exactly one script loaded afterward, with one payment attempt.
- While the challenge was open, the intent was `requires_action`, manual capture,
  with zero received funds. The original payment iframe remained connected.
  After 30 seconds the loading toast stopped and the underlying button read
  “Waiting for authentication…”. Completing the challenge produced booking confirmation.
- Stripe: `pi_3UVSZw0XKEh1Hj0o0nc2U11W` reached `succeeded`, with manual capture,
  `amount_received=5000`, `amount_capturable=0`; the charge was captured for RON 50.00.
- Database: booking `4227477c-7b6a-4ab2-b723-bebea61dfcd6` was confirmed,
  reservation active, total 5000, end minute 1020, no reschedule revision,
  and exactly one matching successful attempt/capture receipt.

## 2. Failed authentication and retry — PASS

- Browser: clicked **Fail** on the actual Stripe challenge. The same payment iframe
  stayed mounted and payment became available again after the error. Retrying with
  the test card and completing authentication used the same PaymentIntent.
  The separate challenge-close/cancel variant was not exercised.
- Stripe: `pi_3UVSab0XKEh1Hj0o1KopDcJ9` returned to `requires_payment_method`
  with `amount_received=0` after failure. After retry it reached `succeeded`,
  with a manually captured RON 50.00 charge and authenticated 3DS2 evidence.
- Database: booking `9ff302d9-e997-47a7-9b6c-e756d6e39366` remained
  `pending_payment`, reservation held, with no capture receipt after failure.
  Retry confirmed it with one payment attempt and one RON 50.00 capture receipt.

## 3. Additional payment for an extension — PASS

- Starting fixture: an authenticated member's confirmed 16:00–17:00 booking,
  RON 50.00. The original booking/payment evidence was seeded by the existing
  harness; the surcharge checkout, authentication, capture, and settlement were real.
- Browser: Stripe was absent before checkout. Extending to 17:30 opened the dynamic
  payment component for RON 25.00. The original booking remained unchanged before
  authentication. The payment iframe stayed mounted during the challenge, and
  completing it returned to booking details without a remaining loading toast.
- Stripe: `pi_3UVSav0XKEh1Hj0o1oYKZr4m` reached `succeeded` with manual capture,
  `amount_received=2500`, `amount_capturable=0`, and a captured RON 25.00 charge.
- Database: booking `8e950be2-9a00-4fcd-b8fe-4a9ca43c5324` advanced to one
  reschedule revision, total 7500, end minute 1050. The adjustment was `applied`,
  its attempt `succeeded`, and its single capture receipt matched 2500. No refunds.

## Corrections

1. Reproduced deferred Stripe initialization hanging in React development Strict
   Mode: the card iframe never appeared, even after 30 seconds, and Stripe warned
   about duplicate script loading. The installed pure loader replaces pending
   script listeners when called twice; render-level `useMemo` does not prevent
   Strict Mode's duplicate call. Cache the lazily created Stripe promise by
   publishable key across renders/remounts. Initialization remains deferred.
2. Real failed 3DS2 returned `invalid_request_error` with code
   `payment_intent_authentication_failure`. Previously it became an uncertain
   outcome and removed retry. Permit that exact error alongside existing
   validation/card errors. Unknown errors still block another submission.

Both corrections are confined to `src/app/book/online-payment.tsx`; regression
coverage extends the existing component and real Stripe lifecycle suites.
The live card-iframe helper now allows 30 seconds for the external form to load.
No server capture, deadline, or recovery policy was changed.

## Automated checks

- Initial `npm test -- ...`: the npm script includes both full suite directories,
  so all 183 unit/component files ran: **1,996 passed** before corrections.
- After corrections: `npx vitest run tests/components/online-payment.test.tsx
  tests/components/booking-calendar.test.tsx tests/components/booking-edit-form.test.tsx
  tests/unit/stripe-adapter.test.ts tests/unit/customer-booking-action.test.ts`:
  **109 passed**, including Strict Mode/remount deduplication, failed-auth retry,
  expiry during authentication, late responses, and bounded loading behavior.
- Existing real Stripe decline/retry/capture browser test: **1 passed** after
  the deferred-initialization correction.
- `npx playwright test -c playwright.stripe-live.config.ts
  booking-modification-lifecycle --grep 3DS2`: **3 passed** after both corrections.
- `npm run test:integration -- tests/integration/stripe-payment.integration.test.ts
  tests/integration/payment-foundation.integration.test.ts
  tests/integration/db/checkout.integration.test.ts
  tests/integration/db/booking-mutations.integration.test.ts`: **216 passed**.
  These cover late authorization rejection, accepted capture grace, interrupted
  capture recovery, concurrency, surcharge settlement, and expiry invariants.
  Provider responses in these integration tests are simulated; the browser results
  above independently used real Stripe TEST payments.
- ESLint on the three changed TypeScript files, `npx tsc --noEmit --incremental false`,
  and `git diff --check`: **passed**.
