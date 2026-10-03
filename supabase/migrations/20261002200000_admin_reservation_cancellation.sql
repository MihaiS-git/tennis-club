-- Operational cancellation is separate from the owner-only personal function.
-- A conditional UPDATE serializes concurrent attempts on the same active row.
create function public.cancel_admin_court_reservation(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed_id uuid;
begin
  if not public.has_role('admin') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  update public.court_reservations r
  set status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = auth.uid(), updated_at = now()
  from public.courts c, public.locations l
  where r.id = p_id and r.status = 'active'
    and c.id = r.court_id and c.is_active
    and l.id = c.location_id and l.is_active and l.archived_at is null
  returning r.id into changed_id;
  return changed_id is not null;
end;
$$;

revoke all on function public.cancel_admin_court_reservation(uuid) from public;
grant execute on function public.cancel_admin_court_reservation(uuid) to authenticated;
