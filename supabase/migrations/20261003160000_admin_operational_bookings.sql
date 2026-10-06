-- One row per active operational interval, with booking snapshots visible only
-- through this active-Admin projection. Direct-reservation management remains
-- separate from customer booking inspection.
create function public.list_admin_operational_occupancy(p_court_ids uuid[], p_date date)
returns table (
  kind text, id uuid, court_id uuid, booking_date date,
  starts_at_minute integer, ends_at_minute integer,
  reason text, created_by_user_id uuid, creator_name text,
  customer_name text, customer_email text, customer_phone text,
  total_amount_minor integer, currency text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.has_role('admin') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select case when b.id is null then 'reservation' else 'booking' end,
      coalesce(b.id, r.id), r.court_id, r.booking_date,
      r.starts_at_minute, r.ends_at_minute,
      case when b.id is null then r.reason else null end,
      case when b.id is null then r.created_by_user_id else null end,
      case when b.id is null then nullif(concat_ws(' ', u.first_name, u.last_name), '') else null end,
      b.customer_name, b.customer_email, b.customer_phone,
      b.total_amount_minor, b.currency
    from public.court_reservations r
    join public.courts c on c.id = r.court_id and c.is_active
    join public.locations l on l.id = c.location_id and l.is_active and l.archived_at is null
    left join public.bookings b on b.reservation_id = r.id
    left join public.users u on u.id = r.created_by_user_id and b.id is null
    where r.court_id = any(p_court_ids) and r.booking_date = p_date
      and r.status = 'active' and (b.id is null or b.status = 'confirmed');
end;
$$;

revoke all on function public.list_admin_operational_occupancy(uuid[], date) from public, anon;
grant execute on function public.list_admin_operational_occupancy(uuid[], date) to authenticated;

-- Existing direct-reservation functions exclude every linked booking.

create or replace function public.cancel_admin_court_reservation(p_id uuid)
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
    and not exists (select 1 from public.bookings b where b.reservation_id = r.id)
  returning r.id into changed_id;
  return changed_id is not null;
end;
$$;

create or replace function public.edit_admin_court_reservation(
  p_id uuid, p_expected_updated_at timestamptz, p_reason text, p_schedule boolean,
  p_court_id uuid, p_booking_date date, p_starts_at_minute integer, p_ends_at_minute integer
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  previous public.court_reservations%rowtype;
  old_timezone text;
  old_location_id uuid;
  target_location_id uuid;
  old_today date;
  old_minute integer;
begin
  if not public.has_role('admin') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select * into previous from public.court_reservations where id = p_id for update;
  if not found or previous.status <> 'active' or
    exists (select 1 from public.bookings b where b.reservation_id = p_id) then return 'unavailable'; end if;
  if previous.updated_at is distinct from p_expected_updated_at then return 'stale'; end if;
  select l.timezone, c.location_id into old_timezone, old_location_id from public.courts c
    join public.locations l on l.id = c.location_id and l.is_active and l.archived_at is null
    where c.id = previous.court_id and c.is_active;
  if not found then return 'unavailable'; end if;
  old_today := (now() at time zone old_timezone)::date;
  old_minute := extract(hour from now() at time zone old_timezone)::integer * 60
    + extract(minute from now() at time zone old_timezone)::integer;
  if previous.booking_date < old_today or
    (previous.booking_date = old_today and previous.ends_at_minute <= old_minute) then
    return 'unavailable';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 255 or p_schedule is null then
    raise exception 'Invalid reservation edit' using errcode = '22023';
  end if;
  if not p_schedule then
    if p_court_id is not null or p_booking_date is not null or
      p_starts_at_minute is not null or p_ends_at_minute is not null then
      raise exception 'Invalid reason-only edit' using errcode = '22023';
    end if;
    update public.court_reservations
      set reason = btrim(p_reason),
        updated_at = greatest(clock_timestamp(), previous.updated_at + interval '1 microsecond')
      where id = p_id;
    return 'updated';
  end if;
  if previous.booking_date < old_today or
    (previous.booking_date = old_today and previous.starts_at_minute <= old_minute) then
    return 'unavailable';
  end if;
  if p_court_id is null or p_booking_date is null or
    p_starts_at_minute is null or p_ends_at_minute is null then
    raise exception 'Invalid schedule edit' using errcode = '22023';
  end if;
  select c.location_id into target_location_id
    from public.courts c join public.locations l on l.id = c.location_id
    where c.id = p_court_id and c.is_active and l.is_active and l.archived_at is null;
  if not found or target_location_id is distinct from old_location_id then return 'unavailable'; end if;
  if p_booking_date < (now() at time zone old_timezone)::date or
    (p_booking_date = (now() at time zone old_timezone)::date and
      p_starts_at_minute < extract(hour from now() at time zone old_timezone)::integer * 60
        + extract(minute from now() at time zone old_timezone)::integer) then
    return 'unavailable';
  end if;
  if not exists (
    select 1 from public.location_opening_hours h where h.location_id = old_location_id
      and h.weekday = extract(isodow from p_booking_date)::integer - 1
      and h.opens_at_minute <= p_starts_at_minute and p_ends_at_minute <= h.closes_at_minute
  ) then return 'unavailable'; end if;
  update public.court_reservations
    set court_id = p_court_id, booking_date = p_booking_date,
      starts_at_minute = p_starts_at_minute, ends_at_minute = p_ends_at_minute,
      reason = btrim(p_reason),
      updated_at = greatest(clock_timestamp(), previous.updated_at + interval '1 microsecond')
    where id = p_id;
  return 'updated';
end;
$$;
