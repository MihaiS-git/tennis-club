begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into auth.users (id, email, aud, role) values
  ('d1000000-0000-4000-8000-000000000001', 'operational-admin@example.test', 'authenticated', 'authenticated'),
  ('d1000000-0000-4000-8000-000000000002', 'operational-coach@example.test', 'authenticated', 'authenticated'),
  ('d1000000-0000-4000-8000-000000000003', 'operational-member@example.test', 'authenticated', 'authenticated'),
  ('d1000000-0000-4000-8000-000000000004', 'operational-suspended@example.test', 'authenticated', 'authenticated');
insert into public.user_roles (user_id, role_code) values
  ('d1000000-0000-4000-8000-000000000001', 'admin'),
  ('d1000000-0000-4000-8000-000000000002', 'coach'),
  ('d1000000-0000-4000-8000-000000000004', 'admin');
update public.users set first_name = 'Mihai', last_name = 'Stan'
  where id = 'd1000000-0000-4000-8000-000000000002';
update public.users set status = 'suspended'
  where id = 'd1000000-0000-4000-8000-000000000004';
insert into public.locations (id, name, slug, timezone, is_public) values
  ('d1000000-0000-4000-8000-000000000010', 'Operations', 'operational-bookings', 'UTC', true);
insert into public.courts (id, location_id, name, slug, surface, environment, is_active) values
  ('d1000000-0000-4000-8000-000000000011', 'd1000000-0000-4000-8000-000000000010',
   'Court 1', 'court-1', 'clay', 'outdoor', true);
insert into public.court_reservations (id, court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_by_user_id) values
  ('d1000000-0000-4000-8000-000000000020', 'd1000000-0000-4000-8000-000000000011', '2099-10-15', 600, 660, 'Training', 'd1000000-0000-4000-8000-000000000002'),
  ('d1000000-0000-4000-8000-000000000021', 'd1000000-0000-4000-8000-000000000011', '2099-10-15', 660, 720, null, null),
  ('d1000000-0000-4000-8000-000000000022', 'd1000000-0000-4000-8000-000000000011', '2099-10-15', 720, 780, null, null);
insert into public.bookings (id, reservation_id, account_user_id, customer_name, customer_email, customer_phone,
  total_amount_minor, currency, cancellation_notice_minutes) values
  ('d1000000-0000-4000-8000-000000000030', 'd1000000-0000-4000-8000-000000000021',
   'd1000000-0000-4000-8000-000000000003', 'Ana Pop', 'ana@example.test', '+40 123', 7500, 'RON', 120),
  ('d1000000-0000-4000-8000-000000000031', 'd1000000-0000-4000-8000-000000000022',
   null, 'Cancelled Guest', 'guest@example.test', '+40 999', 7500, 'RON', 120);
update public.bookings set status = 'cancelled' where id = 'd1000000-0000-4000-8000-000000000031';

set local role authenticated;
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select count(*) from public.list_admin_operational_occupancy(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15')), 2::bigint,
  'Admin receives only consistent active occupancy details');
select is((select kind from public.list_admin_operational_occupancy(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15') where starts_at_minute = 600),
  'reservation', 'direct reservation is identified by absent booking relationship');
select is((select creator_name from public.list_admin_operational_occupancy(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15') where starts_at_minute = 600),
  'Mihai Stan', 'direct reservation creator remains available');
select is((select kind from public.list_admin_operational_occupancy(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15') where starts_at_minute = 660),
  'booking', 'linked booking is identified by booking relationship');
select is((select customer_name from public.list_admin_operational_occupancy(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15') where starts_at_minute = 660),
  'Ana Pop', 'Admin receives stored customer name');
select is((select customer_email from public.list_admin_operational_occupancy(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15') where starts_at_minute = 660),
  'ana@example.test', 'Admin receives stored email');
select is((select customer_phone from public.list_admin_operational_occupancy(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15') where starts_at_minute = 660),
  '+40 123', 'Admin receives stored phone');
select is((select total_amount_minor from public.list_admin_operational_occupancy(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15') where starts_at_minute = 660),
  7500, 'Admin receives stored amount');
select is((select currency from public.list_admin_operational_occupancy(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15') where starts_at_minute = 660),
  'RON', 'Admin receives stored currency');
select is((select count(*) from public.list_admin_court_reservations(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15')), 1::bigint,
  'direct-reservation inspection excludes linked bookings');
select ok((public.read_admin_reservation_edit_availability(
  'd1000000-0000-4000-8000-000000000020', '2099-10-15')->>'updated_at') is not null,
  'Admin direct edit read retains its stale token');
select is(public.cancel_admin_court_reservation('d1000000-0000-4000-8000-000000000021'), false,
  'Admin direct cancellation cannot cancel booking');
select is(public.edit_admin_court_reservation('d1000000-0000-4000-8000-000000000021', now(),
  'Changed', false, null, null, null, null), 'unavailable', 'Admin direct edit cannot change booking');
select throws_ok($$select * from public.read_admin_reservation_edit_availability(
  'd1000000-0000-4000-8000-000000000021', '2099-10-15')$$, '42501', null,
  'Admin direct edit read excludes booking');
select throws_ok($$select customer_email from public.bookings$$, '42501', null,
  'Admin function does not add broad table SELECT');
reset role;
update public.users set first_name = 'Changed', last_name = 'Profile'
  where id = 'd1000000-0000-4000-8000-000000000003';
set local role authenticated;
select is((select customer_name from public.list_admin_operational_occupancy(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15') where starts_at_minute = 660),
  'Ana Pop', 'profile changes do not alter booking snapshot');
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$select * from public.list_admin_operational_occupancy(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15')$$,
  '42501', null, 'Coach cannot inspect booking details directly');
select lives_ok($$select court_id, starts_at_minute from public.court_reservations
  where court_id = 'd1000000-0000-4000-8000-000000000011'$$,
  'Coach can read generic occupancy');
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$select * from public.list_admin_operational_occupancy(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15')$$,
  '42501', null, 'member cannot inspect Admin booking details');
select is((select count(*) from public.list_own_upcoming_customer_bookings()), 1::bigint,
  'member still reads only their own customer booking');
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok($$select * from public.list_admin_operational_occupancy(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15')$$,
  '42501', null, 'suspended Admin cannot inspect booking details');
reset role;
set local role anon;
select throws_ok($$select * from public.list_admin_operational_occupancy(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15')$$,
  '42501', null, 'public cannot inspect booking details');
select throws_ok($$select customer_email from public.bookings$$, '42501', null,
  'public cannot read booking snapshots');
select lives_ok($$select court_id, starts_at_minute from public.court_reservations
  where court_id = 'd1000000-0000-4000-8000-000000000011'$$,
  'public occupancy remains limited to interval fields');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select cancellation_notice_minutes from public.list_admin_operational_occupancy(
  array['d1000000-0000-4000-8000-000000000011'::uuid], '2099-10-15') where kind = 'booking'),
  120, 'Admin read returns booking snapshot, not current location policy');
select * from finish();
rollback;
