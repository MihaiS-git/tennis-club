# P11 — Public location queries and historical configuration growth

## Finding and consumers

The inefficiency was confirmed in `readPublicLocationFacts()`, shared by
`listPublicLocationFacts()` and `listPublicLocationFactsForLocation()` in
`src/lib/db/repositories/clubs.repository.ts`.

The single TypeORM SQL projection loaded:

- Active, unarchived, explicitly published location identity, address, timezone,
  currency, payment-option and cancellation-policy fields.
- Every `location_opening_hours` row joined to `opening_hours_schedules`, including
  interval identity, weekday, minutes, schedule identity and effective dates.
- Active courts' identity, surface, environment and lighting fields, and every
  `location_pricing_rules` record's state, weekday, minutes and effective dates.
  Discovery does not load price amounts, coverage or occupancy through this query.

Neither configuration subquery had a date restriction. PostgreSQL built JSON for
all historical configuration and transferred it to TypeScript, whose publication
checks then discarded expired facts.

`src/lib/courts/public.ts` validates those facts and evaluates publication in
TypeScript using each location's local date. Its consumers are:

| Consumer | Required facts |
| --- | --- |
| Homepage discovery and summaries | Public eligibility, active courts and today's local hours |
| `/courts` via `listPublicLocationsToday()` | Same eligibility; separate batched, date-scoped hours/coverage/prices supply today's hours and starting rate |
| `/club` via `listPublicVisitorLocations()` | Same eligibility plus effective hours across the next seven local dates |
| `/book`, `/coaching` and coach profiles | Same eligible locations and courts; booking/day-specific data comes from separate reads |
| `findPublicLocationWithCourts()` | Same facts scoped to one location, using the caller's manager and reference instant |

All these discovery consumers require current **and future** configuration:
publication checks every relevant opening interval against compatible current or
future base-state pricing. Loading only today's or this week's schedule would
change eligibility. Existing date-specific public calendar queries are already
scoped and remain unchanged; no additional discovery projection is necessary.

## Correction

The repository now accepts a reference instant and computes **UTC yesterday** in
TypeScript. Both opening schedules and court pricing are restricted to effective
ranges overlapping `[UTC yesterday, infinity)`. Predicates use the same inclusive
`daterange(..., '[]')` expressions as the existing GiST exclusions. The schedule
query explicitly constrains `s.location_id` so its existing composite index can
exclude historical periods before loading their intervals.

This is a conservative retrieval bound, not a replacement publication date.
Every current IANA location date is at least UTC yesterday. A small adjacent-date
guard remains intentionally loaded; TypeScript still selects exact local dates,
validates timezone/location details, checks weekday occurrences and pricing
coverage, and decides publication. A local date east of UTC can be two calendar
dates ahead of this bound. No years of expired revisions remain in the result.

The query preserves all future effective periods, including distant schedules,
open-ended dates, null-start pricing, and periods ending exactly at the cutoff.
It never deletes or rewrites history. It retains the same fields and location/
court ordering. No publication, pricing, booking or coaching policy changed.
`readEligibleLocations()` passes one captured instant to both retrieval and the
existing per-location publication-date calculation, including explicit instants
provided by transactional callers.

No queries, indexes, migrations, dependencies or caching were added. Discovery
remains one SQL statement; `/courts` overview remains four statements, including
its three existing batched day reads. Counts are independent of location count.

## Measurement

Only the verified isolated `tennis-club-tests` stack at
`127.0.0.1:55322/postgres` was used, under its runner advisory lock. Synthetic
fixtures and their configuration were enclosed in a transaction and rolled back.
No migrations, seeds, resets or provider calls ran.

The harness captured actual repository SQL and parameters, executed original and
corrected statements against the same data, and collected
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. Tables report medians of three runs.
Execution excludes planning; wall time includes query transport and driver JSON
parsing. All plans had zero shared-buffer reads: these are warm-cache local
results, not production or cold-cache latency estimates.

Fixtures used four active published locations, four courts per location, seven
weekday intervals per schedule, base-state pricing per court/weekday/period,
current and future schedules, and 0, 52 or 500 expired weekly revisions per
location (500 spans roughly 9.6 years). Timezones were Europe/Bucharest,
America/Los_Angeles, Pacific/Kiritimati and Pacific/Pago_Pago. The one-location
case uses the existing UUID-scoped projection; the multiple-location case uses
full discovery.

