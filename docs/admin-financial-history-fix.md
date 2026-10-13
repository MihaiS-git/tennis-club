# Admin financial history and booking-loading correction

## Financial integrity check

Read-only inspection of the development database identified booking
`29e95be8-478e-4b93-b85f-fa63466b54fb`. No records were changed.

| Operation | Database identity | Amount | Stripe reference | Recorded status | Created (UTC) |
| --- | --- | --- | --- | --- | --- |
| Original payment | `6e44f70f-19a6-46fd-bbde-40b3d113f018` | RON 50.00 | `pi_3UPkkZ0XKEh1Hj0o0nuBgxdk` | succeeded | 2026-10-12 15:02:51 |
| Additional payment | `fceb2748-c3f1-4d01-9251-a795a40d2cd2` | RON 25.00 | `pi_3UPkkt0XKEh1Hj0o0XvmJNQS` | succeeded | 2026-10-12 15:03:11 |
| Reduction refund | `720bf90c-a1f9-41cf-bd83-64eaa63c8132` | RON 25.00 | `re_3UPkkt0XKEh1Hj0o0blSYoEY` | succeeded | 2026-10-12 15:04:06 |

The additional attempt links to applied adjustment
`a05c6c55-1b72-40b4-b5ae-270103f2f38f` (5000 → 7500 minor units).
The refund links to applied adjustment `d5a8a8a4-b96f-4c47-84a6-0907437949b0`
(7500 → 5000), and to the additional attempt and its same Stripe PaymentIntent.
Its captured-amount snapshot is 2500 minor units. Both stored payment settlement
receipts match their attempt IDs, provider references, RON amounts and succeeded
outcomes, without unresolved reconciliation. Provider refund history is empty.

The persisted financial records reconcile: captured 7500, refunded 2500, net 5000.
This is a partial refund of the booking's collected funds and a full refund of its
RON 25 additional capture. The original RON 50 capture has no refund against it.
Stripe references and verified observations were inspected in the database; no new
Stripe transaction or provider mutation was initiated.

A final read-only transaction executed the corrected TypeORM projection against
this same booking: it returned all three exact operation identities and amounts,
with `refunded_minor=0` on the original attempt and `2500` on the additional attempt.

## Five defects and corrections

1. **Missing individual operations:** the old booking-based projection selected
   one refund and one preferred attempt using lateral `LIMIT 1` queries. Applied
   adjustments made it display the current booking total instead of the selected
   attempt's amount. The projection now lists every attempt and refund separately,
   applying existing search/filter/sort/count/page-clamping before 20-row pagination.
   Operation and provider IDs are searchable; stable kind/ID ties prevent unstable
   pagination. Historical bookings without attempts remain explicitly historical.
2. **Partial-refund representation:** the old row combined payment and refund
   labels without comparing captured and successfully refunded amounts. Each
   payment now compares only successful refunds linked to that attempt; partial
   and fully refunded labels cannot be inferred from an unrelated booking refund.
   Reduction refunds are labelled as partial booking refunds. Details include
   booking total, collected, refunded, net, outstanding and uncompleted obligations.
3. **Zero-amount ZodError:** real Next.js/Chrome direct navigation reproduced
   `Too small: expected number to be >=1` in transaction details. `formatMoney`
   reused strictly positive price-input validation for valid zero summary balances.
   Display now accepts nonnegative integer amounts; pricing and payment inputs
   retain strictly positive validation. Direct/click navigation now renders zero
   outstanding/uncompleted-refund amounts without throwing.
4. **Transaction navigation:** details existed only in row-local dialog state,
   with no URL or payment-attempt identity. The existing component and projection
   now serve `/admin/payments/transactions/payment/<id>` and `/refund/<id>`.
   Exact kind/ID lookup is independent of list filters and pagination. The server
   authorizes Admin access before reads, and invalid/missing identities return 404.
   Return links retain list query state; the Transactions navigation remains active.
   Recovery results re-read the exact refund or adjustment attempt, and cannot
   replace another transaction's detail snapshot.
5. **Persistent booking-loading notification:** the booking effect already called
   dismiss on success/disposal and guarded late responses. Sonner separately queues
   creation with `setTimeout` and dismissal with animation frames. Dismissal can run
   before its deferred creation callback, leaving an infinite loader rendered even
   though the store says it is dismissed. A standalone Chrome reproduction using
   the installed React/Sonner and the original booking effect deliberately delayed
   publication: after completion and component departure, the rendered page still
   contained `Loading booking…`, while the active toast store was empty. Booking
   and price-read progress now belongs to the edit component; transaction recovery
   progress similarly belongs to its details. Progress disappears on completion,
   failure, cancellation, disposal or navigation. Errors remain visible; disposed
   request callbacks cannot create new notifications. No arbitrary timeout was added
   to application code and no Sonner dependency or vendor source was modified.

## Validation

The existing PostgreSQL and Playwright fixtures simulate Stripe; they use only the
separate test database and server on port 3100 with `.next-test` output. Tests do not
reset the development database or use actual Stripe transactions.

- All 626 unit/component tests passed. Coverage includes transaction-specific links/actions, partial/full
  refund labels, zero-balance formatting with retained positive price validation,
  details authorization/404, loading completion/error/disposal and late callbacks.
- All 214 PostgreSQL integration tests passed. The added exact 50 + 25 − 25 regression
  asserts three financial identities, correct refund/capture linkage, RON 50 net,
  and exact detail selection. Existing payment/refund/concurrency regressions pass.
- All 3 Playwright scenarios passed (paid-edit/financial workflow plus navigation
  regressions); the isolated production build passed. The real Next.js/Chrome
  paid-edit workflow verifies all three Admin financial rows,
  amounts and identities, original Paid versus fully refunded additional capture,
  completed partial booking refund, zero balances, direct links, refresh, Back/Forward,
  retained list query and active navigation. An ordinary owner is denied Admin details.
  It also delays a booking load, disposes the edit, navigates to History, waits for
  the late response and checks no loading toast exists. A failed Server Action request
  shows the genuine booking error and leaves no loading toast.

`npm run typecheck`, `npm run lint`, `npm run knip` and `git diff --check` passed.
No remaining defect was found among the five requested issues.

No financial schema change, development data write/reset, branch change, commit,
merge or development-server restart was performed. Existing unrelated work is retained.
