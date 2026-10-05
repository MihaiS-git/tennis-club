-- Run against the migration immediately preceding 20261005100000, before db push.
-- psql -v ON_ERROR_STOP=1 -f supabase/tests/migrations/location_customer_cancellation_policy.sql
-- Everything, including the migration, is rolled back; never reset the database.
\set ON_ERROR_STOP on
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select plan(4);
insert into public.locations (id, name, slug, timezone) values
  ('ca000000-0000-4000-8000-000000000001', 'Legacy policy', 'legacy-policy-test', 'UTC');
insert into public.courts (id, location_id, name, slug, surface, environment) values
  ('ca000000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000001',
   'Legacy court', 'legacy', 'clay', 'outdoor');
insert into public.court_reservations (id, court_id, booking_date, starts_at_minute, ends_at_minute) values
  ('ca000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000002', '2099-10-15', 600, 660);
insert into public.bookings (id, reservation_id, customer_name, customer_email, customer_phone, total_amount_minor, currency) values
  ('ca000000-0000-4000-8000-000000000004', 'ca000000-0000-4000-8000-000000000003',
   'Legacy guest', 'legacy@example.test', '123', 5000, 'EUR');
\ir ../../migrations/20261005100000_location_customer_cancellation_policy.sql
select is((select customer_cancellation_notice_minutes from public.locations where id = 'ca000000-0000-4000-8000-000000000001'),
  1440, 'existing location backfills to 24 hours');
select is((select cancellation_notice_minutes from public.bookings where id = 'ca000000-0000-4000-8000-000000000004'),
  1440, 'existing booking backfills to 24 hours');
select col_not_null('public', 'locations', 'customer_cancellation_notice_minutes', 'location policy is non-null');
select col_not_null('public', 'bookings', 'cancellation_notice_minutes', 'booking snapshot is non-null after backfill');
select * from finish();
rollback;
