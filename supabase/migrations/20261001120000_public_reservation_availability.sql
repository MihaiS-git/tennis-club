-- The public calendar can read occupancy, but not reservation identity or timestamps.
grant select (court_id, booking_date, starts_at_minute, ends_at_minute)
  on public.court_reservations to anon, authenticated;

create policy court_reservations_public_availability on public.court_reservations
  for select to anon, authenticated using (exists (
    select 1 from public.courts c
    join public.locations l on l.id = c.location_id
    where c.id = court_reservations.court_id
      and c.is_active and l.is_active and l.archived_at is null
  ));
