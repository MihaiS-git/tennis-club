# P10 — Admin payment transaction query efficiency

Measured on the isolated local `tennis-club-tests` PostgreSQL database at
`127.0.0.1:55322/postgres`. No production/development database, migrations,
indexes or dependencies were changed. Synthetic fixtures were inserted in a
single transaction and rolled back, including on failure.

## Query structure

`listAdminPaymentTransactions()` verifies an active Admin, parses filters, and
calls `readFinancialHistory()`. The repository's
`listAdminTransactionProjection()` performs listing, filtering, exact counts,
ordering, page clamping and pagination in one SQL statement through TypeORM.

Before correction:

1. `operations` unions original payment attempts, adjustment payment attempts,
   refund obligations and bookings with no payment attempts.
2. `transactions` joins booking/revision/reservation context, computes verified
   refunded amounts, builds refund JSON, and aggregates provider-event JSON.
   Its volatile `clock_timestamp()` attention expressions prevent CTE inlining.
3. `filtered AS MATERIALIZED` applies booking/detail, status, provider, method,
   attention, literal-substring search and default abandoned-request filters.
4. `stats` counts the filtered rows, while `ordered` numbers those rows for
   sorting, page selection and the final JSON array.

Consequently, even a booking-specific query built every transaction's detailed
financial payload before filtering. The problem was the work crossing that
materialization boundary, not simply the presence of CTEs.

After correction:

1. The original `operations` union remains.
2. `candidates` applies booking/detail, status, provider, method and search
   predicates before materialization. It retains operation fields and the
   existing time-based attention flags. Reconciliation attention uses an
   indexed `EXISTS` predicate instead of constructing event JSON.
3. `filtered AS MATERIALIZED` applies attention and default abandoned-request
   visibility. Both counting and ordering consume the same filtered rows.
4. `stats`, `ordered` and bounded `page_operations AS MATERIALIZED` determine
   the accurately counted, clamped page of at most 20 operations.
5. `transactions` builds the original full payload only for that page.

Date-descending order remains `created_at DESC, transaction_kind ASC,
transaction_id ASC`; existing date-ascending, signed-amount and status sort
options retain their original expressions and tie breakers. Filters still
precede pagination. No financial policy, verified-refund evidence criteria,
status mapping, authorization or persisted data changed. Attention still uses
database wall time and the existing grace thresholds.

After projection, `loadAdminTransactionContext()` retains the existing batched
TypeORM reads for the returned page's revision IDs, adjustment IDs, booking
payments/refunds/captures and refund executions. Executions are loaded in one
batch by refund IDs. Financial summaries remain in TypeScript; no additional
round trips were introduced. The existing integration test still observes six
SQL statements for its representative page (optional batches depend on its
contents).

## Measurement method

The profiling harness used the repository function to capture its exact SQL and
parameters, then executed `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` through a
transaction-bound TypeORM EntityManager. It compared the original statement and
the corrected statement on the same fixture data and statistics. Each case was
run three times; tables below report median execution time, excluding planning.
Relevant fixture tables were analyzed after population. All measured plans had
zero shared-buffer reads: these are warm-cache local measurements, not cold-disk
or production latency estimates.

Two fixture sizes were used: 1,000 and 5,000 bookings, each with one successful
Stripe payment; approximately one quarter also had a refund obligation. The
history-heavy run additionally inserted one pending execution per refund and
three provider events per payment: one requiring reconciliation and two resolved.
The 5,000-booking history-heavy run had 1,267 refunds/executions and 15,000 events,
yielding 6,267 transaction rows. No real provider calls occurred.

Cases:

