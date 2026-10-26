# E3-G: Timezone model and Personal Activity classification

The implementation has **per-location timezones**, with **immutable customer booking
timezone snapshots**. It does not implement the intended single Admin-configured
club timezone. This investigation preserves that persistence/configuration model.
Activity performs avoidable conversions even under its existing model; the focused
service change removes those without changing classification or ordering.

## Actual configuration model

These findings describe application source and its authoritative TypeORM schema
definitions; no deployed database was inspected or modified.

| Question | Finding and source |
| --- | --- |
| One global timezone or one per location? | `public.locations.timezone` is required text: [entity](../src/lib/db/entities/location.entity.ts:36), [initial schema](../src/lib/db/migrations/1791462257924-InitialApplicationSchema.ts:22). There is no global timezone column. The `club_settings` singleton stores only its ID and transactional email settings: [entity](../src/lib/db/entities/club-setting.entity.ts:7), [schema](../src/lib/db/migrations/1791462257924-InitialApplicationSchema.ts:51). |
| Can locations differ? | Yes. Each Create/Edit Location form has its own [timezone combobox](../src/app/admin/locations/location-form.tsx:216). [Validation](../src/lib/admin/locations-validation.ts:27) accepts an IANA zone independently; it does not enforce equality with other locations. [Admin save](../src/lib/admin/locations.ts:72) passes that value to [location persistence](../src/lib/db/repositories/clubs.repository.ts:62). README already documents this at its Locations management section. |
| Are booking timezones snapshotted? | Yes. `booking_revisions.timezone`, `booking_date`, `starts_at_minute`, `ends_at_minute`, location/court names and commercial terms are stored together: [entity](../src/lib/db/entities/booking-revision.entity.ts:54), [schema](../src/lib/db/migrations/1791462257924-InitialApplicationSchema.ts:36). Court checkout copies the locked location timezone into the [created revision](../src/lib/bookings/service.ts:124); [coaching checkout](../src/lib/coaching/booking.ts:138) does likewise. Revision UPDATE/DELETE/TRUNCATE is [prohibited](../src/lib/db/migrations/1791462257925-ApplicationNativeIntegrity.ts:121). |
| What does changing the location timezone do? | Admin save updates the location under configuration/location/account locks. It does not rewrite reservations or revisions, move local dates/minutes, or convert timestamps. New bookings/public calendars use the new location zone. Existing customer activity keeps the current revision's snapshotted zone. Direct staff reservations have no timezone snapshot, so their interpreted UTC schedule, classification and ordering follow the changed location zone, including historical rows. A later customer reschedule snapshots the then-current location timezone in its new revision: [commands](../src/lib/bookings/commands.ts:446). Prior revisions retain their old values. |
| Which timezone interprets a historical booking? | The relevant immutable revision's timezone. Activity uses the booking's current revision (`v.timezone`); direct reservations use current `l.timezone`: [activity projection](../src/lib/db/repositories/court-activity.repository.ts:14). The owner deep-link lookup also uses `owned.revision.timezone`. |
| Is the multi-timezone handling unnecessary? | It is required by the implemented model. One account can have activity across differently configured locations, or revisions created before/after one location's timezone changes. Removing that handling would change behavior. It is broader than the intended single-timezone model; deciding on a configuration redesign is a separate task. |

Public `/book` computes today/current minute in the selected location's current
timezone: [page content](../src/app/book/booking-content.tsx:40),
[public calendar](../src/lib/courts/public-calendar.ts:74). Personal Activity uses
the explicit repository projection above, rather than looking up a global setting.

## Storage, classification and sorting

Reservations store a PostgreSQL `date` and integer local start/end minutes, rather
than UTC start/end timestamps. End minute 1440 denotes next-day midnight. Structural
constraints enforce finite dates, half-hour alignment and interval bounds:
[reservation entity](../src/lib/db/entities/court-reservation.entity.ts:17),
[reservation schema](../src/lib/db/migrations/1791462257924-InitialApplicationSchema.ts:28).
Customer revisions snapshot their own local schedule. Audit/lifecycle timestamps
are `timestamptz`; the activity repository builds JSON directly to retain their
microsecond strings rather than hydrating JavaScript Dates.

`listOwnCourtActivity(..., now = new Date())` captures one application instant at
entry; tests can supply it. All classification compares against `now.getTime()`.
It does not use a per-row clock or issue a database clock query.

The eligibility contract remains:

1. Require the active verified account before privileged persistence. Read only
   that account's customer bookings and, for Admin/Coach accounts, its own direct
   reservations. Validate bounded batches and payment facts.
2. Online bookings need a succeeded payment attempt, including cancelled history.
   Pay-at-club bookings do not need that fact.
