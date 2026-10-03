begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into auth.users (id, email, aud, role) values
  ('cc000000-0000-4000-8000-000000000001', 'admin-edit-admin@example.test', 'authenticated', 'authenticated'),
  ('cc000000-0000-4000-8000-000000000002', 'admin-edit-coach@example.test', 'authenticated', 'authenticated'),
  ('cc000000-0000-4000-8000-000000000003', 'admin-edit-member@example.test', 'authenticated', 'authenticated'),
  ('cc000000-0000-4000-8000-000000000004', 'admin-edit-suspended@example.test', 'authenticated', 'authenticated');
insert into public.user_roles (user_id, role_code) values
  ('cc000000-0000-4000-8000-000000000001', 'admin'),
  ('cc000000-0000-4000-8000-000000000002', 'coach'),
  ('cc000000-0000-4000-8000-000000000004', 'admin');
update public.users set status = 'suspended' where id = 'cc000000-0000-4000-8000-000000000004';
insert into public.locations (id, name, slug, timezone, is_public) values
  ('cc000000-0000-4000-8000-000000000010', 'Operations', 'admin-edit-operations', 'UTC', false),
  ('cc000000-0000-4000-8000-000000000020', 'Other', 'admin-edit-other', 'UTC', false);
insert into public.courts (id, location_id, name, slug, surface, environment, is_active) values
  ('cc000000-0000-4000-8000-000000000011', 'cc000000-0000-4000-8000-000000000010', 'Court 1', 'court-1', 'clay', 'outdoor', true),
  ('cc000000-0000-4000-8000-000000000012', 'cc000000-0000-4000-8000-000000000010', 'Court 2', 'court-2', 'clay', 'outdoor', true),
  ('cc000000-0000-4000-8000-000000000021', 'cc000000-0000-4000-8000-000000000020', 'Other court', 'other-court', 'clay', 'outdoor', true);
insert into public.court_reservations (id, court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_by_user_id) values
  ('cc000000-0000-4000-8000-000000000030', 'cc000000-0000-4000-8000-000000000011', '2099-10-15', 750, 840, 'Coach session', 'cc000000-0000-4000-8000-000000000002'),
  ('cc000000-0000-4000-8000-000000000031', 'cc000000-0000-4000-8000-000000000012', '2099-10-15', 780, 870, 'Other session', 'cc000000-0000-4000-8000-000000000002'),
  ('cc000000-0000-4000-8000-000000000032', 'cc000000-0000-4000-8000-000000000021', '2099-10-15', 750, 840, 'Other location', 'cc000000-0000-4000-8000-000000000002');
insert into public.court_reservations (id, court_id, booking_date, starts_at_minute, ends_at_minute, reason,
  status, cancelled_at, cancelled_by_user_id) values
  ('cc000000-0000-4000-8000-000000000033', 'cc000000-0000-4000-8000-000000000011', '2099-10-15', 840, 900,
   'Cancelled', 'cancelled', now(), 'cc000000-0000-4000-8000-000000000001');

set local role anon;
select throws_ok($$select public.read_admin_reservation_edit_availability(
  'cc000000-0000-4000-8000-000000000030', '2099-10-15')$$,
  '42501', null, 'anonymous cannot read Admin edit availability');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"cc000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$select public.read_admin_reservation_edit_availability(
  'cc000000-0000-4000-8000-000000000030', '2099-10-15')$$,
  '42501', null, 'Coach cannot read Admin edit availability');
set local request.jwt.claims = '{"sub":"cc000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$select public.read_admin_reservation_edit_availability(
  'cc000000-0000-4000-8000-000000000030', '2099-10-15')$$,
  '42501', null, 'ordinary member cannot read Admin edit availability');
set local request.jwt.claims = '{"sub":"cc000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok($$select public.read_admin_reservation_edit_availability(
  'cc000000-0000-4000-8000-000000000030', '2099-10-15')$$,
  '42501', null, 'suspended Admin cannot read edit availability');
set local request.jwt.claims = '{"sub":"cc000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((public.read_admin_reservation_edit_availability(
  'cc000000-0000-4000-8000-000000000030', '2099-10-15')->>'location_id')::uuid,
  'cc000000-0000-4000-8000-000000000010'::uuid, 'Admin read resolves fixed location of another user reservation');
select is((public.read_admin_reservation_edit_availability(
  'cc000000-0000-4000-8000-000000000030', '2099-10-15')->>'location_timezone'),
  'UTC', 'Admin read returns location timezone');
select is(jsonb_array_length(public.read_admin_reservation_edit_availability(
  'cc000000-0000-4000-8000-000000000030', '2099-10-15')->'occupancy'),
  1, 'only another active reservation at the same location blocks');
select is((public.read_admin_reservation_edit_availability(
  'cc000000-0000-4000-8000-000000000030', '2099-10-15')->'occupancy'->0->>'court_id')::uuid,
  'cc000000-0000-4000-8000-000000000012'::uuid, 'target reservation is excluded and another court remains occupied');
select is(jsonb_array_length(public.read_admin_reservation_edit_availability(
  'cc000000-0000-4000-8000-000000000030', '2099-10-16')->'occupancy'),
  0, 'changing date reads occupancy at the same fixed location');
select throws_ok($$select public.read_admin_reservation_edit_availability(
  'cc000000-0000-4000-8000-000000000033', '2099-10-15')$$,
  '42501', null, 'cancelled reservation cannot be edited');
select throws_ok($$select public.read_admin_reservation_edit_availability(
  'cc000000-0000-4000-8000-000000000099', '2099-10-15')$$,
  '42501', null, 'missing reservation cannot be edited');
select throws_ok($$select * from public.list_own_reservation_edit_occupancy(
  'cc000000-0000-4000-8000-000000000030', '2099-10-15')$$,
  '42501', null, 'Admin still cannot use owner-only edit occupancy for another reservation');

select * from finish();
rollback;
