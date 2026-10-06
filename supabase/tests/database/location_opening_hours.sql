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
select throws_ok($$insert into public.location_opening_hours(location_id,weekday,opens_at_minute,closes_at_minute)
  values('c6000000-0000-4000-8000-000000000011',4,420,720)$$,'42501',null,'Admin browser cannot bypass the application command');
select throws_ok($$update public.location_opening_hours set closes_at_minute=720$$,'42501',null,'Admin browser cannot directly update hours');
select throws_ok($$delete from public.location_opening_hours$$,'42501',null,'Admin browser cannot directly delete hours');
select throws_ok($$select public.commit_location_opening_hours(null,array[0],array[]::uuid[],array[420],array[720],null,0,array[]::uuid[])$$,
  '42501',null,'Admin browser cannot submit authoritative applicability');
reset role;
create function pg_temp.hours_command(days integer[],ids uuid[],opens integer[],closes integer[]) returns jsonb language sql as $$
  select public.commit_location_opening_hours('c6000000-0000-4000-8000-000000000011',days,ids,opens,closes,
    'c6000000-0000-4000-8000-000000000001',(select revision from public.booking_configuration_revision where id),array[]::uuid[]);
$$;
select is(pg_temp.hours_command(array[4,5],array[]::uuid[],array[420],array[720])->>'status','ok','multi-day insert commits atomically');
select is(pg_temp.hours_command(array[1,6],array[]::uuid[],array[480],array[600])->>'status','overlap','one conflicting day rejects every insert');
select is((select count(*) from public.location_opening_hours where location_id='c6000000-0000-4000-8000-000000000011' and weekday=6),0::bigint,
  'non-conflicting day rolls back too');
select is(pg_temp.hours_command(array[4,5],array(select id from public.location_opening_hours where location_id='c6000000-0000-4000-8000-000000000011' and weekday in(4,5)),array[480],array[780])->>'status',
  'ok','multi-day replacement commits together');
select is((select count(*) from public.location_opening_hours where location_id='c6000000-0000-4000-8000-000000000011' and weekday in(4,5) and opens_at_minute=480 and closes_at_minute=780),2::bigint,
  'both replacement rows persist');
select throws_ok($$select public.commit_location_opening_hours('c6000000-0000-4000-8000-000000000011',array[6],array[]::uuid[],array[420],array[720],
  'c6000000-0000-4000-8000-000000000002',(select revision from public.booking_configuration_revision where id),array[]::uuid[])$$,'42501',null,'command requires active Admin actor');
set local role anon;
select throws_ok($$select public.commit_location_opening_hours(null,array[0],array[]::uuid[],array[420],array[720],null,0,array[]::uuid[])$$,
  '42501',null,'anonymous cannot execute hours persistence');
reset role;
select * from finish();
rollback;
