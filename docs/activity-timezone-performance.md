# E3-F: Personal Activity timezone CPU profile

The measured bottleneck was repeated formatter construction, rather than an
incorrect timezone or DST algorithm. Reusing request-scoped formatters reduced
the actual activity service's CPU benchmark from 43 seconds to about 1.6 seconds.

## Method and scope

Node 24.18.0. Reused the existing E3-E service benchmark: 15,000 pay-at-club
bookings and 15,000 staff-owned direct reservations, all eligible History rows,
one UTC location, the same playing date and interval. Cases are page 1, page
1,500 and page 1,500 with a compatible location/court filter. No database fixture
was created or regenerated. The actual authorization boundary, TypeORM repository
functions, projection parsing, service validation, conversions, eligibility,
options, candidate retention, sorting and page construction execute. Auth and
SQL transport are mocked; fixture setup is outside measurement.

Ran four sequential invocations, without overlapping benchmark/check workloads:
instrumented before, uninstrumented before, instrumented after, uninstrumented
after. Each invocation uses one observation per case, no warm-up, in the same
case order. These are diagnostic observations, not statistically stable medians
or production latency estimates. The harness's `medianMs` field is the sole
sample when repetitions are one. Cold parsing/JIT/GC particularly affect page 1.

The opt-in Vitest config instruments the real service at transform time; it
does not replace its policy or persistence implementation. `performance.now()`
records exclusive synchronous stages; repository timing includes awaits and
result processing. The business stage includes eligibility, URL filters, option
collection and row/snapshot construction, excluding nested timezone and candidate
timings. Candidate insertion and sorting/trimming share a selection stage. Final
page construction includes option sorting and slicing. Residual service time
includes authorization/setup, payment-ID collection, loop and instrumentation
overhead. Timings sum approximately, rather than attributing this residual to
timezone processing.

V8's inspector samples stacks at a requested 1 ms interval and independently
confirms where CPU is spent. Sample weights are elapsed time, including native
work and GC; they are not exact per-function CPU counters. `process.cpuUsage()`
also measures total user + system process CPU around each service call. This can
include background GC and exceed wall time. Stage durations are wall times in a
CPU-bound harness, not separately measured user/system CPU.

## Profile and redundant work

Before correction, each `localStartInstant` calls its local timestamp function
six times: three offset probes and three candidate checks. Each timestamp calls
`localToday` and `localMinute`, both constructing a formatter. Two conversions per
eligible row therefore create **720,000 formatters for 30,000 rows**.

Across the before CPU profiles, timezone stacks consume 44.44–44.95 seconds,
approximately 97–98% of sampled time. The formatter-construction wrapper alone
accounts for 35.91–37.85 seconds, approximately 79–83%. That wrapper includes a
small diagnostic counter as well as the native constructor. GC is separately
sampled at 0.36–0.70 seconds. Repository stacks and comparators are minor costs.

Measured stage durations in milliseconds, before → after:

| Stage | Page 1 | Page 1,500 | Page 1,500 + court |
| --- | ---: | ---: | ---: |
| Repository retrieval and projection processing | 225.98 → 24.09 | 19.48 → 19.52 | 18.68 → 20.77 |
| Service Zod validation | 263.96 → 68.59 | 53.22 → 55.58 | 261.13 → 48.25 |
| Timezone conversion | 44,919.82 → 1,500.36 | 45,656.61 → 1,476.64 | 45,233.07 → 1,485.54 |
| Business eligibility/filtering and row construction | 225.19 → 47.60 | 116.11 → 45.01 | 114.03 → 45.81 |
| Candidate selection and sorting | 40.09 → 36.39 | 35.21 → 27.74 | 36.05 → 28.48 |
| Final page construction | 0.086 → 0.076 | 0.015 → 0.018 | 0.015 → 0.020 |
| Total processing excluding repository stage | 45,466.20 → 1,665.65 | 45,876.58 → 1,613.82 | 45,659.10 → 1,616.19 |
| Complete instrumented service | 45,692.19 → 1,689.74 | 45,896.06 → 1,633.33 | 45,677.78 → 1,636.96 |

The processing total includes all remaining service work and instrumentation;
repository result processing is classified with retrieval. The large variation
in small stages is not evidence that their algorithms improved: those algorithms
are unchanged, and allocation pressure, GC and JIT are confounders.

The same timezone/date/time inputs repeat in this benchmark, but caching converted
results is unnecessary to remove the dominant cost. The service does not calculate
location-local day boundaries; conservative UTC scan bounds are already computed
once per request. Its exact per-row conversions resolve eligibility.
Some conversions remain unnecessary for unpaid/rejected or cancelled rows; this
profile does not justify changing their policy/check ordering. No such change
was made.

## Exact correction

`src/lib/courts/local-time.ts` now extracts date and minute from one combined
`Intl.DateTimeFormat` instead of two separate formatters. The offset probes,
candidate verification, repeated-time later-instant choice, skipped-time
pre-transition-offset choice, minute-1440 behavior and ISO output remain the same.
Standalone `localStartInstant` retains its existing signature and uses this shared
implementation with one formatter per call.

`createLocalStartInstantResolver()` creates a closure holding formatters keyed
only by timezone. `listOwnCourtActivity` creates one resolver per request and uses
it for its existing start/end conversions. There is no module/global cache,
offset/date/result cache, new dependency, SQL eligibility logic or infrastructure.
Formatter retention grows with distinct encountered timezones, not history rows
or page depth, and ends with the request. Every probe still formats its own
instant using the location or historical booking snapshot timezone.

