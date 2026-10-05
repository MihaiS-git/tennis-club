alter table public.locations add column allow_pay_at_club boolean not null default false;
grant select (allow_pay_at_club) on public.locations to anon, authenticated;
grant insert (allow_pay_at_club), update (allow_pay_at_club) on public.locations to authenticated;

alter table public.bookings add column payment_method text;
-- Historical payment method/collection is unknown. Preserve NULL and do not
-- fabricate a payment attempt or an outstanding debt for those bookings.
alter table public.bookings add constraint bookings_payment_method_check
  check (payment_method in ('online', 'pay_at_club')),
  add constraint bookings_pending_payment_method_check
    check (status <> 'pending_payment' or payment_method = 'online' and payment_method is not null);

alter table public.court_reservations add column hold_expires_at timestamptz;
alter table public.court_reservations drop constraint court_reservation_cancellation_check;
alter table public.court_reservations add constraint court_reservation_cancellation_check check (
  (status in ('active', 'held', 'released') and cancelled_at is null and cancelled_by_user_id is null)
  or (status = 'cancelled' and cancelled_at is not null and cancelled_by_user_id is not null)
);
alter table public.court_reservations add constraint court_reservation_hold_check check (
  (status = 'held' and hold_expires_at is not null and isfinite(hold_expires_at))
  or (status <> 'held' and hold_expires_at is null)
);
alter table public.court_reservations drop constraint court_reservation_no_overlap;
alter table public.court_reservations add constraint court_reservation_no_overlap exclude using gist (
  court_id with =, booking_date with =,
  int4range(starts_at_minute, ends_at_minute, '[)') with &&
) where (status in ('active', 'held'));

create table public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  method text not null check (method in ('online', 'pay_at_club')),
  provider text check (provider in ('stripe', 'netopia')),
  provider_payment_id text check (char_length(provider_payment_id) between 1 and 255),
  amount_minor integer not null check (amount_minor > 0),
  currency text not null check (currency in ('EUR', 'USD', 'GBP', 'RON', 'CHF')),
  status text not null check (status in ('pending', 'succeeded', 'failed', 'cancelled', 'expired', 'due')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint payment_attempt_method_check check (
    (method = 'online' and provider is not null and status <> 'due'
      and expires_at is not null and isfinite(expires_at))
    or (method = 'pay_at_club' and provider is null and provider_payment_id is null
      and status = 'due' and expires_at is null)
  ),
  constraint payment_attempt_completion_check check (
    (status in ('pending', 'due') and completed_at is null)
    or (status in ('succeeded', 'failed', 'cancelled', 'expired') and completed_at is not null)
  )
);
create index payment_attempts_booking_idx on public.payment_attempts(booking_id);
create unique index payment_attempts_one_pending on public.payment_attempts(booking_id) where status = 'pending';
create unique index payment_attempts_provider_id on public.payment_attempts(provider, provider_payment_id)
  where provider_payment_id is not null;
create index payment_holds_expiry_idx on public.court_reservations(court_id, hold_expires_at) where status = 'held';
create trigger payment_attempts_set_updated_at before update on public.payment_attempts
for each row execute function public.set_updated_at();
alter table public.payment_attempts enable row level security;
revoke all on public.payment_attempts from public, anon, authenticated;

