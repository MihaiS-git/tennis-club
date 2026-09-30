create extension if not exists btree_gist with schema extensions;

-- The parent gives a logical definition stable identity and a lock across replacements.
create table public.pricing_rule_sets (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id),
  created_at timestamptz not null default now(),
  unique (id, location_id)
);

alter table public.courts add constraint courts_pricing_target_key unique (id, location_id, environment);

create table public.location_pricing_rules (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id),
  rule_set_id uuid not null,
  court_id uuid not null,
  court_environment text generated always as (
    case when court_state = 'indoor' then 'indoor' else 'outdoor' end
  ) stored,
  constraint pricing_rule_set_fk foreign key (rule_set_id, location_id)
    references public.pricing_rule_sets(id, location_id) on delete cascade,
  constraint pricing_court_fk foreign key (court_id, location_id, court_environment)
    references public.courts(id, location_id, environment),
  court_state text not null check (court_state in ('outdoor', 'covered', 'indoor')),
  weekday integer not null check (weekday between 0 and 6),
  starts_at_minute integer not null check (starts_at_minute between 0 and 1439),
  ends_at_minute integer not null check (ends_at_minute between 1 and 1440),
  starts_on date,
  ends_on date,
  price_per_hour_minor integer not null check (price_per_hour_minor > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint location_pricing_positive_interval check (starts_at_minute < ends_at_minute),
  constraint location_pricing_dates_check check (
    (starts_on is null or isfinite(starts_on)) and
    (ends_on is null or isfinite(ends_on)) and
    (starts_on is null or ends_on is null or starts_on <= ends_on)
  ),
  -- Monday = 0. Dates are inclusive; null date bounds are unbounded.
  -- Times are half-open, so adjacent intervals do not conflict.
  constraint location_pricing_no_overlap exclude using gist (
    court_id with =, court_state with =, weekday with =,
    daterange(starts_on, ends_on, '[]') with &&,
    int4range(starts_at_minute, ends_at_minute, '[)') with &&
  )
);

create index location_pricing_rule_set_idx on public.location_pricing_rules(rule_set_id);

alter table public.pricing_rule_sets enable row level security;
revoke all on public.pricing_rule_sets from anon, authenticated;
grant select, delete on public.pricing_rule_sets to authenticated;
grant insert (location_id) on public.pricing_rule_sets to authenticated;
-- SELECT FOR UPDATE needs UPDATE privilege; immutable metadata stays protected.
grant update (id) on public.pricing_rule_sets to authenticated;
create policy pricing_rule_sets_admin on public.pricing_rule_sets
  for all to authenticated using ((select public.has_role('admin')))
  with check ((select public.has_role('admin')));

alter table public.location_pricing_rules enable row level security;
revoke all on public.location_pricing_rules from anon, authenticated;
grant select, delete on public.location_pricing_rules to authenticated;
grant insert (location_id, rule_set_id, court_id, court_state, weekday, starts_at_minute, ends_at_minute, starts_on, ends_on, price_per_hour_minor, updated_at)
  on public.location_pricing_rules to authenticated;
create policy location_pricing_admin_select on public.location_pricing_rules
  for select to authenticated using ((select public.has_role('admin')));
create policy location_pricing_admin_insert on public.location_pricing_rules
  for insert to authenticated with check ((select public.has_role('admin')));
create policy location_pricing_admin_delete on public.location_pricing_rules
  for delete to authenticated using ((select public.has_role('admin')));

-- Invoker functions retain user-scoped RLS. Next.js validates the definition;
-- PostgreSQL expands and commits persistence, with exclusion/FK integrity.
create function public.save_pricing_rule_set(
  p_rule_set_id uuid, p_location_id uuid, p_court_ids uuid[], p_weekdays integer[],
  p_court_state text, p_starts_at_minute integer, p_ends_at_minute integer,
  p_starts_on date, p_ends_on date, p_price_per_hour_minor integer, p_updated_at timestamptz
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  target_id uuid;
begin
  if not public.has_role('admin') then
    raise exception 'Administrator required' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_court_ids), 0) = 0 or coalesce(cardinality(p_weekdays), 0) = 0 then
    raise exception 'Empty pricing applicability' using errcode = '23514';
  end if;
  if p_rule_set_id is null then
    insert into public.pricing_rule_sets(location_id) values (p_location_id) returning id into target_id;
  else
    select id into target_id from public.pricing_rule_sets
      where id = p_rule_set_id and location_id = p_location_id for update;
    if not found then return null; end if;
    delete from public.location_pricing_rules where rule_set_id = target_id;
  end if;
  insert into public.location_pricing_rules (
    rule_set_id, location_id, court_id, court_state, weekday, starts_at_minute, ends_at_minute,
    starts_on, ends_on, price_per_hour_minor, updated_at
  ) select target_id, p_location_id, court_id, p_court_state, weekday, p_starts_at_minute, p_ends_at_minute,
    p_starts_on, p_ends_on, p_price_per_hour_minor, p_updated_at
    from unnest(p_court_ids) as courts(court_id) cross join unnest(p_weekdays) as days(weekday);
  return target_id;
end;
$$;

create function public.remove_pricing_rule_set(p_rule_set_id uuid, p_location_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  target_id uuid;
begin
  if not public.has_role('admin') then
    raise exception 'Administrator required' using errcode = '42501';
  end if;
  select id into target_id from public.pricing_rule_sets
    where id = p_rule_set_id and location_id = p_location_id for update;
  if not found then return null; end if;
  delete from public.pricing_rule_sets where id = target_id;
  return target_id;
end;
$$;
revoke all on function public.save_pricing_rule_set(uuid, uuid, uuid[], integer[], text, integer, integer, date, date, integer, timestamptz) from public, anon;
grant execute on function public.save_pricing_rule_set(uuid, uuid, uuid[], integer[], text, integer, integer, date, date, integer, timestamptz) to authenticated;
revoke all on function public.remove_pricing_rule_set(uuid, uuid) from public, anon;
grant execute on function public.remove_pricing_rule_set(uuid, uuid) to authenticated;
