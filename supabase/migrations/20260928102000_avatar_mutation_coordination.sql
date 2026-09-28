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
