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

All five supported location currencies use two decimal places. The database stores
positive integer minor units and no currency column; changing a location's currency
changes how existing amounts are denominated without conversion. Decimal input is
parsed as digits without floating-point rounding. Time applicability is `[start,
end)`: `07:00–16:00` and `16:00–20:00` are adjacent; 16:00 resolves only to the
second interval. End time may be `24:00`. Date bounds are inclusive and may be
absent independently.

Each pricing save must fit inside one configured opening interval for every selected
weekday. Changing opening hours also checks the resulting weekly schedule against
existing pricing that can still apply on or after the location's current local date.
Historical rules whose inclusive date range can no longer reach their weekday do
not block a change. A conflict rejects the entire opening-hours mutation and asks
the admin to update or remove pricing first. Both mutation paths serialize on the
configuration advisory fence and location row; TypeScript checks the final schedule
before a grouped replacement. The current application has no opening-hours exceptions.

`resolvePricingRule()` consumes supplied atomic rows and a court ID, derived court
state, calendar date and local minute, returning one matching row or `null`. Monday
is 0. The caller supplies the local calendar date after timezone conversion; the
resolver does not infer coverage state or calculate booking totals. Public `/courts`
is unchanged and retains its temporary “From €10/hour”. Future booking integration
needs its own authorized pricing read and booking/payment policies.

Pricing entities and native overlap integrity are installed by the TypeORM history.
See [fresh setup](../README.md#application-migrations-and-fresh-local-setup) and
[focused disposable validation](testing.md#typeorm-cutover-validation). Existing populated
databases require a separate authorized cutover; no reset is part of validation.
