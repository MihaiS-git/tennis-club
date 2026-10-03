begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into public.locations (id, name, slug, timezone) values
  ('c8000000-0000-4000-8000-000000000010', 'Reservation fixture', 'reservation-fixture', 'UTC');
insert into public.courts (id, location_id, name, slug, surface, environment) values
  ('c8000000-0000-4000-8000-000000000011', 'c8000000-0000-4000-8000-000000000010', 'Court A', 'court-a', 'clay', 'outdoor'),
  ('c8000000-0000-4000-8000-000000000012', 'c8000000-0000-4000-8000-000000000010', 'Court B', 'court-b', 'hard', 'indoor');
insert into auth.users (id, email, aud, role) values
  ('c8000000-0000-4000-8000-000000000001', 'reservation-lifecycle@example.test', 'authenticated', 'authenticated');

select lives_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-15', 1080, 1140)$$,
  'valid 60-minute reservation accepted');
select is((select status::text from public.court_reservations where court_id =
  'c8000000-0000-4000-8000-000000000011' and booking_date = '2026-10-15'),
  'active', 'new reservation defaults to active');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-15', 1110, 1170)$$,
  '23P01', null, 'overlapping reservation on the same court and date rejected');
select lives_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-15', 1140, 1200)$$,
  'adjacent reservation accepted');
select lives_ok($$update public.court_reservations set status = 'cancelled',
  cancelled_at = now(), cancelled_by_user_id = 'c8000000-0000-4000-8000-000000000001'
  where court_id = 'c8000000-0000-4000-8000-000000000011' and booking_date = '2026-10-15'
    and starts_at_minute = 1080$$, 'cancelled row stores lifecycle metadata');
select lives_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-15', 1080, 1140)$$,
  'cancelled interval accepts a new active reservation');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute,
  cancelled_at, cancelled_by_user_id)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-23', 1080, 1140,
    now(), 'c8000000-0000-4000-8000-000000000001')$$,
  '23514', null, 'active row cannot contain cancellation metadata');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute, status)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-24', 1080, 1140, 'cancelled')$$,
  '23514', null, 'cancelled row requires cancellation metadata');
select lives_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000012', '2026-10-15', 1080, 1140)$$,
  'same interval on another court accepted');
select lives_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-16', 1080, 1170)$$,
  'valid 90-minute reservation on another date accepted');
select lives_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-17', 1320, 1440)$$,
  'valid 120-minute reservation ending at 24:00 accepted');
select lives_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute, reason)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-19', 480, 630, 'Course with Andrej')$$,
  'valid 150-minute reservation accepted');
select is((select reason from public.court_reservations
  where court_id = 'c8000000-0000-4000-8000-000000000011' and booking_date = '2026-10-19'),
  'Course with Andrej', 'reservation reason persists');
select lives_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-20', 480, 780)$$,
  'valid several-hour reservation accepted');
select lives_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-22', 0, 1440)$$,
  'full local day accepted without a fixed duration cap');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-18', 1085, 1170)$$,
  '23514', null, 'non-30-minute start rejected');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-18', 1080, 1175)$$,
  '23514', null, 'non-30-minute end rejected');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-18', 1080, 1110)$$,
  '23514', null, '30-minute reservation rejected');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-18', 1080, 1080)$$,
  '23514', null, 'zero-minute reservation rejected');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-18', 1080, 1050)$$,
  '23514', null, 'negative-duration reservation rejected');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-18', 1410, 1470)$$,
  '23514', null, 'minute beyond 24:00 rejected');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute, reason)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-21', 1080, 1140, '   ')$$,
  '23514', null, 'blank reservation reason rejected');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute, reason)
  values ('c8000000-0000-4000-8000-000000000011', '2026-10-21', 1080, 1140, repeat('a', 256))$$,
  '23514', null, 'reason longer than 255 characters rejected');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute)
  values ('c8000000-0000-4000-8000-000000000099', '2026-10-18', 1080, 1140)$$,
  '23503', null, 'reservation requires an existing court');
select throws_ok($$update public.court_reservations set starts_at_minute = 1110
  where court_id = 'c8000000-0000-4000-8000-000000000011' and booking_date = '2026-10-15' and starts_at_minute = 1140$$,
  '23P01', null, 'overlapping edit rejected');
select is(has_table_privilege('anon', 'public.court_reservations', 'INSERT'), false, 'anonymous insert privilege absent');
select is(has_column_privilege('authenticated', 'public.court_reservations', 'reason', 'INSERT'), true, 'authenticated column insert grant exists for RLS-authorized staff');

select * from finish();
rollback;
