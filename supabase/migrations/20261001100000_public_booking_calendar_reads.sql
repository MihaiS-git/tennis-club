-- Public calendar configuration is visible only for active club resources.
grant select on public.location_opening_hours, public.court_coverage_periods,
  public.location_pricing_rules to anon;

create policy location_opening_hours_public_select on public.location_opening_hours
  for select to anon, authenticated using (exists (
    select 1 from public.locations l
    where l.id = location_id and l.is_active and l.archived_at is null
  ));

create policy court_coverage_public_select on public.court_coverage_periods
  for select to anon, authenticated using (exists (
    select 1 from public.courts c
    where c.id = court_id and c.is_active
  ));

create policy location_pricing_public_select on public.location_pricing_rules
  for select to anon, authenticated using (exists (
    select 1 from public.courts c
    where c.id = location_pricing_rules.court_id
      and c.location_id = location_pricing_rules.location_id and c.is_active
  ));
