begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();

insert into auth.users (id, email, aud, role) values
('ca000000-0000-4000-8000-000000000001', 'reservation-admin@example.test', 'authenticated', 'authenticated'),
('ca000000-0000-4000-8000-000000000002', 'reservation-coach@example.test', 'authenticated', 'authenticated'),
('ca000000-0000-4000-8000-000000000003', 'reservation-member@example.test', 'authenticated', 'authenticated'),
('ca000000-0000-4000-8000-000000000004', 'reservation-suspended@example.test', 'authenticated', 'authenticated');
insert into public.user_roles (user_id, role_code) values
('ca000000-0000-4000-8000-000000000001', 'admin'),
('ca000000-0000-4000-8000-000000000002', 'coach'),
('ca000000-0000-4000-8000-000000000004', 'coach');
update public.users set status = 'suspended' where id = 'ca000000-0000-4000-8000-000000000004';
update public.users set first_name = 'Mihai', last_name = 'Stan' where id = 'ca000000-0000-4000-8000-000000000001';
insert into public.locations (id, name, slug, timezone, is_public) values
('ca000000-0000-4000-8000-000000000010', 'Unpublished internal', 'unpublished-internal', 'UTC', false),
('ca000000-0000-4000-8000-000000000020', 'Another internal', 'another-internal', 'UTC', false);
insert into public.courts (id, location_id, name, slug, surface, environment, is_active) values
('ca000000-0000-4000-8000-000000000011', 'ca000000-0000-4000-8000-000000000010', 'Court', 'court', 'clay', 'outdoor', true),
('ca000000-0000-4000-8000-000000000021', 'ca000000-0000-4000-8000-000000000020', 'Other court', 'other-court', 'clay', 'outdoor', true);
insert into public.location_opening_hours (location_id, weekday, opens_at_minute, closes_at_minute) values
('ca000000-0000-4000-8000-000000000010', extract(isodow from date '2026-10-15')::integer - 1, 600, 720),
('ca000000-0000-4000-8000-000000000020', extract(isodow from date '2026-10-15')::integer - 1, 600, 720);

set local role authenticated;
set local request.jwt.claims = '{"sub":"ca000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_by_user_id)
values ('ca000000-0000-4000-8000-000000000011', '2026-10-15', 600, 660, 'Club event', 'ca000000-0000-4000-8000-000000000001')$$,
'active admin reserves unpublished court');
select set_config('test.admin_reservation_id', (select id::text from public.list_personal_court_reservations() where starts_at_minute = 600), true);
select set_config('test.admin_updated_at', (select updated_at::text from public.list_personal_court_reservations() where starts_at_minute = 600), true);
reset role;
select is((select status::text from public.court_reservations where starts_at_minute = 600),
  'active', 'new direct reservation defaults to active');
set local role authenticated;
select is((select created_by_user_id from public.list_personal_court_reservations() where starts_at_minute = 600),
'ca000000-0000-4000-8000-000000000001'::uuid, 'creator is stored');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_by_user_id)
values ('ca000000-0000-4000-8000-000000000011', '2026-10-16', 600, 660, 'Spoof', 'ca000000-0000-4000-8000-000000000002')$$,
'42501', null, 'staff cannot spoof creator');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_by_user_id)
values ('ca000000-0000-4000-8000-000000000011', '2026-10-15', 630, 690, 'Conflict', 'ca000000-0000-4000-8000-000000000001')$$,
'23P01', null, 'GiST exclusion rejects overlap');
select throws_ok($$select reason from public.court_reservations$$,
'42501', null, 'reason has no direct authenticated read grant');
select is((select count(*) from public.list_personal_court_reservations()),
  1::bigint, 'admin can read own details');
