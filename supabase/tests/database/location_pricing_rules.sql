begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into auth.users (id, email, aud, role) values
('c7000000-0000-4000-8000-000000000001', 'pricing-admin@example.test', 'authenticated', 'authenticated'),
('c7000000-0000-4000-8000-000000000002', 'pricing-member@example.test', 'authenticated', 'authenticated');
insert into public.user_roles (user_id, role_code) values ('c7000000-0000-4000-8000-000000000001', 'admin');
insert into public.locations (id, name, slug, timezone) values
('c7000000-0000-4000-8000-000000000011', 'Pricing A', 'pricing-fixture-a', 'UTC');
insert into public.courts (id, location_id, name, slug, surface, environment) values
('c7000000-0000-4000-8000-000000000031', 'c7000000-0000-4000-8000-000000000011', 'Court 1', 'court-1', 'clay', 'outdoor'),
('c7000000-0000-4000-8000-000000000032', 'c7000000-0000-4000-8000-000000000011', 'Court 2', 'court-2', 'hard', 'outdoor'),
('c7000000-0000-4000-8000-000000000033', 'c7000000-0000-4000-8000-000000000011', 'Court 3', 'court-3', 'hard', 'indoor');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c7000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select public.save_pricing_rule_set(null, 'c7000000-0000-4000-8000-000000000011',
 array['c7000000-0000-4000-8000-000000000031','c7000000-0000-4000-8000-000000000032']::uuid[],
 array[0,1,2,3,4], 'outdoor', 420, 960, null, null, 1200, now())) is not null, true, 'create accepted');
select is((select count(*) from public.location_pricing_rules where location_id='c7000000-0000-4000-8000-000000000011'), 10::bigint, 'two courts x five days creates ten rows');
select is((select count(distinct rule_set_id) from public.location_pricing_rules where location_id='c7000000-0000-4000-8000-000000000011'), 1::bigint, 'all rows share one identity');
select lives_ok($$select public.save_pricing_rule_set(null, 'c7000000-0000-4000-8000-000000000011',
 array['c7000000-0000-4000-8000-000000000031']::uuid[], array[0], 'outdoor', 960, 1200, null, null, 1300, now())$$,
 'adjacent 16:00 interval accepted');
select lives_ok($$select public.save_pricing_rule_set(null, 'c7000000-0000-4000-8000-000000000011',
 array['c7000000-0000-4000-8000-000000000032']::uuid[], array[5], 'outdoor', 420, 960, null, null, 1300, now())$$,
 'independent court schedule accepted');
select throws_ok($$select public.save_pricing_rule_set(null, 'c7000000-0000-4000-8000-000000000011',
 array['c7000000-0000-4000-8000-000000000031']::uuid[], array[0], 'outdoor', 959, 1200, null, null, 1300, now())$$,
 '23P01', null, 'overlap on same court/state/day rejected');
select throws_ok($$select public.save_pricing_rule_set(null, 'c7000000-0000-4000-8000-000000000011',
 array['c7000000-0000-4000-8000-000000000033']::uuid[], array[6], 'outdoor', 420, 960, null, null, 1300, now())$$,
 '23503', null, 'indoor court cannot use outdoor state');
select is((select count(*) from public.location_pricing_rules where location_id='c7000000-0000-4000-8000-000000000011'), 12::bigint, 'failed writes leave no rows');
select is((select public.save_pricing_rule_set(rule_set_id, 'c7000000-0000-4000-8000-000000000011',
 array['c7000000-0000-4000-8000-000000000031']::uuid[], array[0,1,2,3],
 'outdoor', 420, 960, null, null, 1400, now()) is not null
 from public.location_pricing_rules where weekday=4 and location_id='c7000000-0000-4000-8000-000000000011' limit 1), true, 'replace entire rule set');
select is((select count(*) from public.location_pricing_rules where price_per_hour_minor=1400 and location_id='c7000000-0000-4000-8000-000000000011'), 4::bigint, 'replacement removed old applicability');
select is((select count(*) from public.location_pricing_rules where location_id='c7000000-0000-4000-8000-000000000011'), 6::bigint, 'other sets remain');
select throws_ok($$select public.save_pricing_rule_set((select rule_set_id from public.location_pricing_rules where price_per_hour_minor=1400 and location_id='c7000000-0000-4000-8000-000000000011' limit 1),
 'c7000000-0000-4000-8000-000000000011', array['c7000000-0000-4000-8000-000000000031']::uuid[],
 array[0,1,2,3], 'outdoor', 420, 1200, null, null, 1500, now())$$,
 '23P01', null, 'conflicting replacement rolls back');
select is((select count(*) from public.location_pricing_rules where price_per_hour_minor=1400 and location_id='c7000000-0000-4000-8000-000000000011'), 4::bigint, 'old rows survive rejected replacement');
select is((select public.remove_pricing_rule_set(rule_set_id, 'c7000000-0000-4000-8000-000000000011') is not null
 from public.location_pricing_rules where price_per_hour_minor=1400 and location_id='c7000000-0000-4000-8000-000000000011' limit 1), true, 'delete logical set');
select is((select count(*) from public.location_pricing_rules where price_per_hour_minor=1400 and location_id='c7000000-0000-4000-8000-000000000011'), 0::bigint, 'all its atomic rows removed');
select lives_ok($$select public.save_pricing_rule_set(null, 'c7000000-0000-4000-8000-000000000011',
 array['c7000000-0000-4000-8000-000000000033']::uuid[], array[6], 'indoor', 420, 960,
 '2026-10-15', '2027-04-15', 1500, now())$$, 'indoor court accepts indoor state');
select lives_ok($$select public.save_pricing_rule_set(null, 'c7000000-0000-4000-8000-000000000011',
 array['c7000000-0000-4000-8000-000000000033']::uuid[], array[6], 'indoor', 420, 960,
 '2027-04-16', null, 1500, now())$$, 'day after inclusive end is disjoint');
select throws_ok($$select public.save_pricing_rule_set(null, 'c7000000-0000-4000-8000-000000000011',
 array['c7000000-0000-4000-8000-000000000033']::uuid[], array[6], 'indoor', 420, 960,
 '2027-04-15', '2027-04-20', 1500, now())$$,
 '23P01', null, 'shared inclusive date overlaps');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"c7000000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$select public.save_pricing_rule_set(null, 'c7000000-0000-4000-8000-000000000011',
 array['c7000000-0000-4000-8000-000000000031']::uuid[], array[6], 'outdoor', 420, 960, null, null, 1200, now())$$,
 '42501', null, 'member RPC denied');
select is((select count(*) from public.location_pricing_rules where location_id='c7000000-0000-4000-8000-000000000011'), 0::bigint, 'member sees no pricing');
reset role;
set local role anon;
select throws_ok('select * from public.location_pricing_rules', '42501', null, 'anonymous read denied');
select throws_ok($$select public.save_pricing_rule_set(null, 'c7000000-0000-4000-8000-000000000011',
 array['c7000000-0000-4000-8000-000000000031']::uuid[], array[6], 'outdoor', 420, 960, null, null, 1200, now())$$,
 '42501', null, 'anonymous RPC denied');
select * from finish();
rollback;
