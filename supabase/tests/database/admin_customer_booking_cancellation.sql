begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into auth.users (id, email, aud, role) values
  ('ac000000-0000-4000-8000-000000000001', 'booking-cancel-admin@example.test', 'authenticated', 'authenticated'),
  ('ac000000-0000-4000-8000-000000000002', 'booking-cancel-coach@example.test', 'authenticated', 'authenticated'),
  ('ac000000-0000-4000-8000-000000000003', 'booking-cancel-owner@example.test', 'authenticated', 'authenticated'),
  ('ac000000-0000-4000-8000-000000000004', 'booking-cancel-suspended@example.test', 'authenticated', 'authenticated');
insert into public.user_roles (user_id, role_code) values
  ('ac000000-0000-4000-8000-000000000001', 'admin'),
  ('ac000000-0000-4000-8000-000000000002', 'coach'),
  ('ac000000-0000-4000-8000-000000000004', 'admin');
update public.users set status = 'suspended' where id = 'ac000000-0000-4000-8000-000000000004';
insert into public.locations (id, name, slug, timezone, is_public) values
  ('ac000000-0000-4000-8000-000000000010', 'Operations', 'booking-cancel-operations', 'UTC', true);
insert into public.courts (id, location_id, name, slug, surface, environment, is_active) values
  ('ac000000-0000-4000-8000-000000000011', 'ac000000-0000-4000-8000-000000000010',
   'Court 1', 'court-1', 'clay', 'outdoor', true);
insert into public.court_reservations (id, court_id, booking_date, starts_at_minute, ends_at_minute) values
  ('ac000000-0000-4000-8000-000000000020', 'ac000000-0000-4000-8000-000000000011', '2099-10-15', 600, 660),
  ('ac000000-0000-4000-8000-000000000021', 'ac000000-0000-4000-8000-000000000011', '2099-10-15', 660, 720);
insert into public.bookings (payment_method, id, reservation_id, account_user_id, customer_name, customer_email,
  customer_phone, total_amount_minor, currency, cancellation_notice_minutes) values
  ('pay_at_club', 'ac000000-0000-4000-8000-000000000030', 'ac000000-0000-4000-8000-000000000020',
   'ac000000-0000-4000-8000-000000000003', 'Ana Pop', 'ana@example.test', '+40 123', 9000, 'RON', 120),
  ('pay_at_club', 'ac000000-0000-4000-8000-000000000031', 'ac000000-0000-4000-8000-000000000021',
   null, 'Guest', 'guest@example.test', '+40 999', 7000, 'RON', 120);

set local role anon;
select throws_ok($$select public.cancel_admin_customer_booking('ac000000-0000-4000-8000-000000000030')$$,
  '42501', null, 'anonymous cannot cancel booking');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"ac000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$select public.cancel_admin_customer_booking('ac000000-0000-4000-8000-000000000030')$$,
  '42501', null, 'Coach cannot cancel booking');
set local request.jwt.claims = '{"sub":"ac000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$select public.cancel_admin_customer_booking('ac000000-0000-4000-8000-000000000030')$$,
  '42501', null, 'owner cannot invoke Admin cancellation');
set local request.jwt.claims = '{"sub":"ac000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok($$select public.cancel_admin_customer_booking('ac000000-0000-4000-8000-000000000030')$$,
  '42501', null, 'suspended Admin cannot cancel booking');
set local request.jwt.claims = '{"sub":"ac000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(public.cancel_admin_court_reservation('ac000000-0000-4000-8000-000000000020'), false,
  'direct-reservation cancellation still excludes bookings');
select is(public.cancel_admin_customer_booking('ac000000-0000-4000-8000-000000000030'), true,
  'Admin cancels another account booking');
select is(public.cancel_admin_customer_booking('ac000000-0000-4000-8000-000000000030'), false,
  'repeat cancellation is unchanged');
select is(public.cancel_admin_customer_booking('ac000000-0000-4000-8000-000000000099'), false,
  'missing booking is unchanged');
select is((select count(*) from public.list_admin_operational_occupancy(
  array['ac000000-0000-4000-8000-000000000011'::uuid], '2099-10-15')),
  1::bigint, 'cancelled booking leaves live Admin schedule');
select is((select count(*) from public.list_own_upcoming_customer_bookings()), 0::bigint,
  'Admin sees no unrelated upcoming booking');
reset role;

select is((select status::text from public.bookings where id = 'ac000000-0000-4000-8000-000000000030'),
  'cancelled', 'booking status is cancelled');
select is((select status::text from public.court_reservations where id = 'ac000000-0000-4000-8000-000000000020'),
  'cancelled', 'linked reservation status is cancelled');
select ok((select cancelled_at is not null from public.court_reservations where id = 'ac000000-0000-4000-8000-000000000020'),
  'cancellation time is recorded');
select is((select cancelled_by_user_id from public.court_reservations where id = 'ac000000-0000-4000-8000-000000000020'),
  'ac000000-0000-4000-8000-000000000001'::uuid, 'Admin is recorded as canceller');
select is((select customer_name from public.bookings where id = 'ac000000-0000-4000-8000-000000000030'),
  'Ana Pop', 'customer name snapshot remains');
select is((select customer_email from public.bookings where id = 'ac000000-0000-4000-8000-000000000030'),
  'ana@example.test', 'email snapshot remains');
select is((select customer_phone from public.bookings where id = 'ac000000-0000-4000-8000-000000000030'),
  '+40 123', 'phone snapshot remains');
select is((select total_amount_minor from public.bookings where id = 'ac000000-0000-4000-8000-000000000030'),
  9000, 'price snapshot remains');
select is((select currency from public.bookings where id = 'ac000000-0000-4000-8000-000000000030'),
  'RON', 'currency snapshot remains');
select is((select starts_at_minute from public.court_reservations where id = 'ac000000-0000-4000-8000-000000000020'),
  600, 'reservation time remains');
select is((select count(*) from public.bookings where id = 'ac000000-0000-4000-8000-000000000030'),
  1::bigint, 'booking row remains');
select is((select count(*) from public.court_reservations where id = 'ac000000-0000-4000-8000-000000000020'),
  1::bigint, 'reservation row remains');
select is(has_table_privilege('authenticated', 'public.bookings', 'UPDATE'), false,
  'no broad booking UPDATE grant');

-- A failed second write must roll back the earlier booking status change.
create function public.reject_test_reservation_cancel() returns trigger language plpgsql as $$
begin
  if new.id = 'ac000000-0000-4000-8000-000000000021'::uuid and new.status = 'cancelled' then
    raise exception 'test failure' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger reject_test_reservation_cancel before update on public.court_reservations
for each row execute function public.reject_test_reservation_cancel();
set local role authenticated;
set local request.jwt.claims = '{"sub":"ac000000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$select public.cancel_admin_customer_booking('ac000000-0000-4000-8000-000000000031')$$,
  'P0001', null, 'second write failure rolls back the RPC');
reset role;
select is((select status::text from public.bookings where id = 'ac000000-0000-4000-8000-000000000031'),
  'confirmed', 'failed transaction leaves booking confirmed');
select is((select status::text from public.court_reservations where id = 'ac000000-0000-4000-8000-000000000021'),
  'active', 'failed transaction leaves reservation active');
select is((select cancelled_at from public.court_reservations where id = 'ac000000-0000-4000-8000-000000000021'),
  null::timestamptz, 'failed transaction leaves cancellation metadata empty');

select * from finish();
rollback;
