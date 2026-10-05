begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into public.locations (id, name, slug, timezone, is_public, allow_pay_at_club) values
  ('c9000000-0000-4000-8000-000000000110', 'Booking fixture', 'customer-booking-fixture', 'UTC', true, true);
insert into public.courts (id, location_id, name, slug, surface, environment, is_active) values
  ('c9000000-0000-4000-8000-000000000111', 'c9000000-0000-4000-8000-000000000110',
   'Booking court', 'booking-court', 'clay', 'outdoor', true);
insert into public.court_reservations (id, court_id, booking_date, starts_at_minute, ends_at_minute) values
  ('c9000000-0000-4000-8000-000000000112', 'c9000000-0000-4000-8000-000000000111', '2099-10-15', 600, 660),
  ('c9000000-0000-4000-8000-000000000113', 'c9000000-0000-4000-8000-000000000111', '2099-10-15', 660, 720);
insert into auth.users (id, email, aud, role) values
  ('c9000000-0000-4000-8000-000000000114', 'booking-schema@example.test', 'authenticated', 'authenticated');

select throws_ok($$insert into public.bookings (payment_method, reservation_id, customer_name, customer_email,
  customer_phone, total_amount_minor, currency, cancellation_notice_minutes) values
  ('pay_at_club', 'c9000000-0000-4000-8000-000000000199', 'A', 'a@example.test', '123', 100, 'RON', 120)$$,
  '23503', null, 'booking requires an existing reservation');
select lives_ok($$insert into public.bookings (payment_method, reservation_id, customer_name, customer_email,
  customer_phone, total_amount_minor, currency, cancellation_notice_minutes) values
  ('pay_at_club', 'c9000000-0000-4000-8000-000000000112', 'Guest', 'guest@example.test', '123', 100, 'RON', 120)$$,
  'guest booking permits null account user');
select is((select account_user_id from public.bookings where reservation_id =
  'c9000000-0000-4000-8000-000000000112'), null::uuid, 'guest account link is null');
select lives_ok($$insert into public.bookings (payment_method, reservation_id, account_user_id, customer_name,
  customer_email, customer_phone, total_amount_minor, currency, cancellation_notice_minutes) values
  ('pay_at_club', 'c9000000-0000-4000-8000-000000000113', 'c9000000-0000-4000-8000-000000000114',
   'Member', 'member@example.test', '123', 100, 'RON', 120)$$,
  'authenticated booking can reference an application user');
