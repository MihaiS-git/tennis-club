-- Lock and compare the row version before changing the same reservation row.
-- TypeScript validates the requested schedule; the database protects ownership,
-- lifecycle, stale edits, active resources and the existing exclusion constraint.
create function public.edit_own_court_reservation(
  p_id uuid, p_expected_updated_at timestamptz, p_reason text, p_schedule boolean,
  p_court_id uuid, p_booking_date date, p_starts_at_minute integer, p_ends_at_minute integer
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  previous public.court_reservations%rowtype;
  old_timezone text;
  target_location_id uuid;
  target_timezone text;
  old_today date;
  old_minute integer;
begin
  if not (public.has_role('admin') or public.has_role('coach')) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select * into previous from public.court_reservations where id = p_id for update;
  if not found or previous.created_by_user_id is distinct from auth.uid() or previous.status <> 'active' then
    return 'unavailable';
  end if;
  if previous.updated_at is distinct from p_expected_updated_at then
    return 'stale';
  end if;
  select l.timezone into old_timezone from public.courts c
    join public.locations l on l.id = c.location_id where c.id = previous.court_id;
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
  select c.location_id, l.timezone into target_location_id, target_timezone
    from public.courts c join public.locations l on l.id = c.location_id
    where c.id = p_court_id and c.is_active and l.is_active and l.archived_at is null;
  if not found then return 'unavailable'; end if;
  if p_booking_date < (now() at time zone target_timezone)::date or
    (p_booking_date = (now() at time zone target_timezone)::date and
      p_starts_at_minute < extract(hour from now() at time zone target_timezone)::integer * 60
        + extract(minute from now() at time zone target_timezone)::integer) then
    return 'unavailable';
  end if;
  if not exists (
    select 1 from public.location_opening_hours h where h.location_id = target_location_id
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
revoke all on function public.edit_own_court_reservation(uuid, timestamptz, text, boolean, uuid, date, integer, integer) from public;
grant execute on function public.edit_own_court_reservation(uuid, timestamptz, text, boolean, uuid, date, integer, integer) to authenticated;
