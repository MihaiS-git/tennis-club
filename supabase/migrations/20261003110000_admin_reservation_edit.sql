-- Keep the Admin edit token inside the existing Admin-only availability read.
create or replace function public.read_admin_reservation_edit_availability(p_id uuid, p_date date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  target record;
  occupied jsonb;
begin
  if not public.has_role('admin') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select r.id, r.court_id, r.booking_date, r.starts_at_minute, r.ends_at_minute,
    r.reason, r.updated_at, c.location_id, l.timezone
  into target
  from public.court_reservations r
  join public.courts c on c.id = r.court_id and c.is_active
  join public.locations l on l.id = c.location_id and l.is_active and l.archived_at is null
  where r.id = p_id and r.status = 'active';
  if not found then raise exception 'Not authorized' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'court_id', other.court_id,
    'starts_at_minute', other.starts_at_minute,
    'ends_at_minute', other.ends_at_minute
  )), '[]'::jsonb) into occupied
  from public.court_reservations other
  join public.courts other_court on other_court.id = other.court_id and other_court.is_active
  where other_court.location_id = target.location_id
    and other.booking_date = p_date and other.status = 'active' and other.id <> p_id;

  return jsonb_build_object(
    'location_id', target.location_id,
    'location_timezone', target.timezone,
    'court_id', target.court_id,
    'booking_date', target.booking_date,
    'starts_at_minute', target.starts_at_minute,
    'ends_at_minute', target.ends_at_minute,
    'reason', target.reason,
    'updated_at', target.updated_at,
    'occupancy', occupied
  );
end;
$$;

-- This operation is separate from the owner-only edit RPC. A row lock and
-- conditional version check make a failed or racing edit leave the row intact.
create function public.edit_admin_court_reservation(
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
  if not found or previous.status <> 'active' then return 'unavailable'; end if;
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
revoke all on function public.edit_admin_court_reservation(uuid, timestamptz, text, boolean, uuid, date, integer, integer) from public;
grant execute on function public.edit_admin_court_reservation(uuid, timestamptz, text, boolean, uuid, date, integer, integer) to authenticated;
