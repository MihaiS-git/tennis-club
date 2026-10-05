-- Keep the booking lifecycle and its physical occupancy in one transaction.
-- Lock the booking first so concurrent cancellation attempts serialize.
create function public.cancel_admin_customer_booking(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  target_booking public.bookings%rowtype;
  target_reservation public.court_reservations%rowtype;
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

  update public.bookings set status = 'cancelled' where id = target_booking.id;
  update public.court_reservations
    set status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = auth.uid(), updated_at = now()
    where id = target_reservation.id;
  return true;
end;
$$;

revoke all on function public.cancel_admin_customer_booking(uuid) from public, anon;
grant execute on function public.cancel_admin_customer_booking(uuid) to authenticated;
