begin;

create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(28);

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
select is((select count(*) from public.roles), 3::bigint, 'active member can read role definitions');
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
  $$insert into public.roles (code, name, description) values ('owner', 'Owner', 'Privileged')$$,
  '42501', null, 'member cannot create a privileged role definition'
);

reset role;
insert into public.user_roles (user_id, role_code)
values ('a13f15e2-7b5d-4b41-8d4b-4f2135081002', 'admin');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a13f15e2-7b5d-4b41-8d4b-4f2135081002', true);

select is(public.has_role('admin'), true, 'active administrator has admin role');
select is((select count(*) from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 1::bigint, 'admin can read another profile');
select is((select count(*) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 1::bigint, 'admin can read another user role');
insert into public.user_roles (user_id, role_code, assigned_by)
values ('a13f15e2-7b5d-4b41-8d4b-4f2135081001', 'coach', 'a13f15e2-7b5d-4b41-8d4b-4f2135081001');
select is(
  (select assigned_by from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'coach'),
  'a13f15e2-7b5d-4b41-8d4b-4f2135081002'::uuid,
  'role assignment audit records the actual administrator despite a spoofed value'
);
delete from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'coach';
select is((select count(*) from public.user_roles where user_id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001' and role_code = 'coach'), 0::bigint, 'admin can revoke a role');
update public.users set status = 'suspended' where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001';
select is((select status from public.users where id = 'a13f15e2-7b5d-4b41-8d4b-4f2135081001'), 'suspended'::public.user_status, 'admin can suspend another account');

select set_config('request.jwt.claim.sub', 'a13f15e2-7b5d-4b41-8d4b-4f2135081001', true);
select is(public.current_user_is_active(), false, 'suspended member is inactive');
select is(public.has_role('member'), false, 'suspended member has no effective role');
select is((select count(*) from public.roles), 0::bigint, 'suspended member cannot read role definitions');

select * from finish();
rollback;
