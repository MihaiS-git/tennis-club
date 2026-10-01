-- Tennis-player data is separate from private account/contact information.
create table public.player_profiles (
  user_id uuid primary key references public.users(id),
  display_name text,
  avatar_path text,
  sportya_level text,
  rating integer,
  handedness text check (handedness in ('right', 'left')),
  backhand text check (backhand in ('one_handed', 'two_handed')),
  preferred_game text check (preferred_game in ('singles', 'doubles', 'both')),
  preferred_surface text check (preferred_surface in ('clay', 'hard', 'grass', 'carpet', 'any')),
  bio text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.player_profiles enable row level security;
revoke all on public.player_profiles from anon, authenticated;
grant select on public.player_profiles to authenticated;
grant insert (user_id, display_name, avatar_path, sportya_level, handedness,
  backhand, preferred_game, preferred_surface, bio) on public.player_profiles to authenticated;
grant update (display_name, avatar_path, sportya_level, handedness,
  backhand, preferred_game, preferred_surface, bio, updated_at) on public.player_profiles to authenticated;

create policy player_profiles_select on public.player_profiles for select to authenticated
using (exists (select 1 from public.users where id = (select auth.uid()) and status = 'active'));
create policy player_profiles_insert on public.player_profiles for insert to authenticated
with check (user_id = (select auth.uid()) and exists
  (select 1 from public.users where id = (select auth.uid()) and status = 'active'));
create policy player_profiles_update on public.player_profiles for update to authenticated
using (user_id = (select auth.uid()) and exists
  (select 1 from public.users where id = (select auth.uid()) and status = 'active'))
with check (user_id = (select auth.uid()) and exists
  (select 1 from public.users where id = (select auth.uid()) and status = 'active'));

-- Private objects; the authenticated Next.js image endpoint downloads under caller RLS.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-avatars', 'profile-avatars', false, 5242880,
  array['image/webp']);

create policy profile_avatars_select on storage.objects for select to authenticated
using (bucket_id = 'profile-avatars' and exists
  (select 1 from public.users where id = (select auth.uid()) and status = 'active'));

create policy profile_avatars_insert on storage.objects for insert to authenticated
with check (bucket_id = 'profile-avatars'
  and name = (select auth.uid())::text || '/avatar.webp'
  and exists (select 1 from public.users where id = (select auth.uid()) and status = 'active'));

create policy profile_avatars_update on storage.objects for update to authenticated
using (bucket_id = 'profile-avatars'
  and name = (select auth.uid())::text || '/avatar.webp'
  and exists (select 1 from public.users where id = (select auth.uid()) and status = 'active'))
with check (bucket_id = 'profile-avatars'
  and name = (select auth.uid())::text || '/avatar.webp'
  and exists (select 1 from public.users where id = (select auth.uid()) and status = 'active'));

create policy profile_avatars_delete on storage.objects for delete to authenticated
using (bucket_id = 'profile-avatars'
  and name = (select auth.uid())::text || '/avatar.webp'
  and exists (select 1 from public.users where id = (select auth.uid()) and status = 'active'));

-- A committed lease spans Storage HTTP requests; no transaction stays open between RPCs.
create table public.avatar_mutation_leases (
  user_id uuid primary key references public.users(id) on delete cascade,
  token uuid not null,
  expires_at timestamptz not null
);
alter table public.avatar_mutation_leases enable row level security;
revoke all on public.avatar_mutation_leases from anon, authenticated;

create function public.acquire_avatar_mutation(p_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare acquired uuid;
begin
  if p_token is null or not exists
    (select 1 from public.users where id = auth.uid() and status = 'active') then
    return false;
  end if;
  insert into public.avatar_mutation_leases as leases (user_id, token, expires_at)
  values (auth.uid(), p_token, clock_timestamp() + interval '5 minutes')
  on conflict (user_id) do update
    set token = excluded.token, expires_at = excluded.expires_at
    where leases.expires_at <= clock_timestamp()
  returning token into acquired;
  return acquired is not null;
end;
$$;

create function public.release_avatar_mutation(p_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.avatar_mutation_leases where user_id = auth.uid() and token = p_token;
  return found;
end;
$$;

create function public.persist_avatar_path(p_token uuid, p_path text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  -- Serialize persistence with acquisition/release and fence expired or replaced owners.
  perform 1 from public.avatar_mutation_leases where user_id = auth.uid()
    and token = p_token and expires_at > clock_timestamp() for update;
  if not found or not exists
    (select 1 from public.users where id = auth.uid() and status = 'active') then
    return false;
  end if;
  if p_path is not null and p_path <> auth.uid()::text || '/avatar.webp' then
    return false;
  end if;
  update public.player_profiles set avatar_path = p_path, updated_at = clock_timestamp()
    where user_id = auth.uid();
  return found;
end;
$$;

revoke all on function public.acquire_avatar_mutation(uuid) from public, anon;
revoke all on function public.release_avatar_mutation(uuid) from public, anon;
revoke all on function public.persist_avatar_path(uuid, text) from public, anon;
grant execute on function public.acquire_avatar_mutation(uuid) to authenticated;
grant execute on function public.release_avatar_mutation(uuid) to authenticated;
grant execute on function public.persist_avatar_path(uuid, text) to authenticated;
