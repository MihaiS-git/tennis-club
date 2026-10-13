# Location pricing policies

`/admin/pricing` is active-admin-only. A selected location supplies its courts,
timezone, opening hours and currency. With multiple locations, changing the selector
navigates immediately to `/admin/pricing?location=<id>`; a single location displays
its context without a selector.

An administrator manages one logical rule set in one shared Create/Edit form. The
form selects one or more courts and weekdays, one compatible state, a local time
interval, optional inclusive date bounds, and an hourly amount. Indoor courts use
only Indoor; outdoor courts use Outdoor or Covered. Surface, environment and
location are court properties, not pricing selectors. The management table has one
row per rule set, with compact weekday labels and Edit/Remove actions.

`pricing_rule_sets` gives each definition a stable identity and a row lock for
concurrent edits. `location_pricing_rules` contains one atomic row per selected
court × weekday, all with the same `rule_set_id`. TypeORM creates or
replaces the complete cartesian product in one transaction. An edit locks the set
before deleting old rows and inserting replacements. On any conflict the transaction
rolls back, including the delete. TypeORM removal deletes the parent and
cascades to every atomic row. Browser roles have no application table grants;
Next.js performs active-admin authorization, validates explicit fields, checks the
selected courts and every weekday against opening hours, and decides the intended
applicability. TypeScript validates court state/location under configuration and location locks;
ordinary court and composite rule-set foreign keys retain structural integrity. The GiST exclusion
constraint prevents overlapping applicability for the same court, state, weekday,
inclusive date range and half-open time range. Different courts may share schedules.

Edit and removal requests carry a revision derived from every child row's identity
and timestamp. The service compares it under the configuration/location locks, so
another pricing edit or automatic opening-hours reconciliation cannot be silently
overwritten. Stale responses refresh the inventory while retaining the open draft.

All five supported location currencies use two decimal places. The database stores
positive integer minor units and no currency column; changing a location's currency
changes how existing amounts are denominated without conversion. Decimal input is
parsed as digits without floating-point rounding. Time applicability is `[start,
end)`: `07:00–16:00` and `16:00–20:00` are adjacent; 16:00 resolves only to the
second interval. End time may be `24:00`. Date bounds are inclusive and may be
absent independently.

Each pricing save must fit inside one opening interval for every selected weekday
on all current/future applicable occurrences within its requested validity period.
An absent start date does not require an opening schedule before location-local today;
entirely historical definitions remain editable. Schedule gaps
and closed weekdays cannot be priced as open. Opening hours are authoritative: their mutation automatically trims, splits
or removes applicable prices outside the new schedule in the same TypeORM transaction.
Only newly opened time inherits adjacent pricing: backward extensions use the next
price, forward extensions the previous price, and interior gaps the maximum applicable
adjacent price. Courts, states and weekdays stay separate; date partitions use only
prices simultaneously applicable in that partition, preserving seasonal boundaries.
Existing unpriced time is not filled and missing adjacent prices are never invented.
Adjacent newly opened intervals inherit as one continuous extension, then pricing is
split at the saved interval boundaries. Missing-coverage messages include active
courts with no compatible base-state price, even when other courts have prices.
The pricing form displays each effective-dated policy separately, including closed
policies, instead of combining their weekly intervals.
Opening hours belong to effective-dated weekly schedules, selected by playing date
in the location timezone. Reconciliation partitions at both schedule and pricing
validity boundaries. Changing November hours preserves October and other unaffected
coverage, splitting date ranges when necessary. Historical coverage before the
location-local change date remains unchanged. A date without a schedule is closed
for new bookings; dormant prices are retained to support later schedule replacement,
and cannot make that date available. Ending the baseline before creating a future
schedule therefore preserves compatible prices for reconciliation.

Partial definitions retain unaffected rows and partition rule sets as needed to keep
the editor's court × weekday representation valid. New reconciled date/time/price slices retain rectangular court × weekday definitions; empty parents are removed. The configuration fence and location
lock serialize opening-hours and pricing writes. Confirmed future/in-progress reservations never block configuration changes and
are never modified by them. Existing booking price/currency, payment-method and
cancellation snapshots, payment attempts and refunds remain intact. Calendars extend
their visible range to grandfathered occupancy, while rejecting new bookings outside
applicable hours. Pending holds revalidate playing-date hours, amount/currency,
cancellation notice and publication before confirmation. Invalid captured attempts
follow existing expiry and Stripe refund/reconciliation handling. Ordinary deletion confirmation
remains, without a pricing dependency dialog. Successful commits refresh schedule,
pricing and publication readiness and report automatic adjustment. Readiness requires
base-state time coverage of every opening interval on a compatible current or future
weekday occurrence within each applicable schedule for every active court; it does not promise perpetual date coverage.
The current application has no opening-hours exceptions.

`resolvePricingRule()` consumes supplied atomic rows and a court ID, derived court
state, calendar date and local minute, returning one matching row or `null`. Monday
is 0. The caller supplies the local calendar date after timezone conversion; the
resolver does not infer coverage state or calculate booking totals. Public `/courts`
is unchanged and retains its temporary “From €10/hour”. Customer checkout and explicit rescheduling use the existing server-authorized pricing
reads and preserve their transactional price acknowledgement rules.

Pricing entities and native overlap integrity are installed by the TypeORM history.
See [fresh setup](../README.md#application-migrations-and-fresh-local-setup) and
[focused disposable validation](testing.md#typeorm-cutover-validation). The initial cutover still requires separate authorization for populated databases;
the subsequent `EffectiveOpeningHours` migration is additive and data preserving.
No reset is part of validation. See the opening-hours PostgreSQL integration tests
for baseline migration, concurrent period exclusion, date-scoped pricing, contract
preservation and pending-policy revalidation.
