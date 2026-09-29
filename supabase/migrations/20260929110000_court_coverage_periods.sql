create extension if not exists btree_gist with schema extensions;

-- A native composite FK protects both coverage writes and environment changes,
-- including concurrent transactions. The generated discriminator is never input.
alter table public.courts add constraint courts_id_environment_key unique (id, environment);

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
