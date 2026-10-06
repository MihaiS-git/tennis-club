create type public.court_reservation_status as enum ('active', 'cancelled');

alter table public.court_reservations
  add column status public.court_reservation_status not null default 'active',
  add column cancelled_at timestamptz,
  add column cancelled_by_user_id uuid references public.users(id) on delete restrict,
  add constraint court_reservation_cancellation_check check (
    (status = 'active' and cancelled_at is null and cancelled_by_user_id is null)
    or (status = 'cancelled' and cancelled_at is not null and cancelled_by_user_id is not null)
  );

alter table public.court_reservations
  drop constraint court_reservation_no_overlap;
alter table public.court_reservations
  add constraint court_reservation_no_overlap exclude using gist (
    court_id with =,
    booking_date with =,
    int4range(starts_at_minute, ends_at_minute, '[)') with &&
  ) where (status = 'active');

drop policy court_reservations_public_availability on public.court_reservations;
create policy court_reservations_public_availability on public.court_reservations
  for select to anon, authenticated using (
    status = 'active' and exists (
      select 1 from public.courts c
      join public.locations l on l.id = c.location_id
      where c.id = court_reservations.court_id
        and c.is_active and l.is_active and l.archived_at is null
    )
  );


revoke delete on public.court_reservations from authenticated;
drop policy court_reservations_staff_delete on public.court_reservations;

grant update (status, cancelled_at, cancelled_by_user_id)
on public.court_reservations to authenticated;
create policy court_reservations_staff_cancel on public.court_reservations
for update to authenticated using (
  status = 'active'
  and ((select public.has_role('admin')) or (select public.has_role('coach')))
  and exists (
    select 1 from public.courts c join public.locations l on l.id = c.location_id
    where c.id = court_id and c.is_active and l.is_active and l.archived_at is null
  )
) with check (
  status = 'cancelled'
  and cancelled_at is not null
  and cancelled_by_user_id = (select auth.uid())
  and ((select public.has_role('admin')) or (select public.has_role('coach')))
);

-- The conditional UPDATE locks the row and makes concurrent attempts idempotent:
-- after the first commit, another attempt no longer matches status = active.
create or replace function public.cancel_internal_court_reservation(p_id uuid)
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
    and c.id = r.court_id and c.is_active
    and l.id = c.location_id and l.is_active and l.archived_at is null
  returning r.id into changed_id;
  return changed_id is not null;
end;
$$;
