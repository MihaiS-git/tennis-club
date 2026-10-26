# E3-E: Personal Activity candidate sorting

## Architecture and scope

The authenticated service scans raw UUID-ordered owner streams in 1,000-row
batches. Staff History has four streams (confirmed/cancelled bookings and
active/cancelled direct reservations); Upcoming has two and ordinary accounts
have booking streams only. All streams contribute to the same retained
collection, rather than getting independently paginated. Database UUID ordering
does not satisfy any public sort. Exhausting all streams is necessary for global
ordering and location/court options, which precede URL filters.

After payment/lifecycle eligibility and URL filtering, the service retains the
best K = page × 20 + 1 rows. When a court is requested, a second collection
retains matching-court rows until the service knows whether the court/location
combination is compatible; incompatible courts use the first collection. These
arrays share row objects. The extra row determines `hasNext`.

Previously, every contributing batch sorted both applicable collections and
copied their first K elements, even when neither exceeded K. Retained rows were
thus repeatedly sorted while deep-page collections were still growing. Rejected
batches already skipped sorting; that correction is preserved.

The correction sorts/trims only after a contributing batch exceeds K. Two dirty
flags record whether later appended rows need ordering. After court compatibility
is resolved, the selected collection is sorted once if dirty. The unused
collection needs no final sort. No heap, merge algorithm, comparison-key cache,
repository change or new production abstraction is introduced.

The comparator is unchanged: requested primary key/direction, then start instant
(ascending Upcoming, descending History), then ascending kind and UUID. All six
sorts remain supported; Upcoming still normalizes the History-only status sort.
Start instants derive from minute-based schedules. Raw microsecond lifecycle and
stale-token strings remain untouched; this change introduces no Date hydration
or timestamp conversion. Historical snapshots, authorization and payment
eligibility are unchanged.

## Reproduction

```bash
node --expose-gc scripts/benchmark-activity-selection.mjs
ACTIVITY_SERVICE_BENCHMARK=/tmp/activity-service.json npx vitest run tests/unit/activity-service.test.ts -t 'benchmarks the complete service'
```

To verify opt-in benchmark registration without executing its 30,000-row workload,
replace `vitest run` with `vitest list` in the service command above. The same
collection-only check works with `--config scripts/activity-profile.config.mts`.

The standalone benchmark extracts/transpiles the actual private production
comparator, without importing the application or connecting to PostgreSQL. It
models the original and corrected retention loops over already classified rows.
It includes 1,000, 10,000 and 30,000 total records, four source/lifecycle streams,
mixed court/coaching bookings and staff reservations, repeated starts, varied
names/durations/statuses, all six sorts and both directions. Five scenarios cover
all matches, 10% matches after eligibility, completely rejected batches, and
court collections with full/selective matches. Each exercises pages 1, 10, 100
and its last nonempty page (including empty requested pages where appropriate).

Each case has an untimed warm-up pair followed by three timed pairs with
alternating execution order. The median includes filtering, candidate array
maintenance, comparisons, trimming and page slicing, and excludes fixture creation,
reference sorting and equality assertions. Every retained ordered prefix and
returned page is compared with a full-sort reference; `hasNext` is checked against
the full matching count. This checks complete ordered results on last pages,
not only a selected handful of IDs. There are 720 distinct cases.

Candidate peaks count live array slots before trimming (both arrays when
applicable), rather than counting shared row objects twice as allocations.
Optional GC-backed memory observations sample V8 heap usage after each batch;
they include allocation garbage and exclude the prebuilt input collection.
They are diagnostic high-water samples, not precise live-object or instantaneous
sort-scratch peaks. They are separate from timing runs.

The opt-in service test uses in-memory SQL transport, with actual authorization,
repository projection validation, service parsing, timezone conversion,
classification, options and pagination. Its 30,000 records are split equally
between bookings and staff reservations. It measures three repetitions after a
warm-up for first/deep pages and compatible court filtering. It excludes fixture
setup and real PostgreSQL execution. This is a CPU service measurement, not a
production network/database latency estimate.

For a shorter single-observation service run, set
`ACTIVITY_SERVICE_REPEATS=1 ACTIVITY_SERVICE_WARMUP=0` as well. The default
full run takes about nine minutes for this fixture; its opt-in timeout is fifteen
minutes. These controls affect benchmark repetitions only.

## Selection measurements

Node 24.18.0, local diagnostic timings in milliseconds. Representative datetime
descending medians, with every input row eligible:

| Total rows | Page | Court collection | Before → after ms | Activity sorts before → after | Peak candidate slots, both versions |
| ---: | ---: | --- | ---: | ---: | ---: |
| 1,000 | 1 | No | 3.57 → 3.46 | 4 → 4 | 271 |
| 1,000 | 50 | No | 5.01 → 3.87 | 4 → 1 | 1,000 |
| 10,000 | 1 | No | 38.14 → 38.32 | 12 → 12 | 1,021 |
| 10,000 | 100 | No | 60.32 → 55.51 | 12 → 10 | 3,001 |
| 10,000 | 500 | No | 85.95 → 41.98 | 12 → 1 | 10,000 |
| 30,000 | 1 | No | 121.66 → 121.44 | 32 → 32 | 1,021 |
| 30,000 | 10 | No | 121.51 → 120.87 | 32 → 32 | 1,201 |
| 30,000 | 100 | No | 165.88 → 163.26 | 32 → 30 | 3,001 |
| 30,000 | 1,500 | No | 510.64 → 126.08 | 32 → 1 | 30,000 |
| 30,000 | 1 | Yes | 234.28 → 243.24 | 64 → 64 | 2,042 |
| 30,000 | 100 | Yes | 351.74 → 343.54 | 64 → 60 | 6,002 |
| 30,000 | 1,500 | Yes | 1,086.86 → 127.90 | 64 → 1 | 60,000 |