-- A time-dependent predicate belongs in reads, never in a GiST index predicate.
create function public.reservation_blocks_court(p_status public.court_reservation_status, p_expiry timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select p_status = 'active' or (p_status = 'held' and p_expiry > statement_timestamp());
$$;
revoke all on function public.reservation_blocks_court(public.court_reservation_status,timestamptz) from public;
grant execute on function public.reservation_blocks_court(public.court_reservation_status,timestamptz) to anon, authenticated, service_role;

-- Bookings are locked before reservations, like cancellation and settlement.
-- SKIP LOCKED avoids lock inversion when called by a reservation UPDATE trigger.
-- A concurrent lifecycle transaction still retains GiST protection; retry after
-- it finishes if the temporary lock prevents this cleanup from releasing a row.
create function public.expire_payment_holds(p_court_id uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare target record; changed integer := 0;
begin
  for target in
    select b.id, b.reservation_id from public.bookings b
    join public.court_reservations r on r.id = b.reservation_id
    where b.status = 'pending_payment' and r.status = 'held'
      and r.hold_expires_at <= clock_timestamp()
      and (p_court_id is null or r.court_id = p_court_id)
    order by b.id for update of b skip locked
  loop
    perform 1 from public.court_reservations r where r.id = target.reservation_id for update skip locked;
    if not found then continue; end if;
    if not exists (select 1 from public.court_reservations r where r.id = target.reservation_id
      and r.status = 'held' and r.hold_expires_at <= clock_timestamp()) then continue; end if;
    update public.bookings set status = 'expired' where id = target.id and status = 'pending_payment';
    update public.payment_attempts set status = 'expired', completed_at = clock_timestamp()
      where booking_id = target.id and status = 'pending';
    update public.court_reservations set status = 'released', hold_expires_at = null
      where id = target.reservation_id;
    changed := changed + 1;
  end loop;
  return changed;
end;
$$;
revoke all on function public.expire_payment_holds(uuid) from public, anon, authenticated;
grant execute on function public.expire_payment_holds(uuid) to service_role;

create function public.release_expired_court_holds()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('active', 'held') then
    perform public.expire_payment_holds(new.court_id);
  end if;
  return new;
end;
$$;
revoke all on function public.release_expired_court_holds() from public, anon, authenticated;
create trigger court_reservations_release_expired_holds before insert or update of court_id, booking_date,
  starts_at_minute, ends_at_minute, status on public.court_reservations
for each row execute function public.release_expired_court_holds();

drop policy court_reservations_public_availability on public.court_reservations;
create policy court_reservations_public_availability on public.court_reservations
for select to anon, authenticated using (
  public.reservation_blocks_court(status, hold_expires_at) and exists (
    select 1 from public.courts c join public.locations l on l.id = c.location_id
    where c.id = court_reservations.court_id and c.is_active and l.is_active and l.archived_at is null
  )
);

-- Replace the immediate-confirmation writer; the old signature cannot bypass checkout.
drop function public.create_customer_booking(uuid, date, integer, integer, uuid, text, text, text, integer, text);
create function public.create_customer_booking(
  p_court_id uuid, p_booking_date date, p_starts_at_minute integer,
  p_ends_at_minute integer, p_account_user_id uuid, p_customer_name text,
  p_customer_email text, p_customer_phone text, p_total_amount_minor integer,
  p_currency text, p_payment_method text, p_provider text, p_hold_seconds integer
)
returns table (booking_id uuid, reservation_id uuid, payment_attempt_id uuid,
  booking_status public.booking_status, hold_expires_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
declare
  location_policy record; v_booking_id uuid; v_reservation_id uuid; v_attempt_id uuid;
  v_expiry timestamptz; v_status public.booking_status;
begin
  if current_role <> 'service_role' then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_payment_method is null or p_payment_method not in ('online', 'pay_at_club')
    or (p_payment_method = 'online' and (p_provider is null or p_provider not in ('stripe', 'netopia')
      or p_hold_seconds is null or p_hold_seconds not between 1 and 3600))
    or (p_payment_method = 'pay_at_club' and p_provider is not null) then
    raise exception 'Invalid payment intent' using errcode = '22023';
  end if;
  if p_account_user_id is not null then
    perform 1 from public.users where id = p_account_user_id and status = 'active' for share;
    if not found then raise exception 'Account unavailable' using errcode = '42501'; end if;
  end if;
  select l.customer_cancellation_notice_minutes, l.allow_pay_at_club, l.timezone into location_policy
  from public.courts c join public.locations l on l.id = c.location_id
  where c.id = p_court_id and c.is_active and l.is_active and l.archived_at is null
    and l.is_public and l.currency = p_currency for share of c, l;
  if not found then raise exception 'Court unavailable' using errcode = '23514'; end if;
  if p_payment_method = 'pay_at_club' and not location_policy.allow_pay_at_club then
    raise exception 'Pay at club unavailable' using errcode = '42501';
  end if;
  if (p_booking_date + make_interval(mins => p_starts_at_minute)) at time zone location_policy.timezone <= clock_timestamp() then
    raise exception 'Booking start unavailable' using errcode = '23514';
  end if;
  v_status := case when p_payment_method = 'online' then 'pending_payment'::public.booking_status else 'confirmed'::public.booking_status end;
  v_expiry := case when p_payment_method = 'online' then clock_timestamp() + make_interval(secs => p_hold_seconds) else null end;
  insert into public.court_reservations(court_id, booking_date, starts_at_minute, ends_at_minute,
    status, hold_expires_at, created_by_user_id, reason)
  values (p_court_id, p_booking_date, p_starts_at_minute, p_ends_at_minute,
    case when p_payment_method = 'online' then 'held'::public.court_reservation_status else 'active'::public.court_reservation_status end,
    v_expiry, null, null) returning id into v_reservation_id;
  insert into public.bookings(reservation_id, account_user_id, customer_name, customer_email,
    customer_phone, status, total_amount_minor, currency, cancellation_notice_minutes, payment_method)
  values (v_reservation_id, p_account_user_id, p_customer_name, p_customer_email, p_customer_phone,
    v_status, p_total_amount_minor, p_currency, location_policy.customer_cancellation_notice_minutes, p_payment_method)
  returning id into v_booking_id;
  insert into public.payment_attempts(booking_id, method, provider, amount_minor, currency, status, expires_at)
  values (v_booking_id, p_payment_method, p_provider, p_total_amount_minor, p_currency,
    case when p_payment_method = 'online' then 'pending' else 'due' end, v_expiry) returning id into v_attempt_id;
  if v_status = 'confirmed' then perform public.enqueue_booking_email(v_booking_id, 'confirmed', 'confirmed'); end if;
  return query select v_booking_id, v_reservation_id, v_attempt_id, v_status, v_expiry;
end;
$$;
revoke all on function public.create_customer_booking(uuid,date,integer,integer,uuid,text,text,text,integer,text,text,text,integer) from public, anon, authenticated;
grant execute on function public.create_customer_booking(uuid,date,integer,integer,uuid,text,text,text,integer,text,text,text,integer) to service_role;

-- Future verified provider callbacks update the same identities. No public endpoint.
create function public.settle_online_payment(p_attempt_id uuid, p_provider text,
  p_provider_payment_id text, p_outcome text)
returns text language plpgsql security invoker set search_path = '' as $$
declare attempt public.payment_attempts%rowtype; booking public.bookings%rowtype;
  reservation public.court_reservations%rowtype; target_booking_id uuid; outcome text;
begin
  if current_role <> 'service_role' then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_outcome is null or p_outcome not in ('succeeded', 'failed', 'retryable_failed', 'cancelled')
    or p_provider_payment_id is null or char_length(btrim(p_provider_payment_id)) not between 1 and 255 then
    raise exception 'Invalid settlement' using errcode = '22023';
  end if;
  select booking_id into target_booking_id from public.payment_attempts where id = p_attempt_id;
  select * into booking from public.bookings where id = target_booking_id for update;
  if not found then return 'unavailable'; end if;
  select * into reservation from public.court_reservations where id = booking.reservation_id for update;
  select * into attempt from public.payment_attempts where id = p_attempt_id for update;
  if attempt.method <> 'online' or attempt.provider is distinct from p_provider
    or (attempt.provider_payment_id is not null and attempt.provider_payment_id <> p_provider_payment_id) then return 'unavailable'; end if;
  if attempt.status <> 'pending' then return attempt.status; end if;
  if booking.payment_method <> 'online' or booking.status <> 'pending_payment' or reservation.status <> 'held' then return 'unavailable'; end if;
  outcome := case when least(reservation.hold_expires_at, attempt.expires_at) <= clock_timestamp() then 'expired' else p_outcome end;
  -- Card declines are retryable on the same attempt/intent until the original deadline.
  if outcome = 'retryable_failed' then return 'pending'; end if;
  update public.payment_attempts set status = case when p_outcome = 'cancelled' then 'cancelled' else outcome end, completed_at = clock_timestamp(),
    provider_payment_id = p_provider_payment_id where id = p_attempt_id;
  update public.bookings set status = case outcome when 'succeeded' then 'confirmed'::public.booking_status
    when 'failed' then 'failed'::public.booking_status else 'expired'::public.booking_status end where id = booking.id;
  update public.court_reservations set status = case when outcome = 'succeeded'
    then 'active'::public.court_reservation_status else 'released'::public.court_reservation_status end,
    hold_expires_at = null where id = reservation.id;
  if outcome = 'succeeded' then perform public.enqueue_booking_email(booking.id, 'confirmed', 'confirmed'); end if;
  return outcome;
end;
$$;
revoke all on function public.settle_online_payment(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.settle_online_payment(uuid,text,text,text) to service_role;

-- Shared occupancy reads include live holds without exposing payment/customer metadata.

create or replace function public.list_internal_court_reservations(p_court_ids uuid[], p_date date)
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
    where r.court_id = any(p_court_ids) and r.booking_date = p_date and public.reservation_blocks_court(r.status, r.hold_expires_at);
end;
$$;

create or replace function public.list_own_reservation_edit_occupancy(p_id uuid, p_date date)
returns table (court_id uuid, starts_at_minute integer, ends_at_minute integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.has_role('admin') or public.has_role('coach')) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.court_reservations owned
    join public.courts own_court on own_court.id = owned.court_id
    join public.locations own_location on own_location.id = own_court.location_id
    where owned.id = p_id and owned.created_by_user_id = auth.uid()
      and owned.status = 'active' and own_court.is_active
      and own_location.is_active and own_location.archived_at is null
  ) then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
    select other.court_id, other.starts_at_minute, other.ends_at_minute
    from public.court_reservations owned
    join public.courts own_court on own_court.id = owned.court_id
    join public.courts target_court on target_court.location_id = own_court.location_id and target_court.is_active
    join public.court_reservations other on other.court_id = target_court.id
    where owned.id = p_id and owned.created_by_user_id = auth.uid()
      and other.id <> p_id and public.reservation_blocks_court(other.status, other.hold_expires_at) and other.booking_date = p_date;
end;
$$;

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
  where r.id = p_id and r.status = 'active'
    and not exists (select 1 from public.bookings b where b.reservation_id = r.id);
  if not found then raise exception 'Not authorized' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'court_id', other.court_id,
    'starts_at_minute', other.starts_at_minute,
    'ends_at_minute', other.ends_at_minute
  )), '[]'::jsonb) into occupied
  from public.court_reservations other
  join public.courts other_court on other_court.id = other.court_id and other_court.is_active
  where other_court.location_id = target.location_id
    and other.booking_date = p_date and public.reservation_blocks_court(other.status, other.hold_expires_at) and other.id <> p_id;

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
  where c.location_id = target.location_id and c.is_active and public.reservation_blocks_court(r.status, r.hold_expires_at)
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
    and r.court_id = p_court_id and r.booking_date = p_booking_date and public.reservation_blocks_court(r.status, r.hold_expires_at)
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

