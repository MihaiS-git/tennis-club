-- Dedicated self-service boundary. Admin operational cancellation and direct
-- reservation cancellation remain separate. No caller-supplied clock or identity.
create function public.cancel_own_customer_booking(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  target_booking public.bookings%rowtype;
  target_reservation public.court_reservations%rowtype;
  location_timezone text;
  booking_start timestamptz;
  checked_at timestamptz;
begin
  perform 1 from public.users u
    where u.id = (select auth.uid()) and u.status = 'active' for share;
  if not found then raise exception 'Not authorized' using errcode = '42501'; end if;

  select * into target_booking from public.bookings b
    where b.id = p_id and b.account_user_id = (select auth.uid()) for update;
  if not found or target_booking.status <> 'confirmed' then return 'unavailable'; end if;

  select r.* into target_reservation
    from public.court_reservations r where r.id = target_booking.reservation_id for update;
  if not found or target_reservation.status <> 'active' then return 'unavailable'; end if;
  select l.timezone into location_timezone
    from public.courts c join public.locations l on l.id = c.location_id
    where c.id = target_reservation.court_id for share of c, l;
  if not found then return 'unavailable'; end if;

  booking_start := (target_reservation.booking_date::timestamp
    + target_reservation.starts_at_minute * interval '1 minute') at time zone location_timezone;
  -- Check wall-clock time AFTER acquiring lifecycle locks, including any wait.
  checked_at := clock_timestamp();
  if checked_at >= booking_start then return 'started'; end if;
  if not (public.has_role('admin') or public.has_role('coach'))
    and checked_at > booking_start - target_booking.cancellation_notice_minutes * interval '1 minute' then
    return 'notice_required';
  end if;

  update public.bookings set status = 'cancelled' where id = target_booking.id;
  if not found then raise exception 'Cancellation failed' using errcode = '23514'; end if;
  update public.court_reservations
    set status = 'cancelled', cancelled_at = checked_at,
      cancelled_by_user_id = auth.uid(), updated_at = checked_at
    where id = target_reservation.id;
  if not found then raise exception 'Cancellation failed' using errcode = '23514'; end if;
  return 'cancelled';
end;
$$;
revoke all on function public.cancel_own_customer_booking(uuid) from public, anon;
grant execute on function public.cancel_own_customer_booking(uuid) to authenticated;
