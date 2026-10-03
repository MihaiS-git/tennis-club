begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into auth.users (id, email, aud, role) values
  ('ce000000-0000-4000-8000-000000000001', 'edit-admin@example.test', 'authenticated', 'authenticated'),
  ('ce000000-0000-4000-8000-000000000002', 'edit-coach@example.test', 'authenticated', 'authenticated'),
  ('ce000000-0000-4000-8000-000000000003', 'edit-member@example.test', 'authenticated', 'authenticated'),
  ('ce000000-0000-4000-8000-000000000004', 'edit-suspended@example.test', 'authenticated', 'authenticated');
insert into public.user_roles (user_id, role_code) values
  ('ce000000-0000-4000-8000-000000000001', 'admin'),
  ('ce000000-0000-4000-8000-000000000002', 'coach'),
  ('ce000000-0000-4000-8000-000000000004', 'admin');
update public.users set status = 'suspended' where id = 'ce000000-0000-4000-8000-000000000004';
insert into public.locations (id, name, slug, timezone, is_public) values
  ('ce000000-0000-4000-8000-000000000010', 'Operations', 'admin-edit-operations', 'UTC', false),
  ('ce000000-0000-4000-8000-000000000012', 'Other', 'admin-edit-other', 'UTC', false);
insert into public.courts (id, location_id, name, slug, surface, environment, is_active) values
  ('ce000000-0000-4000-8000-000000000011', 'ce000000-0000-4000-8000-000000000010', 'Court 1', 'court-1', 'clay', 'outdoor', true),
  ('ce000000-0000-4000-8000-000000000013', 'ce000000-0000-4000-8000-000000000010', 'Court 2', 'court-2', 'clay', 'outdoor', true),
  ('ce000000-0000-4000-8000-000000000014', 'ce000000-0000-4000-8000-000000000012', 'Other', 'other', 'clay', 'outdoor', true);
insert into public.location_opening_hours (location_id, weekday, opens_at_minute, closes_at_minute) values
  ('ce000000-0000-4000-8000-000000000010', extract(isodow from date '2099-10-15')::integer - 1, 600, 900),
  ('ce000000-0000-4000-8000-000000000010', extract(isodow from date '2099-10-16')::integer - 1, 600, 900);
insert into public.court_reservations (id, court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_by_user_id)
values ('ce000000-0000-4000-8000-000000000020', 'ce000000-0000-4000-8000-000000000011',
  '2099-10-15', 600, 660, 'Coach training', 'ce000000-0000-4000-8000-000000000002'),
  ('ce000000-0000-4000-8000-000000000021', 'ce000000-0000-4000-8000-000000000013',
  '2099-10-16', 720, 780, 'Other booking', 'ce000000-0000-4000-8000-000000000002');
select set_config('test.admin_edit_token', (select updated_at::text from public.court_reservations
  where id = 'ce000000-0000-4000-8000-000000000020'), true);

set local role anon;
select throws_ok($$select public.edit_admin_court_reservation('ce000000-0000-4000-8000-000000000020', now(),
  'Spoof', false, null, null, null, null)$$, '42501', null, 'anonymous cannot edit as Admin');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"ce000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$select public.edit_admin_court_reservation('ce000000-0000-4000-8000-000000000020', now(),
  'Spoof', false, null, null, null, null)$$, '42501', null, 'Coach cannot edit as Admin');
set local request.jwt.claims = '{"sub":"ce000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$select public.edit_admin_court_reservation('ce000000-0000-4000-8000-000000000020', now(),
  'Spoof', false, null, null, null, null)$$, '42501', null, 'ordinary member cannot edit as Admin');
set local request.jwt.claims = '{"sub":"ce000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok($$select public.edit_admin_court_reservation('ce000000-0000-4000-8000-000000000020', now(),
  'Spoof', false, null, null, null, null)$$, '42501', null, 'suspended Admin cannot edit');
set local request.jwt.claims = '{"sub":"ce000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(public.edit_own_court_reservation('ce000000-0000-4000-8000-000000000020',
  current_setting('test.admin_edit_token')::timestamptz,
  'Spoof', false, null, null, null, null), 'unavailable', 'personal edit remains owner-only');
select is(public.edit_admin_court_reservation('ce000000-0000-4000-8000-000000000020',
  current_setting('test.admin_edit_token')::timestamptz,
  'Spoof', true, 'ce000000-0000-4000-8000-000000000014', '2099-10-16', 780, 870),
  'unavailable', 'crafted cross-location schedule fails');
select throws_ok($$select public.edit_admin_court_reservation('ce000000-0000-4000-8000-000000000020',
  current_setting('test.admin_edit_token')::timestamptz, 'Conflict', true,
  'ce000000-0000-4000-8000-000000000013', '2099-10-16', 720, 780)$$,
  '23P01', null, 'GiST rejects an overlapping same-row move');
select is(public.edit_admin_court_reservation('ce000000-0000-4000-8000-000000000020',
  current_setting('test.admin_edit_token')::timestamptz,
  ' Admin reason ', false, null, null, null, null), 'updated', 'Admin edits Coach reservation in place');
select is(public.edit_admin_court_reservation('ce000000-0000-4000-8000-000000000020',
  '2000-01-01'::timestamptz, 'Stale', false, null, null, null, null), 'stale', 'stale token fails');
reset role;
select is((select reason from public.court_reservations where id = 'ce000000-0000-4000-8000-000000000020'),
  'Admin reason', 'stale attempt preserved newer reason');
select is((select court_id from public.court_reservations where id = 'ce000000-0000-4000-8000-000000000020'),
  'ce000000-0000-4000-8000-000000000011'::uuid, 'failed move preserved original court');
select is((select booking_date from public.court_reservations where id = 'ce000000-0000-4000-8000-000000000020'),
  '2099-10-15'::date, 'failed move preserved original date');
select is((select created_by_user_id from public.court_reservations where id = 'ce000000-0000-4000-8000-000000000020'),
  'ce000000-0000-4000-8000-000000000002'::uuid, 'creator preserved');
select is((select status::text from public.court_reservations where id = 'ce000000-0000-4000-8000-000000000020'),
  'active', 'status preserved');
select is((select cancelled_by_user_id from public.court_reservations where id = 'ce000000-0000-4000-8000-000000000020'),
  null::uuid, 'canceller remains null');
select is(has_column_privilege('authenticated', 'public.court_reservations', 'reason', 'UPDATE'), false,
  'no broad authenticated UPDATE grant');
select * from finish();
rollback;
