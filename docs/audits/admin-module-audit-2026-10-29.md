# Admin Module Audit — 2026-10-29

Independent functional, security and data-integrity verification of the Admin module on branch
`fix/checkout-booking-lifecycle`. This audit covers the working tree, including the uncommitted
checkout-lifecycle changes (`checkout_records` / confirmed-only `bookings`). No application code,
tests, migrations, configuration or data were modified. This report is the only file created.

**Coverage statement.** This audit is **not comprehensive**. Server-side authorization was
verified across every Admin page, Server Action and lib entry point. The booking, payment,
location, court, pricing, coaching and user-role workflows were reviewed in depth. Some areas
received partial or no review; they are listed in §10 and §11. E2E tests were not executed.

Finding labels:

- **Confirmed** — proven by an executed test or by an unambiguous code path. The cited lines are sufficient to reproduce it.
- **Credible risk** — the code allows it, but the impact depends on operational conditions.
- **Runtime verification required** — static reading cannot settle it.

---

## 1. Executive summary

| Severity | Confirmed | Credible risk | Total |
|---|---|---|---|
| P0 | 0 | 0 | 0 |
| P1 | 2 | 0 | 2 |
| P2 | 3 | 3 | 6 |
| P3 | 3 | 0 | 3 |

No authorization bypass, IDOR, secret exposure or browser-side persistence path was found. Every
Admin loader and mutation enforces `requireActiveAdmin`, or `requireReservationRole` where coaches
are intended. Mutations re-verify the actor inside the transaction with `lockActiveAdminAccount`.

The most serious findings:

1. **A1 (P1, confirmed by execution).** The current working tree fails 7 domain integration tests.
   - The uncommitted `protectedPaymentOccupancy` change makes every *registered* Stripe intent keep its court held until Stripe resolves it.
   - The integration suite still expects local expiry to release such holds.
   - The docs (`docs/payments-memberships.md:620,631-647`) describe the new behaviour, so the tests are stale.
   - However, the new behaviour currently has no passing regression coverage, and the branch is not releasable.
2. **D1 (P1, confirmed by code path).** A Stripe capture that arrives after the checkout deadline is persisted as attempt status `expired`.
   - Its compensation refund is created, but the captured attempt can never leave `expired`.
   - It stays in "Payment check required" in Admin Payments forever.
   - It is re-polled by the expiry cron forever.
   - It permanently blocks currency changes for its location.
3. **D2 (P2, confirmed by code path).** Admin financial-exception notifications for late captures on non-confirmed checkouts link to `/admin/bookings/<checkoutId>`.
   - After the checkout split, that page returns 404 for those IDs.
   - The customer link has the same problem.
4. **D3 / D4 / D5 (P2).** Changing a location's timezone, deactivating or archiving a location, deactivating or moving a court, or revoking or suspending a coach is not checked against future bookings or lessons.
   - Currency changes and coach-profile deletion *are* checked. The inconsistency is the defect.

## 2. Admin feature inventory

