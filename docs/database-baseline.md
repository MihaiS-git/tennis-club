# Pre-production database baseline consolidation

The application now has two initial migrations. No development or remote database was
modified during consolidation. Only the disposable `tennis-club-tests` stack was recreated.

## Original migration responsibilities

| Former migration | Responsibility | Consolidation |
| --- | --- | --- |
| `InitialApplicationSchema1791462257924` | Entity-derived application tables, enums, indexes, checks, FKs, GiST exclusions and financial exceptions | Retained with final checkout/booking and Coach hold definitions |
| `ApplicationNativeIntegrity1791462257925` | Immutable financial evidence, ownership and revision guards, expression indexes, roles and singleton reference records | Incorporated into initial schema |
| `SupabaseAuthStorage1791462257926` | Auth provisioning/email hooks, private avatar bucket/policies, active-account helper and privilege restrictions | Retained as the security integration baseline |
| `SeparateCheckoutBookings1791462257927` | Renamed the old booking aggregate to checkout records, rewrote revision functions, added confirmed identities and backfilled confirmation proof | Replaced by direct final definitions |
| `CoachOnlyAdjustmentHolds1791462257928` | Added `occupies_court` and its check; replaced the court exclusion predicate | Incorporated into initial reservation definition |

The last two migrations were valid upgrades of their preceding schema, but their
intermediate states and data transformations are unnecessary for a fresh baseline.
Removed operations include the table rename, catalog-based function rewriting, empty-database
confirmation backfill, later column/check additions and exclusion drop/recreation.
Rollback no longer deletes bootstrap rows or separately drops expression indexes before
dropping their owning tables. Financial-history rollback refusals remain.

## Final structure and ordering

1. `src/lib/db/migrations/1791462257924-InitialApplicationSchema.ts`
2. `src/lib/db/migrations/1791462257926-SupabaseAuthStorage.ts`

The timestamp gap is intentional. The first migration includes native integrity guards
and reference data because these belong to the same application schema. The second has
a distinct security/infrastructure responsibility and depends on the completed application
schema and native Supabase Auth/Storage infrastructure. Run pending migrations atomically
with TypeORM's `transaction: "all"`, as the initializer and rebuild workflow do.

Within the schema, `btree_gist` precedes exclusions. Tables precede cyclic
checkout/revision/adjustment FKs; same-booking current-revision and adjustment-source FKs
remain deferred. Confirmed booking proof references the checkout and same-booking revision
keys. Integrity triggers follow their tables. There is no separate native-integrity
migration dependency requiring a third migration.

Existing constraint/index/trigger names containing `bookings` on `checkout_records` are
intentional final names shared with the entities. Renaming them would create metadata drift
and change the existing final catalog. Financial FKs still reference checkout records;
confirmed identities remain a separate proof of confirmation.

Coach-only holds require an adjustment and coach, skip the court exclusion, and retain
the coach exclusion. Ordinary reservations default to occupying the court. Adjustment
fragments retain their 30-minute minimum; ordinary reservations retain 60 minutes.
Payment/refund uniqueness, restrictive FKs, deferred revision validation, write-once facts,
append-only evidence and immutable financial-context guards are preserved.

## Schema equivalence verification

On 2026-10-30, two separate fresh starts of the isolated test Supabase stack were used:
first applying the original five migrations, then applying the consolidated two. Sorted
catalog snapshots matched exactly, without normalizing SQL definitions or object names.
The comparison covered `public`, `auth` and `storage`:

- Relations, owners, ACLs, RLS flags and relation options.
- Columns, types, defaults, nullability, identity/generated attributes, collation and column ACLs.
- Primary, foreign, unique, CHECK and exclusion constraints, including validation/deferral.
- Index definitions; function definitions, owners and ACLs; non-internal triggers and enablement.
- Storage RLS policies, default privileges, schema ACLs, enum labels, sequences and extensions.
- Required role records, payment/club singletons, private avatar bucket configuration and
  row counts for every application table.

The snapshots contain 35 application tables, 247 public constraints, 347 public columns,
13 public functions, 18 public non-internal triggers and four Storage policies. Counts for
public indexes/relations also include the unchanged TypeORM tracking index. Tracking-table
contents were checked separately because the history intentionally changes from five to two.
Only the seeded payment-settings `updated_at` value was excluded from reference-data
comparison; its default definition was compared. Catalog OIDs and physical column ordering
are not schema identity and were not compared.

Temporary evidence is in `/tmp/tennis-original-schema.json`,
`/tmp/tennis-consolidated-schema.json` and `/tmp/tennis-schema-snapshot.mjs` for this work
session. Both snapshot files have SHA-256
`34a5ab20bacf0da92faf15fd8a2bbad65f97cb81fcf40d9e8ca7c346b0c7170e`.

The fresh initializer applied two migrations; the second run applied zero and reported
no pending migrations. The migration-cutover integration suite also checks exact tracking
names and an empty TypeORM schema-builder diff, plus behavioral integrity/security checks.

## Validation results

| Check | Result |
| --- | --- |
| Original five migrations on a fresh isolated stack | Passed; reference catalog captured |
| Consolidated baseline on a second fresh isolated stack | Passed; two migrations applied atomically |
| Schema/security/reference-data comparison | Exact match across all compared sections |
| Second migration run | Zero applied; none pending |
| Full database/integration suite | 60 files, 653 tests passed; zero TypeORM metadata drift |
| ESLint, TypeScript, Knip | All passed |
| Full unit/component suite | 199 files, 2,279 tests passed |

Integration coverage includes checkout holds, operational changes, refund executions,
Coach-only holds, concurrent occupancy/configuration writes, denied browser access,
Auth provisioning/email synchronization and private avatar Storage. The integration run
emitted a `pg` concurrent-client-query deprecation warning without test failures.
No dependencies or application runtime behavior changed. No Git operations were performed.

## Development database transition

The existing development database with the original history was left untouched. Retained
migration names now have rewritten definitions: `migration:run` cannot transition that
database. Do not edit tracking rows or attempt to reconcile the old history in place.

When you choose to discard the disposable development data:

1. Stop the application and preserve anything you need from the development stack, including
   account/profile/booking data and avatars. The rebuild deletes Auth users and avatar objects.
2. Verify `.env.local` points to this project's development Supabase stack on ports
   54321/54322, and start that stack if needed.
3. Run `npm run db:dev:rebuild -- --discard-local-data` yourself. Its local-target guards
   recreate the application schema and apply the new baseline atomically.
4. Run `npm run db:dev:seed`, then optionally `npm run db:dev:seed:coaching`.
5. Confirm `public.migrations`, ordered by timestamp, contains exactly
   `InitialApplicationSchema1791462257924` and `SupabaseAuthStorage1791462257926`.
   A migration status check must show no pending migrations:

   ```bash
   node --conditions=react-server --env-file=.env.local --import=./scripts/ts-loader.mjs node_modules/typeorm/cli.js migration:show -d src/lib/db/migration-data-source.mjs
   ```

Restart the app after verification. If any existing database's data must be retained,
stop before rebuilding: that needs a separately authorized data-preserving cutover.
This procedure was documented, not executed against development.
