-- Physical locations of one club, not tenants.
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  address_line1 text,
  address_line2 text,
  city text,
  postal_code text,
  country_code text,
  timezone text not null,
  currency text not null default 'EUR'
    constraint locations_currency_check check (currency in ('EUR', 'USD', 'GBP', 'RON', 'CHF')),
  is_active boolean not null default true,
  archived_at timestamptz,
  constraint locations_archived_inactive_check check (archived_at is null or not is_active),
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.courts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id),
  name text not null,
  slug text not null,
  surface text not null check (surface in ('clay', 'hard', 'grass', 'carpet')),
  environment text not null check (environment in ('outdoor', 'indoor')),
  has_lighting boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, slug),
  constraint courts_id_environment_key unique (id, environment)
);

alter table public.locations enable row level security;
alter table public.courts enable row level security;
revoke all on public.locations, public.courts from anon, authenticated;
grant select on public.locations, public.courts to anon, authenticated;

create policy locations_select on public.locations for select to anon, authenticated
using (is_active and archived_at is null);
-- Separate authenticated policies keep the admin helper out of anonymous reads.
create policy locations_admin_select on public.locations for select to authenticated
using ((select public.has_role('admin')));
grant insert (name, slug, address_line1, address_line2, city, postal_code,
  country_code, timezone, currency, is_active, display_order, updated_at)
  on public.locations to authenticated;
grant update (name, address_line1, address_line2, city, postal_code,
  country_code, timezone, currency, is_active, display_order, archived_at, updated_at)
  on public.locations to authenticated;
create policy locations_admin_insert on public.locations for insert to authenticated
with check ((select public.has_role('admin')));
create policy locations_admin_update on public.locations for update to authenticated
using ((select public.has_role('admin')))
with check ((select public.has_role('admin')));
create policy courts_select on public.courts for select to anon, authenticated
using (is_active and exists (
  select 1 from public.locations where id = courts.location_id and is_active and archived_at is null
));
create policy courts_admin_select on public.courts for select to authenticated
using ((select public.has_role('admin')));
grant insert (location_id, name, slug, surface, environment, has_lighting,
  is_active, updated_at) on public.courts to authenticated;
grant update (location_id, name, surface, environment, has_lighting,
  is_active, updated_at) on public.courts to authenticated;
create policy courts_admin_insert on public.courts for insert to authenticated
with check ((select public.has_role('admin')));
create policy courts_admin_update on public.courts for update to authenticated
using ((select public.has_role('admin')))
with check ((select public.has_role('admin')));

create extension if not exists btree_gist with schema extensions;

-- A native composite FK protects both coverage writes and environment changes,
-- including concurrent transactions. The generated discriminator is never input.
create table public.court_coverage_periods (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null,
  court_environment text generated always as ('outdoor'::text) stored,
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint court_coverage_outdoor_fk foreign key (court_id, court_environment)
    references public.courts (id, environment),
  constraint court_coverage_dates_check check (
    starts_on <= ends_on and isfinite(starts_on) and isfinite(ends_on)
  ),
  constraint court_coverage_no_overlap exclude using gist (
    court_id with =, daterange(starts_on, ends_on, '[]') with &&
  )
);

alter table public.court_coverage_periods enable row level security;
revoke all on public.court_coverage_periods from anon, authenticated;
grant select, delete on public.court_coverage_periods to authenticated;
grant insert (court_id, starts_on, ends_on, updated_at)
  on public.court_coverage_periods to authenticated;
grant update (starts_on, ends_on, updated_at)
  on public.court_coverage_periods to authenticated;
create policy court_coverage_admin_select on public.court_coverage_periods
  for select to authenticated using ((select public.has_role('admin')));
create policy court_coverage_admin_insert on public.court_coverage_periods
  for insert to authenticated with check ((select public.has_role('admin')));
create policy court_coverage_admin_update on public.court_coverage_periods
  for update to authenticated using ((select public.has_role('admin')))
  with check ((select public.has_role('admin')));
create policy court_coverage_admin_delete on public.court_coverage_periods
  for delete to authenticated using ((select public.has_role('admin')));

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
  for insert to authenticated with check (
    (select public.has_role('admin')) and exists (
      select 1 from public.locations
      where id = location_opening_hours.location_id and archived_at is null
    )
  );
create policy location_opening_hours_admin_update on public.location_opening_hours
  for update to authenticated using (
    (select public.has_role('admin')) and exists (
      select 1 from public.locations
      where id = location_opening_hours.location_id and archived_at is null
    )
  )
  with check (
    (select public.has_role('admin')) and exists (
      select 1 from public.locations
      where id = location_opening_hours.location_id and archived_at is null
    )
  );
create policy location_opening_hours_admin_delete on public.location_opening_hours
  for delete to authenticated using (
    (select public.has_role('admin')) and exists (
      select 1 from public.locations
      where id = location_opening_hours.location_id and archived_at is null
    )
  );

-- One invoker transaction replaces selected logical intervals across weekdays.
-- The location lock serializes editor operations; the exclusion constraint remains authoritative.
create function public.mutate_location_opening_hours(
  p_location_id uuid, p_weekdays integer[], p_replace_ids uuid[],
  p_opens_at_minutes integer[], p_closes_at_minutes integer[]
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  conflict_days integer[];
  existing_count integer;
  location_archived_at timestamptz;
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

  select archived_at into location_archived_at from public.locations where id = p_location_id for update;
  if not found then return jsonb_build_object('status', 'not-found'); end if;
  if location_archived_at is not null then return jsonb_build_object('status', 'archived'); end if;
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
