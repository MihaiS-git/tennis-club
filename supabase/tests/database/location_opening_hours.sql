begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into auth.users (id, email, aud, role) values
('c6000000-0000-4000-8000-000000000001', 'hours-admin@example.test', 'authenticated', 'authenticated'),
('c6000000-0000-4000-8000-000000000002', 'hours-member@example.test', 'authenticated', 'authenticated'),
('c6000000-0000-4000-8000-000000000003', 'hours-coach@example.test', 'authenticated', 'authenticated'),
('c6000000-0000-4000-8000-000000000004', 'hours-suspended@example.test', 'authenticated', 'authenticated');
insert into public.user_roles (user_id, role_code) values
('c6000000-0000-4000-8000-000000000001', 'admin'),
('c6000000-0000-4000-8000-000000000003', 'coach'),
('c6000000-0000-4000-8000-000000000004', 'admin');
update public.users set status = 'suspended' where id = 'c6000000-0000-4000-8000-000000000004';
insert into public.locations (id, name, slug, timezone, is_active) values
('c6000000-0000-4000-8000-000000000011', 'Hours A', 'hours-fixture-a', 'UTC', true),
('c6000000-0000-4000-8000-000000000012', 'Hours B', 'hours-fixture-b', 'Europe/Bucharest', false);

select lives_ok($$insert into public.location_opening_hours (location_id, weekday, opens_at_minute, closes_at_minute)
  values ('c6000000-0000-4000-8000-000000000011', 0, 420, 1440)$$, '07:00–24:00 accepted');
select throws_ok(format('insert into public.location_opening_hours (location_id, weekday, opens_at_minute, closes_at_minute) values (%L, %s, 420, 1440)',
  'c6000000-0000-4000-8000-000000000011', weekday), '23514', null, 'invalid weekday rejected: ' || weekday)
  from unnest(array[-1, 7]) weekday;
select throws_ok(format('insert into public.location_opening_hours (location_id, weekday, opens_at_minute, closes_at_minute) values (%L, 3, %s, %s)',
  'c6000000-0000-4000-8000-000000000011', opens, closes), '23514', null, 'invalid minute bounds rejected')
  from (values (-1, 420), (1440, 1441), (0, 0), (0, 1441)) bounds(opens, closes);
select throws_ok(format('insert into public.location_opening_hours (location_id, weekday, opens_at_minute, closes_at_minute) values (%L, 3, 500, %s)',
  'c6000000-0000-4000-8000-000000000011', closes), '23514', null, 'zero/negative interval rejected')
  from unnest(array[500, 499]) closes;
select throws_ok($$insert into public.location_opening_hours (location_id, weekday, opens_at_minute, closes_at_minute)
  values ('c6000000-0000-4000-8000-000000000011', 0, 500, 600)$$, '23P01', null, 'overlap rejected');
select lives_ok($$insert into public.location_opening_hours (location_id, weekday, opens_at_minute, closes_at_minute)
  values ('c6000000-0000-4000-8000-000000000011', 0, 0, 420)$$, 'adjacent interval accepted');
select lives_ok($$insert into public.location_opening_hours (location_id, weekday, opens_at_minute, closes_at_minute)
  values ('c6000000-0000-4000-8000-000000000011', 1, 420, 1440)$$, 'same interval on different weekday accepted');
select lives_ok($$insert into public.location_opening_hours (location_id, weekday, opens_at_minute, closes_at_minute)
  values ('c6000000-0000-4000-8000-000000000012', 0, 420, 1440)$$, 'same interval at different location accepted');
select throws_ok($$update public.location_opening_hours set opens_at_minute = 419
  where location_id = 'c6000000-0000-4000-8000-000000000011' and weekday = 0 and opens_at_minute = 420$$,
  '23P01', null, 'overlapping edit rejected');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c6000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select count(*) from public.location_opening_hours where location_id in
  ('c6000000-0000-4000-8000-000000000011', 'c6000000-0000-4000-8000-000000000012')), 4::bigint, 'admin reads hours at inactive and active locations');
select lives_ok($$insert into public.location_opening_hours (location_id, weekday, opens_at_minute, closes_at_minute, updated_at)
  values ('c6000000-0000-4000-8000-000000000012', 2, 420, 600, '2000-01-01')$$, 'admin inserts');
select results_eq($$update public.location_opening_hours set closes_at_minute = 700
  where location_id = 'c6000000-0000-4000-8000-000000000012' and weekday = 2 returning closes_at_minute$$,
  array[700], 'admin updates');
select is((select updated_at from public.location_opening_hours where location_id = 'c6000000-0000-4000-8000-000000000012' and weekday = 2),
  '2000-01-01'::timestamptz, 'updated_at remains application-controlled');
select lives_ok($$update public.location_opening_hours set updated_at = '2026-09-29'
  where location_id = 'c6000000-0000-4000-8000-000000000012' and weekday = 2$$, 'admin assigns update timestamp');
select throws_ok($$update public.location_opening_hours set location_id = 'c6000000-0000-4000-8000-000000000011'$$,
  '42501', null, 'parent location is immutable');
select throws_ok($$update public.location_opening_hours set created_at = now()$$, '42501', null, 'creation timestamp immutable');
select results_eq($$delete from public.location_opening_hours where location_id = 'c6000000-0000-4000-8000-000000000012' and weekday = 2 returning weekday$$,
  array[2], 'admin removes');

select is(public.mutate_location_opening_hours(
  'c6000000-0000-4000-8000-000000000011', array[4,5], array[]::uuid[], array[420], array[720])->>'status',
  'ok', 'one weekly call creates both weekdays');