| # | Feature | Routes / entry points | Depth reviewed |
|---|---|---|---|
| 1 | Admin entry / redirect (no dashboard exists) | `src/app/admin/page.tsx`, `admin-entry-redirect.tsx` | Full |
| 2 | Admin layout and access gate | `src/app/admin/layout.tsx`, per-area layouts, `src/lib/admin/authorization.ts` | Full |
| 3 | Bookings list, search and filters | `src/app/admin/bookings/page.tsx`, `src/lib/db/repositories/bookings.repository.ts` | Partial: confirmed-only join verified; pagination/search SQL not exhaustively tested |
| 4 | Booking details and financial history | `src/app/admin/bookings/[bookingId]/page.tsx`, `src/lib/bookings/admin-details.ts`, `src/lib/payments/financial-history.ts` | Full for access and visibility; totals partially |
| 5 | Booking cancellation by Admin, with refund | `src/lib/bookings/commands.ts:122-182`, `src/lib/payments/refunds.ts` | Full |
| 6 | Direct reservations (create/edit/cancel) | `src/app/admin/reservations/*`, `src/lib/reservations/service.ts` | Create/cancel full; edit partial |
| 7 | Reservation calendar / occupancy projection | `reservation-calendar.tsx`, `listAdminOperationalProjection` | Full |
| 8 | Payment transactions list, attention, detail | `src/app/admin/payments/transactions/**`, `listAdminTransactionProjection` | Full |
| 9 | Admin "Check with Stripe" (payment/refund) | `src/lib/payments/admin.ts`, `src/lib/payments/checkout.ts` | Full |
| 10 | Payment provider settings | `src/app/admin/payments/settings`, `src/lib/payments/settings.ts` | Authorization only |
| 11 | Locations: create/edit/currency/timezone/active | `src/app/admin/locations/**`, `src/lib/admin/locations.ts` | Full |
| 12 | Location publication / archive | `src/lib/admin/locations.ts` | Full |
| 13 | Opening hours | `opening-hours-actions.ts`, `src/lib/admin/opening-hours.ts` | Full |
| 14 | Courts | `src/app/admin/courts`, `src/lib/admin/courts.ts` | Full |
| 15 | Pricing rules | `src/app/admin/pricing`, `src/lib/admin/pricing.ts` | Full |
| 16 | Club settings / contact / test email | `src/app/admin/club`, `src/lib/club/settings.ts` | Authorization; test-email flow not reviewed |
| 17 | Coaching programs | `src/app/admin/coaching/programs`, `src/lib/coaching/admin.ts` | Full |
| 18 | Coach profiles | `src/lib/coaching/admin.ts` | Full |
| 19 | Coaching prices | `src/lib/coaching/admin*.ts`, `src/lib/coaching/lesson-quote.ts` | Full |
| 20 | Coach availability | `src/lib/coaching/availability.ts` | Authorization only |
| 21 | Users list / detail | `src/app/admin/users/**`, `src/lib/admin/users.ts` | Authorization only; filters/pagination not reviewed |
| 22 | User role management (final-admin protection) | `src/lib/admin/user-role.ts` | Full |
| 23 | User status (suspend/reactivate) | `src/lib/admin/user-status.ts` | Full |
| 24 | Admin avatar proxy | `src/app/admin/users/[userId]/avatar/route.ts`, `src/lib/profile/avatar.ts` | Full |
| 25 | Admin notifications / delivery status | `src/lib/notifications/admin-delivery.ts`, `src/lib/notifications/events.ts` | Partial: links and IDOR verified; inbox counts not reviewed |
| 26 | Cron: hold expiry, notification delivery | `src/app/api/payments/holds/expire/route.ts`, `src/app/api/notifications/deliver/route.ts` | Authorization and expiry logic full |
| 27 | Stripe webhook (feeds Admin state) | `src/app/api/payments/stripe/webhook/route.ts` | Settlement path via `commitSettlement`; route diff not reviewed line by line |

Features examined: **27**. Full or near-full depth: 18. Authorization-only or partial: 9.

## 3. Confirmed defects

### A1 — Integration suite fails on the working tree after the registered-intent occupancy change (P1)

- **Feature:** Checkout hold expiry; Admin reads that expire abandoned checkouts.
- **Location:** `src/lib/db/repositories/reservations.repository.ts:15-22` (`protectedPaymentOccupancy`), used by `lockExpiredHoldBookings` / `discoverExpiredHoldLocations` (`src/lib/db/repositories/payments.repository.ts:385-410`).
- **Violated rule:** CLAUDE.md "Validate changes … Never claim a check passed unless executed" and "Add regression tests". The uncommitted behaviour change ships with contradicting tests.
- **Root cause:**
  - The predicate now treats `cp.provider_payment_id IS NOT NULL AND cp.status='pending'` as protected occupancy, regardless of the clock.
  - Hold expiry therefore skips every registered Stripe checkout. Only `checkOnlinePayment` (cron sample or Admin check) can release it.
  - The tests seed checkouts with `provider_payment_id` (`booking-mutations.integration.test.ts:93-94`) and still expect local expiry.