The four streams have terminal partial batches, so 30,000 rows have 32 matching
batches. Final option sorts are excluded from these activity-sort counts. A
separate preliminary run showed the same deep-page effect (531 → 139 ms without
court filtering and 1,010 → 127 ms with it). Shallow differences are timing noise;
the algorithm performs the same number of sorts there.

All sorts, 30,000 rows, page 1,500, compatible court collection; asc/desc medians:

| Sort | Ascending before → after ms | Descending before → after ms |
| --- | ---: | ---: |
| Datetime | 1,126.14 → 136.05 | 1,086.86 → 127.90 |
| Location | 831.60 → 119.77 | 833.25 → 120.38 |
| Court | 700.61 → 82.87 | 742.48 → 83.22 |
| Type | 735.75 → 107.35 | 720.85 → 107.37 |
| Duration | 737.40 → 90.49 | 693.47 → 89.67 |
| Status | 695.90 → 109.26 | 743.87 → 122.38 |

Sampled heap growth above the prebuilt fixture, compatible court collection:
page 1: 18.0 → 15.5 MiB; page 1,500: 21.7 → 4.0 MiB. Sampling includes the final
sort. These single GC-sensitive observations include garbage and comparator
allocations, so they do not establish a reduced live-memory bound.

All 720 cases, counts and timings, plus memory observations, are retained in
[activity-selection-results.json](activity-selection-results.json).

## Complete-service observations

With actual timezone conversion and an in-memory SQL transport, seconds:

| 30,000-row request | Original median (three samples) | Corrected observation (one sample) | Observed reduction |
| --- | ---: | ---: | ---: |
| Page 1 | 45.65 | 44.22 | 3.1% |
| Page 1,500 | 46.08 | 43.87 | 4.8% |
| Page 1,500 with court | 47.59 | 43.64 | 8.3% |

The original samples followed warm-up; the corrected observations used the
shorter command without warm-up. Some original observations overlapped the
standalone selection benchmark; the first corrected observation partially
overlapped completion of the focused regression run. Scheduling, GC and CPU load
are confounders. Even page 1 improved despite essentially unchanged sorting work.
These observations therefore **do not establish a causal full-service percentage
improvement**. The paired selection timings establish the removed sorting work;
the service observations establish that total CPU latency remains dominated by
the unchanged per-row processing, particularly repeated timezone conversion.
No real PostgreSQL end-to-end speedup is claimed.

The first opt-in baseline invocation wrote all measurements and completed its
assertions, then Vitest reported its original 120-second timeout (551 seconds
total). The opt-in timeout was corrected to fifteen minutes. The corrected short
run passed in 132 seconds; the baseline was not repeated after this harness-only
timeout correction. Raw service samples are included in the results JSON.

## Regression and validation

The focused run passed 92 tests in four files: activity service, My Activity pages,
personal activity components and activity controls. The slow opt-in benchmark is
registered only when `ACTIVITY_SERVICE_BENCHMARK` is set, so normal regression
runs execute no benchmark and report no skipped benchmark test. New service
assertions cover deferred sorting across batches, choosing only the court collection for final sorting,
equal starts across mixed types, first/deep/exhausted pages, all six sorts and
both directions, entirely unpaid batches, exact `hasNext`, court/date filters
and preservation of microsecond stale tokens. Existing cases retain payment,
owner/role, option fallback, rejected-batch and raw UUID continuation coverage.
The larger selection matrix uses the real comparator and checks full retained
prefix equality against a single complete reference sort, ruling out missing,
duplicated or misordered retained activity on stable fixtures.

No integration run is needed: repositories and database queries are unchanged.
`npm run typecheck` and ESLint on the modified service, unit test and benchmark
script passed. No full unit, component, integration or end-to-end suite was run.

## Limits

The algorithm retains the same O(min(matches, K)) rows per collection. After a
batch the bound is K; during a batch it is at most K + 1,000 per collection.
Page depth increases K until all matching rows fit. Options separately grow with
distinct locations/courts; raw batch validation and projection storage remain
bounded by 1,000 rows. Slices, sort scratch and garbage collection add transient
memory beyond candidate slot counts. This correction reduces sorting and copying,
not the retained-row bound.

Overflow sorts remain necessary for the existing bounded-selection approach,
and one final ordering is necessary if untrimmed rows remain. Sorting small
distinct option lists also remains necessary. Shallow pages still overflow on
almost every matching batch; this change does not promise faster first pages.
Two candidate arrays still do overlapping work when court filtering is present.

Database scan/transfer costs, online payment-fact queries, Zod validation and
location-local time conversion are separate costs. Existing UUID continuation,
batched payment facts and rejected-batch sort skipping remain intact. See
[E3-D database measurements](activity-pagination-performance.md) for prior real
PostgreSQL scans; those are different fixtures and cannot be added to these CPU
times as a measured end-to-end latency. Real database latency was not remeasured
because no query or repository behavior changed. Live request/cross-page snapshot
consistency remains unchanged.
