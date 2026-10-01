begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into auth.users (id, email, aud, role) values
('c8000000-0000-4000-8000-000000000001', 'hours-pricing-admin@example.test', 'authenticated', 'authenticated');
insert into public.user_roles (user_id, role_code) values
('c8000000-0000-4000-8000-000000000001', 'admin');
insert into public.locations (id, name, slug, timezone) values
('c8000000-0000-4000-8000-000000000011', 'Hours pricing fixture', 'hours-pricing-fixture', 'UTC');
insert into public.courts (id, location_id, name, slug, surface, environment) values
('c8000000-0000-4000-8000-000000000031', 'c8000000-0000-4000-8000-000000000011', 'Court 1', 'court-1', 'clay', 'outdoor'),
('c8000000-0000-4000-8000-000000000032', 'c8000000-0000-4000-8000-000000000011', 'Court 2', 'court-2', 'clay', 'outdoor');
insert into public.location_opening_hours (location_id, weekday, opens_at_minute, closes_at_minute)
select 'c8000000-0000-4000-8000-000000000011', day, 420, case when day = 4 then 1440 else 1320 end
from generate_series(0, 6) day;

set local role authenticated;
set local request.jwt.claims = '{"sub":"c8000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$select public.save_pricing_rule_set(null, 'c8000000-0000-4000-8000-000000000011',
  array['c8000000-0000-4000-8000-000000000031','c8000000-0000-4000-8000-000000000032']::uuid[],
  array[0,1], 'outdoor', 1080, 1260, null, null, 1200, now())$$,
  'one logical rule covers two courts and weekdays');
select lives_ok($$select public.save_pricing_rule_set(null, 'c8000000-0000-4000-8000-000000000011',
  array['c8000000-0000-4000-8000-000000000031']::uuid[], array[4],
  'outdoor', 1260, 1440, null, null, 1200, now())$$,
  '24:00 pricing fits a 24:00 closing boundary');

-- Force this deferred integrity trigger at the end of each test operation while
-- retaining one transaction for the complete RPC replacement.
create function pg_temp.apply_hours(days integer[], replace_ids uuid[], opens integer[], closes integer[])
returns text language plpgsql as $$
declare outcome jsonb;
begin
  outcome := public.mutate_location_opening_hours(
    'c8000000-0000-4000-8000-000000000011', days, replace_ids, opens, closes);
  set constraints check_hours_cover_pricing immediate;
  set constraints check_hours_cover_pricing deferred;
  return outcome->>'status';
end;
$$;
grant execute on function pg_temp.apply_hours(integer[], uuid[], integer[], integer[]) to authenticated;

select is(pg_temp.apply_hours(array[0], array(select id from public.location_opening_hours where weekday = 0), array[420], array[1260]),
  'ok', 'hours can end exactly when applicable pricing ends');
select throws_ok($$select pg_temp.apply_hours(array[0],
  array(select id from public.location_opening_hours where weekday = 0), array[420], array[1200])$$,
  'P0001', 'opening_hours_pricing_conflict', 'shortening past pricing is rejected');
select is((select closes_at_minute from public.location_opening_hours where weekday = 0), 1260,
  'rejected shortening leaves the prior schedule');
select throws_ok($$select pg_temp.apply_hours(array[0],
  array(select id from public.location_opening_hours where weekday = 0), array[420,1200], array[1140,1320])$$,
  'P0001', 'opening_hours_pricing_conflict', 'split gap crossing pricing is rejected');
select throws_ok($$select pg_temp.apply_hours(array[0],
  array(select id from public.location_opening_hours where weekday = 0), array[]::integer[], array[]::integer[])$$,
  'P0001', 'opening_hours_pricing_conflict', 'closing a priced weekday is rejected');
select is(pg_temp.apply_hours(array[2], array(select id from public.location_opening_hours where weekday = 2), array[480], array[1200]),
  'ok', 'an unrelated weekday can change');
select throws_ok($$select pg_temp.apply_hours(array[1],
  array(select id from public.location_opening_hours where weekday = 1), array[420], array[1200])$$,
  'P0001', 'opening_hours_pricing_conflict', 'another selected day of the logical rule remains protected');
select throws_ok($$select pg_temp.apply_hours(array[4],
  array(select id from public.location_opening_hours where weekday = 4), array[420], array[1439])$$,
  'P0001', 'opening_hours_pricing_conflict', '24:00 boundary remains protected');

select lives_ok(format($sql$select public.save_pricing_rule_set(null, 'c8000000-0000-4000-8000-000000000011',
  array['c8000000-0000-4000-8000-000000000032']::uuid[], array[3], 'outdoor', 480, 600,
  %L::date, %L::date, 1200, now())$sql$, current_date - 30, current_date - 1),
  'a historical rule may remain stored');
select is(pg_temp.apply_hours(array[3], array(select id from public.location_opening_hours where weekday = 3),
  array[]::integer[], array[]::integer[]), 'ok', 'expired pricing does not block closing its day');
select throws_ok($$insert into public.location_pricing_rules
  (rule_set_id, location_id, court_id, court_state, weekday, starts_at_minute, ends_at_minute, price_per_hour_minor)
  values ('c8000000-0000-4000-8000-000000000099', 'c8000000-0000-4000-8000-000000000011',
    'c8000000-0000-4000-8000-000000000031', 'outdoor', 3, 480, 600, 1200)$$,
  'P0001', 'pricing_outside_opening_hours', 'direct pricing writes cannot bypass current hours');
select * from finish();
rollback;
