-- Durable, private booking notification snapshots. No Auth or payment emails.
create table public.booking_email_outbox (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  event_kind text not null check (event_kind in ('confirmed', 'customer_cancelled', 'admin_cancelled', 'customer_rescheduled', 'admin_rescheduled')),
  mutation_key text not null,
  recipient text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sending', 'delivered', 'uncertain', 'failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  unique (booking_id, event_kind, mutation_key)
);
alter table public.booking_email_outbox enable row level security;
revoke all on public.booking_email_outbox from public, anon, authenticated;
grant select, insert, update, delete on public.booking_email_outbox to service_role;
create index booking_email_outbox_pending on public.booking_email_outbox(available_at, created_at) where status = 'pending';

create function public.enqueue_booking_email(p_booking_id uuid, p_kind text, p_key text, p_previous jsonb default null)
returns void language sql security definer set search_path = '' as $$
  insert into public.booking_email_outbox(booking_id, event_kind, mutation_key, recipient, payload)
  select b.id, p_kind, p_key, b.customer_email,
    jsonb_build_object('customer_name', b.customer_name, 'booking_id', b.id,
      'location_name', l.name, 'timezone', l.timezone, 'court_name', c.name,
      'booking_date', r.booking_date, 'starts_at_minute', r.starts_at_minute,
      'ends_at_minute', r.ends_at_minute, 'total_amount_minor', b.total_amount_minor,
      'currency', b.currency, 'previous', p_previous)
  from public.bookings b join public.court_reservations r on r.id = b.reservation_id
    join public.courts c on c.id = r.court_id join public.locations l on l.id = c.location_id
  where b.id = p_booking_id
  on conflict (booking_id, event_kind, mutation_key) do nothing;