The number of conversions stays **60,000** in every case. Formatter construction
falls from **720,000 to 1** in this one-timezone fixture. After CPU profiles still
show approximately 1.46–1.49 seconds in timezone stacks, principally actual
`formatToParts` and date parsing. This is remaining necessary work under the
unchanged conversion algorithm.

No authorization, financial eligibility, historical snapshots, lifecycle checks,
raw microsecond timestamps, public filters/sorts, UUID continuation or candidate
retention logic changed. The existing lossless stale tokens remain strings.

## Complete service and memory observations

Uninstrumented runs, identical inputs and matching SHA-256 hashes of the complete
returned rows, options and `hasNext`:

| Case | Complete service seconds before → after | Process CPU seconds before → after | Observed speedup |
| --- | ---: | ---: | ---: |
| Page 1 | 42.972 → 1.567 | 42.977 → 1.683 | 27.4× |
| Page 1,500 | 43.520 → 1.541 | 43.442 → 1.570 | 28.2× |
| Page 1,500 + court | 43.122 → 1.584 | 43.083 → 1.622 | 27.2× |

Uninstrumented RSS immediately after each request was 1,708 → 178 MiB,
2,216 → 253 MiB and 2,228 → 264 MiB respectively. Instrumented maximum heap
samples at batch boundaries were 106 → 75 MiB, 120 → 109 MiB and 132 → 121 MiB.
These are process observations with GC/native ICU allocations and accumulated
effects from earlier cases, not isolated request live-memory or peak-RSS bounds.
No forced GC was used. Candidate retention bounds are unchanged.

All raw timing/count/memory observations, result hashes and CPU-profile summaries
are in [activity-timezone-results.json](activity-timezone-results.json). Full V8
profiles from this run are `/tmp/e3f-{before,after}-{0,1,2}-0.cpuprofile`; those
temporary files are not durable repository artifacts.

## Targeted validation

138 tests passed across activity service, local time, precise time, My Activity
pages and the personal-activity/activity-controls components; the opt-in benchmark
was skipped in the normal regression command. Both before and both after benchmark
invocations passed separately. Complete result hashes match across all four runs.

New coverage checks exact Upcoming/History end classification one millisecond
before and at the boundary, midnight/end-minute 1440, Bucharest/New York DST,
Lord Howe's half-hour transition, Kathmandu's fractional-hour offset, Samoa's
historical skipped date, and independent resolver lifetimes. Differential tests
compare the previous converter on every half-hour slot including minute 1440
across transition days and their neighboring dates: 1,176 conversions.
Existing regressions cover multiple locations/timezones in one request, ownership
and roles, unpaid online rows and payment facts, cancellation snapshots, raw
microsecond tokens, equal starts/kind/UUID ties, six public sorts in both
directions, date/type/status/location/court filters, first/deep/exhausted pages,
court fallback, rejected batches and raw UUID continuation.

`npm run typecheck` and ESLint on all modified TypeScript/JavaScript files passed.
No full test suite, migrations, dependency changes or Git commands were used.

```bash
npx vitest run tests/unit/activity-service.test.ts tests/unit/local-time.test.ts tests/unit/precise-time.test.ts tests/unit/my-activity-pages.test.tsx tests/components/personal-activity.test.tsx tests/components/activity-controls.test.tsx
npm run typecheck
npx eslint src/lib/courts/local-time.ts src/lib/bookings/activity-service.ts tests/unit/local-time.test.ts tests/unit/activity-service.test.ts scripts/activity-profile.config.mts scripts/summarize-activity-profile.mjs

ACTIVITY_SERVICE_BENCHMARK=/tmp/activity-service.json ACTIVITY_SERVICE_REPEATS=1 ACTIVITY_SERVICE_WARMUP=0 npx vitest run tests/unit/activity-service.test.ts -t 'benchmarks the complete service'
ACTIVITY_SERVICE_BENCHMARK=/tmp/activity-profile.json ACTIVITY_SERVICE_REPEATS=1 ACTIVITY_SERVICE_WARMUP=0 ACTIVITY_CPU_PROFILE=/tmp/activity npx vitest run --config scripts/activity-profile.config.mts tests/unit/activity-service.test.ts -t 'benchmarks the complete service'
node scripts/summarize-activity-profile.mjs /tmp/activity-0-0.cpuprofile /tmp/activity-1-0.cpuprofile /tmp/activity-2-0.cpuprofile
```

The profiler's source markers fail explicitly if the service structure changes;
profiling instrumentation never enters a production build.

## Remaining limits

This establishes an improvement in execution of the actual service with mocked SQL
transport, rather than an isolated converter/selection microbenchmark. It does
not measure PostgreSQL query execution, wire transfer/JSON decoding, real Auth
latency, rendering or Upcoming enrichment queries. Existing E3-D database timings
use different fixtures and cannot be added to these measurements. Real production
end-to-end latency and a mixed-timezone/mixed-date large-history timing matrix
remain unmeasured. The repeated UTC fixture deliberately matches E3-E; varied
timezone/date behavior is covered by regression and differential tests.

The service still scans all owner streams to resolve global ordering and options.
Actual per-row timezone probes, parsing, sorting and deep-page retained candidates
remain costs. No further optimization or cache is justified by this change alone.
