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