3. Non-cancelled activity needs an active linked reservation. Its exact resolved
   end instant **greater than now** is Upcoming; end **less than or equal to now**
   is History. In-progress activity remains Upcoming. Completion is derived;
   confirmed/active source statuses are not rewritten.
4. Cancelled rows go to History regardless of their scheduled date/end. Their
   `history_at` remains the booking's `updated_at`, or the direct reservation's
   `cancelled_at ?? updated_at`, preserving raw precision.
5. Collect options across eligible records before URL filters. Filter, merge,
   globally sort and paginate with the unchanged bounded candidate retention.

The [sort comparator](../src/lib/bookings/activity-service.ts:60) uses exact UTC
start instants for the datetime primary sort and the secondary key on every other
sort. That secondary key is ascending for Upcoming and descending for History,
then kind and UUID ascending. `history_at` is not a sorting key. Local date/minute
ordering cannot replace UTC ordering across differing zones or historical offsets.
The current algorithm therefore retains start resolution for each sort candidate;
lazy conversion during comparisons would require a separate ordering algorithm
and is not introduced by this change.

## Proven simplification

The [service](../src/lib/bookings/activity-service.ts:132) reuses the already-existing
request-scoped conservative UTC scan bounds, without changing database queries:

```text
earliestDate = UTC date of (now - 2 days)
latestDate   = UTC date of (now + 1 day)

non-cancelled playing date <= earliestDate -> ended
non-cancelled playing date >  latestDate   -> not ended
otherwise -> resolve exact end using the existing timezone/DST algorithm
```

For proof, let `U` be UTC midnight today. A date on/before `U - 2 days`, even with
end 1440, has wall end on/before `U - 1 day`. IANA offsets have magnitude less than
one day, so its resolved end is before `U`, hence before/equal to now. A date after
`U + 1 day` starts no earlier than `U + 2 days`; even the largest positive offset
cannot place its end at/before now. These bounds also cover date-line changes:
the resolver's chosen probe offsets remain within that envelope. The intervening
window always uses full resolution. This is deliberately conservative and avoids
introducing per-timezone current-date/minute calculations.

Comparing today's local minutes directly would be wrong during a repeated hour:
at Bucharest `2026-10-25T00:30Z`, local 03:30 has occurred once, but a stored 03:30
end resolves to the later `01:30Z` and remains Upcoming. Spring's nonexistent
times similarly require the existing pre-transition-offset rule. The unchanged
[resolver](../src/lib/courts/local-time.ts:41) still checks three historical offset
probes and their candidates, chooses the later repeated instant and the
pre-transition offset for skipped wall times, and normalizes minute 1440.

Additional removed work:

- Check ownership/payment eligibility before conversions; unpaid online rows need
  neither a start nor an end conversion.
- Cancelled rows never resolve scheduled ends.
- Apply URL filters after collecting eligible options but before resolving starts
  or constructing full candidate rows. Filtered rows near now can still require
  an end conversion to determine whether they belong in those options.
- Retain resolved boundary ends when available; defer other `history_at` end
  instants until the final page. Internal candidates permit an absent end string;
  every returned row retains the complete original DTO.
- The single booking notification-target lookup no longer resolves an end for a
  cancelled booking or converts a completed end twice.

E3-F's request-local formatter reuse is unchanged. There are no result/offset
caches, schema changes, persistence changes, new dependencies or new timezone
utilities. Authorization, payment eligibility, UUID continuation, SQL projections,
option/court fallback, snapshots, tie-breakers and raw microsecond tokens remain.

## Measurements

Node 24.18.0, actual service and TypeORM repository functions with mocked Auth/SQL
transport, 15,000 pay-at-club bookings plus 15,000 staff direct reservations.
The revised opt-in fixture has six distinct location/court pairs, each with a
consistent zone: Bucharest, New York, Kathmandu, Lord Howe, Apia and UTC. It spans
twelve dates from 2024 through October 2026, including spring/autumn transition
dates and recent dates exercising exact classification, with varied intervals.
Each location contributes 5,000 records. The shared now is `2026-10-03T12:00Z`.

Separate sequential instrumented invocations ran the saved original service and
the final service. One warm-up plus three measured samples per case; tables show
medians. Fixture setup is excluded. All complete-result SHA-256 hashes match
between versions and across samples, including rows, options and `hasNext`.
The raw counts explicitly verify that the baseline executes 60,000 conversions.