select throws_ok($$insert into public.bookings (payment_method, reservation_id, customer_name, customer_email,
  customer_phone, total_amount_minor, currency, cancellation_notice_minutes) values
  ('pay_at_club', 'c9000000-0000-4000-8000-000000000112', 'Second', 'a@example.test', '123', 100, 'RON', 120)$$,
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
select throws_ok($$insert into public.bookings (payment_method, reservation_id, customer_name, customer_email,
  customer_phone, total_amount_minor, currency, cancellation_notice_minutes) values
  ('pay_at_club', 'c9000000-0000-4000-8000-000000000113', 'A', 'a@example.test', '123', 100, 'RON', 120)$$,
  '42501', null, 'anonymous browser cannot insert bookings');
select throws_ok($$select * from public.create_customer_booking(
  'c9000000-0000-4000-8000-000000000111', '2099-10-15', 720, 780, null,
  'A', 'a@example.test', '123', 100, 'RON', 'pay_at_club', null, 600)$$,
  '42501', null, 'anonymous browser cannot call booking writer');
select lives_ok($$select court_id, booking_date, starts_at_minute, ends_at_minute
  from public.court_reservations limit 1$$, 'public occupancy remains readable');
select throws_ok($$select reason from public.court_reservations$$, '42501', null,
  'public occupancy does not expose reservation details');

set local role authenticated;
select throws_ok($$select customer_email from public.bookings$$, '42501', null,
  'authenticated browser cannot read booking contacts');
select throws_ok($$insert into public.bookings (payment_method, reservation_id, customer_name, customer_email,
  customer_phone, total_amount_minor, currency, cancellation_notice_minutes) values
  ('pay_at_club', 'c9000000-0000-4000-8000-000000000113', 'A', 'a@example.test', '123', 100, 'RON', 120)$$,
  '42501', null, 'authenticated browser cannot insert bookings');
select throws_ok($$select * from public.create_customer_booking(
  'c9000000-0000-4000-8000-000000000111', '2099-10-15', 720, 780, null,
  'A', 'a@example.test', '123', 100, 'RON', 'pay_at_club', null, 600)$$,
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

reset role;
select is((select customer_cancellation_notice_minutes from public.locations where id =
  'c9000000-0000-4000-8000-000000000110'), 1440, 'new location defaults to 24 hours');
select throws_ok($$update public.locations set customer_cancellation_notice_minutes = -1$$,
  '23514', null, 'negative location notice is rejected');
select throws_ok($$update public.locations set customer_cancellation_notice_minutes = 43201$$,
  '23514', null, 'location notice over 30 days is rejected');
select throws_ok($$update public.locations set customer_cancellation_notice_minutes = null$$,
  '23502', null, 'location notice must be non-null');
select throws_ok($$update public.bookings set cancellation_notice_minutes = -1$$,
  '23514', null, 'negative booking snapshot is rejected');
select throws_ok($$update public.bookings set cancellation_notice_minutes = 43201$$,
  '23514', null, 'booking snapshot over 30 days is rejected');
select throws_ok($$update public.bookings set cancellation_notice_minutes = null$$,
  '23502', null, 'booking snapshot must be non-null');
update public.locations set customer_cancellation_notice_minutes = 0
  where id = 'c9000000-0000-4000-8000-000000000110';
set local role service_role;
select lives_ok($$select * from public.create_customer_booking(
  'c9000000-0000-4000-8000-000000000111', '2099-10-15', 720, 780, null,
  'Policy Guest', 'policy@example.test', '123', 5000, 'EUR', 'pay_at_club', null, 600)$$, 'guest booking snapshots zero notice');
reset role;
select is((select cancellation_notice_minutes from public.bookings where customer_name = 'Policy Guest'),
  0, 'zero notice is copied from the court location');
update public.locations set customer_cancellation_notice_minutes = 2880
  where id = 'c9000000-0000-4000-8000-000000000110';
select is((select cancellation_notice_minutes from public.bookings where customer_name = 'Policy Guest'),
  0, 'changing policy leaves existing booking unchanged');
set local role service_role;
select lives_ok($$select * from public.create_customer_booking(
  'c9000000-0000-4000-8000-000000000111', '2099-10-15', 780, 840,
  'c9000000-0000-4000-8000-000000000114', 'Policy Member', 'member@example.test', '123', 6000, 'EUR', 'pay_at_club', null, 600)$$,
  'authenticated booking snapshots updated notice');
reset role;
select is((select cancellation_notice_minutes from public.bookings where customer_name = 'Policy Member'),
  2880, 'subsequent booking receives new policy');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c9000000-0000-4000-8000-000000000114', true);
select is((select cancellation_notice_minutes from public.list_own_upcoming_customer_bookings()
  where customer_name = 'Member'), 120, 'personal read returns old booking snapshot, not current location policy');
select throws_ok($$select customer_cancellation_notice_minutes from public.locations$$,
  '42501', null, 'authenticated browser cannot read policy column directly');
select throws_ok($$select * from public.list_admin_location_cancellation_policies()$$,
  '42501', null, 'non-Admin cannot read location policies');
with changed as (update public.locations set customer_cancellation_notice_minutes = 60
  where id = 'c9000000-0000-4000-8000-000000000110' returning id) select is(count(*),
  0::bigint, 'non-Admin cannot change location policy') from changed;
reset role;
set local role anon;
select throws_ok($$select customer_cancellation_notice_minutes from public.locations$$,
  '42501', null, 'public cannot read policy configuration');
select throws_ok($$select * from public.list_admin_location_cancellation_policies()$$,
  '42501', null, 'public cannot call Admin policy read');
select * from finish();
rollback;