select is((select count(*) from public.location_opening_hours where location_id = 'c6000000-0000-4000-8000-000000000011'
  and weekday in (4,5) and opens_at_minute = 420), 2::bigint, 'both weekday rows persist');
select is(public.mutate_location_opening_hours(
  'c6000000-0000-4000-8000-000000000011', array[1,6], array[]::uuid[], array[480], array[600])->>'status',
  'overlap', 'one conflicting weekday rejects the entire operation');
select is((select count(*) from public.location_opening_hours where location_id = 'c6000000-0000-4000-8000-000000000011'
  and weekday = 6), 0::bigint, 'non-conflicting weekday also rolls back');
select is(public.mutate_location_opening_hours(
  'c6000000-0000-4000-8000-000000000011', array[4,5],
  array(select id from public.location_opening_hours where location_id = 'c6000000-0000-4000-8000-000000000011' and weekday in (4,5)),
  array[480], array[780])->>'status', 'ok', 'grouped edit replaces both weekdays');
select is((select count(*) from public.location_opening_hours where location_id = 'c6000000-0000-4000-8000-000000000011'
  and weekday in (4,5) and opens_at_minute = 480 and closes_at_minute = 780), 2::bigint, 'grouped edit persisted together');
select is(public.mutate_location_opening_hours(
  'c6000000-0000-4000-8000-000000000011', array[4,5],
  array(select id from public.location_opening_hours where location_id = 'c6000000-0000-4000-8000-000000000011' and weekday in (4,5)),
  array[]::integer[], array[]::integer[])->>'status', 'ok', 'grouped remove commits together');
select is((select count(*) from public.location_opening_hours where location_id = 'c6000000-0000-4000-8000-000000000011'
  and weekday in (4,5)), 0::bigint, 'grouped removal cleared both weekdays');

update public.locations set archived_at = now(), is_active = false
  where id = 'c6000000-0000-4000-8000-000000000011';
select ok((select count(*) from public.location_opening_hours
  where location_id = 'c6000000-0000-4000-8000-000000000011') > 0,
  'admin can still read archived location hours');
select throws_ok($$insert into public.location_opening_hours
  (location_id, weekday, opens_at_minute, closes_at_minute)
  values ('c6000000-0000-4000-8000-000000000011', 6, 420, 720)$$,
  '42501', null, 'admin cannot directly insert archived location hours');
select results_eq($$update public.location_opening_hours set closes_at_minute = 1380
  where location_id = 'c6000000-0000-4000-8000-000000000011' returning id$$,
  array[]::uuid[], 'admin cannot directly update archived location hours');
select results_eq($$delete from public.location_opening_hours
  where location_id = 'c6000000-0000-4000-8000-000000000011' returning id$$,
  array[]::uuid[], 'admin cannot directly delete archived location hours');
select is(public.mutate_location_opening_hours(
  'c6000000-0000-4000-8000-000000000011', array[6], array[]::uuid[], array[420], array[720])->>'status',
  'archived', 'archived location rejects weekly mutation');
select is((select count(*) from public.location_opening_hours where location_id = 'c6000000-0000-4000-8000-000000000011'
  and weekday = 6), 0::bigint, 'archived rejection leaves hours unchanged');
update public.locations set archived_at = null
  where id = 'c6000000-0000-4000-8000-000000000011';
select is((select is_active from public.locations where id = 'c6000000-0000-4000-8000-000000000011'),
  false, 'restored location remains inactive');
select is(public.mutate_location_opening_hours(
  'c6000000-0000-4000-8000-000000000011', array[6], array[]::uuid[], array[420], array[720])->>'status',
  'ok', 'restored inactive location accepts weekly mutation');

-- Member, coach and suspended admin share the same denied operations.
reset role;
create function pg_temp.test_denied_hours(subject uuid) returns setof text language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', subject, 'role', 'authenticated')::text, true);
  return next throws_ok('insert into public.location_opening_hours (location_id, weekday, opens_at_minute, closes_at_minute) values (''c6000000-0000-4000-8000-000000000011'', 5, 420, 1440)', '42501', null, 'non-admin insert rejected');
  return next results_eq('update public.location_opening_hours set closes_at_minute = 1439 where location_id = ''c6000000-0000-4000-8000-000000000011'' returning weekday', array[]::integer[], 'non-admin update rejected');
  return next results_eq('delete from public.location_opening_hours where location_id = ''c6000000-0000-4000-8000-000000000011'' returning weekday', array[]::integer[], 'non-admin delete rejected');
  return next is((select count(*) from public.location_opening_hours), 0::bigint, 'non-admin cannot read hours');
  return next throws_ok('select public.mutate_location_opening_hours(''c6000000-0000-4000-8000-000000000011'', array[6], array[]::uuid[], array[420], array[720])',
    '42501', null, 'non-admin weekly mutation rejected');
end;
$$;
grant execute on function pg_temp.test_denied_hours(uuid) to authenticated;
set local role authenticated;
select pg_temp.test_denied_hours(subject) from unnest(array[
  'c6000000-0000-4000-8000-000000000002'::uuid,
  'c6000000-0000-4000-8000-000000000003'::uuid,
  'c6000000-0000-4000-8000-000000000004'::uuid]) subject;
reset role;
set local role anon;
select throws_ok($$insert into public.location_opening_hours (location_id, weekday, opens_at_minute, closes_at_minute)
  values ('c6000000-0000-4000-8000-000000000011', 5, 420, 1440)$$, '42501', null, 'anonymous insert rejected');
select throws_ok($$update public.location_opening_hours set closes_at_minute = 1439$$, '42501', null, 'anonymous update rejected');
select throws_ok($$delete from public.location_opening_hours$$, '42501', null, 'anonymous delete rejected');
reset role;
select * from finish();
rollback;