- **Reproduction:** `npm run test:integration`, executed during this audit.
- **Expected vs actual:** Either the tests encode the new rule, or the code keeps the old one. Actually, 7 tests fail:
  - `booking-mutations` (5):
    - expiry/replacement serialization: `court_reservation_no_overlap` violation when seeding the replacement
    - busy-attempt skip: `expected 0 to be 1`
    - TypeScript rollback: "promise resolved 0 instead of rejecting"
    - expired checkout capture: overlap violation
    - initial-booking expiry with modification leases: `expected 0 to be 1`
  - `coaching-booking`: "Admin read expires abandoned coaching…" stays `pending_payment`.
  - `admin-stripe-reconciliation`: late-capture test, `pending_payment` instead of `expired`.
- **Impact:**
  - The branch is not releasable.
  - Hold expiry, rollback atomicity, expiry/replacement serialization and late-capture compensation currently have **no passing integration coverage** on this tree.
  - Earlier regressions in those areas could be hidden behind the expected failures.
- **Existing coverage:** Present but stale.
- **Minimal fix:** Decide the rule. If registered-intent protection is intended (as the docs say), update the fixtures in one of two ways:
  - seed unregistered attempts where local expiry is under test, or
  - drive registered ones through a simulated Stripe cancellation.
  Then add explicit tests for the new rule.
- **Required regression tests:**
  - (a) A registered pending intent past its deadline is not expired by `expirePaymentHolds` and still blocks occupancy.
  - (b) After a simulated Stripe `cancelled` through `checkOnlinePayment`, the hold is released and the slot can be rebooked.
  - (c) An unregistered attempt still expires at its deadline.
  - (d) Restore the rollback and serialization tests using unregistered fixtures.

### D1 — A late-captured attempt stays `expired` and permanently "needs attention" (P1)

- **Feature:** Admin payment transactions, the expiry cron, and the location currency change guard.
- **Location:**
  - `src/lib/payments/domain.ts:116-124`: a capture after the deadline gives `attempt: outcome = "expired"`.
  - `src/lib/payments/domain.ts:103`: a non-pending attempt always returns `targets: null`.
  - `src/lib/db/repositories/payments.repository.ts:192-194` (`paymentCheckRequired`).
  - `:375-381` (`listOverdueStripeCheckouts`).
  - `:344-352` (`locationHasUnresolvedFinancialOperations`).
- **Violated rule:** Payment, capture and refund states must stay distinct (CLAUDE.md). Captured money is recorded as an `expired` attempt that every unresolved-payment query treats as possibly uncaptured.
- **Root cause:**
  - `paymentTransition` collapses "captured after deadline" into `attempt = expired`.
  - The only escape from `expired` is a Stripe `cancelled` outcome (`domain.ts:95-101`), which can never happen for a captured intent.
  - None of the three queries excludes attempts that have a capture receipt.
- **Reproduction (static):**
  1. Create an online Stripe checkout and let its deadline pass, so the hold expires and the attempt becomes `expired`.
  2. Deliver `payment_intent.succeeded`.
  3. `commitSettlement` records the receipt and the `late_capture_compensation` refund (`src/lib/payments/service.ts:208-226`). The attempt stays `expired`.
  4. Admin "Check with Stripe" returns the stored status and changes nothing.
  5. The row keeps `payment_check_required = true`.
  6. Editing the location currency is refused as "unresolved financial operations".
- **Expected vs actual:** Once verified capture evidence and a compensation refund exist, the attempt should leave the unresolved set. Actually, it stays in the attention list, in the cron sample, and in the currency blocker forever.
- **Impact:**
  - A permanent false positive in Admin attention. It cannot be cleared from the UI.
  - The cron spends its 5-per-run sample on unresolvable rows. With several such rows, real overdue intents are checked less often, which makes A1's indefinite occupancy worse.
  - The location's currency can never be changed again.
- **Existing coverage:**
  - `tests/integration/admin-stripe-reconciliation.integration.test.ts` checks the late-capture *refund* row only (`needsAttention:false` for a search by refund id). It never asserts the *payment* row's attention state.
  - That test currently fails anyway (A1).
- **Runtime verification:** The code path is unambiguous. It has not been executed end-to-end because the governing test fails earlier.
- **Minimal fix:** Exclude attempts that have a capture receipt (`payment_capture_receipts`) from `paymentCheckRequired`, `listOverdueStripeCheckouts` and `locationHasUnresolvedFinancialOperations`. The compensation refund already carries the obligation. The alternative is a distinct terminal attempt state, but that is a larger change.
- **Required regression tests:**
  - (a) After a late capture, the payment row has `payment_check_required = false`.
  - (b) `listOverdueStripeCheckouts` excludes it.
  - (c) `locationHasUnresolvedFinancialOperations` is false once the compensation refund succeeds.