| Expired revisions per location | Scope | Execution before → after (ms) | Driver wall time before → after (ms) | Configuration records before → after | JSON bytes before → after |
| ---: | --- | ---: | ---: | ---: | ---: |
| 0 | One location | 0.522 → 0.479 | 1.208 → 1.178 | 70 → 70 | 11,073 → 11,073 |
| 0 | Four locations | 1.685 → 1.810 | 2.462 → 2.745 | 280 → 280 | 44,295 → 44,295 |
| 52 | One location | 10.708 → 0.705 | 13.711 → 1.380 | 1,890 → 70 | 276,065 → 11,073 |
| 52 | Four locations | 40.399 → 2.588 | 45.853 → 3.629 | 7,560 → 280 | 1,104,263 → 44,295 |
| 500 | One location | 99.785 → 0.667 | 118.476 → 1.324 | 17,570 → 70 | 2,559,073 → 11,073 |
| 500 | Four locations | 387.821 → 2.483 | 439.098 → 3.256 | 70,280 → 280 | 10,236,295 → 44,295 |

Each row uses **one SQL statement before and after**. With little history, execution remains around 0.5 ms for one location and 1.7–1.8 ms for four; the benefit appears as historical configuration grows. Planning remained approximately 0.15–0.25 ms.

Only four top-level SQL rows are returned for multiple-location discovery, so
that count alone hides the problem: historical records were nested inside JSON.
The configuration-record and byte counts above measure that actual transfer.

At 500 revisions per location, shared buffer hits fell from 9,489 to 291.
The old four-location plan scanned 14,056 opening-hours rows per location
(3,514 matched, 10,542 filtered), approximately 56,224 interval-row visits.
It also retrieved 3,514 pricing records per court, or 56,224 in total.
The corrected plan used `opening_hours_schedules_no_overlap`,
`location_opening_hours_no_overlap` and `location_pricing_no_overlap` to retrieve
only eight relevant schedules, 56 intervals and 224 prices. Range filtering occurs
in index access before JSON aggregation, rather than after transfer to TypeScript.
The existing GiST indexes are sufficient; no index was added.

Sequential scans on the tiny location/court tables are harmless. The expensive
work was historical interval/pricing retrieval and JSON construction, not the
mere presence of a sequential scan or correlated subquery.

A measured alternative that validated timezone names through PostgreSQL's
`pg_timezone_names` view added approximately 32 ms even with little history. The
conservative date guard avoids that cost, extra queries and a second timezone
validation policy. Exact local selection remains in existing TypeScript.

## Correctness and validation

The profiling harness compared original/corrected publication eligibility for all
fixtures and effective opening intervals across the next fourteen local dates,
including the scheduled transition. All comparisons passed.

The focused PostgreSQL regression compares full fixture history with pruned facts
using the unchanged `publicationReadiness()` across seven instants and seven
location configurations. It covers UTC date differences, UTC-11's previous local
day, UTC+14, inclusive cutoff/end boundaries, the exact midnight schedule change,
a DST transition instant and a 2030 future date. It checks today's public projection
and each date of the visitor week, null-start/open-ended prices, future-only
eligibility, inactive courts, expired-only configuration, missing prices and an
invalid timezone. Explicit counts prove expired hours and pricing remain stored.

Passed:

- `npm run test:integration -- tests/integration/courts/public.integration.test.ts tests/integration/admin/locations.integration.test.ts`
  — 5 tests across two files. Existing visibility, court ordering, calendar
  boundaries, local-date batching and Admin publication checks remain green.
- `node node_modules/vitest/vitest.mjs run tests/unit/location-publication.test.ts tests/unit/public-locations-hours.test.ts tests/unit/public-courts-overview.test.ts tests/unit/effective-opening-hours.test.ts`
  — 52 tests. A focused assertion checks that retrieval receives the same
  reference instant as public projection.
- `npm run typecheck`.
- `npx eslint src/lib/db/repositories/clubs.repository.ts src/lib/courts/public.ts tests/integration/courts/public.integration.test.ts tests/unit/public-locations-hours.test.ts`.

No full test suites or production build ran. The session evidence, containing
actual before/after SQL, EXPLAIN JSON, timings, indexes and profiling harness, is
preserved in [`/tmp/p11-query-efficiency-evidence.json`](/tmp/p11-query-efficiency-evidence.json).

## Remaining limitations

The deliberately small adjacent-date guard can include recently expired local
configuration. It avoids timezone duplication while bounding historical loading
by dates rather than years. All future configuration still grows with future
planning horizons because existing publication semantics require it. Open-ended
records remain relevant until explicitly bounded.

Work and payloads still grow with published locations, active courts, intervals
and relevant future pricing. There is no pagination or caching change. The
measurements do not establish cold-cache, high-concurrency or production latency;
they demonstrate removal of unnecessary historical records and index access
using existing schema.