-- Customer cancellation is a transition from a confirmed booking only.
create function public.guard_customer_booking_cancellation()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'cancelled' and old.status not in ('confirmed', 'cancelled') then
    raise exception 'Only confirmed bookings can be cancelled' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_customer_booking_cancellation() from public, anon, authenticated;
create trigger bookings_guard_cancellation before update of status on public.bookings
for each row execute function public.guard_customer_booking_cancellation();

-- Pending/failed/expired checkouts are internal, including in owner option lists.
create or replace function public.list_own_court_activity(
  p_scope text default 'upcoming', p_page integer default 1,
  p_type text default 'all', p_status text default 'all',
  p_location_id uuid default null, p_court_id uuid default null,
  p_date_from date default null, p_date_to date default null,
  p_sort text default 'datetime', p_direction text default 'asc',
  p_now timestamptz default now()
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not exists (select 1 from public.users u where u.id = (select auth.uid()) and u.status = 'active') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('upcoming', 'history')
    or p_page is null or p_page < 1 or p_page > 1000000
    or p_type is null or p_type not in ('all', 'booking', 'reservation')
    or p_status is null or p_status not in ('all', 'completed', 'cancelled')
    or (p_scope = 'upcoming' and p_status <> 'all')
    or p_sort is null or p_sort not in ('datetime', 'location', 'court', 'type', 'duration', 'status')
    or (p_scope = 'upcoming' and p_sort = 'status')
    or p_direction is null or p_direction not in ('asc', 'desc') or p_now is null
    or (p_date_from is not null and p_date_to is not null and p_date_from > p_date_to) then
    raise exception 'Invalid activity query' using errcode = '22023';
  end if;

  with activity as (
    select 'booking'::text as kind, b.id,
      (r.booking_date::timestamp + r.starts_at_minute * interval '1 minute') at time zone l.timezone as starts_at_instant,
      (r.booking_date::timestamp + r.ends_at_minute * interval '1 minute') at time zone l.timezone as ends_at_instant,
      case when b.status = 'cancelled' then b.updated_at
        else (r.booking_date::timestamp + r.ends_at_minute * interval '1 minute') at time zone l.timezone end as history_at,
      r.booking_date, r.starts_at_minute, r.ends_at_minute,
      l.name as location_name, l.timezone as location_timezone, c.name as court_name,
      b.status::text as status, r.status::text as reservation_status,
      b.customer_name, b.customer_email, b.customer_phone,
      b.total_amount_minor, b.currency, b.cancellation_notice_minutes,
      r.court_id, c.location_id, null::timestamptz as updated_at,
      null::text as reason, null::uuid as created_by_user_id,
      null::text as creator_name, null::timestamptz as cancelled_at,
      null::text as cancelled_by_name
    from public.bookings b
    join public.court_reservations r on r.id = b.reservation_id
    join public.courts c on c.id = r.court_id
    join public.locations l on l.id = c.location_id
    where b.account_user_id = (select auth.uid())
      and b.status in ('confirmed', 'cancelled')
      and (b.payment_method is distinct from 'online' or exists (
        select 1 from public.payment_attempts p where p.booking_id = b.id and p.status = 'succeeded'
      ))
    union all
    select 'reservation'::text, r.id,
      (r.booking_date::timestamp + r.starts_at_minute * interval '1 minute') at time zone l.timezone,
      (r.booking_date::timestamp + r.ends_at_minute * interval '1 minute') at time zone l.timezone,
      case when r.status = 'cancelled' then coalesce(r.cancelled_at, r.updated_at)
        else (r.booking_date::timestamp + r.ends_at_minute * interval '1 minute') at time zone l.timezone end,
      r.booking_date, r.starts_at_minute, r.ends_at_minute,
      l.name, l.timezone, c.name, r.status::text, r.status::text,
      null::text, null::text, null::text, null::integer, null::text, null::integer,
      r.court_id, c.location_id, r.updated_at, r.reason, r.created_by_user_id,
      nullif(concat_ws(' ', creator.first_name, creator.last_name), ''),
      r.cancelled_at, nullif(concat_ws(' ', canceller.first_name, canceller.last_name), '')
    from public.court_reservations r
    join public.courts c on c.id = r.court_id
    join public.locations l on l.id = c.location_id
    left join public.users creator on creator.id = r.created_by_user_id
    left join public.users canceller on canceller.id = r.cancelled_by_user_id
    where r.created_by_user_id = (select auth.uid())
      and (public.has_role('admin') or public.has_role('coach'))
  ), eligible as materialized (
    select a.*, case when a.status = 'cancelled' then 'cancelled' else 'completed' end as display_status
    from activity a
    where (p_scope = 'upcoming' and a.status in ('active', 'confirmed')
        and a.reservation_status = 'active' and a.ends_at_instant > p_now)
      or (p_scope = 'history' and (a.status = 'cancelled'
        or (a.status in ('active', 'confirmed') and a.reservation_status = 'active' and a.ends_at_instant <= p_now)))
  ), filtered as materialized (
    select a.* from eligible a
    where (p_type = 'all' or a.kind = p_type)
      and (p_status = 'all' or a.display_status = p_status)
      and (p_location_id is null or a.location_id = p_location_id)
      and (p_court_id is null or a.court_id = p_court_id)
      and (p_date_from is null or a.booking_date >= p_date_from)
      and (p_date_to is null or a.booking_date <= p_date_to)
  ), numbered as (
    select a.*, row_number() over (order by
      case when p_sort = 'datetime' and p_direction = 'asc' then a.starts_at_instant end asc,
      case when p_sort = 'datetime' and p_direction = 'desc' then a.starts_at_instant end desc,
      case when p_sort = 'location' and p_direction = 'asc' then lower(a.location_name) end asc,
      case when p_sort = 'location' and p_direction = 'desc' then lower(a.location_name) end desc,
      case when p_sort = 'court' and p_direction = 'asc' then lower(a.court_name) end asc,
      case when p_sort = 'court' and p_direction = 'desc' then lower(a.court_name) end desc,
      case when p_sort = 'type' and p_direction = 'asc' then a.kind end asc,
      case when p_sort = 'type' and p_direction = 'desc' then a.kind end desc,
      case when p_sort = 'duration' and p_direction = 'asc' then a.ends_at_minute - a.starts_at_minute end asc,
      case when p_sort = 'duration' and p_direction = 'desc' then a.ends_at_minute - a.starts_at_minute end desc,
      case when p_sort = 'status' and p_direction = 'asc' then a.display_status end asc,
      case when p_sort = 'status' and p_direction = 'desc' then a.display_status end desc,
      case when p_scope = 'upcoming' then a.starts_at_instant end asc,
      case when p_scope = 'history' then a.starts_at_instant end desc,
      a.kind asc, a.id asc
    ) as position from filtered a
  ), page as (
    select a.* from numbered a order by a.position limit 20 offset (p_page - 1) * 20
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(a) - 'position' - 'display_status' - 'reservation_status' - 'ends_at_instant' order by a.position) from page a), '[]'::jsonb),
    'hasNext', (select count(*) > p_page * 20 from filtered),
    'locations', coalesce((select jsonb_agg(to_jsonb(l) order by l.name, l.id)
      from (select distinct a.location_id as id, a.location_name as name from eligible a) l), '[]'::jsonb),
    'courts', coalesce((select jsonb_agg(to_jsonb(c) order by c.name, c.id)
      from (select distinct a.court_id as id, a.court_name as name, a.location_id from eligible a) c), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

-- Pending/failed/expired checkouts are internal, including in owner option lists.
create or replace function public.list_own_upcoming_customer_bookings()
returns table (
  id uuid, booking_date date, starts_at_minute integer, ends_at_minute integer,
  location_name text, location_timezone text, court_name text,
  customer_name text, customer_email text, customer_phone text,
  total_amount_minor integer, currency text, cancellation_notice_minutes integer, starts_at_instant timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.users u where u.id = (select auth.uid()) and u.status = 'active') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  return query
    select b.id, r.booking_date, r.starts_at_minute, r.ends_at_minute,
      l.name, l.timezone, c.name,
      b.customer_name, b.customer_email, b.customer_phone,
      b.total_amount_minor, b.currency, b.cancellation_notice_minutes,
      (r.booking_date::timestamp + r.starts_at_minute * interval '1 minute') at time zone l.timezone
    from public.bookings b
    join public.court_reservations r on r.id = b.reservation_id
    join public.courts c on c.id = r.court_id
    join public.locations l on l.id = c.location_id
    where b.account_user_id = (select auth.uid())
      and b.status in ('confirmed', 'cancelled')
      and (b.payment_method is distinct from 'online' or exists (
        select 1 from public.payment_attempts p where p.booking_id = b.id and p.status = 'succeeded'
      ))
      and b.status = 'confirmed' and r.status = 'active'
      and r.booking_date >= (now() at time zone l.timezone)::date
      and (r.booking_date > (now() at time zone l.timezone)::date
        or r.ends_at_minute > extract(hour from now() at time zone l.timezone)::integer * 60
          + extract(minute from now() at time zone l.timezone)::integer)
    order by r.booking_date, r.starts_at_minute, b.id;
end;
$$;

-- Pending/failed/expired checkouts are internal, including in owner option lists.
create or replace function public.list_own_court_activity_history(
  p_page integer default 1, p_now timestamptz default now()
)
returns table (
  kind text, id uuid, history_at timestamptz,
  booking_date date, starts_at_minute integer, ends_at_minute integer,
  location_name text, location_timezone text, court_name text,
  status text, customer_name text, customer_email text, customer_phone text,
  total_amount_minor integer, currency text, cancellation_notice_minutes integer,
  court_id uuid, location_id uuid, updated_at timestamptz,
  reason text, created_by_user_id uuid, creator_name text,
  cancelled_at timestamptz, cancelled_by_name text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.users u where u.id = (select auth.uid()) and u.status = 'active') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_page is null or p_page < 1 or p_page > 1000000 or p_now is null then
    raise exception 'Invalid activity page' using errcode = '22023';
  end if;

  return query
    select h.kind, h.id, h.history_at, h.booking_date,
      h.starts_at_minute, h.ends_at_minute, h.location_name,
      h.location_timezone, h.court_name, h.status,
      h.customer_name, h.customer_email, h.customer_phone,
      h.total_amount_minor, h.currency, h.cancellation_notice_minutes,
      h.court_id, h.location_id, h.updated_at, h.reason,
      h.created_by_user_id, h.creator_name, h.cancelled_at,
      h.cancelled_by_name
    from (
      select 'booking'::text as kind, b.id,
        case when b.status = 'cancelled' then b.updated_at
          else (r.booking_date::timestamp + r.ends_at_minute * interval '1 minute') at time zone l.timezone end as history_at,
        r.booking_date, r.starts_at_minute, r.ends_at_minute,
        l.name as location_name, l.timezone as location_timezone, c.name as court_name,
        b.status::text as status, b.customer_name, b.customer_email, b.customer_phone,
        b.total_amount_minor, b.currency, b.cancellation_notice_minutes,
        null::uuid as court_id, null::uuid as location_id, null::timestamptz as updated_at,
        null::text as reason, null::uuid as created_by_user_id,
        null::text as creator_name, null::timestamptz as cancelled_at,
        null::text as cancelled_by_name
      from public.bookings b
      join public.court_reservations r on r.id = b.reservation_id
      join public.courts c on c.id = r.court_id
      join public.locations l on l.id = c.location_id
      where b.account_user_id = (select auth.uid())
      and b.status in ('confirmed', 'cancelled')
      and (b.payment_method is distinct from 'online' or exists (
        select 1 from public.payment_attempts p where p.booking_id = b.id and p.status = 'succeeded'
      ))
        and (b.status = 'cancelled' or (b.status = 'confirmed' and r.status = 'active'
          and (r.booking_date::timestamp + r.ends_at_minute * interval '1 minute') at time zone l.timezone <= p_now))
      union all
      select 'reservation'::text, r.id,
        case when r.status = 'cancelled' then coalesce(r.cancelled_at, r.updated_at)
          else (r.booking_date::timestamp + r.ends_at_minute * interval '1 minute') at time zone l.timezone end,
        r.booking_date, r.starts_at_minute, r.ends_at_minute,
        l.name, l.timezone, c.name, r.status::text,
        null::text, null::text, null::text, null::integer, null::text, null::integer,
        r.court_id, c.location_id, r.updated_at, r.reason,
        r.created_by_user_id,
        nullif(concat_ws(' ', creator.first_name, creator.last_name), ''),
        r.cancelled_at,
        nullif(concat_ws(' ', canceller.first_name, canceller.last_name), '')
      from public.court_reservations r
      join public.courts c on c.id = r.court_id
      join public.locations l on l.id = c.location_id
      left join public.users creator on creator.id = r.created_by_user_id
      left join public.users canceller on canceller.id = r.cancelled_by_user_id
      where r.created_by_user_id = (select auth.uid())
        and (public.has_role('admin') or public.has_role('coach'))
        and (r.status = 'cancelled' or (r.status = 'active'
          and (r.booking_date::timestamp + r.ends_at_minute * interval '1 minute') at time zone l.timezone <= p_now))
    ) h
    order by h.history_at desc, h.kind, h.id desc
    limit 21 offset (p_page - 1) * 20;
end;
$$;