### D2 — Financial-exception links point to a 404 for non-confirmed checkouts (P2, regression from the uncommitted change)

- **Feature:** Admin in-app notifications, Admin delivery status, customer notifications.
- **Location:**
  - `src/lib/notifications/events.ts:51`: `/admin/bookings/${bookingId}#financial-history`.
  - `src/lib/notifications/events.ts:55,71`: `/my-activity/history?booking=…`.
  - `src/lib/notifications/admin-delivery.ts:34`: `bookingHref`.
  - Target page: `src/app/admin/bookings/[bookingId]/page.tsx:36` calls `notFound()` when `findAdminBookingDetails` returns null.
  - Details query joins `public.bookings confirmed` (`bookings.repository.ts:25,50,117`).
- **Violated rule:** UI state consistency. A notification must lead to the evidence it describes.
- **Root cause:**
  - After the checkout split, `bookingId` in exception facts is a `checkout_records.id`.
  - Late-capture exceptions are raised specifically for checkouts that never became confirmed bookings (`service.ts:208-226`), so no `bookings` row exists for them.
- **Reproduction:**
  1. Produce a late capture on an expired checkout (see D1).
  2. Open the Admin notification.
  3. The page returns 404.
- **Expected vs actual:** The notification should open the transaction or financial evidence. Actually, it gives a 404, and the customer link most likely shows nothing for that id (the customer history view was not inspected).
- **Impact:** Admins cannot navigate to the exceptions that most need investigation. The evidence is still reachable manually via Payments → Transactions.
- **Existing coverage:** `tests/unit/notifications/events.test.ts:112` asserts only the href string.
- **Minimal fix:** When the checkout has no `bookings` row, link to the payment transaction detail (`/admin/payments/transactions/payment/<attemptId>`). Apply the same choice in `admin-delivery`.
- **Required regression tests:** An integration test that a late-capture exception's href resolves to a page that loads for an Admin.

### D3 — Location timezone change is not guarded against existing bookings or in-flight checkouts (P2)

- **Location:** `src/lib/admin/locations.ts` `saveAdminLocation`. The currency guard is at `:106` and `currencyChangeBlockers` at `:129-152`. There is no equivalent for `timezone` (`:78`).
- **Violated rule:** Snapshotted booking terms (CLAUDE.md "snapshotted at the appropriate boundary"). The same guard is applied to currency but not to timezone.
- **Root cause:** Bookings store local date and minutes. Settlement compares the location's timezone to the revision snapshot, and on a mismatch it expires the checkout and refunds it.
- **Reproduction:**
  1. Start an online checkout at a location.
  2. As Admin, change the location timezone.
  3. Complete payment.
  4. The settlement result is `expired` and a compensation refund is created.
  5. Separately, existing confirmed bookings are rendered at the same local minutes in the new zone. Their absolute instant silently shifts.
- **Expected vs actual:** The change should be blocked, like currency, while unfinished occupancy exists. Actually, it is accepted.
- **Impact:** Paying customers are refunded unexpectedly, and the calendar meaning of confirmed bookings shifts.
- **Coverage:** None found for timezone edits with live occupancy.
- **Minimal fix:** Reuse `currencyChangeBlockers` (occupancy and financial checks) when the timezone changes.
- **Tests:** Timezone change with (a) a pending checkout and (b) a future confirmed booking is refused. With neither, it succeeds.

### D4 — Court deactivation/move and location deactivation/archive are not checked against future bookings (P2)

- **Location:**
  - `src/lib/admin/courts.ts:64-90`: checks pricing coverage only.
  - `src/lib/admin/locations.ts` `saveAdminLocation` (`is_active`) and `setAdminLocationArchived`.
  - Projections filter on `c.is_active` and `l.is_active AND l.archived_at IS NULL`: `reservations.repository.ts:181-182,196-197,381-382`. `listInternalLocations` keeps a location only if it is structurally ready or `has_reservations`, and lists active courts only (`:209,229`).
