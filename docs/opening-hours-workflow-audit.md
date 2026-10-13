# Opening hours → pricing → reservations audit

Expected behavior is based on AGENTS.md, README.md and docs/pricing.md. Verification below distinguishes browser journeys, TypeScript combinations and PostgreSQL guarantees. Dates are inclusive; time intervals are half-open. The playing date and current day use the location timezone.

| Scenario / transition | Expected outcome | Verification target |
| --- | --- | --- |
| First schedule, current or future | Save explicit dates and selected weekdays/intervals; no invented pricing; explain missing pricing. Closed days have no intervals. | Browser creation; service reads |
| Current unlimited → future schedule | Cut current end to new start minus one calendar day atomically; preserve intervals/history; increment current revision. | Browser creation; PostgreSQL cutoff/rollback |
| Independent future unlimited policy | Never shorten or replace implicitly; require explicit validity edit. | TypeScript period matrix; browser rejection |
| Insert between dated schedules | Fit fully within a gap, or shorten only an overlapping current policy when no future policy is overlapped. | Browser dated sequence; period matrix |
| Edit current/future validity only | Preserve unchanged interval IDs/timestamps and all other schedules; reject reversed periods and ambiguous overlaps. | Browser Save; persisted interval snapshot |
| Add multiple daily intervals | Insert new intervals without replacing saved ones, even after revisiting the schedule. | Browser Add/Save/reload |
| Modify/remove an interval group | Change only explicitly selected interval IDs/days; retain every other daily interval and schedule. Warn before discarding a dirty draft. | Browser Edit/Remove; component sequence |
| Adjacent periods and times | Day after inclusive end is valid; same day overlaps. Adjacent times are valid. Direct reservations and pricing definitions must fit one opening interval; customer selection uses contiguous eligible priced calendar cells. | TypeScript boundaries; PostgreSQL exclusion |
| Gaps and closed weekdays | No new reservations without an applicable schedule/interval; keep dormant prices when no schedule exists. | Browser calendar; TypeScript and persistence |
| Current/Scheduled/History | Derive from location-local validity dates; no persisted status mutation. Preserve history when creating/editing future policies. | TypeScript date transitions; browser labels |
| Pricing reductions | Partition effective dates; trim/split/remove only affected future time coverage. Retain history, dormant periods and unaffected prices. | TypeScript reconciliation; PostgreSQL sequence |
| Pricing extensions/inheritance | Use adjacent compatible court/state/weekday/date prices; max across gaps. Never invent a missing price or borrow from another court/season. | TypeScript combinations; browser pricing rows |
| Missing price coverage | Warn when an active court has uncovered newly opened time, even if other courts are priced. New customer bookings require a valid quote. | TypeScript scopes; browser warnings/calendar |
| Manual pricing Create/Edit | Validate against current/future applicable schedules; optional dates must not demand opening hours before today. Display each schedule separately. Reject stale edits/removals. | Browser pricing form; stale persistence |
| Confirmed bookings/reservations | Configuration changes preserve their row identities, intervals, contract snapshots, payment/refund records; show occupancy outside revised hours. | PostgreSQL contract snapshot; browser calendar |
| New direct/customer reservations | Locked authoritative playing-date configuration, alignment/minimum length, applicable opening hours, valid price for customer bookings, active resources/actor, overlap exclusion. | Existing command integration; browser reservation |
| Pending payment settlement | Revalidate playing-date hours, current price/currency/cancellation/publication under shared config fence. Invalid capture releases hold and records reconciliation; valid holds confirm unchanged. | Focused PostgreSQL settlement |
| Stale/parallel configuration | Keep configuration fence then location/actor locks; stale edits cannot overwrite later changes, including automatic reconciliation. Clean UI refreshes reload; dirty drafts retain their original stale token. | Browser two-editor sequence; PostgreSQL concurrency/rollback |

## Findings and evidence

The audit inspected the schedule mutation service, period planner, pricing reconciliation
and manual pricing mutations, public/internal playing-date reads, reservation/booking
creation and rescheduling, settlement revalidation, publication readiness, and the
Create/Edit/Remove components. Existing configuration advisory fencing, location-first
locking, actor authorization, structural exclusions and contract snapshots were retained.

