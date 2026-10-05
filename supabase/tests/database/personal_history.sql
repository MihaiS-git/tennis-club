begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into auth.users (id, email, aud, role) values
  ('cb000000-0000-4000-8000-000000000001', 'history-owner@example.test', 'authenticated', 'authenticated'),
  ('cb000000-0000-4000-8000-000000000002', 'history-other@example.test', 'authenticated', 'authenticated'),
  ('cb000000-0000-4000-8000-000000000003', 'history-admin@example.test', 'authenticated', 'authenticated');
insert into public.user_roles (user_id, role_code) values
  ('cb000000-0000-4000-8000-000000000003', 'admin');
insert into public.locations (id, name, slug, timezone) values
  ('cb000000-0000-4000-8000-000000000010', 'History location', 'history-location', 'Pacific/Kiritimati');
insert into public.courts (id, location_id, name, slug, surface, environment) values
  ('cb000000-0000-4000-8000-000000000011', 'cb000000-0000-4000-8000-000000000010', 'Court 1', 'court-1', 'clay', 'outdoor'),
  ('cb000000-0000-4000-8000-000000000012', 'cb000000-0000-4000-8000-000000000010', 'Court 2', 'court-2', 'clay', 'outdoor'),
  ('cb000000-0000-4000-8000-000000000013', 'cb000000-0000-4000-8000-000000000010', 'Court 3', 'court-3', 'clay', 'outdoor'),
  ('cb000000-0000-4000-8000-000000000014', 'cb000000-0000-4000-8000-000000000010', 'Court 4', 'court-4', 'clay', 'outdoor');
insert into public.court_reservations (id, court_id, booking_date, starts_at_minute, ends_at_minute, created_by_user_id) values
  ('cb000000-0000-4000-8000-000000000021', 'cb000000-0000-4000-8000-000000000011', '2026-10-04', 0, 60, null),
  ('cb000000-0000-4000-8000-000000000022', 'cb000000-0000-4000-8000-000000000012', '2026-10-04', 0, 60, null),
  ('cb000000-0000-4000-8000-000000000023', 'cb000000-0000-4000-8000-000000000013', '2026-10-04', 0, 60, null),
  ('cb000000-0000-4000-8000-000000000024', 'cb000000-0000-4000-8000-000000000014', '2026-10-04', 0, 60,
   'cb000000-0000-4000-8000-000000000003');
insert into public.bookings (id, reservation_id, account_user_id, customer_name, customer_email, customer_phone, total_amount_minor, currency, cancellation_notice_minutes) values
  ('cb000000-0000-4000-8000-000000000031', 'cb000000-0000-4000-8000-000000000021', 'cb000000-0000-4000-8000-000000000001', 'Owner', 'owner@example.test', '123', 9000, 'RON', 120),
  ('cb000000-0000-4000-8000-000000000032', 'cb000000-0000-4000-8000-000000000022', 'cb000000-0000-4000-8000-000000000002', 'Other', 'other@example.test', '123', 9000, 'RON', 120),
  ('cb000000-0000-4000-8000-000000000033', 'cb000000-0000-4000-8000-000000000023', null, 'Guest', 'owner@example.test', '123', 9000, 'RON', 120);

set local role anon;
select throws_ok($$select * from public.list_own_court_activity_history(1, '2026-10-03T11:30:00Z')$$,
  '42501', null, 'anonymous users cannot read history');
set local role authenticated;
set local request.jwt.claims = '{"sub":"cb000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select count(*) from public.list_own_court_activity_history(1, '2026-10-03T11:30:00Z')),
  1::bigint, 'member sees only own elapsed booking at location-local time');
select is((select customer_email from public.list_own_court_activity_history(1, '2026-10-03T11:30:00Z')),
  'owner@example.test'::text, 'history contact is stored booking snapshot');
select throws_ok($$select customer_email from public.bookings$$, '42501', null,
  'history RPC does not grant direct booking access');
set local request.jwt.claims = '{"sub":"cb000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is((select count(*) from public.list_own_court_activity_history(1, '2026-10-03T11:30:00Z')),
  1::bigint, 'admin sees own reservation and no other activity');
select is((select kind from public.list_own_court_activity_history(1, '2026-10-03T11:30:00Z')),
  'reservation'::text, 'admin personal archive keeps direct reservation ownership');
select throws_ok($$select * from public.list_own_court_activity_history(0, '2026-10-03T11:30:00Z')$$,
  '22023', null, 'invalid page is rejected');

select * from finish();
rollback;
