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
