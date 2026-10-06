begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into public.locations (id, name, slug, timezone, is_public) values
  ('c9000000-0000-4000-8000-000000000010', 'Public reservation fixture', 'public-reservation-fixture', 'UTC', true);
insert into public.courts (id, location_id, name, slug, surface, environment, is_active) values
  ('c9000000-0000-4000-8000-000000000011', 'c9000000-0000-4000-8000-000000000010', 'Active', 'active', 'clay', 'outdoor', true),
  ('c9000000-0000-4000-8000-000000000012', 'c9000000-0000-4000-8000-000000000010', 'Inactive', 'inactive', 'clay', 'outdoor', false);
insert into auth.users (id, email, aud, role) values
  ('c9000000-0000-4000-8000-000000000001', 'public-occupancy@example.test', 'authenticated', 'authenticated');
insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute, reason) values
  ('c9000000-0000-4000-8000-000000000011', '2026-10-15', 1080, 1140, 'Court maintenance'),
  ('c9000000-0000-4000-8000-000000000012', '2026-10-15', 1080, 1140, 'Club event');
insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute,
  reason, status, cancelled_at, cancelled_by_user_id) values
  ('c9000000-0000-4000-8000-000000000011', '2026-10-15', 1140, 1200,
    'Cancelled club event', 'cancelled', now(), 'c9000000-0000-4000-8000-000000000001');

set local role anon;
select is((select count(court_id) from public.court_reservations where court_id in
  ('c9000000-0000-4000-8000-000000000011', 'c9000000-0000-4000-8000-000000000012')),
  1::bigint, 'anonymous availability includes only active reservations at active courts');
select lives_ok($$select court_id, booking_date, starts_at_minute, ends_at_minute
  from public.court_reservations limit 1$$, 'only availability columns are readable');
select throws_ok($$select id from public.court_reservations$$,
  '42501', null, 'reservation identity is not public');
select throws_ok($$select reason from public.court_reservations$$,
  '42501', null, 'reservation reason is not public');
select throws_ok($$select created_by_user_id from public.court_reservations$$,
  '42501', null, 'reservation creator is not public');
select throws_ok($$select status, cancelled_at, cancelled_by_user_id from public.court_reservations$$,
  '42501', null, 'cancellation metadata is not public');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c9000000-0000-4000-8000-000000000011', '2026-10-16', 1080, 1140)$$,
  '42501', null, 'anonymous insert remains denied');
reset role;
set local role authenticated;
select is((select count(court_id) from public.court_reservations where court_id in
  ('c9000000-0000-4000-8000-000000000011', 'c9000000-0000-4000-8000-000000000012')),
  1::bigint, 'authenticated availability omits cancelled reservations');
select throws_ok($$select created_at from public.court_reservations$$,
  '42501', null, 'reservation timestamps remain private');
select throws_ok($$select updated_at from public.court_reservations$$,
  '42501', null, 'edit concurrency token remains private');
select throws_ok($$select reason from public.court_reservations$$,
  '42501', null, 'reservation reason remains private for authenticated users');
select throws_ok($$select created_by_user_id from public.court_reservations$$,
  '42501', null, 'reservation creator remains private for authenticated users');
select throws_ok($$select status, cancelled_at, cancelled_by_user_id from public.court_reservations$$,
  '42501', null, 'cancellation metadata remains private for authenticated users');

select * from finish();
rollback;
