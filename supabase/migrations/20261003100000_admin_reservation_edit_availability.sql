-- Admin edit availability is a read of one active reservation and other active
-- occupancy at its fixed location. The personal owner-only read stays unchanged.
create function public.read_admin_reservation_edit_availability(p_id uuid, p_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  target record;
  occupied jsonb;
begin
  if not public.has_role('admin') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select r.id, r.court_id, r.booking_date, r.starts_at_minute, r.ends_at_minute,
    r.reason, c.location_id, l.timezone
  into target
  from public.court_reservations r
  join public.courts c on c.id = r.court_id and c.is_active
  join public.locations l on l.id = c.location_id and l.is_active and l.archived_at is null
  where r.id = p_id and r.status = 'active';
  if not found then raise exception 'Not authorized' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'court_id', other.court_id,
    'starts_at_minute', other.starts_at_minute,
    'ends_at_minute', other.ends_at_minute
  )), '[]'::jsonb) into occupied
  from public.court_reservations other
  join public.courts other_court on other_court.id = other.court_id and other_court.is_active
  where other_court.location_id = target.location_id
    and other.booking_date = p_date and other.status = 'active' and other.id <> p_id;

  return jsonb_build_object(
    'location_id', target.location_id,
    'location_timezone', target.timezone,
    'court_id', target.court_id,
    'booking_date', target.booking_date,
    'starts_at_minute', target.starts_at_minute,
    'ends_at_minute', target.ends_at_minute,
    'reason', target.reason,
    'occupancy', occupied
  );
end;
$$;

revoke all on function public.read_admin_reservation_edit_availability(uuid, date) from public;
grant execute on function public.read_admin_reservation_edit_availability(uuid, date) to authenticated;