| Metric, before → after | Page 1 | Page 1,500 | Page 250 + location/court |
| --- | ---: | ---: | ---: |
| Conversions | 60,000 → 32,496 | 60,000 → 32,516 | 60,000 → 7,516 |
| Formatters | 6 → 6 | 6 → 6 | 6 → 6 |
| Classification ms | 780.81 → 64.53 | 786.16 → 64.04 | 776.62 → 66.19 |
| All timezone conversion ms | 1,516.95 → 796.74 | 1,525.15 → 801.99 | 1,506.68 → 193.73 |
| Complete service ms | 1,764.14 → 1,026.95 | 1,794.98 → 1,051.75 | 1,642.09 → 299.29 |
| Process CPU ms | 1,789.54 → 1,065.48 | 1,856.69 → 1,093.66 | 1,666.12 → 310.12 |
| RSS MiB after request | 262.12 → 265.43 | 300.51 → 303.05 | 310.45 → 315.48 |
| Maximum sampled heap MiB | 119.19 → 119.72 | 143.94 → 141.21 | 116.51 → 112.17 |

Of the unfiltered conversions after the change, 30,000 resolve starts for global
sorting, 2,496 resolve near-boundary ends, and the deep page adds 20 otherwise
unresolved end instants. The filtered case resolves only 5,000 starts, the same
2,496 boundary ends for eligible options across all locations, and 20 page ends.
Conversions drop about 46% unfiltered and 87% filtered. Formatter counts remain
six because this fixture has six actual timezones, unlike E3-F's one-zone fixture.

Classification is an inclusive `performance.now()` timer around the real lifecycle
classification block. This CPU-bound wall measurement overlaps timezone/business
stage timers; it must not be added to them. Final page timing also includes nested
end conversion work. Process CPU uses `process.cpuUsage()` for the whole request,
not a separate classification CPU counter. Complete service measurements include
instrumentation overhead and mocked repository processing, but not real database,
network/Auth latency, rendering or Upcoming enrichment. These few samples are
diagnostic rather than production latency predictions. Memory observations include
GC and accumulated process allocations, with no forced GC; sampled heap is not a
true peak. Memory does not show a reliable improvement.

Vitest 5 persisted transformed modules across profiling invocations with different
environment-selected source. Counters caught a stale baseline during investigation.
The profiling config now disables `fsModuleCache`; stale runs are excluded from
the saved results. Baseline benchmark assertions also require 60,000 conversions.
[Durable results](activity-classification-results.json) include all accepted raw
samples, medians, counts, result digests and before/after source hashes.

## Focused validation and reproduction

149 tests passed across the six files below; the opt-in benchmark was skipped.
Nine added differential cases compare service classification/output against the
original exact conversion rule across mixed nearby/distant dates, both scopes and
two pages: Bucharest spring/fall, New York repeated hour, Lord Howe's half-hour
gap, Apia's skipped date and UTC+14/UTC-12 midnight boundaries. Existing tests
retain exact-boundary milliseconds, minute 1440, payment eligibility, ownership,
all sorts/directions, first/deep/exhausted pages, UUID continuation and stale-token
coverage. New call-count tests verify deferred ends, filtered/unpaid work and
cancelled microsecond timestamps. The converter itself is unchanged.

```bash
npx vitest run tests/unit/activity-service.test.ts tests/unit/local-time.test.ts tests/unit/precise-time.test.ts tests/unit/my-activity-pages.test.tsx tests/components/personal-activity.test.tsx tests/components/activity-controls.test.tsx
npm run typecheck
npx eslint src/lib/bookings/activity-service.ts tests/unit/activity-service.test.ts scripts/activity-profile.config.mts

# Before editing the service, save its original source:
cp src/lib/bookings/activity-service.ts /tmp/e3g-activity-before.ts
# Run after editing, substituting the saved baseline at transform time:
ACTIVITY_SERVICE_BASELINE=/tmp/e3g-activity-before.ts ACTIVITY_SERVICE_MIXED=1 ACTIVITY_SERVICE_BENCHMARK=/tmp/e3g-before.json ACTIVITY_SERVICE_REPEATS=3 ACTIVITY_SERVICE_WARMUP=1 npx vitest run --config scripts/activity-profile.config.mts tests/unit/activity-service.test.ts -t 'benchmarks the complete service'
ACTIVITY_SERVICE_MIXED=1 ACTIVITY_SERVICE_BENCHMARK=/tmp/e3g-after.json ACTIVITY_SERVICE_REPEATS=3 ACTIVITY_SERVICE_WARMUP=1 npx vitest run --config scripts/activity-profile.config.mts tests/unit/activity-service.test.ts -t 'benchmarks the complete service'
```

Typecheck and targeted ESLint passed. No full test suites, Git commands, migrations,
dependency changes or timezone configuration redesign were performed.
