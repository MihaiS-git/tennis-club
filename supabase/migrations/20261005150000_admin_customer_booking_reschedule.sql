-- Booking-specific read: direct-reservation edit RPCs deliberately exclude bookings.
create or replace function public.read_customer_booking_edit_availability(p_id uuid, p_date date, p_owner boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare target record; occupied jsonb;
begin
  if p_owner then
    if not exists (select 1 from public.users u where u.id = auth.uid() and u.status = 'active') then raise exception 'Not authorized' using errcode = '42501'; end if;
  elsif not public.has_role('admin') then raise exception 'Not authorized' using errcode = '42501'; end if;
  select r.*, b.updated_at as booking_updated_at, b.total_amount_minor, b.currency,
    c.location_id, l.timezone into target
  from public.bookings b join public.court_reservations r on r.id = b.reservation_id
  join public.courts c on c.id = r.court_id and c.is_active
  join public.locations l on l.id = c.location_id and l.is_active and l.archived_at is null
  where b.id = p_id and (not p_owner or b.account_user_id = auth.uid()) and b.status = 'confirmed' and r.status = 'active'
    and (r.booking_date + make_interval(mins => r.starts_at_minute)) at time zone l.timezone > now()
    and (not p_owner or public.has_role('admin') or public.has_role('coach') or
      now() <= ((r.booking_date + make_interval(mins => r.starts_at_minute)) at time zone l.timezone)
        - make_interval(mins => b.cancellation_notice_minutes));
  if not found then raise exception 'Booking unavailable' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('court_id', r.court_id,
    'starts_at_minute', r.starts_at_minute, 'ends_at_minute', r.ends_at_minute)), '[]'::jsonb)
  into occupied from public.court_reservations r join public.courts c on c.id = r.court_id
  where c.location_id = target.location_id and c.is_active and r.status = 'active'
    and r.booking_date = p_date and r.id <> target.id;
  return jsonb_build_object('location_id', target.location_id, 'location_timezone', target.timezone,
    'court_id', target.court_id, 'booking_date', target.booking_date,
    'starts_at_minute', target.starts_at_minute, 'ends_at_minute', target.ends_at_minute,
    'updated_at', target.updated_at, 'booking_updated_at', target.booking_updated_at,
    'total_amount_minor', target.total_amount_minor, 'currency', target.currency, 'occupancy', occupied,
    'location', (select jsonb_build_object('id', l.id, 'name', l.name, 'timezone', l.timezone,
      'is_active', l.is_active, 'archived_at', l.archived_at, 'courts',
        (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'is_active', c.is_active)), '[]'::jsonb)
          from public.courts c where c.location_id = l.id and c.is_active))
      from public.locations l where l.id = target.location_id),
    'hours', (select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) from public.location_opening_hours h
      where h.location_id = target.location_id and h.weekday = extract(isodow from p_date)::integer - 1));
end;
$$;

