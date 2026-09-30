begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into auth.users (id, email, aud, role) values
('c2000000-0000-4000-8000-000000000001', 'location-admin@example.test', 'authenticated', 'authenticated'),
('c2000000-0000-4000-8000-000000000002', 'location-member@example.test', 'authenticated', 'authenticated'),
('c2000000-0000-4000-8000-000000000003', 'location-suspended@example.test', 'authenticated', 'authenticated'),
('c2000000-0000-4000-8000-000000000004', 'location-coach@example.test', 'authenticated', 'authenticated');
insert into public.user_roles (user_id, role_code) values
('c2000000-0000-4000-8000-000000000001', 'admin'),
('c2000000-0000-4000-8000-000000000003', 'admin'),
('c2000000-0000-4000-8000-000000000004', 'coach');
update public.users set status = 'suspended' where id = 'c2000000-0000-4000-8000-000000000003';

insert into public.locations (id, name, slug, timezone, is_active, updated_at) values
('c2000000-0000-4000-8000-000000000011', 'Active fixture', 'admin-locations-active', 'Europe/Bucharest', true, '2000-01-01'),
('c2000000-0000-4000-8000-000000000012', 'Inactive fixture', 'admin-locations-inactive', 'Europe/Bucharest', false, '2000-01-01');

select is((select currency from public.locations where slug = 'admin-locations-active'), 'EUR', 'currency defaults to EUR');
select lives_ok(format('insert into public.locations (name, slug, timezone, currency) values (%L, %L, %L, %L)',
  currency, 'admin-locations-currency-' || currency, 'UTC', currency), 'currency accepted: ' || currency)
  from unnest(array['EUR','USD','GBP','RON','CHF']) currency;
select throws_ok($$insert into public.locations (name, slug, timezone, currency) values ('Bad', 'admin-locations-bad', 'UTC', 'CAD')$$,
  '23514', null, 'unsupported currency rejected');
select throws_ok($$update public.locations set currency = 'JPY' where slug = 'admin-locations-active'$$,
  '23514', null, 'unsupported currency update rejected');
select throws_ok($$insert into public.locations (name, slug, timezone, currency) values ('Null', 'admin-locations-null', 'UTC', null)$$,
  '23502', null, 'currency cannot be null');
select throws_ok($$insert into public.locations (name, slug, timezone) values ('Duplicate', 'admin-locations-active', 'UTC')$$,
  '23505', null, 'location slug remains globally unique');
select throws_ok($$insert into public.locations (name, slug, timezone) values ('No timezone', 'admin-locations-no-tz', null)$$,
  '23502', null, 'timezone remains required');
select throws_ok($$insert into public.locations (id, name, slug, timezone)
  values ('c2000000-0000-4000-8000-000000000011', 'Duplicate ID', 'admin-locations-duplicate-id', 'UTC')$$,
  '23505', null, 'location primary key remains unique');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c2000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select count(*) from public.locations where slug in ('admin-locations-active', 'admin-locations-inactive')),
  2::bigint, 'active admin sees active and inactive locations');
select lives_ok($$insert into public.locations (name, slug, timezone, currency, is_active, display_order, updated_at)
  values ('Admin created', 'admin-locations-created', 'Europe/London', 'GBP', false, 3, '2026-09-29')$$,
  'admin can create an inactive location');
select results_eq($$update public.locations set name = 'Edited', currency = 'RON', display_order = 5, updated_at = '2026-09-29'
  where slug = 'admin-locations-inactive' returning currency$$, array['RON']::text[], 'admin can edit an inactive location');
select results_eq($$update public.locations set is_active = false where slug = 'admin-locations-active' returning is_active$$,
  array[false], 'admin can deactivate a location');
select results_eq($$update public.locations set is_active = true where slug = 'admin-locations-active' returning is_active$$,
  array[true], 'admin can reactivate a location');
select results_eq($$update public.locations set archived_at = now(), is_active = false
  where slug = 'admin-locations-created' returning is_active$$,
  array[false], 'admin archive deactivates a location');
select ok((select archived_at is not null from public.locations where slug = 'admin-locations-created'),
  'archived location remains stored and visible to admin');
select throws_ok($$update public.locations set is_active = true where slug = 'admin-locations-created'$$,
  '23514', null, 'archived location cannot become active');
select results_eq($$update public.locations set archived_at = null where slug = 'admin-locations-created' returning is_active$$,
  array[false], 'restore leaves location inactive');
update public.locations set archived_at = now() where slug = 'admin-locations-created';
select is((select updated_at from public.locations where slug = 'admin-locations-active'),
  '2000-01-01'::timestamptz, 'database leaves updated_at application controlled');
select is((select updated_at from public.locations where slug = 'admin-locations-inactive'),
  '2026-09-29'::timestamptz, 'explicit update timestamp persists');
select throws_ok($$update public.locations set slug = 'changed' where slug = 'admin-locations-active'$$,
  '42501', null, 'slug update privilege not granted');
select throws_ok($$update public.locations set created_at = now() where slug = 'admin-locations-active'$$,
  '42501', null, 'creation timestamp update privilege not granted');
select throws_ok($$delete from public.locations where slug = 'admin-locations-created'$$,
  '42501', null, 'admin has no hard deletion privilege');

set local request.jwt.claims = '{"sub":"c2000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$insert into public.locations (name, slug, timezone) values ('Member', 'admin-locations-member', 'UTC')$$,
  '42501', null, 'normal user insert denied by RLS');
select results_eq($$update public.locations set name = 'Spoof' where slug = 'admin-locations-active' returning name$$,
  array[]::text[], 'normal user cannot update active location');
select results_eq($$update public.locations set is_active = true where slug = 'admin-locations-inactive' returning name$$,
  array[]::text[], 'normal user cannot reactivate inactive location');
select is((select count(*) from public.locations where slug = 'admin-locations-inactive'), 0::bigint, 'inactive location hidden from normal user');

set local request.jwt.claims = '{"sub":"c2000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok($$insert into public.locations (name, slug, timezone) values ('Coach', 'admin-locations-coach', 'UTC')$$,
  '42501', null, 'coach insert denied');
select results_eq($$update public.locations set name = 'Spoof' where slug = 'admin-locations-active' returning name$$,
  array[]::text[], 'coach update denied');

set local request.jwt.claims = '{"sub":"c2000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$insert into public.locations (name, slug, timezone) values ('Suspended', 'admin-locations-suspended', 'UTC')$$,
  '42501', null, 'suspended admin insert denied');
select results_eq($$update public.locations set name = 'Spoof' where slug = 'admin-locations-active' returning name$$,
  array[]::text[], 'suspended admin update denied');
select is((select count(*) from public.locations where slug = 'admin-locations-inactive'), 0::bigint, 'suspended admin cannot read inactive locations');

reset role;
set local role anon;
select throws_ok($$insert into public.locations (name, slug, timezone) values ('Anon', 'admin-locations-anon', 'UTC')$$,
  '42501', null, 'anonymous insert denied');
select throws_ok($$update public.locations set name = 'Spoof' where slug = 'admin-locations-active'$$,
  '42501', null, 'anonymous update denied');
select is((select count(*) from public.locations where slug = 'admin-locations-inactive'), 0::bigint, 'inactive location hidden anonymously');
select is((select count(*) from public.locations where slug = 'admin-locations-created'), 0::bigint, 'archived location hidden anonymously');
reset role;
select * from finish();
rollback;
