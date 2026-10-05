-- Historical and started intervals are immutable to Admin cancellation.
-- Check wall-clock time after acquiring lifecycle locks, including any wait.
create or replace function public.cancel_admin_customer_booking(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  target_booking public.bookings%rowtype;
  target_reservation public.court_reservations%rowtype;
  location_timezone text;
  checked_at timestamptz;
begin
  if not public.has_role('admin') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select * into target_booking from public.bookings where id = p_id for update;
  if not found or target_booking.status <> 'confirmed' then return false; end if;

  select r.* into target_reservation
  from public.court_reservations r
  join public.courts c on c.id = r.court_id and c.is_active
  join public.locations l on l.id = c.location_id and l.is_active and l.archived_at is null
  where r.id = target_booking.reservation_id
  for update of r;
  if not found or target_reservation.status <> 'active' then return false; end if;

  select l.timezone into location_timezone
    from public.courts c join public.locations l on l.id = c.location_id
    where c.id = target_reservation.court_id for share of c, l;
  checked_at := clock_timestamp();
  if checked_at >= (target_reservation.booking_date::timestamp
    + target_reservation.starts_at_minute * interval '1 minute') at time zone location_timezone then
    return false;
  end if;

  update public.bookings set status = 'cancelled' where id = target_booking.id;
  update public.court_reservations
    set status = 'cancelled', cancelled_at = checked_at, cancelled_by_user_id = auth.uid(), updated_at = checked_at
    where id = target_reservation.id;
  perform public.enqueue_booking_email(target_booking.id, 'admin_cancelled', 'cancelled');
  return true;
end;
$$;

create or replace function public.cancel_admin_court_reservation(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  target public.court_reservations%rowtype;
  location_timezone text;
  checked_at timestamptz;
begin
  if not public.has_role('admin') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select r.* into target from public.court_reservations r
    join public.courts c on c.id = r.court_id and c.is_active
    join public.locations l on l.id = c.location_id and l.is_active and l.archived_at is null
    where r.id = p_id and not exists (select 1 from public.bookings b where b.reservation_id = r.id)
    for update of r;
  if not found or target.status <> 'active' then return false; end if;

  select l.timezone into location_timezone
    from public.courts c join public.locations l on l.id = c.location_id
    where c.id = target.court_id for share of c, l;
  checked_at := clock_timestamp();
  if checked_at >= (target.booking_date::timestamp
    + target.starts_at_minute * interval '1 minute') at time zone location_timezone then
    return false;
  end if;

  update public.court_reservations
    set status = 'cancelled', cancelled_at = checked_at, cancelled_by_user_id = auth.uid(), updated_at = checked_at
    where id = target.id;
  return true;
end;
$$;
