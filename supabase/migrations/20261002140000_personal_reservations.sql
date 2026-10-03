-- Personal activity includes cancelled rows and private metadata. Keep it behind
-- a staff check and bind ownership to auth.uid(), never a caller-supplied ID.
create function public.list_personal_court_reservations()
returns table (id uuid, booking_date date, starts_at_minute integer, ends_at_minute integer,
  reason text, status public.court_reservation_status, created_by_user_id uuid,
  creator_name text, cancelled_at timestamptz, cancelled_by_name text,
  location_name text, location_timezone text, court_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.has_role('admin') or public.has_role('coach')) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return query
    select r.id, r.booking_date, r.starts_at_minute, r.ends_at_minute,
      r.reason, r.status, r.created_by_user_id,
      nullif(concat_ws(' ', creator.first_name, creator.last_name), ''),
      r.cancelled_at,
      nullif(concat_ws(' ', canceller.first_name, canceller.last_name), ''),
      l.name, l.timezone, c.name
    from public.court_reservations r
    join public.courts c on c.id = r.court_id
    join public.locations l on l.id = c.location_id
    left join public.users creator on creator.id = r.created_by_user_id
    left join public.users canceller on canceller.id = r.cancelled_by_user_id
    where r.created_by_user_id = (select auth.uid());
end;
$$;

revoke all on function public.list_personal_court_reservations() from public;
grant execute on function public.list_personal_court_reservations() to authenticated;
