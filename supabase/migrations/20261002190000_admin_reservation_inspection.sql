-- Operational details are available only to active admins. The table's public
-- and authenticated SELECT grants remain limited to occupancy columns.
create function public.list_admin_court_reservations(p_court_ids uuid[], p_date date)
returns table (id uuid, court_id uuid, booking_date date, starts_at_minute integer,
  ends_at_minute integer, reason text, created_by_user_id uuid, creator_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_role('admin') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return query
    select r.id, r.court_id, r.booking_date, r.starts_at_minute, r.ends_at_minute,
      r.reason, r.created_by_user_id,
      nullif(concat_ws(' ', u.first_name, u.last_name), '')
    from public.court_reservations r
    join public.courts c on c.id = r.court_id and c.is_active
    join public.locations l on l.id = c.location_id and l.is_active and l.archived_at is null
    left join public.users u on u.id = r.created_by_user_id
    where r.court_id = any(p_court_ids) and r.booking_date = p_date and r.status = 'active';
end;
$$;

revoke all on function public.list_admin_court_reservations(uuid[], date) from public;
grant execute on function public.list_admin_court_reservations(uuid[], date) to authenticated;
