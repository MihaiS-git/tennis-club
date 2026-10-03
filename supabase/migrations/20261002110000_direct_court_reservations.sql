-- Internal operations may use unpublished active locations and courts.
create policy locations_coach_select on public.locations for select to authenticated
using ((select public.has_role('coach')) and is_active and archived_at is null);
create policy courts_coach_select on public.courts for select to authenticated
using ((select public.has_role('coach')) and is_active and exists (
  select 1 from public.locations l
  where l.id = location_id and l.is_active and l.archived_at is null
));
create policy location_opening_hours_coach_select on public.location_opening_hours
for select to authenticated using ((select public.has_role('coach')) and exists (
  select 1 from public.locations l
  where l.id = location_id and l.is_active and l.archived_at is null
));

grant insert (court_id, booking_date, starts_at_minute, ends_at_minute, reason)
on public.court_reservations to authenticated;
create policy court_reservations_direct_insert on public.court_reservations
for insert to authenticated with check (
  ((select public.has_role('admin')) or (select public.has_role('coach')))
  and reason is not null
  and exists (
    select 1 from public.courts c
    join public.locations l on l.id = c.location_id
    where c.id = court_id and c.is_active and l.is_active and l.archived_at is null
  )
);
