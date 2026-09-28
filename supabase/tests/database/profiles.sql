begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select plan(29);
select is((select count(*) from pg_trigger where tgrelid = 'public.player_profiles'::regclass
  and tgname = 'player_profiles_set_updated_at'), 0::bigint, 'player update timestamps have no maintenance trigger');
select ok(has_column_privilege('authenticated', 'public.player_profiles', 'updated_at', 'UPDATE'),
  'user-scoped Next.js client can write the server-generated update timestamp');

insert into auth.users (id, email, aud, role) values
('b13f15e2-7b5d-4b41-8d4b-4f2135081001', 'profile-owner@example.test', 'authenticated', 'authenticated'),
('b13f15e2-7b5d-4b41-8d4b-4f2135081002', 'profile-other@example.test', 'authenticated', 'authenticated');
select is((select count(*) from public.player_profiles where user_id = 'b13f15e2-7b5d-4b41-8d4b-4f2135081001'), 0::bigint, 'signup does not create a tennis profile');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b13f15e2-7b5d-4b41-8d4b-4f2135081001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
update public.users set first_name = 'Ana', phone = '123' where id = auth.uid();
select is((select first_name from public.users where id = auth.uid()), 'Ana', 'owner updates personal fields');
select is((select phone from public.users where id = auth.uid()), '123', 'owner reads personal fields');
select is((select count(*) from public.users where id <> auth.uid()), 0::bigint, 'unrelated personal rows are hidden');
update public.users set status = 'suspended' where id = auth.uid();
select is((select status from public.users where id = auth.uid()), 'active'::public.user_status, 'owner cannot self-suspend');
select throws_ok($$update public.users set email = 'spoof@example.test' where id = auth.uid()$$, '42501', null, 'owner cannot write email');
select throws_ok($$update public.users set updated_at = now() where id = auth.uid()$$, '42501', null, 'owner cannot write timestamps');
insert into public.player_profiles (user_id, display_name) values (auth.uid(), 'Ana');
select is((select display_name from public.player_profiles where user_id = auth.uid()), 'Ana', 'owner creates tennis profile');
update public.player_profiles set bio = 'Clay player' where user_id = auth.uid();
select is((select bio from public.player_profiles where user_id = auth.uid()), 'Clay player', 'owner updates tennis profile');
select throws_ok($$update public.player_profiles set rating = 2000 where user_id = auth.uid()$$, '42501', null, 'rating update is forbidden');
select throws_ok($$insert into public.player_profiles (user_id, rating) values (auth.uid(), 2000)$$, '42501', null, 'rating insert is forbidden');
select throws_ok($$update public.player_profiles set user_id = 'b13f15e2-7b5d-4b41-8d4b-4f2135081002' where user_id = auth.uid()$$, '42501', null, 'ownership update is forbidden');
select throws_ok($$insert into public.player_profiles (user_id) values ('b13f15e2-7b5d-4b41-8d4b-4f2135081002')$$, '42501', null, 'arbitrary player targeting is forbidden');
select throws_ok($$update public.player_profiles set handedness = 'other' where user_id = auth.uid()$$, '23514', null, 'choice constraint enforced');

select set_config('request.jwt.claim.sub', 'b13f15e2-7b5d-4b41-8d4b-4f2135081002', true);
select is((select count(*) from public.player_profiles where display_name = 'Ana'), 1::bigint, 'active user reads another tennis profile');
update public.player_profiles set bio = 'spoof' where user_id <> auth.uid();
select is((select bio from public.player_profiles where display_name = 'Ana'), 'Clay player', 'other user cannot mutate profile');
reset role;
set local role anon;
select throws_ok($$select * from public.player_profiles$$, '42501', null, 'anonymous cannot read tennis data');
reset role;
-- Establish a trusted active admin before exercising suspension on a pristine DB.
insert into public.user_roles (user_id, role_code) values ('b13f15e2-7b5d-4b41-8d4b-4f2135081001', 'admin');
update public.users set status = 'suspended' where id = 'b13f15e2-7b5d-4b41-8d4b-4f2135081002';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b13f15e2-7b5d-4b41-8d4b-4f2135081002', true);
select is((select count(*) from public.player_profiles), 0::bigint, 'suspended user has no club-wide tennis visibility');
update public.users set first_name = 'restricted' where id = auth.uid();
select is((select first_name from public.users where id = auth.uid()), null::text, 'suspended owner cannot edit personal data');
select throws_ok($$insert into public.player_profiles (user_id) values (auth.uid())$$, '42501', null, 'suspended owner cannot create profile');

select set_config('request.jwt.claim.sub', 'b13f15e2-7b5d-4b41-8d4b-4f2135081001', true);
update public.users set first_name = 'admin-overwrite' where id <> auth.uid();
select is((select first_name from public.users where id = 'b13f15e2-7b5d-4b41-8d4b-4f2135081002'), null::text, 'admin status policy does not permit others personal edits');
update public.users set status = 'active' where id = 'b13f15e2-7b5d-4b41-8d4b-4f2135081002';
select is((select status from public.users where id = 'b13f15e2-7b5d-4b41-8d4b-4f2135081002'), 'active'::public.user_status, 'admin status behavior preserved');

insert into storage.objects (bucket_id, name) values ('profile-avatars', auth.uid()::text || '/avatar.png');
select is((select count(*) from storage.objects where bucket_id = 'profile-avatars' and name = auth.uid()::text || '/avatar.png'), 1::bigint, 'owner avatar path allowed');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('profile-avatars', 'b13f15e2-7b5d-4b41-8d4b-4f2135081002/avatar.png')$$, '42501', null, 'other avatar path forbidden');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('profile-avatars', auth.uid()::text || '/extra.png')$$, '42501', null, 'only canonical avatar filenames allowed');
reset role;
select is((select public from storage.buckets where id = 'profile-avatars'), false, 'avatar bucket is private');
select is((select file_size_limit from storage.buckets where id = 'profile-avatars'), 5242880::bigint, 'bucket enforces five MiB');
select * from finish();
rollback;
