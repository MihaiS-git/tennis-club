# E3-D: Personal Activity internal pagination

## Architecture and correction

`activity-service.ts` authorizes the active account before reading owner-scoped
projections from `court-activity.repository.ts`. Upcoming scans confirmed bookings
and, for Admins/Coaches, active owned reservations. History additionally scans
cancelled bookings and reservations. Members never scan the staff stream.

Each stream is read in batches of 1,000, in ascending UUID order. Previously these
queries used `LIMIT 1000 OFFSET n`. All streams must be exhausted even for public
page 1: location/court options intentionally precede URL filters, and database UUID
order differs from every public ordering. TypeScript checks exact location-local
end times, online-payment eligibility, activity type, status, location, court and
date filters. It retains the best `page * 20 + 1` candidates, sorts only when a batch
contributes matches, and merges types before slicing the requested numbered page.
The extra candidate determines `hasNext`; there is no COUNT query. Court-filter
fallback retains its parallel bounded candidates without rescanning.

The correction replaces only internal OFFSET with `id > lastRawId`. The initial
batch has no cursor predicate; subsequent batches use a bound UUID. Each
source/lifecycle has its own cursor, taken from the last validated raw row before
business eligibility or URL filtering. Entire batches with no eligible matches
therefore still advance. Full batches still require the same terminal read.
Public numbered pages, all six sort options and both directions, start-time and
kind/ID tie-breakers, historical snapshots, authorization, batched payment facts,
filter options and the previous E3 optimizations remain unchanged.

## Reproduction and method

Run only against the initialized isolated test stack:

```bash
ACTIVITY_BENCHMARK=1 npm run test:integration -- tests/integration/activity-pagination.integration.test.ts
```

The existing runner verifies project/connection identity and takes its exclusive
runner lock. The fixture reuses the integration Admin anchor, copies one valid
booking and immutable revision into real application tables, and creates a direct
reservation stream. No triggers are disabled, indexes added or migrations run.
Each size is ANALYZEd and rolled back, including all temporary fixture data.
The benchmark appends raw results to `/tmp/tennis-activity-plans.jsonl`.
Without the environment flag, only the focused repository regression runs.

Measured on PostgreSQL 17.6, `work_mem=4MB`, `shared_buffers=128MB`. Each size has
N direct reservations and N+1 pay-at-club bookings. UUIDs are random; each row has
a distinct playing date and the same court/time/duration. All rows satisfy the
history date bound. The benchmark compares the original OFFSET SQL to the same
projection/joins/predicates with UUID continuation, sequentially in the same
transaction. Sampled batches have three `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`
runs; the table below shows median execution time. Complete scans are single
wall-clock observations including driver transfer/JSON decoding, excluding fixture
setup, service TypeScript processing and authentication. They are local diagnostic
measurements, not production latency estimates. OFFSET runs first; cache/order
bias is possible. The benchmark starts continuation at an all-zero UUID lower
bound over nonzero random fixture IDs; production omits the predicate on the first
batch. Both modes used shared-buffer hits with zero physical reads in
the retained tail plans.

## Measurements

Representative 1,000-row batches, milliseconds (OFFSET → continuation):

| Rows per source | Skipped rows | Bookings | Staff reservations |
| --- | ---: | ---: | ---: |
| 1,000 | 0 | 12.55 → 12.60 | 10.83 → 10.90 |
| 10,000 | 5,000 | 133.20 → 15.28 | 116.21 → 12.10 |
| 10,000 | 9,000 | 134.22 → 17.54 | 117.19 → 12.14 |
| 30,000 | 15,000 | 398.86 → 15.16 | 180.60 → 11.89 |
| 30,000 | 29,000 | 403.78 → 27.23 | 336.31 → 11.74 |

Complete scans, milliseconds; query counts are identical before and after:

| N | Booking queries | Booking scan | Reservation queries | Reservation scan | Combined scan |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 2 | 32.3 → 18.1 | 2 | 24.5 → 15.4 | 56.8 → 33.5 |
| 10,000 | 11 | 1,344.9 → 269.8 | 11 | 1,012.5 → 159.4 | 2,357.4 → 429.2 |
| 30,000 | 31 | 9,818.1 → 615.1 | 31 | 6,603.9 → 485.8 | 16,421.9 → 1,100.9 |

The combined times add the two sequential source scans. They exclude empty
cancelled streams and financial/UI enrichment; pay-at-club fixtures need no payment
fact queries. Service regression tests separately assert one payment-fact query
per online batch and unchanged query counts when entire batches fail eligibility.

At offset 29,000, the booking OFFSET plan joins/projects 30,001 rows and its sort
feeds 30,000 rows into LIMIT to return 1,000. Continuation joins/projects only
1,001 and returns 1,000. The direct reservation OFFSET plan joins/projects 30,000;
continuation joins/projects 1,000. Existing primary/owner indexes suffice.
The retained booking tail plans have 4,451 → 4,264 shared-buffer hits and
3,184/3,191 → 0/0 temporary blocks read/written. Reservations have 492 → 806
shared-buffer hits but 2,274/2,281 → 0/0 temporary blocks: shared-buffer access
need not decrease when the planner switches strategies. The measured benefit is
less discarded joined/projection work and elimination of these deep sort spills.

Full representative plans and scan measurements are retained in
[activity-pagination-plans.json](activity-pagination-plans.json).

## Regression and validation

Focused unit/component coverage exercises first/later/empty pages, large histories,
all public sort options/directions, equal-time mixed types, filters and court
fallback, payment eligibility, one-pass options, batches rejected entirely by
eligibility or URL filters, independent stream cursors and exact-full-batch
termination. Public pages 1, 51 and 52 over a mixed 1,002-eligible-row result have
identical database call counts: six for Upcoming, eight for History, including
one online payment-fact query. `hasNext` is true only on page 1 in those cases.
This verifies that page depth affects retained candidates, not internal scan depth.
The real repository regression compares all IDs across multiple batches against
an independent ordered SQL read and checks uniqueness. Existing history/customer
booking integrations verify owner/role boundaries, archived resources, snapshots,
microsecond timestamps and global mixed pagination.

Validation passed: 101 tests across five focused unit/component files; four checks
across the three integration files (including the opt-in benchmark);
`npm run typecheck`; and ESLint on all four changed TypeScript files. After making
the fixture anchor explicit, the repository regression was rerun and passed; the
opt-in benchmark was skipped on that final regression-only run.

## Remaining limits

All eligible raw streams are still scanned for options and arbitrary global sorts;
TypeScript time conversion, filtering and selection remain proportional to the
activity scanned. Very deep numbered pages retain more candidates and do more
sorting; this change does not optimize that cost. Booking continuation can still
sequentially scan joined revisions/reservations (30,001/60,001 rows in the tail
plan); it is not a constant-work query or an index-only solution. Shared-buffer
counts vary by planner strategy.

Batches do not share a repeatable-read snapshot. Concurrent additions below a
passed UUID or concurrent lifecycle changes can affect a request; cross-request
numbered pages also reflect live data. The no-gaps/no-duplicates regressions apply
to stable fixture datasets, not a new consistency guarantee. No new caching,
indexes, business rules or public cursor navigation were introduced.
