begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
select no_plan();
insert into auth.users (id, email, aud, role) values
('b13f15e2-7b5d-4b41-8d4b-4f2135082001', 'avatar-lock-owner@example.test', 'authenticated', 'authenticated'),
('b13f15e2-7b5d-4b41-8d4b-4f2135082002', 'avatar-lock-other@example.test', 'authenticated', 'authenticated');
insert into public.player_profiles (user_id) values ('b13f15e2-7b5d-4b41-8d4b-4f2135082001');
select ok((select relrowsecurity from pg_class where oid = 'public.avatar_mutation_leases'::regclass), 'lease table has RLS');
select ok(not has_table_privilege('authenticated', 'public.avatar_mutation_leases', 'SELECT'), 'tokens are not exposed to clients');
select ok(not has_table_privilege('authenticated', 'public.avatar_mutation_leases', 'UPDATE'), 'clients cannot change expiry or ownership');
select ok(not has_function_privilege('anon', 'public.acquire_avatar_mutation(uuid)', 'EXECUTE'), 'anonymous acquisition forbidden');
select ok(not has_function_privilege('anon', 'public.release_avatar_mutation(uuid)', 'EXECUTE'), 'anonymous release forbidden');
select ok(not has_function_privilege('anon', 'public.persist_avatar_path(uuid,text)', 'EXECUTE'), 'anonymous persistence forbidden');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b13f15e2-7b5d-4b41-8d4b-4f2135082001', true);
select ok(not public.acquire_avatar_mutation(null), 'null ownership token rejected');
select ok(public.acquire_avatar_mutation('00000000-0000-0000-0000-000000000001'), 'first owner acquires');
select ok(not public.acquire_avatar_mutation('00000000-0000-0000-0000-000000000002'), 'same user second mutation conflicts');
select ok(not public.release_avatar_mutation('00000000-0000-0000-0000-000000000002'), 'wrong token cannot release');
select ok(not public.persist_avatar_path('00000000-0000-0000-0000-000000000002', null), 'wrong token cannot persist');
select ok(not public.persist_avatar_path('00000000-0000-0000-0000-000000000001', 'victim/avatar.webp'), 'noncanonical path rejected');
select ok(public.persist_avatar_path('00000000-0000-0000-0000-000000000001', auth.uid()::text || '/avatar.webp'), 'owner can persist canonical path');
select ok((select updated_at > created_at from public.player_profiles where user_id = auth.uid()), 'persistence sets server timestamp');

select set_config('request.jwt.claim.sub', 'b13f15e2-7b5d-4b41-8d4b-4f2135082002', true);
select ok(not public.release_avatar_mutation('00000000-0000-0000-0000-000000000001'), 'another user cannot release owner token');
select ok(not public.persist_avatar_path('00000000-0000-0000-0000-000000000001', null), 'another user cannot persist owner path');
select ok(public.acquire_avatar_mutation('00000000-0000-0000-0000-000000000002'), 'different user can acquire independently');
select ok(public.release_avatar_mutation('00000000-0000-0000-0000-000000000002'), 'different user releases only own lease');

reset role;
update public.avatar_mutation_leases set expires_at = clock_timestamp() - interval '1 second'
  where user_id = 'b13f15e2-7b5d-4b41-8d4b-4f2135082001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b13f15e2-7b5d-4b41-8d4b-4f2135082001', true);
select ok(not public.persist_avatar_path('00000000-0000-0000-0000-000000000001', null), 'expired token cannot persist');
select ok(public.acquire_avatar_mutation('00000000-0000-0000-0000-000000000002'), 'abandoned lease can be replaced');
select ok(not public.release_avatar_mutation('00000000-0000-0000-0000-000000000001'), 'old owner cannot release replacement');
select ok(not public.persist_avatar_path('00000000-0000-0000-0000-000000000001', null), 'old owner cannot overwrite replacement');
select ok(public.persist_avatar_path('00000000-0000-0000-0000-000000000002', null), 'replacement owner persists');
select ok(public.release_avatar_mutation('00000000-0000-0000-0000-000000000002'), 'replacement owner releases');
select ok(public.acquire_avatar_mutation('00000000-0000-0000-0000-000000000001'), 'released lease immediately reusable');
reset role;
update public.users set status = 'suspended' where id = 'b13f15e2-7b5d-4b41-8d4b-4f2135082001';
set local role authenticated;
select ok(not public.persist_avatar_path('00000000-0000-0000-0000-000000000001', null), 'suspension prevents persistence');
select ok(public.release_avatar_mutation('00000000-0000-0000-0000-000000000001'), 'suspension does not prevent cleanup');
select ok(not public.acquire_avatar_mutation('00000000-0000-0000-0000-000000000002'), 'suspended acquisition rejected');
select * from finish();
rollback;