- Unfiltered first page: default date-descending sort and default visibility.
- Filtered first page: literal customer-name substring matching about 1% of
  bookings (including those bookings' refunds).
- Booking-specific: exact booking UUID with its payment and refund.
- Later page: page 200; at 1,000 bookings this also exercises last-page clamping.
- Attention-required first page: existing refund-status/reconciliation rules.

The history-heavy harness also compared complete original/corrected projection
JSON for each case and fixture size. These comparisons include ordered rows,
counts, clamped page, refund fields, reconciliation and verified refund totals.
All ten comparisons passed. Fixtures avoided time-threshold boundaries.

## Results

### Without provider-event/execution history

| Case | 1,000 bookings: before → after (ms) | 5,000 bookings: before → after (ms) | 5,000: shared buffer hits before → after |
| --- | ---: | ---: | ---: |
| Unfiltered page 1 | 24.869 → 13.111 | 133.953 → 65.860 | 96,331 → 67,539 |
| Filtered page 1 | 25.883 → 11.573 | 142.264 → 58.264 | 96,331 → 62,561 |
| Booking-specific | 22.117 → 0.431 | 126.007 → 0.423 | 96,331 → 84 |
| Later page | 25.304 → 13.783 | 137.756 → 64.619 | 96,331 → 67,459 |
| Attention page 1 | 27.016 → 13.820 | 126.469 → 59.501 | 96,331 → 67,539 |

At 5,000 bookings, the original unfiltered/later queries read/wrote 352/703
temporary blocks; filtered/booking/attention queries wrote 351 temporary blocks.
Every corrected case used zero temporary blocks.

### With growing provider-event/execution history

| Case | 1,000 bookings: before → after (ms) | 5,000 bookings: before → after (ms) | 5,000: shared buffer hits before → after |
| --- | ---: | ---: | ---: |
| Unfiltered page 1 | 377.123 → 18.498 | 7,989.762 → 86.189 | 2,374,129 → 88,079 |
| Filtered page 1 | 374.678 → 14.824 | 7,980.003 → 76.668 | 2,374,129 → 73,194 |
| Booking-specific | 375.272 → 1.176 | 8,044.729 → 4.082 | 2,374,129 → 818 |
| Later page | 395.008 → 13.690 | 7,919.252 → 84.554 | 2,374,129 → 87,939 |
| Attention page 1 | 388.362 → 18.475 | 8,354.719 → 83.178 | 2,374,129 → 88,079 |

At 5,000 bookings, the old first/attention pages read/wrote 3,181/8,079 temporary blocks; page 200 used 4,547/8,079. Filtered and booking reads wrote 2,688 temporary blocks. All corrected cases used zero temporary blocks. Planning time was approximately 3–4 ms, separate from the execution times above.

## Actual plan findings

The no-history 5,000-booking run had 6,316 operation rows. Before correction,
the detailed projection ran 6,316 times even when the final booking filter
returned only two rows; the substring case discarded 6,253 fully projected rows.
After correction, that booking's candidate CTE emitted just two rows, using
existing booking/foreign-key indexes, and the full projection ran twice.

For ordinary pages, verified-refund sum subplans and full reconciliation
aggregations fell from once per transaction to once per returned row (20).
The filtered CTE is executed once and scanned for both count and ordering;
these scans are purposeful reuse, not repeated execution of the financial
projection. The page boundary is explicitly materialized to prevent joins from
expanding full payload work before page selection.

In the history-heavy 5,000-booking first-page plan, the old reconciliation
aggregation performed 6,267 sequential scans over 15,000 provider-event rows:
approximately 94 million event-row visits, returning only 20 transactions.
The corrected attention predicate used `payment_reconciliation_idx` via
5,000 index-only probes; full event aggregation ran only 20 times (approximately
300,000 event-row visits). The old first-page sort spilled to disk using an
external merge of 21,576 KiB. The corrected operation sort used 1,436 KiB in
memory. These are confirmed reductions in avoidable work.

Sequential scans over all operations for an exact unfiltered count are expected.
Small-table sequential scans, empty branches, and the retained count/sort CTE
scans are not themselves defects. With the current row-number page selection,
the corrected window evaluates all filtered operation rows; this modest work on
narrow rows is retained and is included in the measurements.

## Existing indexes inspected

The live `pg_indexes` catalog confirmed:

- Booking and operation primary keys, booking reservation uniqueness.
- `payment_attempts_booking_idx`, adjustment uniqueness and provider-payment ID
  uniqueness.
- `payment_refunds_booking_idx` and `(payment_attempt_id, operation_key)` uniqueness.
- Revision `(booking_id, revision_number)`, `(booking_id, operation_key)`, identity
  and partial adjustment indexes.
- Capture receipt attempt indexes.
- Refund execution `(refund_id, execution_number)` uniqueness, allowing a backward
  scan to find the latest execution, plus active/idempotency/provider-refund indexes.
- Partial `payment_reconciliation_idx (attempt_id) WHERE reconciliation_required`.

Existing indexes suffice for the correction; no index or migration was added.

## Validation

Passed:

- `npm run test:integration -- tests/integration/admin-payment-transactions.integration.test.ts`
  — 7 tests, including the new tied-timestamp, cross-page ordering, booking-only,
  filtered-count and clamped-page regression. Existing authorization, history,
  context, privacy and constant query-count checks still pass.
- `node node_modules/vitest/vitest.mjs run tests/unit/financial-reporting.test.ts tests/unit/financial-history-context.test.ts tests/unit/admin-payment-check.test.ts`
  — 16 tests.
- `node node_modules/vitest/vitest.mjs run tests/unit/payment-attention.test.ts`
  — 7 tests.
- `npm run typecheck`.
- `npx eslint src/lib/db/repositories/payments.repository.ts tests/integration/admin-payment-transactions.integration.test.ts`.

No complete suites or production build were run. Local Supabase discovery and
integration access required sandbox escalation; they used the project's verified
isolated environment and runner lock. No migration initializer or reset was run.

The session's raw plans, timings, inspected indexes, original/final SQL and local
profiling harnesses are preserved in
[`/tmp/p10-query-efficiency-evidence.json`](/tmp/p10-query-efficiency-evidence.json).
The final source omits the now-unused `bool_or` output from the page-only event
aggregate; the measured plans already prune that unused value.

## Remaining scalability limits

Exact counts and substring search still require work proportional to candidate
history; literal substring matching intentionally cannot use ordinary B-tree
indexes. Sorting and row numbering still grow with filtered result size, and
larger histories can eventually spill even with narrower rows. There is no
keyset-pagination or approximate-count behavior change.

Resolved provider-event JSON aggregation still has no general attempt-ID index:
it sequentially scans event history for each returned operation in the measured
plans. This cost is now bounded by page size, but may matter with much larger
event tables. No additional index is needed to achieve this measured correction;
future changes should be measured against realistic cardinalities.

The TypeScript financial summary still reads complete histories for bookings on
the selected page. A booking with an exceptionally large retry/refund history
can therefore remain costly. High-concurrency, cold-cache, generic prepared-plan
and production-distribution behavior were not benchmarked.