set local request.jwt.claims = '{"sub":"ca000000-0000-4000-8000-000000000002","role":"authenticated"}';
select lives_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_by_user_id)
values ('ca000000-0000-4000-8000-000000000011', '2026-10-15', 660, 720, 'Course with Andrej', 'ca000000-0000-4000-8000-000000000002')$$,
'active coach reserves adjacent interval');
select set_config('test.coach_reservation_id', (select id::text from public.list_personal_court_reservations() where starts_at_minute = 660), true);
select is((select count(*) from public.list_personal_court_reservations()),
  1::bigint, 'coach can read only own details');
select throws_ok($$select * from public.list_admin_court_reservations(
  array['ca000000-0000-4000-8000-000000000011'::uuid], '2026-10-15')$$,
  '42501', null, 'coach cannot read operational details');
select is((select count(*) from public.list_own_reservation_edit_occupancy(current_setting('test.coach_reservation_id')::uuid, '2026-10-15')),
  1::bigint, 'edit occupancy excludes the coach reservation itself');
select is((select starts_at_minute from public.list_own_reservation_edit_occupancy(current_setting('test.coach_reservation_id')::uuid, '2026-10-15')),
  600, 'another active reservation still blocks the coach');
reset role;
insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute, reason)
values ('ca000000-0000-4000-8000-000000000011', '2026-10-15', 720, 780, 'Legacy maintenance');
set local role authenticated;
set local request.jwt.claims = '{"sub":"ca000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select count(*) from public.list_admin_court_reservations(
  array['ca000000-0000-4000-8000-000000000011'::uuid], '2026-10-15')),
  3::bigint, 'admin sees all active direct reservations at selected court and date');
select is((select creator_name from public.list_admin_court_reservations(
  array['ca000000-0000-4000-8000-000000000011'::uuid], '2026-10-15') where starts_at_minute = 600),
  'Mihai Stan', 'admin reads creator display identity');
select is((select reason from public.list_admin_court_reservations(
  array['ca000000-0000-4000-8000-000000000011'::uuid], '2026-10-15') where starts_at_minute = 660),
  'Course with Andrej', 'admin can inspect another staff member reservation');
select is((select creator_name from public.list_admin_court_reservations(
  array['ca000000-0000-4000-8000-000000000011'::uuid], '2026-10-15') where starts_at_minute = 720),
  null::text, 'legacy reservation has null creator identity');
select is((select count(*) from public.list_personal_court_reservations()),
  1::bigint, 'Admin operational read does not broaden personal ownership');
reset role;
delete from public.court_reservations where court_id = 'ca000000-0000-4000-8000-000000000011'
  and starts_at_minute = 720 and created_by_user_id is null;
update public.locations set is_public = true where id = 'ca000000-0000-4000-8000-000000000010';
set local role authenticated;
set local request.jwt.claims = '{"sub":"ca000000-0000-4000-8000-000000000003","role":"authenticated"}';
select throws_ok($$select * from public.list_personal_court_reservations()$$,
  '42501', null, 'ordinary user cannot read personal details');
select throws_ok($$select * from public.list_admin_court_reservations(
  array['ca000000-0000-4000-8000-000000000011'::uuid], '2026-10-15')$$,
  '42501', null, 'ordinary user cannot inspect operational details');
select throws_ok($$select * from public.list_own_reservation_edit_occupancy('ca000000-0000-4000-8000-000000000099', '2026-10-15')$$,
  '42501', null, 'ordinary user cannot read edit occupancy');
select throws_ok($$select public.cancel_own_court_reservation('ca000000-0000-4000-8000-000000000099')$$,
  '42501', null, 'ordinary user cannot cancel');
select throws_ok($$select public.edit_own_court_reservation(null, null, 'Spoof', false, null, null, null, null)$$,
  '42501', null, 'ordinary user cannot edit direct reservations');
select throws_ok($$update public.court_reservations set status = 'cancelled',
  cancelled_at = now(), cancelled_by_user_id = 'ca000000-0000-4000-8000-000000000003'
  where court_id = 'ca000000-0000-4000-8000-000000000011'$$,
  '42501', null, 'ordinary user has no direct UPDATE grant');