| Verified defect | Root cause and correction | Evidence |
| --- | --- | --- |
| Future creation rejected against unlimited current policy | Planner now permits one unambiguous current-policy cutoff, persists both policies atomically, and binds the preview to its original revision. Independent future policies remain protected. | Period combinations, transaction rollback/concurrency and browser preview/Save |
| Dirty schedule draft could adopt refreshed concurrency information | Draft period/revision and cutoff preview now use one snapshot. Clean editors reload; stale dirty drafts are rejected and can reload explicitly. | Component refresh cases and two browser editors |
| Date-only edits replaced interval identities | Service distinguishes interval changes from validity changes and preserves unchanged rows. | Exact persisted interval snapshot in browser journey |
| Disabled Save without actionable interval/date validation | Derived invalid dates, overlapping times, missing weekdays and ambiguous policies now show errors. | Component cases and browser ambiguous/adjacent dates |
| Pricing creation with blank dates rejected after first schedule | Validation previously demanded hours back to year 0001. It now checks current/future applicable occurrences from location-local today. | Browser first schedule → two blank-date pricing definitions; future-gap unit cases |
| Pricing edits/removals silently replaced concurrent changes | Parent locks serialized writes but did not compare the draft version. Child-row revision now detects replacements and partial reconciliation before mutation. Stale responses refresh inventory. | Competing browser pricing edits and PostgreSQL edit/removal cases |
| Pricing form displayed a misleading combined weekly policy | Form now lists individual effective-dated schedules, dates/status and their own intervals, including policies with no intervals. | Browser current/future policy summary; rendering/code inspection |
| Missing-price message overlooked wholly unpriced courts | Reconciliation now checks active court/base-state scopes as well as existing rules; message identifies possible missing court coverage. | Scope combinations and browser first-creation warning |
| Adjacent new intervals inherited uneven prices | Inheritance was calculated independently per newly opened piece. Reconcile contiguous newly opened spans together, then split at saved boundaries. Existing-open unpriced spans remain unfilled. | Actual browser failure discovered during Add/Add/Save sequence, corrected browser SQL assertions; forward/backward/interior-gap combinations |
| Early browser input disappeared during hydration | React hydration replaced a date entered before client handlers were ready. The editor now uses the existing hydration gate pattern before enabling inputs. | Actual Chrome failure followed by successful unslept Create sequence |
| Pricing changes left dependent calendars stale | Successful pricing mutations now revalidate public courts/booking and internal reservation paths. | Action inspection and browser navigation/quotes |
| Browser infrastructure collided with normal development build/port | Isolated test project now uses `.next-test` and port 3100, retaining existing guarded isolated infrastructure. | Fresh production build and browser journey; development server untouched |

## Actual browser sequence

One Playwright Chromium journey uses real forms and Server Actions against the guarded
isolated database. Only resource/account fixtures and contract assertions use direct
test persistence. It creates the first policy with two daily intervals; saves two
multi-court prices with optional dates; rejects competing hours/pricing edits; publishes
the location; creates a direct reservation and a pay-at-club customer booking; creates a
bounded future policy with the automatic cutoff; verifies grandfathered occupancy;
rejects an ambiguous middle policy; inserts one into a gap; edits adjacent validity
boundaries; retains a History policy; verifies a closed gap; adds two adjacent intervals,
modifies another, removes one, reloads, and verifies all surviving intervals and exact
reconciled prices. Reservation, booking, attempt and refund snapshots remain identical
across configuration changes. The final workspace screenshot was visually inspected.

The journey passed after the hydration and adjacent-inheritance defects it exposed were
fixed. Final validation: 548 unit/component tests across 84 files; 32 tests across the
two focused opening-hours/pricing PostgreSQL suites; one complete Chromium journey;
production test build, typecheck, lint and `git diff --check`. All passed. The focused
seven-file TypeScript/component selection also passed its 120 scenarios before the
full unit/component run.

## Limits

Stripe settlement is exercised with persisted provider events in focused integration
tests; no live Stripe checkout/webhook/refund or notification delivery was attempted.
Date-derived status transitions are tested with controlled dates and all three labels
are visible in the browser; a tab kept open across local midnight was not exercised.
The complete browser journey uses desktop Chromium, two outdoor courts and one location;
other browsers, mobile layout and multi-location interaction were not exercised here.
Fully closed policy rendering was inspected in code; its complete browser creation
sequence was not run. Existing creation/rescheduling eligibility and locking were
inspected and covered by existing tests; this browser journey does not exercise every
reservation rescheduling/payment method combination.