- **Root cause:** Occupancy remains in the database, but every Admin read path drops inactive courts and locations.
- **Reproduction:**
  1. Create a future confirmed booking on court X.
  2. Deactivate court X, or move it to another location.
  3. The booking disappears from the Admin reservation calendar. It still exists in the bookings list. Its future occupancy cannot be seen or managed from the calendar.
  4. In-flight checkouts on the court are expired and refunded at settlement.
- **Expected vs actual:** Either block deactivation while future occupancy exists, or require explicit cancellation. Actually, the booking silently vanishes from the calendar.
- **Impact:** Customers keep bookings for a court staff believe is out of service. Staff cannot see the clash.
- **Coverage:** None found.
- **Minimal fix:** Reuse the live-occupancy query (`clubs.listLocationLiveOccupancy`, already used by `currencyChangeBlockers`), scoped to the court, before deactivate, move or archive. Return a blocking message.
- **Tests:** Deactivating, moving or archiving with a future confirmed booking or a held checkout is refused. It succeeds when there are none.

### D5 — Revoking the coach role or suspending a coach ignores future lessons (P2)

- **Location:** `src/lib/admin/user-role.ts:44` (`updateAdminUserRole`) and `src/lib/admin/user-status.ts:33` (`updateAdminUserStatus`). Compare `src/lib/coaching/admin.ts:310` (`deleteCoachProfile` returns `active-lessons`).
- **Root cause:** Only profile deletion checks lessons. Role revocation and suspension remove coach access (`/coach/bookings`) and hide the public profile.
- **Reproduction:**
  1. Book a future lesson with coach C.
  2. As Admin, remove C's coach role, or suspend C.
  3. The change succeeds without warning.
  4. The lesson remains confirmed, with a coach who can no longer see it.
- **Expected vs actual:** The same `active-lessons` guard, or an explicit warning and acknowledgement. Actually, there is no check.
- **Impact:** Lessons without an operational coach, and no Admin signal.
- **Coverage:** None found.
- **Minimal fix:** Call the same future-lesson query used by `deleteCoachProfile` inside the role and status transactions, after the existing locks.
- **Tests:** Revoking the role or suspending with a future lesson is refused, or requires explicit confirmation. It is allowed when there are no lessons.

### D6 — Coaching quote accepts an override in a currency that has no club price (P3)

- **Location:** `src/lib/coaching/lesson-quote.ts` (the authoritative quote resolves `override ?? club`). The selector filters with `hasPublishedClubPrice(program, location.currency)` (`src/lib/coaching/booking-options.ts:37`). See also `docs/coaching.md:198`.
- **Root cause:** The server quote does not re-apply the selector's "club price in the location currency" requirement.
- **Reproduction:** A crafted request for a program and coach pair that has only a coach override in that currency.
- **Impact:**
  - A lesson is bookable for a program that is not publicly offered at that location.
  - The price is still server-side, so there is no price tampering.
- **Fix:** Require `hasPublishedClubPrice(program, location.currency)` in the quote.
- **Test:** Quote and checkout reject the program when only an override exists.

### D7 — Admin cancellation toast uses customer wording (P3)

- **Location:** `src/lib/payments/refund-message.ts:9`: "Booking cancelled. Your payment has been refunded."
- **Impact:** The Admin sees "Your payment" for a customer's refund. Cosmetic.
- **Fix:** Add an Admin variant, e.g. "Booking cancelled. The customer's payment has been refunded."
- **Test:** A component test of the Admin cancel result message.

### D8 — Adjustment holds occupy courts but have no Admin calendar card (P3)

- **Location:** `reservations.repository.ts:388`. Held rows need `b.id is not null`, and adjustment-hold reservations are not linked through `checkout_records.reservation_id`.
- **Impact:** Admins see a free-looking slot that cannot be booked while a customer modification payment is in progress. The blocking itself is correct.
- **Fix:** Project adjustment holds as a distinct "modification in progress" hold.
- **Test:** A calendar projection includes a pending adjustment hold.

## 4. Architectural risks

