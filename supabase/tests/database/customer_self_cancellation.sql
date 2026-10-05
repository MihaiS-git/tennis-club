begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

-- Freeze only this function's database clock inside this rolled-back test
-- transaction. Production accepts no p_now and always calls clock_timestamp()
-- after locking. This exercises the actual SQL at exact microsecond boundaries.
select ok(position('checked_at := clock_timestamp();' in pg_get_functiondef('public.cancel_own_customer_booking(uuid)'::regprocedure)) > 0,
  'production uses wall-clock time after locks');
do $$begin
  execute replace(pg_get_functiondef('public.cancel_own_customer_booking(uuid)'::regprocedure),
    'clock_timestamp()', 'current_setting(''test.self_cancel_now'')::timestamptz');
end$$;
set local test.self_cancel_now = '2099-10-14T06:59:59Z';
insert into auth.users (id, email, aud, role) values
  ('ce000000-0000-4000-8000-000000000001', 'self-owner@example.test', 'authenticated', 'authenticated'),
  ('ce000000-0000-4000-8000-000000000002', 'self-admin@example.test', 'authenticated', 'authenticated'),
  ('ce000000-0000-4000-8000-000000000003', 'self-coach@example.test', 'authenticated', 'authenticated'),
  ('ce000000-0000-4000-8000-000000000004', 'self-other@example.test', 'authenticated', 'authenticated');
insert into public.user_roles (user_id, role_code) values
  ('ce000000-0000-4000-8000-000000000002', 'admin'), ('ce000000-0000-4000-8000-000000000003', 'coach');
insert into public.locations (id, name, slug, timezone, is_public, customer_cancellation_notice_minutes) values
  ('ce000000-0000-4000-8000-000000000010', 'Self cancellation', 'self-cancel-pgtap', 'Europe/Bucharest', true, 0);
insert into public.courts (id, location_id, name, slug, surface, environment)
select ('ce000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'ce000000-0000-4000-8000-000000000010', 'Court ' || n, 'court-' || n, 'clay', 'outdoor'
from generate_series(101, 113) n;
insert into public.court_reservations (id, court_id, booking_date, starts_at_minute, ends_at_minute)
select ('ce000000-0000-4000-8000-' || lpad((n+100)::text, 12, '0'))::uuid,
  ('ce000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '2099-10-15', 600, 660
from generate_series(101, 113) n;
insert into public.bookings (id, reservation_id, account_user_id, customer_name, customer_email, customer_phone,
  total_amount_minor, currency, cancellation_notice_minutes)
select ('ce000000-0000-4000-8000-' || lpad((n+200)::text, 12, '0'))::uuid,
  ('ce000000-0000-4000-8000-' || lpad((n+100)::text, 12, '0'))::uuid,
  case when n in (104,106) then 'ce000000-0000-4000-8000-000000000002'::uuid
    when n in (105,107) then 'ce000000-0000-4000-8000-000000000003'::uuid
    when n = 109 then null else 'ce000000-0000-4000-8000-000000000001'::uuid end,
  'Stored Owner', 'self-owner@example.test', '123', 9000, 'RON', case when n = 113 then 0 else 1440 end
from generate_series(101, 113) n;

set local role authenticated;
set local request.jwt.claims = '{"sub":"ce000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000301'), 'cancelled', 'ordinary owner before snapshot cutoff succeeds');
set local test.self_cancel_now = '2099-10-14T07:00:00Z';
select is(public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000302'), 'cancelled', 'exact snapshot cutoff succeeds');
set local test.self_cancel_now = '2099-10-14T07:00:00.000001Z';
select is(public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000303'), 'notice_required', 'one microsecond after cutoff fails despite current location zero notice');
select is(public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000301'), 'unavailable', 'repeat does not report success');
select is(public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000309'), 'unavailable', 'matching guest contact gives no ownership');
select is(public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000399'), 'unavailable', 'missing booking is safe');
set local request.jwt.claims = '{"sub":"ce000000-0000-4000-8000-000000000004","role":"authenticated"}';
select is(public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000308'), 'unavailable', 'another ordinary user cannot cancel');
set local test.self_cancel_now = '2099-10-15T06:59:59.999999Z';
set local request.jwt.claims = '{"sub":"ce000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000308'), 'unavailable', 'Admin cannot cancel another owner through self-service');
select is(public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000304'), 'cancelled', 'Admin owner bypasses notice until start');
set local request.jwt.claims = '{"sub":"ce000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is(public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000308'), 'unavailable', 'Coach cannot cancel another owner');
select is(public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000305'), 'cancelled', 'Coach owner bypasses notice until start');
set local test.self_cancel_now = '2099-10-15T07:00:00Z';
select is(public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000307'), 'started', 'Coach is rejected at start');
set local request.jwt.claims = '{"sub":"ce000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000306'), 'started', 'Admin is rejected at start');
set local request.jwt.claims = '{"sub":"ce000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000313'), 'started', 'zero notice cannot cancel at start');
reset role;
select is((select status::text from public.bookings where id = 'ce000000-0000-4000-8000-000000000303'), 'confirmed', 'expired booking stays confirmed');
select is((select status::text from public.court_reservations where id = 'ce000000-0000-4000-8000-000000000203'), 'active', 'expired reservation stays active');
select is((select cancelled_at from public.court_reservations where id = 'ce000000-0000-4000-8000-000000000201'),
  '2099-10-14T06:59:59Z'::timestamptz, 'repeat preserves original timestamp');
select is((select cancelled_by_user_id from public.court_reservations where id = 'ce000000-0000-4000-8000-000000000201'),
  'ce000000-0000-4000-8000-000000000001'::uuid, 'owner recorded as canceller');

-- A failure on the second write must undo the first write.
create function pg_temp.reject_cancellation() returns trigger language plpgsql as $$begin
  if new.id = 'ce000000-0000-4000-8000-000000000212' then
    raise exception 'Test reservation failure' using errcode = '23514';
  end if;
  return new;
end$$;
create trigger test_reject_cancellation before update on public.court_reservations
  for each row execute function pg_temp.reject_cancellation();
set local test.self_cancel_now = '2099-10-14T06:00:00Z';
set local role authenticated;
select throws_ok($$select public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000312')$$,
  '23514', null, 'failure on reservation update rolls back booking update');
reset role;
select is((select status::text from public.bookings where id = 'ce000000-0000-4000-8000-000000000312'), 'confirmed', 'booking update rolled back');
select is((select status::text from public.court_reservations where id = 'ce000000-0000-4000-8000-000000000212'), 'active', 'reservation remains active');
update public.court_reservations set status = 'cancelled', cancelled_at = now(),
  cancelled_by_user_id = 'ce000000-0000-4000-8000-000000000001' where id = 'ce000000-0000-4000-8000-000000000211';
set local role authenticated;
select is(public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000311'), 'unavailable', 'inactive linked reservation rejected');
reset role;
update public.users set status = 'suspended' where id = 'ce000000-0000-4000-8000-000000000001';
set local role authenticated;
select throws_ok($$select public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000310')$$,
  '42501', null, 'suspended owner rejected');
reset role;
set local role anon;
select throws_ok($$select public.cancel_own_customer_booking('ce000000-0000-4000-8000-000000000310')$$,
  '42501', null, 'anonymous caller rejected');
select throws_ok($$select customer_email from public.bookings$$, '42501', null, 'booking SELECT remains private');
select throws_ok($$select cancelled_by_user_id from public.court_reservations$$, '42501', null, 'public occupancy reveals no canceller');
select * from finish();
rollback;
