alter table public.court_reservations
add column created_by_user_id uuid references public.users(id) on delete restrict;

revoke insert (court_id, booking_date, starts_at_minute, ends_at_minute, reason)
on public.court_reservations from authenticated;
grant insert (court_id, booking_date, starts_at_minute, ends_at_minute, reason, created_by_user_id)
on public.court_reservations to authenticated;
drop policy court_reservations_direct_insert on public.court_reservations;
create policy court_reservations_direct_insert on public.court_reservations
for insert to authenticated with check (
  ((select public.has_role('admin')) or (select public.has_role('coach')))
  and reason is not null
  and created_by_user_id = (select auth.uid())
  and exists (
    select 1 from public.courts c
    join public.locations l on l.id = c.location_id
    where c.id = court_id and c.is_active and l.is_active and l.archived_at is null
  )
);

-- The public table grant stays limited to occupancy columns. Staff details are
-- exposed through this checked projection, including the row ID used to cancel.
create function public.list_internal_court_reservations(p_court_ids uuid[], p_date date)
returns table (id uuid, court_id uuid, booking_date date, starts_at_minute integer,
  ends_at_minute integer, reason text, created_by_user_id uuid, creator_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.has_role('admin') or public.has_role('coach')) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return query
    select r.id, r.court_id, r.booking_date, r.starts_at_minute, r.ends_at_minute,
      r.reason, r.created_by_user_id,
      nullif(concat_ws(' ', u.first_name, u.last_name), '') as creator_name
    from public.court_reservations r
    join public.courts c on c.id = r.court_id and c.is_active
    join public.locations l on l.id = c.location_id and l.is_active and l.archived_at is null
    left join public.users u on u.id = r.created_by_user_id
    where r.court_id = any(p_court_ids) and r.booking_date = p_date;
end;
$$;
revoke all on function public.list_internal_court_reservations(uuid[], date) from public;
grant execute on function public.list_internal_court_reservations(uuid[], date) to authenticated;

grant delete on public.court_reservations to authenticated;
create policy court_reservations_staff_delete on public.court_reservations
for delete to authenticated using (
  ((select public.has_role('admin')) or (select public.has_role('coach')))
  and exists (
    select 1 from public.courts c join public.locations l on l.id = c.location_id
    where c.id = court_id and c.is_active and l.is_active and l.archived_at is null
  )
);

-- The function accepts only a row ID and rechecks role and resource context.
-- A missing row is a clean false result, including a concurrent deletion.
create function public.cancel_internal_court_reservation(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare removed_id uuid;
begin
  if not (public.has_role('admin') or public.has_role('coach')) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  delete from public.court_reservations r
  using public.courts c, public.locations l
  where r.id = p_id and c.id = r.court_id and c.is_active
    and l.id = c.location_id and l.is_active and l.archived_at is null
  returning r.id into removed_id;
  return removed_id is not null;
end;
$$;
revoke all on function public.cancel_internal_court_reservation(uuid) from public;
grant execute on function public.cancel_internal_court_reservation(uuid) to authenticated;
