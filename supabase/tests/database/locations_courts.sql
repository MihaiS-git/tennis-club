begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select plan(18);

insert into public.locations (id, name, slug, timezone, is_active) values
('c1000000-0000-4000-8000-000000000001', 'Active', 'test-locations-active', 'Europe/Bucharest', true),
('c1000000-0000-4000-8000-000000000002', 'Other', 'test-locations-other', 'Europe/Bucharest', true),
('c1000000-0000-4000-8000-000000000003', 'Inactive', 'test-locations-inactive', 'Europe/Bucharest', false);
insert into public.courts (location_id, name, slug, surface, environment, is_active) values
('c1000000-0000-4000-8000-000000000001', 'Active court', 'shared', 'clay', 'outdoor', true),
('c1000000-0000-4000-8000-000000000001', 'Inactive court', 'inactive', 'hard', 'indoor', false),
('c1000000-0000-4000-8000-000000000003', 'Hidden by location', 'hidden', 'grass', 'covered', true);

select throws_ok($$insert into public.courts (location_id, name, slug, surface, environment)
  values ('c1000000-0000-4000-8000-000000000001', 'Bad surface', 'bad-surface', 'sand', 'outdoor')$$,
  '23514', null, 'invalid surface rejected');
select throws_ok($$insert into public.courts (location_id, name, slug, surface, environment)
  values ('c1000000-0000-4000-8000-000000000001', 'Bad environment', 'bad-environment', 'clay', 'other')$$,
  '23514', null, 'invalid environment rejected');
select throws_ok($$insert into public.courts (location_id, name, slug, surface, environment)
  values ('c1000000-0000-4000-8000-000000000001', 'Duplicate', 'shared', 'clay', 'outdoor')$$,
  '23505', null, 'duplicate court slug within location rejected');
select lives_ok($$insert into public.courts (location_id, name, slug, surface, environment)
  values ('c1000000-0000-4000-8000-000000000002', 'Other court', 'shared', 'carpet', 'indoor')$$,
  'same court slug allowed under different locations');
select throws_ok($$insert into public.courts (location_id, name, slug, surface, environment)
  values ('c1000000-0000-4000-8000-000000000099', 'Orphan', 'orphan', 'hard', 'outdoor')$$,
  '23503', null, 'court requires an existing location');
select throws_ok($$insert into public.locations (name, slug, timezone)
  values ('Duplicate location', 'test-locations-active', 'Europe/Bucharest')$$,
  '23505', null, 'location slug is globally unique');
select is((select count(*) from pg_trigger where tgrelid in
  ('public.locations'::regclass, 'public.courts'::regclass) and not tgisinternal),
  0::bigint, 'no automatic update timestamp triggers');
select ok((select relrowsecurity from pg_class where oid = 'public.locations'::regclass), 'location RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.courts'::regclass), 'court RLS enabled');

set local role anon;
select is((select count(*) from public.locations where id in
  ('c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003')),
  2::bigint, 'anonymous reads only active locations');
select is((select count(*) from public.courts where location_id in
  ('c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003')),
  2::bigint, 'anonymous reads only active courts at active locations');
select throws_ok($$insert into public.locations (name, slug, timezone) values ('Spoof', 'spoof', 'UTC')$$,
  '42501', null, 'anonymous cannot insert locations');
select throws_ok($$update public.locations set name = 'Spoof'$$, '42501', null, 'anonymous cannot update locations');
select throws_ok($$delete from public.locations$$, '42501', null, 'anonymous cannot delete locations');
select throws_ok($$insert into public.courts (location_id, name, slug, surface, environment)
  values ('c1000000-0000-4000-8000-000000000001', 'Spoof', 'spoof', 'clay', 'outdoor')$$,
  '42501', null, 'anonymous cannot insert courts');
select throws_ok($$update public.courts set name = 'Spoof'$$, '42501', null, 'anonymous cannot update courts');
select throws_ok($$delete from public.courts$$, '42501', null, 'anonymous cannot delete courts');
reset role;
set local role authenticated;
select is((select count(*) from public.courts where location_id in
  ('c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003')),
  2::bigint, 'authenticated public discovery has the same visibility');
reset role;
select * from finish();
rollback;
