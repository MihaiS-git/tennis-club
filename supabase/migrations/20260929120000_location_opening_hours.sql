create extension if not exists btree_gist with schema extensions;

-- Recurring local wall-clock hours: Monday = 0, Sunday = 6.
create table public.location_opening_hours (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id),
  weekday integer not null check (weekday between 0 and 6),
  opens_at_minute integer not null check (opens_at_minute between 0 and 1439),
  closes_at_minute integer not null check (closes_at_minute between 1 and 1440),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint location_opening_hours_positive_interval check (opens_at_minute < closes_at_minute),
  constraint location_opening_hours_no_overlap exclude using gist (
    location_id with =,
    weekday with =,
    int4range(opens_at_minute, closes_at_minute, '[)') with &&
  )
);

alter table public.location_opening_hours enable row level security;
revoke all on public.location_opening_hours from anon, authenticated;
grant select, delete on public.location_opening_hours to authenticated;
grant insert (location_id, weekday, opens_at_minute, closes_at_minute, updated_at)
  on public.location_opening_hours to authenticated;
grant update (weekday, opens_at_minute, closes_at_minute, updated_at)
  on public.location_opening_hours to authenticated;
create policy location_opening_hours_admin_select on public.location_opening_hours
  for select to authenticated using ((select public.has_role('admin')));
create policy location_opening_hours_admin_insert on public.location_opening_hours
  for insert to authenticated with check ((select public.has_role('admin')));
create policy location_opening_hours_admin_update on public.location_opening_hours
  for update to authenticated using ((select public.has_role('admin')))
  with check ((select public.has_role('admin')));
create policy location_opening_hours_admin_delete on public.location_opening_hours
  for delete to authenticated using ((select public.has_role('admin')));

-- One invoker transaction replaces selected logical intervals across weekdays.
-- The location lock serializes editor operations; the exclusion constraint remains authoritative.
create function public.mutate_location_opening_hours(
  p_location_id uuid, p_weekdays integer[], p_replace_ids uuid[],
  p_opens_at_minutes integer[], p_closes_at_minutes integer[]
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  conflict_days integer[];
  existing_count integer;
begin
  if not public.has_role('admin') then
    raise exception 'Administrator required' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_weekdays), 0) = 0
    or exists (select 1 from unnest(p_weekdays) day where day not between 0 and 6)
    or (select count(distinct day) from unnest(p_weekdays) day) <> cardinality(p_weekdays)
    or p_replace_ids is null or cardinality(p_replace_ids) <> (select count(distinct id) from unnest(p_replace_ids) id)
    or p_opens_at_minutes is null or p_closes_at_minutes is null
    or cardinality(p_opens_at_minutes) <> cardinality(p_closes_at_minutes)
    or (cardinality(p_replace_ids) = 0 and cardinality(p_opens_at_minutes) = 0)
    or exists (select 1 from unnest(p_opens_at_minutes, p_closes_at_minutes) proposed(opens, closes)
      where opens is null or closes is null or opens not between 0 and 1439
        or closes not between 1 and 1440 or opens >= closes) then
    raise exception 'Invalid weekly opening hours' using errcode = '23514';
  end if;

  perform 1 from public.locations where id = p_location_id for update;
  if not found then return jsonb_build_object('status', 'not-found'); end if;
  select count(*) into existing_count from public.location_opening_hours
    where location_id = p_location_id and id = any(p_replace_ids);
  if existing_count <> cardinality(p_replace_ids) then
    return jsonb_build_object('status', 'not-found');
  end if;

  begin
    delete from public.location_opening_hours
      where location_id = p_location_id and id = any(p_replace_ids);
    insert into public.location_opening_hours
      (location_id, weekday, opens_at_minute, closes_at_minute, updated_at)
    select p_location_id, day, proposed.opens, proposed.closes, now()
      from unnest(p_weekdays) day
      cross join unnest(p_opens_at_minutes, p_closes_at_minutes) proposed(opens, closes);
  exception when exclusion_violation then
    select array_agg(distinct existing.weekday order by existing.weekday) into conflict_days
      from public.location_opening_hours existing
      join unnest(p_weekdays) day on day = existing.weekday
      cross join unnest(p_opens_at_minutes, p_closes_at_minutes) proposed(opens, closes)
      where existing.location_id = p_location_id and existing.id <> all(p_replace_ids)
        and int4range(existing.opens_at_minute, existing.closes_at_minute, '[)')
          && int4range(proposed.opens, proposed.closes, '[)');
    return jsonb_build_object('status', 'overlap', 'weekdays', coalesce(conflict_days, p_weekdays));
  end;
  return jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.mutate_location_opening_hours(uuid, integer[], uuid[], integer[], integer[]) from public, anon;
grant execute on function public.mutate_location_opening_hours(uuid, integer[], uuid[], integer[], integer[]) to authenticated;
