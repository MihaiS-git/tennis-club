begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into auth.users (id, email, aud, role) values
  ('cb000000-0000-4000-8000-000000000001', 'admin-cancel-admin@example.test', 'authenticated', 'authenticated'),
  ('cb000000-0000-4000-8000-000000000002', 'admin-cancel-coach@example.test', 'authenticated', 'authenticated'),
  ('cb000000-0000-4000-8000-000000000003', 'admin-cancel-member@example.test', 'authenticated', 'authenticated'),
  ('cb000000-0000-4000-8000-000000000004', 'admin-cancel-suspended@example.test', 'authenticated', 'authenticated');
insert into public.user_roles (user_id, role_code) values
  ('cb000000-0000-4000-8000-000000000001', 'admin'),
  ('cb000000-0000-4000-8000-000000000002', 'coach'),
  ('cb000000-0000-4000-8000-000000000004', 'admin');
update public.users set status = 'suspended' where id = 'cb000000-0000-4000-8000-000000000004';
insert into public.locations (id, name, slug, timezone, is_public) values
  ('cb000000-0000-4000-8000-000000000010', 'Operations', 'admin-cancel-operations', 'UTC', false);
insert into public.courts (id, location_id, name, slug, surface, environment, is_active) values
  ('cb000000-0000-4000-8000-000000000011', 'cb000000-0000-4000-8000-000000000010',
    'Court 1', 'court-1', 'clay', 'outdoor', true);
insert into public.court_reservations (id, court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_by_user_id)
values ('cb000000-0000-4000-8000-000000000020', 'cb000000-0000-4000-8000-000000000011',
  '2099-10-15', 750, 840, 'Coach training', 'cb000000-0000-4000-8000-000000000002');

set local role anon;
select throws_ok($$select public.cancel_admin_court_reservation('cb000000-0000-4000-8000-000000000020')$$,
  '42501', null, 'anonymous cannot invoke Admin cancellation');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"cb000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$select public.cancel_admin_court_reservation('cb000000-0000-4000-8000-000000000020')$$,
  '42501', null, 'Coach cannot invoke Admin cancellation');
set local request.jwt.claims = '{"sub":"cb000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$select public.cancel_admin_court_reservation('cb000000-0000-4000-8000-000000000020')$$,
  '42501', null, 'ordinary user cannot invoke Admin cancellation');
set local request.jwt.claims = '{"sub":"cb000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok($$select public.cancel_admin_court_reservation('cb000000-0000-4000-8000-000000000020')$$,
  '42501', null, 'suspended Admin cannot cancel');
set local request.jwt.claims = '{"sub":"cb000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(public.cancel_own_court_reservation('cb000000-0000-4000-8000-000000000020'), false,
  'Admin still cannot cancel another owner via personal RPC');
select is(public.cancel_admin_court_reservation('cb000000-0000-4000-8000-000000000020'), true,
  'Admin cancels another staff member active reservation');
select is(public.cancel_admin_court_reservation('cb000000-0000-4000-8000-000000000020'), false,
  'already cancelled reservation returns false');
select is(public.cancel_admin_court_reservation('cb000000-0000-4000-8000-000000000099'), false,
  'missing reservation returns false');
select is((select count(*) from public.list_admin_court_reservations(
  array['cb000000-0000-4000-8000-000000000011'::uuid], '2099-10-15')), 0::bigint,
  'cancelled reservation disappears from live Admin schedule');
reset role;
select is((select count(*) from public.court_reservations where id = 'cb000000-0000-4000-8000-000000000020'),
  1::bigint, 'cancelled row remains stored');
select is((select status::text from public.court_reservations where id = 'cb000000-0000-4000-8000-000000000020'),
  'cancelled', 'lifecycle status is cancelled');
select ok((select cancelled_at is not null from public.court_reservations where id = 'cb000000-0000-4000-8000-000000000020'),
  'cancellation timestamp is stored');
select is((select cancelled_by_user_id from public.court_reservations where id = 'cb000000-0000-4000-8000-000000000020'),
  'cb000000-0000-4000-8000-000000000001'::uuid, 'Admin is recorded as canceller');
select is((select created_by_user_id from public.court_reservations where id = 'cb000000-0000-4000-8000-000000000020'),
  'cb000000-0000-4000-8000-000000000002'::uuid, 'Coach remains creator');
select is((select reason from public.court_reservations where id = 'cb000000-0000-4000-8000-000000000020'),
  'Coach training', 'reason is preserved');
select is((select court_id from public.court_reservations where id = 'cb000000-0000-4000-8000-000000000020'),
  'cb000000-0000-4000-8000-000000000011'::uuid, 'court is preserved');
select is((select booking_date from public.court_reservations where id = 'cb000000-0000-4000-8000-000000000020'),
  '2099-10-15'::date, 'date is preserved');
select is((select starts_at_minute from public.court_reservations where id = 'cb000000-0000-4000-8000-000000000020'),
  750, 'start is preserved');
select is((select ends_at_minute from public.court_reservations where id = 'cb000000-0000-4000-8000-000000000020'),
  840, 'end is preserved');
select is(has_column_privilege('authenticated', 'public.court_reservations', 'status', 'UPDATE'), false,
  'authenticated role has no broad lifecycle UPDATE grant');

select * from finish();
rollback;
