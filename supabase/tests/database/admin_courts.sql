begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into auth.users (id, email, aud, role) values
('c4000000-0000-4000-8000-000000000001', 'court-admin@example.test', 'authenticated', 'authenticated'),
('c4000000-0000-4000-8000-000000000002', 'court-member@example.test', 'authenticated', 'authenticated'),
('c4000000-0000-4000-8000-000000000003', 'court-suspended@example.test', 'authenticated', 'authenticated'),
('c4000000-0000-4000-8000-000000000004', 'court-coach@example.test', 'authenticated', 'authenticated');
insert into public.user_roles (user_id, role_code) values
('c4000000-0000-4000-8000-000000000001', 'admin'),
('c4000000-0000-4000-8000-000000000003', 'admin'),
('c4000000-0000-4000-8000-000000000004', 'coach');
update public.users set status = 'suspended' where id = 'c4000000-0000-4000-8000-000000000003';
insert into public.locations (id, name, slug, timezone, is_active, is_public) values
('c4000000-0000-4000-8000-000000000011', 'Active', 'admin-courts-active', 'UTC', true, true),
('c4000000-0000-4000-8000-000000000012', 'Inactive', 'admin-courts-inactive', 'UTC', false, false);
insert into public.courts (id, location_id, name, slug, surface, environment, is_active, updated_at) values
('c4000000-0000-4000-8000-000000000021', 'c4000000-0000-4000-8000-000000000011', 'Active court', 'one', 'clay', 'outdoor', true, '2000-01-01'),
('c4000000-0000-4000-8000-000000000022', 'c4000000-0000-4000-8000-000000000011', 'Inactive court', 'two', 'hard', 'indoor', false, '2000-01-01'),
('c4000000-0000-4000-8000-000000000023', 'c4000000-0000-4000-8000-000000000012', 'Hidden court', 'one', 'grass', 'outdoor', true, '2000-01-01');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c4000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select count(*) from public.courts where location_id in
  ('c4000000-0000-4000-8000-000000000011', 'c4000000-0000-4000-8000-000000000012')),
  3::bigint, 'active admin sees inactive courts and courts at inactive locations');
select lives_ok($$insert into public.courts (location_id, name, slug, surface, environment, has_lighting, is_active, updated_at)
  values ('c4000000-0000-4000-8000-000000000012', 'Admin created', 'created', 'carpet', 'indoor', true, false, '2026-09-29')$$,
  'admin may create a court at an inactive location');
select results_eq($$update public.courts set name = 'Edited', surface = 'grass', environment = 'outdoor', has_lighting = true,
  updated_at = '2026-09-29' where id = 'c4000000-0000-4000-8000-000000000022' returning name$$,
  array['Edited']::text[], 'admin may edit an inactive court');
select results_eq($$update public.courts set is_active = false where id = 'c4000000-0000-4000-8000-000000000021' returning is_active$$,
  array[false], 'admin may deactivate a court');
select results_eq($$update public.courts set is_active = true where id = 'c4000000-0000-4000-8000-000000000021' returning is_active$$,
  array[true], 'admin may reactivate a court');
select is((select updated_at from public.courts where id = 'c4000000-0000-4000-8000-000000000021'),
  '2000-01-01'::timestamptz, 'database does not automatically change updated_at');
select is((select updated_at from public.courts where id = 'c4000000-0000-4000-8000-000000000022'),
  '2026-09-29'::timestamptz, 'explicit application timestamp persists');
select throws_ok($$update public.courts set location_id = 'c4000000-0000-4000-8000-000000000012'
  where id = 'c4000000-0000-4000-8000-000000000021'$$, '23505', null, 'moving to a location with a duplicate slug fails');
select results_eq($$update public.courts set location_id = 'c4000000-0000-4000-8000-000000000012'
  where id = 'c4000000-0000-4000-8000-000000000022' returning slug$$, array['two']::text[], 'admin may move a court while preserving its slug');
select throws_ok($$update public.courts set surface = 'sand' where id = 'c4000000-0000-4000-8000-000000000021'$$,
  '23514', null, 'invalid surface update rejected');
select throws_ok($$update public.courts set environment = 'covered' where id = 'c4000000-0000-4000-8000-000000000021'$$,
  '23514', null, 'invalid environment update rejected');
select throws_ok($$update public.courts set slug = 'changed' where id = 'c4000000-0000-4000-8000-000000000021'$$,
  '42501', null, 'slug update privilege not granted');
select throws_ok($$update public.courts set created_at = now() where id = 'c4000000-0000-4000-8000-000000000021'$$,
  '42501', null, 'creation timestamp update privilege not granted');
select throws_ok($$delete from public.courts where id = 'c4000000-0000-4000-8000-000000000021'$$,
  '42501', null, 'admin has no hard deletion privilege');

set local request.jwt.claims = '{"sub":"c4000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$insert into public.courts (location_id, name, slug, surface, environment)
  values ('c4000000-0000-4000-8000-000000000011', 'Member', 'member-spoof', 'clay', 'outdoor')$$,
  '42501', null, 'normal user insert denied by RLS');
select results_eq($$update public.courts set name = 'Spoof' where id = 'c4000000-0000-4000-8000-000000000021' returning name$$,
  array[]::text[], 'normal user update denied');
select results_eq($$update public.courts set is_active = true where id = 'c4000000-0000-4000-8000-000000000022' returning name$$,
  array[]::text[], 'normal user cannot reactivate an inactive court');
select is((select count(*) from public.courts where location_id in
  ('c4000000-0000-4000-8000-000000000011', 'c4000000-0000-4000-8000-000000000012')),
  1::bigint, 'normal user sees only active courts at active locations');

set local request.jwt.claims = '{"sub":"c4000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok($$insert into public.courts (location_id, name, slug, surface, environment)
  values ('c4000000-0000-4000-8000-000000000011', 'Coach', 'coach-spoof', 'clay', 'outdoor')$$,
  '42501', null, 'coach insert denied');
select results_eq($$update public.courts set name = 'Spoof' where id = 'c4000000-0000-4000-8000-000000000021' returning name$$,
  array[]::text[], 'coach update denied');

set local request.jwt.claims = '{"sub":"c4000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$insert into public.courts (location_id, name, slug, surface, environment)
  values ('c4000000-0000-4000-8000-000000000011', 'Suspended', 'suspended-spoof', 'clay', 'outdoor')$$,
  '42501', null, 'suspended admin insert denied');
select results_eq($$update public.courts set name = 'Spoof' where id = 'c4000000-0000-4000-8000-000000000021' returning name$$,
  array[]::text[], 'suspended admin update denied');
select is((select count(*) from public.courts where id = 'c4000000-0000-4000-8000-000000000022'),
  0::bigint, 'suspended admin cannot read inactive court');
reset role;
set local role anon;
select throws_ok($$insert into public.courts (location_id, name, slug, surface, environment)
  values ('c4000000-0000-4000-8000-000000000011', 'Anonymous', 'anon-spoof', 'clay', 'outdoor')$$,
  '42501', null, 'anonymous insert denied');
select throws_ok($$update public.courts set name = 'Spoof' where id = 'c4000000-0000-4000-8000-000000000021'$$,
  '42501', null, 'anonymous update denied');
select is((select count(*) from public.courts where location_id in
  ('c4000000-0000-4000-8000-000000000011', 'c4000000-0000-4000-8000-000000000012')),
  1::bigint, 'anonymous discovery remains active only');
reset role;
select * from finish();
rollback;
