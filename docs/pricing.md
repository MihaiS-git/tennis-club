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
court × weekday, all with the same `rule_set_id`. `save_pricing_rule_set` creates or
replaces the complete cartesian product in one transaction. An edit locks the set
before deleting old rows and inserting replacements. On any conflict the transaction
rolls back, including the delete. `remove_pricing_rule_set` deletes the parent and
cascades to every atomic row. These invoker RPCs retain authenticated-user RLS;
Next.js performs active-admin authorization, validates explicit fields, checks the
selected courts and every weekday against opening hours, and decides the intended
applicability. The court/location/environment composite foreign key prevents wrong
court state or location even under concurrent court changes. The GiST exclusion
constraint prevents overlapping applicability for the same court, state, weekday,
inclusive date range and half-open time range. Different courts may share schedules.

All five supported location currencies use two decimal places. The database stores
positive integer minor units and no currency column; changing a location's currency
changes how existing amounts are denominated without conversion. Decimal input is
parsed as digits without floating-point rounding. Time applicability is `[start,
end)`: `07:00–16:00` and `16:00–20:00` are adjacent; 16:00 resolves only to the
second interval. End time may be `24:00`. Date bounds are inclusive and may be
absent independently.

Opening hours remain independent. Each save must fit inside one configured interval
for every selected weekday, or the whole submission fails. Later opening-hours
edits may leave a pricing definition outside the schedule; consumers must check
opening hours separately. The current application has no opening-hours exceptions.

`resolvePricingRule()` consumes supplied atomic rows and a court ID, derived court
state, calendar date and local minute, returning one matching row or `null`. Monday
is 0. The caller supplies the local calendar date after timezone conversion; the
resolver does not infer coverage state or calculate booking totals. Public `/courts`
is unchanged and retains its temporary “From €10/hour”. Future booking integration
needs its own authorized pricing read and booking/payment policies.

For an existing unreleased local database, the owning migration is edited for a
clean future history. Apply only a focused transactional local schema/data delta;
do not reset the database or rewrite migration history. Legacy surface/day rows
must be mapped to compatible courts and grouped by their original definition; if a
row has no compatible court, abort the delta and resolve it explicitly.

Focused checks:

```bash
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -v ON_ERROR_STOP=1 -f supabase/tests/database/location_pricing_rules.sql
npx vitest run tests/unit/pricing.test.ts tests/unit/admin/pricing.test.ts tests/unit/admin/pricing-actions.test.ts tests/components/admin-pricing.test.tsx tests/components/admin-dashboard.test.tsx
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run tests/integration/admin/pricing.integration.test.ts --no-file-parallelism
npx tsc --noEmit -p tsconfig.pricing-check.json
npx eslint src/lib/pricing src/lib/admin/pricing.ts src/app/admin/pricing src/app/admin/page.tsx src/components/admin-navigation.tsx tests/unit/pricing.test.ts tests/unit/admin/pricing.test.ts tests/unit/admin/pricing-actions.test.ts tests/components/admin-pricing.test.tsx tests/components/admin-dashboard.test.tsx tests/integration/admin/pricing.integration.test.ts
```

Apply the focused local schema/data delta before database/integration tests. No reset
or migration-history manipulation is needed.