select throws_ok($$delete from public.court_reservations where court_id =
  'ca000000-0000-4000-8000-000000000011' and booking_date = '2026-10-15'$$,
  '42501', null, 'ordinary user has no DELETE grant');
reset role;
select is((select count(*) from public.court_reservations where court_id =
  'ca000000-0000-4000-8000-000000000011'), 2::bigint, 'ordinary user did not delete occupancy');
select is((select count(*) from public.court_reservations where court_id =
  'ca000000-0000-4000-8000-000000000011' and status = 'active'),
  2::bigint, 'ordinary user did not change lifecycle');
set local role authenticated;
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute, reason)
values ('ca000000-0000-4000-8000-000000000011', '2026-10-16', 600, 660, 'Spoof')$$,
'42501', null, 'ordinary user denied by RLS');
set local request.jwt.claims = '{"sub":"ca000000-0000-4000-8000-000000000004","role":"authenticated"}';
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute, reason)
values ('ca000000-0000-4000-8000-000000000011', '2026-10-16', 600, 660, 'Spoof')$$,
'42501', null, 'suspended coach denied by RLS');
reset role;
set local role anon;
select throws_ok($$select * from public.list_personal_court_reservations()$$,
  '42501', null, 'anonymous cannot read personal details');
select throws_ok($$select * from public.list_own_reservation_edit_occupancy('ca000000-0000-4000-8000-000000000099', '2026-10-15')$$,
  '42501', null, 'anonymous cannot read edit occupancy');
select throws_ok($$select public.cancel_own_court_reservation('ca000000-0000-4000-8000-000000000099')$$,
  '42501', null, 'anonymous cannot cancel');
select throws_ok($$select public.edit_own_court_reservation(null, null, 'Spoof', false, null, null, null, null)$$,
  '42501', null, 'anonymous cannot edit direct reservations');
select throws_ok($$update public.court_reservations set status = 'cancelled'
  where court_id = 'ca000000-0000-4000-8000-000000000011'$$,
  '42501', null, 'anonymous direct UPDATE denied');
select throws_ok($$delete from public.court_reservations where court_id =
  'ca000000-0000-4000-8000-000000000011'$$,
  '42501', null, 'anonymous direct DELETE denied');
select throws_ok($$insert into public.court_reservations (court_id, booking_date, starts_at_minute, ends_at_minute, reason)
values ('ca000000-0000-4000-8000-000000000011', '2026-10-16', 600, 660, 'Spoof')$$,
'42501', null, 'anonymous insert denied');
reset role;
select is((select count(*) from public.court_reservations where court_id = 'ca000000-0000-4000-8000-000000000011'),
2::bigint, 'only two reservations persisted');
select is(has_table_privilege('authenticated', 'public.court_reservations', 'DELETE'), false,
  'authenticated DELETE grant removed');
select is(has_column_privilege('authenticated', 'public.court_reservations', 'status', 'UPDATE'), false,
  'direct lifecycle UPDATE grant removed');
select is(has_column_privilege('authenticated', 'public.court_reservations', 'reason', 'UPDATE'), false,
  'direct reason UPDATE is not granted');
select is(to_regprocedure('public.cancel_internal_court_reservation(uuid)'), null::regprocedure,
  'broad staff cancellation RPC removed');
select is(to_regprocedure('public.list_internal_court_reservations(uuid[],date)'), null::regprocedure,
  'staff details RPC removed from creation timetable');
set local role authenticated;
set local request.jwt.claims = '{"sub":"ca000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is(public.cancel_own_court_reservation('ca000000-0000-4000-8000-000000000099'),
  false, 'missing reservation returns false');
select is(public.edit_own_court_reservation(current_setting('test.coach_reservation_id')::uuid,
  current_setting('test.admin_updated_at')::timestamptz, 'Spoof', false, null, null, null, null),
  'unavailable', 'admin cannot edit coach reservation');
select is(public.edit_own_court_reservation(current_setting('test.admin_reservation_id')::uuid,
  current_setting('test.admin_updated_at')::timestamptz, 'Updated club event', false, null, null, null, null),
  'updated', 'admin edits own reason in place');
