-- Existing staff management is replaced by a personal mutation. Timetables read
-- occupancy columns directly; private details remain available only to the owner.
drop function public.list_internal_court_reservations(uuid[], date);
drop function public.cancel_internal_court_reservation(uuid);

revoke update (status, cancelled_at, cancelled_by_user_id)
on public.court_reservations from authenticated;
drop policy court_reservations_staff_cancel on public.court_reservations;

create function public.cancel_own_court_reservation(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed_id uuid;
begin
  if not (public.has_role('admin') or public.has_role('coach')) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  update public.court_reservations r
  set status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = auth.uid(), updated_at = now()
  from public.courts c, public.locations l
  where r.id = p_id and r.status = 'active'
    and r.created_by_user_id = auth.uid()
    and c.id = r.court_id and c.is_active
    and l.id = c.location_id and l.is_active and l.archived_at is null
    and (r.booking_date > (now() at time zone l.timezone)::date
      or (r.booking_date = (now() at time zone l.timezone)::date
        and r.ends_at_minute > extract(hour from now() at time zone l.timezone)::integer * 60
          + extract(minute from now() at time zone l.timezone)::integer))
  returning r.id into changed_id;
  return changed_id is not null;
end;
$$;
revoke all on function public.cancel_own_court_reservation(uuid) from public;
grant execute on function public.cancel_own_court_reservation(uuid) to authenticated;
