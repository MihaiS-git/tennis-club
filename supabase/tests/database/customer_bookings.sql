begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into public.locations (id, name, slug, timezone, is_public) values
  ('c9000000-0000-4000-8000-000000000110', 'Booking fixture', 'customer-booking-fixture', 'UTC', true);
insert into public.courts (id, location_id, name, slug, surface, environment, is_active) values
  ('c9000000-0000-4000-8000-000000000111', 'c9000000-0000-4000-8000-000000000110',
   'Booking court', 'booking-court', 'clay', 'outdoor', true);
insert into public.court_reservations (id, court_id, booking_date, starts_at_minute, ends_at_minute) values
  ('c9000000-0000-4000-8000-000000000112', 'c9000000-0000-4000-8000-000000000111', '2099-10-15', 600, 660),
  ('c9000000-0000-4000-8000-000000000113', 'c9000000-0000-4000-8000-000000000111', '2099-10-15', 660, 720);
insert into auth.users (id, email, aud, role) values
  ('c9000000-0000-4000-8000-000000000114', 'booking-schema@example.test', 'authenticated', 'authenticated');

select throws_ok($$insert into public.bookings (reservation_id, customer_name, customer_email,
  customer_phone, total_amount_minor, currency) values
  ('c9000000-0000-4000-8000-000000000199', 'A', 'a@example.test', '123', 100, 'RON')$$,
  '23503', null, 'booking requires an existing reservation');
select lives_ok($$insert into public.bookings (reservation_id, customer_name, customer_email,
  customer_phone, total_amount_minor, currency) values
  ('c9000000-0000-4000-8000-000000000112', 'Guest', 'guest@example.test', '123', 100, 'RON')$$,
  'guest booking permits null account user');
select is((select account_user_id from public.bookings where reservation_id =
  'c9000000-0000-4000-8000-000000000112'), null::uuid, 'guest account link is null');
select lives_ok($$insert into public.bookings (reservation_id, account_user_id, customer_name,
  customer_email, customer_phone, total_amount_minor, currency) values
  ('c9000000-0000-4000-8000-000000000113', 'c9000000-0000-4000-8000-000000000114',
   'Member', 'member@example.test', '123', 100, 'RON')$$,
  'authenticated booking can reference an application user');
select throws_ok($$insert into public.bookings (reservation_id, customer_name, customer_email,
  customer_phone, total_amount_minor, currency) values
  ('c9000000-0000-4000-8000-000000000112', 'Second', 'a@example.test', '123', 100, 'RON')$$,
  '23505', null, 'one reservation cannot belong to two bookings');
select throws_ok($$update public.bookings set customer_name = '  ' where reservation_id =
  'c9000000-0000-4000-8000-000000000112'$$, '23514', null, 'name cannot be blank');
select throws_ok($$update public.bookings set customer_email = '  ' where reservation_id =
  'c9000000-0000-4000-8000-000000000112'$$, '23514', null, 'email cannot be blank');
select throws_ok($$update public.bookings set customer_phone = '  ' where reservation_id =
  'c9000000-0000-4000-8000-000000000112'$$, '23514', null, 'phone cannot be blank');
select throws_ok($$update public.bookings set status = 'held' where reservation_id =
  'c9000000-0000-4000-8000-000000000112'$$, '22P02', null, 'unsupported status is rejected');
select throws_ok($$update public.bookings set total_amount_minor = 0 where reservation_id =
  'c9000000-0000-4000-8000-000000000112'$$, '23514', null, 'nonpositive amount is rejected');
select throws_ok($$update public.bookings set currency = 'XYZ' where reservation_id =
  'c9000000-0000-4000-8000-000000000112'$$, '23514', null, 'unsupported currency is rejected');

set local role anon;
select throws_ok($$select * from public.list_own_upcoming_customer_bookings()$$, '42501', null,
  'anonymous users cannot read personal booking snapshots');
select throws_ok($$select customer_name from public.bookings$$, '42501', null,
  'anonymous users cannot read customer contact');
select throws_ok($$insert into public.bookings (reservation_id, customer_name, customer_email,
  customer_phone, total_amount_minor, currency) values
  ('c9000000-0000-4000-8000-000000000113', 'A', 'a@example.test', '123', 100, 'RON')$$,
  '42501', null, 'anonymous browser cannot insert bookings');
select throws_ok($$select * from public.create_customer_booking(
  'c9000000-0000-4000-8000-000000000111', '2099-10-15', 720, 780, null,
  'A', 'a@example.test', '123', 100, 'RON')$$,
  '42501', null, 'anonymous browser cannot call booking writer');
select lives_ok($$select court_id, booking_date, starts_at_minute, ends_at_minute
  from public.court_reservations limit 1$$, 'public occupancy remains readable');
select throws_ok($$select reason from public.court_reservations$$, '42501', null,
  'public occupancy does not expose reservation details');

set local role authenticated;
select throws_ok($$select customer_email from public.bookings$$, '42501', null,
  'authenticated browser cannot read booking contacts');
select throws_ok($$insert into public.bookings (reservation_id, customer_name, customer_email,
  customer_phone, total_amount_minor, currency) values
  ('c9000000-0000-4000-8000-000000000113', 'A', 'a@example.test', '123', 100, 'RON')$$,
  '42501', null, 'authenticated browser cannot insert bookings');
select throws_ok($$select * from public.create_customer_booking(
  'c9000000-0000-4000-8000-000000000111', '2099-10-15', 720, 780, null,
  'A', 'a@example.test', '123', 100, 'RON')$$,
  '42501', null, 'authenticated browser cannot call booking writer');

select set_config('request.jwt.claim.sub', 'c9000000-0000-4000-8000-000000000114', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select is((select count(*) from public.list_own_upcoming_customer_bookings()), 1::bigint,
  'owner can read the linked future booking through the narrow function');
select is((select customer_name from public.list_own_upcoming_customer_bookings()), 'Member'::text,
  'personal read returns the stored contact snapshot');
select throws_ok($$select customer_email from public.bookings$$, '42501', null,
  'owner function does not grant direct booking table reads');
select set_config('request.jwt.claim.sub', 'c9000000-0000-4000-8000-000000000199', true);
select throws_ok($$select * from public.list_own_upcoming_customer_bookings()$$, '42501', null,
  'account without an active public user cannot inspect bookings');

select * from finish();
rollback;