select isnt((select updated_at::text from public.list_personal_court_reservations() where starts_at_minute = 600),
  current_setting('test.admin_updated_at'), 'edit advances updated_at');
select is(public.edit_own_court_reservation(current_setting('test.admin_reservation_id')::uuid,
  current_setting('test.admin_updated_at')::timestamptz, 'Stale overwrite', false, null, null, null, null),
  'stale', 'old updated_at cannot overwrite a newer edit');
select is((select reason from public.list_personal_court_reservations() where starts_at_minute = 600),
  'Updated club event', 'stale edit preserves newer reason');
select set_config('test.admin_updated_at', (select updated_at::text from public.list_personal_court_reservations() where starts_at_minute = 600), true);
select is(public.edit_own_court_reservation(current_setting('test.admin_reservation_id')::uuid,
  current_setting('test.admin_updated_at')::timestamptz, 'Cross-location', true,
  'ca000000-0000-4000-8000-000000000021', '2026-10-15', 600, 660),
  'unavailable', 'same-row edit refuses a court at another location');
select is((select court_id from public.list_personal_court_reservations() where id = current_setting('test.admin_reservation_id')::uuid),
  'ca000000-0000-4000-8000-000000000011'::uuid, 'cross-location rejection keeps the original court');
select throws_ok($$select public.edit_own_court_reservation(
  current_setting('test.admin_reservation_id')::uuid, current_setting('test.admin_updated_at')::timestamptz,
  'Overlap', true, 'ca000000-0000-4000-8000-000000000011', '2026-10-15', 660, 720)$$,
  '23P01', null, 'GiST rejects overlapping in-place edit');
select is((select starts_at_minute from public.list_personal_court_reservations() where id = current_setting('test.admin_reservation_id')::uuid),
  600, 'failed reschedule keeps the original interval');
select is(public.cancel_own_court_reservation(current_setting('test.coach_reservation_id')::uuid),
  false, 'admin cannot cancel coach reservation');
select ok(public.cancel_own_court_reservation((select id from public.list_personal_court_reservations() where starts_at_minute = 600)),
  'admin cancels own reservation');
select is(public.cancel_own_court_reservation((select id from public.list_personal_court_reservations() where starts_at_minute = 600)),
  false, 'already-cancelled reservation returns false');
set local request.jwt.claims = '{"sub":"ca000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is(public.cancel_own_court_reservation(current_setting('test.admin_reservation_id')::uuid),
  false, 'coach cannot cancel admin reservation');
select ok(public.cancel_own_court_reservation((select id from public.list_personal_court_reservations() where starts_at_minute = 660)),
  'coach cancels own reservation');
set local request.jwt.claims = '{"sub":"ca000000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select count(*) from public.list_admin_court_reservations(
  array['ca000000-0000-4000-8000-000000000011'::uuid], '2026-10-15')),
  0::bigint, 'cancelled reservations are absent from live Admin inspection');
reset role;
select is((select count(*) from public.court_reservations where court_id = 'ca000000-0000-4000-8000-000000000011'),
  2::bigint, 'cancellation preserves both rows');
select is((select count(*) from public.court_reservations where court_id = 'ca000000-0000-4000-8000-000000000011' and status = 'cancelled'
  and cancelled_at is not null and cancelled_by_user_id is not null),
  2::bigint, 'cancellation stores complete lifecycle metadata');
select is((select cancelled_by_user_id from public.court_reservations where starts_at_minute = 600),
  'ca000000-0000-4000-8000-000000000001'::uuid, 'admin recorded as canceller');
select is((select cancelled_by_user_id from public.court_reservations where starts_at_minute = 660),
  'ca000000-0000-4000-8000-000000000002'::uuid, 'coach recorded as canceller');
select is((select created_by_user_id from public.court_reservations where starts_at_minute = 600),
  'ca000000-0000-4000-8000-000000000001'::uuid, 'creator remains unchanged');
select * from finish();
rollback;
