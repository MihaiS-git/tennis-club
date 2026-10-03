begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select plan(30);

insert into public.locations (id, name, slug, timezone, is_active, is_public) values
('c1000000-0000-4000-8000-000000000001', 'Active', 'test-locations-active', 'Europe/Bucharest', true, true),
('c1000000-0000-4000-8000-000000000002', 'Other', 'test-locations-other', 'Europe/Bucharest', true, true),
('c1000000-0000-4000-8000-000000000003', 'Inactive', 'test-locations-inactive', 'Europe/Bucharest', false, true);
insert into public.courts (location_id, name, slug, surface, environment, is_active) values
('c1000000-0000-4000-8000-000000000001', 'Active court', 'shared', 'clay', 'outdoor', true),
('c1000000-0000-4000-8000-000000000001', 'Inactive court', 'inactive', 'hard', 'indoor', false),
('c1000000-0000-4000-8000-000000000003', 'Hidden by location', 'hidden', 'grass', 'outdoor', true);

select throws_ok($$insert into public.courts (location_id, name, slug, surface, environment)
  values ('c1000000-0000-4000-8000-000000000001', 'Covered', 'covered', 'clay', 'covered')$$,
  '23514', null, 'covered is not a permanent environment');
select hasnt_column('public', 'courts', 'supports_balloon', 'obsolete capability column removed');
select hasnt_column('public', 'courts', 'balloon_installed', 'obsolete installation column removed');

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
select is((select is_public from public.locations where slug = 'test-locations-active'), true,
  'explicit publication persists');
insert into public.locations (id, name, slug, timezone) values
('c1000000-0000-4000-8000-000000000004', 'Private', 'test-locations-private', 'Europe/Bucharest');
insert into public.courts (location_id, name, slug, surface, environment) values
('c1000000-0000-4000-8000-000000000004', 'Private court', 'private', 'clay', 'outdoor');
select is((select is_public from public.locations where slug = 'test-locations-private'), false,
  'new locations default private');

set local role anon;
select is((select count(*) from public.locations where id in
  ('c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003')),
  2::bigint, 'anonymous reads only active locations');
select is((select count(*) from public.courts where location_id in
  ('c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003')),
  2::bigint, 'anonymous reads only active courts at active locations');
select is((select count(*) from public.locations where slug = 'test-locations-private'), 0::bigint,
  'anonymous cannot read a private active location');
select is((select count(*) from public.courts where location_id = 'c1000000-0000-4000-8000-000000000004'), 0::bigint,
  'anonymous cannot read courts at a private location');
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
select throws_ok($$update public.locations set archived_at = now() where slug = 'test-locations-active'$$,
  '23514', null, 'active location cannot be archived without deactivation');
update public.locations set is_active = false, archived_at = now() where slug = 'test-locations-active';
select ok((select archived_at is not null from public.locations where slug = 'test-locations-active'),
  'archived location remains stored');
set local role anon;
select is((select count(*) from public.locations where slug = 'test-locations-active'), 0::bigint,
  'archived location hidden from anonymous location discovery');
select is((select count(*) from public.courts where location_id = 'c1000000-0000-4000-8000-000000000001'), 0::bigint,
  'courts at archived location hidden anonymously');
reset role;
set local role authenticated;
select is((select count(*) from public.courts where location_id = 'c1000000-0000-4000-8000-000000000001'), 0::bigint,
  'courts at archived location hidden from normal authenticated users');
reset role;
select * from finish();
rollback;
