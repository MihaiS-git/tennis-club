begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();
insert into auth.users (id, email, aud, role) values
('c6000000-0000-4000-8000-000000000001', 'coverage-admin@example.test', 'authenticated', 'authenticated'),
('c6000000-0000-4000-8000-000000000002', 'coverage-member@example.test', 'authenticated', 'authenticated'),
('c6000000-0000-4000-8000-000000000003', 'coverage-suspended@example.test', 'authenticated', 'authenticated'),
('c6000000-0000-4000-8000-000000000004', 'coverage-coach@example.test', 'authenticated', 'authenticated');
insert into public.user_roles (user_id, role_code) values
('c6000000-0000-4000-8000-000000000001', 'admin'),
('c6000000-0000-4000-8000-000000000003', 'admin'),
('c6000000-0000-4000-8000-000000000004', 'coach');
update public.users set status = 'suspended' where id = 'c6000000-0000-4000-8000-000000000003';
insert into public.locations (id, name, slug, timezone) values
('c6000000-0000-4000-8000-000000000010', 'Coverage fixture', 'coverage-fixture', 'UTC');
insert into public.courts (id, location_id, name, slug, surface, environment) values
('c6000000-0000-4000-8000-000000000011', 'c6000000-0000-4000-8000-000000000010', 'Outdoor', 'outdoor', 'clay', 'outdoor'),
('c6000000-0000-4000-8000-000000000012', 'c6000000-0000-4000-8000-000000000010', 'Other', 'other', 'clay', 'outdoor'),
('c6000000-0000-4000-8000-000000000013', 'c6000000-0000-4000-8000-000000000010', 'Indoor', 'indoor', 'hard', 'indoor');
set local role authenticated;
set local request.jwt.claims = '{"sub":"c6000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$insert into public.court_coverage_periods (court_id, starts_on, ends_on, updated_at)
values ('c6000000-0000-4000-8000-000000000011', '2026-10-15', '2027-04-15', '2000-01-01')$$, 'outdoor coverage accepted for active admin');
select throws_ok($$insert into public.court_coverage_periods (court_id, starts_on, ends_on)
values ('c6000000-0000-4000-8000-000000000011', '2027-04-16', '2027-04-15')$$, '23514', null, 'reversed dates rejected');
select throws_ok($$insert into public.court_coverage_periods (court_id, starts_on, ends_on)
values ('c6000000-0000-4000-8000-000000000013', '2026-10-15', '2027-04-15')$$, '23503', null, 'indoor coverage rejected');
select throws_ok($$update public.courts set environment = 'indoor'
where id = 'c6000000-0000-4000-8000-000000000011'$$, '23503', null, 'court with periods cannot become indoor');
select throws_ok($$insert into public.court_coverage_periods (court_id, starts_on, ends_on) values ('c6000000-0000-4000-8000-000000000011', '2026-10-14', '2026-10-15')$$, '23P01', null, 'shared first day overlap rejected');
select throws_ok($$insert into public.court_coverage_periods (court_id, starts_on, ends_on) values ('c6000000-0000-4000-8000-000000000011', '2027-04-15', '2027-04-16')$$, '23P01', null, 'shared last day overlap rejected');
select throws_ok($$insert into public.court_coverage_periods (court_id, starts_on, ends_on) values ('c6000000-0000-4000-8000-000000000011', '2026-12-01', '2027-01-01')$$, '23P01', null, 'contained period overlap rejected');
select throws_ok($$insert into public.court_coverage_periods (court_id, starts_on, ends_on) values ('c6000000-0000-4000-8000-000000000011', '2026-10-01', '2027-05-01')$$, '23P01', null, 'containing period overlap rejected');
select lives_ok($$insert into public.court_coverage_periods (court_id, starts_on, ends_on)
values ('c6000000-0000-4000-8000-000000000011', '2027-04-16', '2027-04-16')$$, 'adjacent single-day period accepted');
select lives_ok($$insert into public.court_coverage_periods (court_id, starts_on, ends_on)
values ('c6000000-0000-4000-8000-000000000012', '2026-10-15', '2027-04-15')$$, 'different courts may overlap');
select throws_ok($$update public.court_coverage_periods set starts_on = '2027-04-15' where starts_on = '2027-04-16'$$,
'23P01', null, 'overlap on edit rejected');
select results_eq($$update public.court_coverage_periods set ends_on = '2027-04-14' where court_id = 'c6000000-0000-4000-8000-000000000011' and starts_on = '2026-10-15' returning ends_on::text$$,
array['2027-04-14']::text[], 'admin may edit dates');
select is((select updated_at from public.court_coverage_periods where court_id = 'c6000000-0000-4000-8000-000000000011' and starts_on = '2026-10-15'),
'2000-01-01'::timestamptz, 'updated_at remains application controlled');
select lives_ok($$update public.court_coverage_periods set updated_at = '2026-09-29' where court_id = 'c6000000-0000-4000-8000-000000000011'$$,
'admin may set explicit application timestamp');
select throws_ok($$update public.court_coverage_periods set court_id = 'c6000000-0000-4000-8000-000000000012'$$, '42501', null, 'period cannot be reassigned');
select throws_ok($$update public.court_coverage_periods set created_at = now()$$, '42501', null, 'creation timestamp protected');
set local request.jwt.claims = '{"sub":"c6000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*) from public.court_coverage_periods), 0::bigint, 'member cannot read schedules');
select throws_ok($$insert into public.court_coverage_periods (court_id, starts_on, ends_on) values ('c6000000-0000-4000-8000-000000000011', '2028-01-01', '2028-01-02')$$, '42501', null, 'member insert rejected');
select results_eq($$update public.court_coverage_periods set ends_on = '2028-01-01' returning id::text$$, array[]::text[], 'member update rejected');
select results_eq($$delete from public.court_coverage_periods returning id::text$$, array[]::text[], 'member delete rejected');
set local request.jwt.claims = '{"sub":"c6000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is((select count(*) from public.court_coverage_periods), 0::bigint, 'suspended admin cannot read schedules');
select throws_ok($$insert into public.court_coverage_periods (court_id, starts_on, ends_on) values ('c6000000-0000-4000-8000-000000000011', '2028-01-01', '2028-01-02')$$, '42501', null, 'suspended admin insert rejected');
select results_eq($$update public.court_coverage_periods set ends_on = '2028-01-01' returning id::text$$, array[]::text[], 'suspended admin update rejected');
select results_eq($$delete from public.court_coverage_periods returning id::text$$, array[]::text[], 'suspended admin delete rejected');
set local request.jwt.claims = '{"sub":"c6000000-0000-4000-8000-000000000004","role":"authenticated"}';
select is((select count(*) from public.court_coverage_periods), 0::bigint, 'coach cannot read schedules');
select throws_ok($$insert into public.court_coverage_periods (court_id, starts_on, ends_on) values ('c6000000-0000-4000-8000-000000000011', '2028-01-01', '2028-01-02')$$, '42501', null, 'coach insert rejected');
select results_eq($$update public.court_coverage_periods set ends_on = '2028-01-01' returning id::text$$, array[]::text[], 'coach update rejected');
select results_eq($$delete from public.court_coverage_periods returning id::text$$, array[]::text[], 'coach delete rejected');
reset role;
set local role anon;
select throws_ok($$select * from public.court_coverage_periods$$, '42501', null, 'anonymous schedules inaccessible');
select throws_ok($$insert into public.court_coverage_periods (court_id, starts_on, ends_on) values ('c6000000-0000-4000-8000-000000000011', '2028-01-01', '2028-01-02')$$, '42501', null, 'anonymous insert rejected');
select throws_ok($$update public.court_coverage_periods set ends_on = '2028-01-01'$$, '42501', null, 'anonymous update rejected');
select throws_ok($$delete from public.court_coverage_periods$$, '42501', null, 'anonymous delete rejected');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"c6000000-0000-4000-8000-000000000001","role":"authenticated"}';
select results_eq($$with deleted as (delete from public.court_coverage_periods where court_id = 'c6000000-0000-4000-8000-000000000011' returning starts_on) select starts_on::text from deleted order by starts_on$$,
array['2026-10-15', '2027-04-16']::text[], 'admin may hard delete configuration intervals');
select lives_ok($$update public.courts set environment = 'indoor' where id = 'c6000000-0000-4000-8000-000000000011'$$,
'court may become indoor after removing periods');
reset role;
select * from finish();
rollback;