- **R1 (P2, credible).** Indefinite court occupancy depends on cron and Stripe availability (consequence of A1's design).
  - Registered intents are released only by `checkOnlinePayment`.
  - The cron samples 5 random overdue intents per run (`payments.repository.ts:375-381`; `docs/payments-memberships.md:647`).
  - If the cron is not configured, Stripe is unreachable, or many intents accumulate (D1 inflates the pool), abandoned checkouts can block courts for long periods.
  - Mitigation: Admin "Check with Stripe" exists; the docs state the rule.
  - Recommend an occupancy-age metric or alert, and excluding D1 rows from the sample.
- **R2 (P2, credible).** `setCoachingProgramStatus` takes the admin fence and the program lock, but not the configuration fence that the other configuration writers use.
  - A concurrent checkout quote could read the program as active while it is being deactivated.
  - Impact is bounded because settlement re-quotes.
  - Needs runtime verification under concurrency.
- **R3 (P2, credible).** Admin "attention" is derived (no stored state).
  - D1 shows that any terminal state not anticipated by the derivation becomes a permanent false positive.
  - Derived predicates should key on evidence (capture receipts, provider-confirmed cancellation) rather than on attempt status alone.

## 5. Business logic inconsistencies

| Topic | Guarded | Not guarded |
|---|---|---|
| Live occupancy before a location change | currency (`locations.ts:106`) | timezone, `is_active`, archive (D3, D4) |
| Future lessons before a coach change | profile deletion (`coaching/admin.ts:310`) | role revocation, suspension (D5) |
| Program offered at location | public selector (`booking-options.ts:37`) | authoritative quote (D6) |
| Opening-hours reduction | Existing reservations are grandfathered on purpose (documented) | n/a: consistent with docs |

## 6. Security findings

No confirmed security defects.

- Every Admin page loader and Server Action calls a lib function that runs `requireActiveAdmin`. This was verified by enumerating `src/lib/admin/*`, `club/settings.ts`, `coaching/admin*.ts`, `coaching/availability.ts`, `payments/{settings,admin}.ts`, `bookings/admin-details.ts`, `reservations/service.ts` and `notifications/admin-delivery.ts`. The `/admin` layout gate (`requireReservationRole`) is therefore not the only check, consistent with the Next.js docs' warning about layout-only authorization.
- `createDirectReservation` intentionally allows coaches (`requireReservationRole`). `projectStaffOccupancy` removes customer PII for coaches.
- Mutations re-lock the actor (`lockActiveAdminAccount`) inside the transaction, so a revoked admin cannot finish an in-flight mutation.
- Final-admin protection: `lockAdminRole`, `lockUserIdentityFacts`, a count under lock, and a DB check (`23514`). Self-demotion and self-suspension are blocked.
- Avatar proxy: active account required; the admin role is required for a target user; UUID validation; path ownership check (`isOwnAvatarPath`); `private, no-store`; `nosniff`; webp only.
- Notification delivery detail is scoped to the requesting admin's own message, so there is no IDOR.
- The cron endpoints use a bearer secret of at least 32 characters with a timing-safe comparison. `checkout/abandon` uses a hashed capability token.
- No browser Supabase client or application-table access was observed in Admin code.

## 7. Data-integrity findings

- D1: captured funds recorded under a non-captured attempt status. The financial evidence (receipt and refund) is intact; the derived state is wrong.
- D3: the absolute instant of existing bookings shifts on a timezone edit.
- D4: confirmed occupancy becomes invisible on the Admin calendar.
- Verified intact:
  - GiST exclusions `court_reservation_no_overlap` and `court_reservation_coach_no_overlap` cover `active` and `held`. The A1 test failures themselves demonstrate the constraint rejecting an overlapping insert.
  - Settlement receipt idempotency.
  - A late capture never reclaims released occupancy (it goes to compensation).
  - A cancellation keeps the booking confirmed until refund evidence is verified.
  - Refund execution does not create a second provider refund while an outcome is unknown.

## 8. Test quality assessment

- Unit and component suites are broad and green. Their gaps:
  - Notification links are asserted as strings, not as reachable routes (D2).
  - The late-capture integration test asserts the refund row, not the payment row (D1).
  - There are no tests for timezone, deactivation or archive with live occupancy (D3, D4), or for coach role/status changes with future lessons (D5).
- The integration suite is the main safety net for concurrency and lifecycle, and it is currently red for domain reasons (A1).
  - Seven tests share one fixture assumption (registered intents expire locally) that the uncommitted code invalidated.
  - Until they are fixed, rollback atomicity and expiry serialization are unverified on this tree.
- Three integration failures are environmental: Supabase Auth or Storage at `127.0.0.1:55324` refused the connection, or failed with "Error sending confirmation email". They do not indicate application defects, but they leave signup and Storage grant tests unverified.
- E2E (Playwright) was not executed. See §10.

## 9. Verified behavior

Static review plus green unit/component tests unless stated otherwise:

- Server-side authorization on all Admin loaders and actions (§6).
- Final-admin protection under locks; self-management blocked.
- Pricing rules:
  - configuration fence plus location lock
  - stale-revision rejection
  - overlap check
  - opening-hours containment
- Admin bookings list and details show only confirmed bookings (`JOIN public.bookings`). Transactions label non-booking checkouts via `is_actual_booking`.
- Admin booking cancellation:
  - online refunds keep the booking confirmed until the refund succeeds
  - offline cancellation releases the reservation
  - idempotent refund processing
- Settlement:
  - stable lock order (configuration, location, booking, reservation, attempt)
  - receipt idempotency
  - court quote revalidation
  - cancel intent beats capture
  - late capture triggers compensation, never re-confirmation
- `checkAdminRefundWithProvider` is strict, and retries only rejected outcomes.
- Coaching price = per-person price × participants, as documented.
- `deleteCoachProfile` and `deleteCoachingProgram` blocking rules.
- Cron and capability authorization.
- Integration (executed): **522 of 532 tests passed**, including the booking-mutation, Admin payment, coaching and migration suites, except for the failures listed in A1 and §8.

## 10. Runtime verification required

- D1 end to end: late capture → Admin attention → "Check with Stripe" → currency change refusal. Run against the isolated test DB once A1 is fixed.
- R1: occupancy duration of abandoned registered intents with the cron disabled, and with many overdue intents.
- R2: concurrent program deactivation and checkout.
- E2E suites (`tests/e2e/admin-booking-management`, `booking-adjustments`, `booking-refund-recovery`, `initial-checkout`, `opening-hours-workflow`) were not run. They need the app server and the isolated DB lock. An earlier E2E run held the lock during this audit.
- Supabase-dependent tests (signup, password change, Storage grants) need the local Supabase stack running.
- Areas not reviewed beyond authorization:
  - users list filters/pagination
  - coach availability editing
  - payment provider settings
  - club test email
  - notification inbox unread counts
  - Admin reservation edit flow details
  - Stripe webhook route diff
  - `financial-history` totals arithmetic
  - Admin bookings search/pagination SQL

## 11. Prioritized remediation plan

1. **A1.** Decide and lock in the registered-intent occupancy rule. Fix the 7 stale integration fixtures and add the 4 regression tests. Rerun `npm run test:integration` to green.
2. **D1.** Exclude attempts with capture receipts from the three unresolved-payment queries. Add the 3 regression tests. This also reduces R1.
3. **D2.** Route notification links for non-confirmed checkouts to the transaction detail.
4. **D3, D4.** Apply the live-occupancy blocker to timezone, court deactivation/move, and location deactivation/archive.
5. **D5.** Add the future-lesson guard to coach role revocation and suspension.
6. **R1.** Add monitoring for long-held registered intents.
7. **R2.** Take the configuration fence in `setCoachingProgramStatus`.
8. **D6, D7, D8.** Low-risk consistency and UX fixes.
9. Run the E2E suites and the Supabase-dependent integration tests in a full local environment. Complete the areas listed in §10.

## Checks executed during this audit

| Command | Result |
|---|---|
| `npm test` (unit + components) | 189 files, **2058/2058 passed** |
| `npm run test:integration` (isolated test DB) | 56 files: 51 passed, 5 failed. **522/532 tests passed**, 10 failed (7 domain failures, A1; 3 environmental Supabase failures) |
| `npx tsc --noEmit -p .` | Passed (exit 0) |
| `npm run lint` | Passed (exit 0) |
| `npm run test:e2e` | **Not executed** |
