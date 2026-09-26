begin;

create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(72);

insert into auth.users (id, email, aud, role)
values
  ('a13f15e2-7b5d-4b41-8d4b-4f2135081001', 'pgtap-member-a@example.test', 'authenticated', 'authenticated'),
  ('a13f15e2-7b5d-4b41-8d4b-4f2135081002', 'pgtap-member-b@example.test', 'authenticated', 'authenticated');

select is(
  (select count(*) from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and email = 'pgtap-member-a@example.test'),
  1::bigint,
  'auth user creation provisions a matching application profile'
);
select is(
  (select count(*) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'member'),
  1::bigint,
  'auth user creation assigns the member role'
);
select is(
  (select count(*) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'),
  1::bigint,
  'new accounts have no additional roles'
);
select is(
  (select count(*) from auth.users a left join public.users u on u.id = a.id
   where a.id in ('a13f15e2-7b5d-4b41-8d4b-4f2135081001', 'a13f15e2-7b5d-4b41-8d4b-4f2135081002') and u.id is null),
  0::bigint,
  'successful auth inserts leave no fixture user without a profile'
);
select is(
  (select count(*) from auth.users a left join public.user_roles ur on ur.user_id = a.id and ur.role_code = 'member'
   where a.id in ('a13f15e2-7b5d-4b41-8d4b-4f2135081001', 'a13f15e2-7b5d-4b41-8d4b-4f2135081002') and ur.user_id is null),
  0::bigint,
  'successful auth inserts leave no fixture user without the default role'
);


select is(
  (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
   where table_schema = 'public' and table_name = 'roles'),
  array['code']::text[], 'roles contains only code'
);
select is((select array_agg(code order by code) from public.roles),
  array['admin', 'coach', 'member']::text[], 'only current role codes are seeded');
select throws_ok($$insert into public.roles (code) values ('Invalid')$$,
  '23514', null, 'role codes retain format validation');
select throws_ok($$delete from auth.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'$$,
  '23503', null, 'Auth deletion is restricted by the application identity FK');
select is((select count(*) from auth.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 1::bigint, 'Auth identity survives rejected deletion');
select is((select count(*) from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 1::bigint, 'application identity survives rejected Auth deletion');
select is((select count(*) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'member'), 1::bigint, 'roles survive rejected Auth deletion');

-- Establish an active administrator before exercising status transitions on a pristine DB.
insert into public.user_roles (user_id, role_code)
values ('a13f15e2-7b5d-4b41-8d4b-4f2135081002', 'admin');

-- Use an old creation time so accidental overwrites with transaction now() are visible.
update public.users set created_at = '2000-01-01 00:00:00+00'::timestamptz where id in ('a13f15e2-7b5d-4b41-8d4b-4f2135081001', 'a13f15e2-7b5d-4b41-8d4b-4f2135081002');
-- Trusted fixture setup bypasses only the timestamp trigger, then restores it.
alter table public.users disable trigger users_set_updated_at;
update public.users set updated_at = '2000-01-01 00:00:00+00'::timestamptz where id in ('a13f15e2-7b5d-4b41-8d4b-4f2135081001');
alter table public.users enable trigger users_set_updated_at;
update public.users set status = 'suspended' where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001';
select ok((select updated_at > '2000-01-01 00:00:00+00'::timestamptz from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 'status changes touch account timestamp');
-- Trusted fixture setup bypasses only the timestamp trigger, then restores it.
alter table public.users disable trigger users_set_updated_at;
update public.users set updated_at = '2000-01-01 00:00:00+00'::timestamptz where id in ('a13f15e2-7b5d-4b41-8d4b-4f2135081001');
alter table public.users enable trigger users_set_updated_at;
insert into public.user_roles (user_id, role_code) values ('a13f15e2-7b5d-4b41-8d4b-4f2135081001', 'coach');
select ok((select updated_at > '2000-01-01 00:00:00+00'::timestamptz from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 'role assignment touches account timestamp');
-- Trusted fixture setup bypasses only the timestamp trigger, then restores it.
alter table public.users disable trigger users_set_updated_at;
update public.users set updated_at = '2000-01-01 00:00:00+00'::timestamptz where id in ('a13f15e2-7b5d-4b41-8d4b-4f2135081001');
alter table public.users enable trigger users_set_updated_at;
delete from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'coach';
select ok((select updated_at > '2000-01-01 00:00:00+00'::timestamptz from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 'role revocation touches account timestamp');
insert into public.user_roles (user_id, role_code) values ('a13f15e2-7b5d-4b41-8d4b-4f2135081001', 'coach');
-- Trusted fixture setup bypasses only the timestamp trigger, then restores it.
alter table public.users disable trigger users_set_updated_at;
update public.users set updated_at = '2000-01-01 00:00:00+00'::timestamptz where id in ('a13f15e2-7b5d-4b41-8d4b-4f2135081001', 'a13f15e2-7b5d-4b41-8d4b-4f2135081002');
alter table public.users enable trigger users_set_updated_at;
update public.user_roles set user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002' where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'coach';
select ok((select updated_at > '2000-01-01 00:00:00+00'::timestamptz from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 'role reassignment touches old user');
select ok((select updated_at > '2000-01-01 00:00:00+00'::timestamptz from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002'), 'role reassignment touches new user');
delete from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002' and role_code = 'member';
-- Trusted fixture setup bypasses only the timestamp trigger, then restores it.
alter table public.users disable trigger users_set_updated_at;
update public.users set updated_at = '2000-01-01 00:00:00+00'::timestamptz where id in ('a13f15e2-7b5d-4b41-8d4b-4f2135081002');
alter table public.users enable trigger users_set_updated_at;
update public.user_roles set role_code = 'member' where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002' and role_code = 'coach';
select ok((select updated_at > '2000-01-01 00:00:00+00'::timestamptz from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002'), 'role code update touches account timestamp');
-- Trusted fixture setup bypasses only the timestamp trigger, then restores it.
alter table public.users disable trigger users_set_updated_at;
update public.users set updated_at = '2000-01-01 00:00:00+00'::timestamptz where id in ('a13f15e2-7b5d-4b41-8d4b-4f2135081002');
alter table public.users enable trigger users_set_updated_at;
update public.user_roles set assigned_at = '2000-01-01 00:00:00+00'::timestamptz where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002' and role_code = 'member';
select is((select updated_at from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002'), '2000-01-01 00:00:00+00'::timestamptz, 'assignment audit metadata alone preserves account timestamp');
-- Trusted fixture setup bypasses only the timestamp trigger, then restores it.
alter table public.users disable trigger users_set_updated_at;
update public.users set updated_at = '2000-01-01 00:00:00+00'::timestamptz where id in ('a13f15e2-7b5d-4b41-8d4b-4f2135081001');
alter table public.users enable trigger users_set_updated_at;
update auth.users set email = 'pgtap-member-a-updated@example.test' where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001';
select ok((select updated_at > '2000-01-01 00:00:00+00'::timestamptz from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 'Auth email synchronization touches account timestamp');
select is((select email from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 'pgtap-member-a-updated@example.test', 'Auth email remains authoritative');
select is((select count(*) from public.users where id in ('a13f15e2-7b5d-4b41-8d4b-4f2135081001', 'a13f15e2-7b5d-4b41-8d4b-4f2135081002') and created_at = '2000-01-01 00:00:00+00'::timestamptz), 2::bigint, 'account and role changes preserve creation timestamps');
update public.users set status = 'active' where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001';

set local role anon;
select throws_ok($$select count(*) from public.users$$, '42501', null, 'anonymous users cannot read application profiles');
select throws_ok($$select count(*) from public.user_roles$$, '42501', null, 'anonymous users cannot read role assignments');
select throws_ok($$select count(*) from public.roles$$, '42501', null, 'anonymous users cannot read role definitions');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a13f15e2-7b5d-4b41-8d4b-4f2135081001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select is((select count(*) from public.users where id = auth.uid()), 1::bigint, 'member can read own profile');
select is((select count(*) from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002'), 0::bigint, 'member cannot read another profile');
select is((select count(*) from public.user_roles where user_id = auth.uid() and role_code = 'member'), 1::bigint, 'member can read own role');
select is((select count(*) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002'), 0::bigint, 'member cannot read another user role');
select throws_ok($$select count(*) from public.roles$$, '42501', null, 'authenticated users cannot read the internal role lookup');
select is(public.has_role('admin'), false, 'member is not an administrator');

select throws_ok(
  $$insert into public.user_roles (user_id, role_code) values ('a13f15e2-7b5d-4b41-8d4b-4f2135081001', 'admin')$$,
  '42501', null, 'member cannot self-assign admin'
);
select throws_ok(
  $$insert into public.user_roles (user_id, role_code) values ('a13f15e2-7b5d-4b41-8d4b-4f2135081001', 'coach')$$,
  '42501', null, 'member cannot self-assign coach'
);
delete from public.user_roles where user_id = auth.uid() and role_code = 'member';
select is((select count(*) from public.user_roles where user_id = auth.uid() and role_code = 'member'), 1::bigint, 'member cannot revoke own role');
update public.users set status = 'suspended' where id = auth.uid();
select is((select status from public.users where id = auth.uid()), 'active'::public.user_status, 'member cannot change own status');
select throws_ok(
  $$insert into public.roles (code) values ('owner')$$,
  '42501', null, 'member cannot create a privileged role definition'
);

reset role;
insert into public.user_roles (user_id, role_code)
values ('a13f15e2-7b5d-4b41-8d4b-4f2135081002', 'admin')
on conflict (user_id, role_code) do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a13f15e2-7b5d-4b41-8d4b-4f2135081002', true);

select is(public.has_role('admin'), true, 'active administrator has admin role');
-- Another active admin exists, isolating RLS from the final-admin invariant.
insert into public.user_roles (user_id, role_code) values ('a13f15e2-7b5d-4b41-8d4b-4f2135081001', 'admin');
update public.users set status = 'suspended' where id = auth.uid();
select is((select status from public.users where id = auth.uid()), 'active'::public.user_status, 'RLS prevents admin self-suspension');
update public.users set status = 'active' where id = auth.uid();
select is((select status from public.users where id = auth.uid()), 'active'::public.user_status, 'own account remains active after attempted idempotent status update');
delete from public.user_roles where user_id = auth.uid() and role_code = 'admin';
select is((select count(*) from public.user_roles where user_id = auth.uid() and role_code = 'admin'), 1::bigint, 'RLS prevents deleting own admin assignment');
select throws_ok($$insert into public.user_roles (user_id, role_code) values ('a13f15e2-7b5d-4b41-8d4b-4f2135081002', 'admin')$$, '42501', null, 'RLS rejects own admin INSERT before uniqueness check');
insert into public.user_roles (user_id, role_code) values ('a13f15e2-7b5d-4b41-8d4b-4f2135081002', 'coach');
select is((select count(*) from public.user_roles where user_id = auth.uid() and role_code = 'coach'), 1::bigint, 'admin can assign own coach role');
delete from public.user_roles where user_id = auth.uid() and role_code = 'coach';
select is((select count(*) from public.user_roles where user_id = auth.uid() and role_code = 'coach'), 0::bigint, 'admin can revoke own coach role');
delete from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'admin';

delete from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'member';
select is((select count(*) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'member'), 1::bigint, 'admin cannot delete another account mandatory member role');
delete from public.user_roles where user_id = auth.uid() and role_code = 'member';
select is((select count(*) from public.user_roles where user_id = auth.uid() and role_code = 'member'), 1::bigint, 'admin cannot delete own mandatory member role');
insert into public.user_roles (user_id, role_code) values ('a13f15e2-7b5d-4b41-8d4b-4f2135081001', 'admin');
delete from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'admin';
select is((select count(*) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'admin'), 0::bigint, 'authenticated admin can revoke another admin while an active admin remains');


select is((select count(*) from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 1::bigint, 'admin can read another profile');
select is((select count(*) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 1::bigint, 'admin can read another user role');
reset role;
-- Trusted fixture setup bypasses only the timestamp trigger, then restores it.
alter table public.users disable trigger users_set_updated_at;
update public.users set updated_at = '2000-01-01 00:00:00+00'::timestamptz where id in ('a13f15e2-7b5d-4b41-8d4b-4f2135081001');
alter table public.users enable trigger users_set_updated_at;
set local role authenticated;
insert into public.user_roles (user_id, role_code, assigned_by)
values ('a13f15e2-7b5d-4b41-8d4b-4f2135081001', 'coach', 'a13f15e2-7b5d-4b41-8d4b-4f2135081001');
select is(
  (select assigned_by from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'coach'),
  'a13f15e2-7b5d-4b41-8d4b-4f2135081002'::uuid,
  'role assignment audit records the actual administrator despite a spoofed value'
);
select ok((select updated_at > '2000-01-01 00:00:00+00'::timestamptz from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 'authenticated admin role assignment touches timestamp');
reset role;
-- Trusted fixture setup bypasses only the timestamp trigger, then restores it.
alter table public.users disable trigger users_set_updated_at;
update public.users set updated_at = '2000-01-01 00:00:00+00'::timestamptz where id in ('a13f15e2-7b5d-4b41-8d4b-4f2135081001');
alter table public.users enable trigger users_set_updated_at;
set local role authenticated;
delete from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'coach';
select is((select count(*) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'coach'), 0::bigint, 'admin can revoke a role');
select ok((select updated_at > '2000-01-01 00:00:00+00'::timestamptz from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 'authenticated admin role revocation touches timestamp');
update public.users set status = 'suspended' where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001';
select is((select status from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 'suspended'::public.user_status, 'admin can suspend another account');

select set_config('request.jwt.claim.sub', 'a13f15e2-7b5d-4b41-8d4b-4f2135081001', true);
select is(public.has_role('member'), false, 'suspended member has no effective role');
select is((select count(*) from public.user_roles where user_id = auth.uid() and role_code = 'member'), 1::bigint, 'suspension retains the mandatory member assignment');

reset role;

-- Isolate the final-admin cases from existing local accounts. The surrounding
-- transaction restores these statuses when the test rolls back.
update public.users u
set status = 'suspended'
where u.status = 'active'
  and u.id not in (
    'a13f15e2-7b5d-4b41-8d4b-4f2135081001',
    'a13f15e2-7b5d-4b41-8d4b-4f2135081002'
  )
  and exists (
    select 1 from public.user_roles ur
    where ur.user_id = u.id and ur.role_code = 'admin'
  );

-- Trusted fixture setup bypasses only the timestamp trigger, then restores it.
alter table public.users disable trigger users_set_updated_at;
update public.users set updated_at = '2000-01-01 00:00:00+00'::timestamptz where id in ('a13f15e2-7b5d-4b41-8d4b-4f2135081002');
alter table public.users enable trigger users_set_updated_at;
-- Trusted writes independently exercise the global final-admin invariant.
select throws_ok(
  $$delete from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002' and role_code = 'admin'$$,
  '23514', 'At least one active administrator must remain.',
  'cannot revoke the only active administrator'
);
reset role;
select set_config('request.jwt.claim.sub', 'a13f15e2-7b5d-4b41-8d4b-4f2135081001', true);
select throws_ok(
  $$update public.users set status = 'suspended' where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002'$$,
  '23514', 'At least one active administrator must remain.',
  'cannot suspend the only active administrator'
);

select is((select status from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002'), 'active'::public.user_status, 'rejected suspension preserves active status');
select is((select count(*) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002' and role_code = 'admin'), 1::bigint, 'rejected revocation preserves admin role');
select is((select updated_at from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002'), '2000-01-01 00:00:00+00'::timestamptz, 'rejected status and role changes roll back timestamp touches');
select throws_ok($$update public.user_roles set role_code = 'coach' where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002' and role_code = 'admin'$$, '23514', 'At least one active administrator must remain.', 'cannot replace final admin role');
select throws_ok($$update public.user_roles set user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002' and role_code = 'admin'$$, '23514', 'At least one active administrator must remain.', 'cannot move final admin role to suspended user');
select is((select updated_at from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002'), '2000-01-01 00:00:00+00'::timestamptz, 'rejected role UPDATE preserves account timestamp');
select is((select count(*) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002' and role_code = 'admin'), 1::bigint, 'rejected role UPDATE preserves admin assignment');
insert into public.user_roles (user_id, role_code)
values ('a13f15e2-7b5d-4b41-8d4b-4f2135081001', 'admin');
select is(
  (select count(*) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'admin'),
  1::bigint,
  'assigning admin to a suspended account remains allowed'
);
select throws_ok(
  $$delete from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002' and role_code = 'admin'$$,
  '23514', 'At least one active administrator must remain.',
  'a suspended administrator does not count as active'
);

update public.users set status = 'active'
where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001';
select is(
  (select status from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'),
  'active'::public.user_status,
  'reactivating a suspended administrator remains allowed'
);

delete from public.user_roles
where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002' and role_code = 'admin';
select is(
  (select count(*) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002' and role_code = 'admin'),
  0::bigint,
  'can revoke admin when another active administrator remains'
);

insert into public.user_roles (user_id, role_code)
values ('a13f15e2-7b5d-4b41-8d4b-4f2135081002', 'admin');
update public.users set status = 'suspended'
where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002';
select is(
  (select status from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002'),
  'suspended'::public.user_status,
  'can suspend an administrator when another active administrator remains'
);
select is((select array_agg(role_code order by role_code) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002'), array['admin', 'member']::text[], 'suspended administrator retains all assigned roles');

update public.users set status = 'active'
where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002';
select is(
  (select status from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002'),
  'active'::public.user_status,
  'reactivating an administrator remains allowed'
);

insert into public.user_roles (user_id, role_code)
values ('a13f15e2-7b5d-4b41-8d4b-4f2135081002', 'coach');
delete from public.user_roles
where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002' and role_code = 'coach';
select is(
  (select count(*) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081002' and role_code = 'coach'),
  0::bigint,
  'non-admin role changes remain unaffected'
);

select * from finish();
rollback;