-- Quote and save use the same authoritative calculation. The calculation is
-- inside this transaction specifically to close the configuration/price TOCTOU
-- gap; it matches the public calendar's 30-minute slots and aggregate rounding.
create or replace function public.reschedule_customer_booking(
  p_id uuid, p_expected_updated_at timestamptz, p_expected_booking_updated_at timestamptz,
  p_court_id uuid, p_booking_date date, p_starts_at_minute integer, p_ends_at_minute integer,
  p_save boolean, p_expected_total integer, p_price_acknowledged boolean, p_owner boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  booking public.bookings%rowtype; reservation public.court_reservations%rowtype;
  v_location_id uuid; v_timezone text; location_currency text; v_environment text; v_court_state text;
  slot integer; hourly integer; matches integer; sum_hourly bigint := 0; total integer;
  wall_time timestamptz;
begin
  if p_owner then
    perform 1 from public.users u where u.id = auth.uid() and u.status = 'active' for share;
    if not found then raise exception 'Not authorized' using errcode = '42501'; end if;
  elsif not public.has_role('admin') then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into booking from public.bookings where id = p_id and (not p_owner or account_user_id = auth.uid()) for update;
  if not found or booking.status <> 'confirmed' then return jsonb_build_object('status', 'unavailable'); end if;
  select * into reservation from public.court_reservations where id = booking.reservation_id for update;
  if not found or reservation.status <> 'active' then return jsonb_build_object('status', 'unavailable'); end if;
  if reservation.updated_at is distinct from p_expected_updated_at or
    booking.updated_at is distinct from p_expected_booking_updated_at then
    return jsonb_build_object('status', 'stale');
  end if;
  -- Prevent configuration inserts, updates or deletes during validation and save.
  -- These short-lived locks are never held during network requests.
  lock table public.locations, public.courts, public.location_opening_hours,
    public.court_coverage_periods, public.location_pricing_rules in share mode;
  select c.location_id, l.timezone, l.currency into v_location_id, v_timezone, location_currency
  from public.courts c join public.locations l on l.id = c.location_id
  where c.id = reservation.court_id and c.is_active and l.is_active and l.archived_at is null;
  if not found or location_currency <> booking.currency then return jsonb_build_object('status', 'unavailable'); end if;
  wall_time := clock_timestamp();
  if (reservation.booking_date + make_interval(mins => reservation.starts_at_minute)) at time zone v_timezone <= wall_time then
    return jsonb_build_object('status', 'unavailable');
  end if;
  if p_owner and not (public.has_role('admin') or public.has_role('coach')) and
    wall_time > ((reservation.booking_date + make_interval(mins => reservation.starts_at_minute)) at time zone v_timezone)
      - make_interval(mins => booking.cancellation_notice_minutes) then
    return jsonb_build_object('status', 'notice_required');
  end if;
  if p_owner and not exists (select 1 from public.users u where u.id = auth.uid() and u.status = 'active') then return jsonb_build_object('status', 'unavailable'); end if;
  if p_save is null or p_booking_date is null or p_starts_at_minute is null or p_ends_at_minute is null
    or p_starts_at_minute < 0 or p_ends_at_minute > 1440
    or p_starts_at_minute % 30 <> 0 or p_ends_at_minute % 30 <> 0
    or p_ends_at_minute - p_starts_at_minute < 60 then
    return jsonb_build_object('status', 'unavailable');
  end if;
  select c.environment into v_environment from public.courts c
    where c.id = p_court_id and c.location_id = v_location_id and c.is_active;
  if not found or (p_booking_date + make_interval(mins => p_starts_at_minute)) at time zone v_timezone <= wall_time then
    return jsonb_build_object('status', 'unavailable');
  end if;
  if not exists (select 1 from public.location_opening_hours h where h.location_id = v_location_id
    and h.weekday = extract(isodow from p_booking_date)::integer - 1
    and h.opens_at_minute <= p_starts_at_minute and p_ends_at_minute <= h.closes_at_minute) then
    return jsonb_build_object('status', 'unavailable');
  end if;
  if exists (select 1 from public.court_reservations r where r.id <> reservation.id
    and r.court_id = p_court_id and r.booking_date = p_booking_date and r.status = 'active'
    and r.starts_at_minute < p_ends_at_minute and p_starts_at_minute < r.ends_at_minute) then
    return jsonb_build_object('status', 'overlap');
  end if;
  v_court_state := case when v_environment = 'indoor' then 'indoor'
    when exists (select 1 from public.court_coverage_periods c where c.court_id = p_court_id
      and c.starts_on <= p_booking_date and p_booking_date <= c.ends_on) then 'covered' else 'outdoor' end;
  for slot in select generate_series(p_starts_at_minute, p_ends_at_minute - 30, 30) loop
    select count(*), min(r.price_per_hour_minor) into matches, hourly
    from public.location_pricing_rules r where r.court_id = p_court_id and r.court_state = v_court_state
      and r.weekday = extract(isodow from p_booking_date)::integer - 1
      and (r.starts_on is null or r.starts_on <= p_booking_date)
      and (r.ends_on is null or p_booking_date <= r.ends_on)
      and r.starts_at_minute <= slot and slot + 30 <= r.ends_at_minute;
    if matches <> 1 then return jsonb_build_object('status', 'unpriced'); end if;
    sum_hourly := sum_hourly + hourly;
  end loop;
  if sum_hourly > 4294967294 then return jsonb_build_object('status', 'unpriced'); end if;
  total := round(sum_hourly::numeric / 2)::integer;
  if not p_save then return jsonb_build_object('status', 'quoted', 'total_amount_minor', total); end if;
  if p_expected_total is distinct from total or
    (total <> booking.total_amount_minor and p_price_acknowledged is distinct from true) then
    return jsonb_build_object('status', 'price_changed', 'total_amount_minor', total);
  end if;
  -- Exclusion constraint remains authoritative if another reservation wins a race.
  update public.court_reservations set court_id = p_court_id, booking_date = p_booking_date,
    starts_at_minute = p_starts_at_minute, ends_at_minute = p_ends_at_minute,
    updated_at = greatest(clock_timestamp(), reservation.updated_at + interval '1 microsecond')
    where id = reservation.id;
  update public.bookings set total_amount_minor = total,
    updated_at = greatest(clock_timestamp(), booking.updated_at + interval '1 microsecond') where id = booking.id;
  return jsonb_build_object('status', 'updated', 'total_amount_minor', total);
end;
$$;
-- Only the authorization-specific entrypoints are callable through PostgREST.
revoke all on function public.read_customer_booking_edit_availability(uuid, date, boolean) from public, anon, authenticated;
revoke all on function public.reschedule_customer_booking(uuid, timestamptz, timestamptz, uuid, date, integer, integer, boolean, integer, boolean, boolean) from public, anon, authenticated;
create or replace function public.read_admin_booking_edit_availability(p_id uuid, p_date date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.read_customer_booking_edit_availability(p_id, p_date, false);
$$;
create or replace function public.reschedule_admin_customer_booking(
  p_id uuid, p_expected_updated_at timestamptz, p_expected_booking_updated_at timestamptz,
  p_court_id uuid, p_booking_date date, p_starts_at_minute integer, p_ends_at_minute integer,
  p_save boolean, p_expected_total integer, p_price_acknowledged boolean
) returns jsonb language sql security definer set search_path = '' as $$
  select public.reschedule_customer_booking(p_id, p_expected_updated_at, p_expected_booking_updated_at,
    p_court_id, p_booking_date, p_starts_at_minute, p_ends_at_minute,
    p_save, p_expected_total, p_price_acknowledged, false);
$$;
revoke all on function public.read_admin_booking_edit_availability(uuid, date) from public, anon;
grant execute on function public.read_admin_booking_edit_availability(uuid, date) to authenticated;
revoke all on function public.reschedule_admin_customer_booking(uuid, timestamptz, timestamptz, uuid, date, integer, integer, boolean, integer, boolean) from public, anon;
grant execute on function public.reschedule_admin_customer_booking(uuid, timestamptz, timestamptz, uuid, date, integer, integer, boolean, integer, boolean) to authenticated;
