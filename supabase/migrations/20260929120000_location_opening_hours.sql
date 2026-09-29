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