$$;
revoke all on function public.enqueue_booking_email(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_booking_email(uuid, text, text, jsonb) to service_role;

-- Claim one event at a time so no queued batch can outlive its lease.
create function public.claim_booking_email()
returns setof public.booking_email_outbox language plpgsql security definer set search_path = '' as $$
begin
  -- SMTP may have accepted an interrupted send. Never automatically resend it.
  update public.booking_email_outbox set status = 'uncertain', last_error = 'delivery_acknowledgement_unknown',
    lease_token = null, lease_until = null where status = 'sending' and lease_until < clock_timestamp();
  update public.booking_email_outbox set status = 'pending', lease_token = null, lease_until = null
    where status = 'processing' and lease_until < clock_timestamp();
  return query
    update public.booking_email_outbox o set status = 'processing', attempts = o.attempts + 1,
      lease_token = gen_random_uuid(), lease_until = clock_timestamp() + interval '2 minutes'
    where o.id = (select q.id from public.booking_email_outbox q
      where q.status = 'pending' and q.available_at <= clock_timestamp()
      -- Preserve lifecycle order for each booking, including across workers.
      and not exists (select 1 from public.booking_email_outbox earlier
        where earlier.booking_id = q.booking_id and earlier.created_at < q.created_at
          and earlier.status in ('pending', 'processing', 'sending'))
      order by q.created_at, q.id for update skip locked limit 1)
    returning o.*;
end;
$$;

create function public.start_booking_email(p_id uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.booking_email_outbox set status = 'sending'
    where id = p_id and lease_token = p_token and status = 'processing' and lease_until > clock_timestamp();
  return found;
end;
$$;

create function public.finish_booking_email(p_id uuid, p_token uuid, p_outcome text, p_error text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_outcome not in ('delivered', 'retry', 'uncertain', 'failed') or p_outcome is null then
    raise exception 'Invalid delivery outcome';
  end if;
  update public.booking_email_outbox set
    status = case when p_outcome = 'retry' and attempts < 10 then 'pending'
      when p_outcome = 'retry' then 'failed' else p_outcome end,
    available_at = clock_timestamp() + make_interval(secs => least(3600, 30 * power(2, least(attempts - 1, 7)))::integer),
    delivered_at = case when p_outcome = 'delivered' then clock_timestamp() else null end,
    last_error = left(p_error, 100), lease_token = null, lease_until = null
    where id = p_id and lease_token = p_token and status in ('processing', 'sending');
  return found;
end;
$$;
revoke all on function public.claim_booking_email() from public, anon, authenticated;
revoke all on function public.start_booking_email(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_booking_email(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_booking_email() to service_role;
grant execute on function public.start_booking_email(uuid, uuid) to service_role;
grant execute on function public.finish_booking_email(uuid, uuid, text, text) to service_role;

create or replace function public.create_customer_booking(
  p_court_id uuid, p_booking_date date, p_starts_at_minute integer,
  p_ends_at_minute integer, p_account_user_id uuid, p_customer_name text,
  p_customer_email text, p_customer_phone text, p_total_amount_minor integer,
  p_currency text
)
returns table (booking_id uuid, reservation_id uuid)
language plpgsql security invoker set search_path = '' as $$
declare created_reservation_id uuid;
declare created_booking_id uuid;
declare location_notice_minutes integer;
begin
  if current_role <> 'service_role' then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_account_user_id is not null and not exists (
    select 1 from public.users u where u.id = p_account_user_id and u.status = 'active'
  ) then
    raise exception 'Account unavailable' using errcode = '42501';
  end if;
  select l.customer_cancellation_notice_minutes into location_notice_minutes
    from public.courts c join public.locations l on l.id = c.location_id
    where c.id = p_court_id and c.is_active and l.is_active
      and l.archived_at is null and l.is_public and l.currency = p_currency;
  if not found then
    raise exception 'Court unavailable' using errcode = '23514';
  end if;

  insert into public.court_reservations
    (court_id, booking_date, starts_at_minute, ends_at_minute, status,
     created_by_user_id, reason)
  values (p_court_id, p_booking_date, p_starts_at_minute, p_ends_at_minute,
    'active', null, null)
  returning id into created_reservation_id;

  insert into public.bookings
    (reservation_id, account_user_id, customer_name, customer_email,
     customer_phone, status, total_amount_minor, currency, cancellation_notice_minutes)
  values (created_reservation_id, p_account_user_id, p_customer_name,
    p_customer_email, p_customer_phone, 'confirmed', p_total_amount_minor, p_currency, location_notice_minutes)
  returning id into created_booking_id;

  perform public.enqueue_booking_email(created_booking_id, 'confirmed', 'confirmed');
  return query select created_booking_id, created_reservation_id;
end;
$$;

revoke all on function public.create_customer_booking(uuid, date, integer, integer, uuid, text, text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.create_customer_booking(uuid, date, integer, integer, uuid, text, text, text, integer, text)
  to service_role;

create or replace function public.cancel_admin_customer_booking(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  target_booking public.bookings%rowtype;
  target_reservation public.court_reservations%rowtype;
begin
  if not public.has_role('admin') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select * into target_booking from public.bookings where id = p_id for update;
  if not found or target_booking.status <> 'confirmed' then return false; end if;

  select r.* into target_reservation
  from public.court_reservations r
  join public.courts c on c.id = r.court_id and c.is_active
  join public.locations l on l.id = c.location_id and l.is_active and l.archived_at is null
  where r.id = target_booking.reservation_id
  for update of r;
  if not found or target_reservation.status <> 'active' then return false; end if;

  update public.bookings set status = 'cancelled' where id = target_booking.id;
  update public.court_reservations
    set status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = auth.uid(), updated_at = now()
    where id = target_reservation.id;
  perform public.enqueue_booking_email(target_booking.id, 'admin_cancelled', 'cancelled');
  return true;
end;
$$;

create or replace function public.cancel_own_customer_booking(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  target_booking public.bookings%rowtype;
  target_reservation public.court_reservations%rowtype;
  location_timezone text;
  booking_start timestamptz;
  checked_at timestamptz;
begin
  perform 1 from public.users u
    where u.id = (select auth.uid()) and u.status = 'active' for share;
  if not found then raise exception 'Not authorized' using errcode = '42501'; end if;

  select * into target_booking from public.bookings b
    where b.id = p_id and b.account_user_id = (select auth.uid()) for update;
  if not found or target_booking.status <> 'confirmed' then return 'unavailable'; end if;

  select r.* into target_reservation
    from public.court_reservations r where r.id = target_booking.reservation_id for update;
  if not found or target_reservation.status <> 'active' then return 'unavailable'; end if;
  select l.timezone into location_timezone
    from public.courts c join public.locations l on l.id = c.location_id
    where c.id = target_reservation.court_id for share of c, l;
  if not found then return 'unavailable'; end if;

  booking_start := (target_reservation.booking_date::timestamp
    + target_reservation.starts_at_minute * interval '1 minute') at time zone location_timezone;
  -- Check wall-clock time AFTER acquiring lifecycle locks, including any wait.
  checked_at := clock_timestamp();
  if checked_at >= booking_start then return 'started'; end if;
  if not (public.has_role('admin') or public.has_role('coach'))
    and checked_at > booking_start - target_booking.cancellation_notice_minutes * interval '1 minute' then
    return 'notice_required';
  end if;

  update public.bookings set status = 'cancelled' where id = target_booking.id;
  if not found then raise exception 'Cancellation failed' using errcode = '23514'; end if;
  update public.court_reservations
    set status = 'cancelled', cancelled_at = checked_at,
      cancelled_by_user_id = auth.uid(), updated_at = checked_at
    where id = target_reservation.id;
  if not found then raise exception 'Cancellation failed' using errcode = '23514'; end if;
  perform public.enqueue_booking_email(target_booking.id, 'customer_cancelled', 'cancelled');
  return 'cancelled';
end;
$$;

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
  -- A repeated save of the same schedule is not a new reschedule notification.
  update public.court_reservations set court_id = p_court_id, booking_date = p_booking_date,
    starts_at_minute = p_starts_at_minute, ends_at_minute = p_ends_at_minute,
    updated_at = greatest(clock_timestamp(), reservation.updated_at + interval '1 microsecond')
    where id = reservation.id;
  update public.bookings set total_amount_minor = total,
    updated_at = greatest(clock_timestamp(), booking.updated_at + interval '1 microsecond') where id = booking.id;
  if (reservation.court_id, reservation.booking_date, reservation.starts_at_minute, reservation.ends_at_minute)
    is distinct from (p_court_id, p_booking_date, p_starts_at_minute, p_ends_at_minute) then
    perform public.enqueue_booking_email(booking.id,
      case when p_owner then 'customer_rescheduled' else 'admin_rescheduled' end,
      (select b.updated_at::text from public.bookings b where b.id = booking.id),
      jsonb_build_object('booking_date', reservation.booking_date,
        'starts_at_minute', reservation.starts_at_minute, 'ends_at_minute', reservation.ends_at_minute,
        'court_name', (select c.name from public.courts c where c.id = reservation.court_id)));
  end if;
  return jsonb_build_object('status', 'updated', 'total_amount_minor', total);
end;
$$;
