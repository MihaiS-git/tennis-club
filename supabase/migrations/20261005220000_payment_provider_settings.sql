-- Credentials remain in server environment configuration. Only selection is persisted.
create table public.payment_provider_settings (
  id boolean primary key default true check (id),
  active_provider text check (active_provider in ('stripe', 'netopia')),
  updated_by_user_id uuid references public.users(id) on delete restrict,
  updated_at timestamptz not null default now()
);
insert into public.payment_provider_settings(id, active_provider) values (true, null);
alter table public.payment_provider_settings enable row level security;
revoke all on public.payment_provider_settings from public, anon, authenticated;
grant select on public.payment_provider_settings to authenticated;
create policy payment_provider_settings_admin_select on public.payment_provider_settings
for select to authenticated using ((select public.has_role('admin')));

create table public.payment_provider_changes (
  id uuid primary key default gen_random_uuid(),
  previous_provider text check (previous_provider in ('stripe', 'netopia')),
  active_provider text check (active_provider in ('stripe', 'netopia')),
  changed_by_user_id uuid not null references public.users(id) on delete restrict,
  changed_at timestamptz not null default now()
);
alter table public.payment_provider_changes enable row level security;
revoke all on public.payment_provider_changes from public, anon, authenticated;

-- The Next.js Admin service verifies provider configuration before this RPC.
-- A browser cannot bypass that server boundary by writing settings/calling RPC.
create function public.select_payment_provider(p_provider text, p_actor_user_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare previous text;
begin
  if current_role <> 'service_role' then raise exception 'Not authorized' using errcode = '42501'; end if;
  perform 1 from public.users u join public.user_roles ur on ur.user_id = u.id
  where u.id = p_actor_user_id and u.status = 'active' and ur.role_code = 'admin' for share of u, ur;
  if not found then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_provider is not null and p_provider not in ('stripe', 'netopia') then
    raise exception 'Invalid provider' using errcode = '22023';
  end if;
  select active_provider into previous from public.payment_provider_settings where id = true for update;
  if not found then raise exception 'Payment settings missing'; end if;
  if previous is not distinct from p_provider then return; end if;
  update public.payment_provider_settings set active_provider = p_provider,
    updated_by_user_id = p_actor_user_id, updated_at = clock_timestamp() where id = true;
  insert into public.payment_provider_changes(previous_provider, active_provider, changed_by_user_id)
    values (previous, p_provider, p_actor_user_id);
end;
$$;
revoke all on function public.select_payment_provider(text,uuid) from public, anon, authenticated;
grant execute on function public.select_payment_provider(text,uuid) to service_role;

-- A stored provider is an immutable fact about the attempt, independent of selection.
create function public.protect_payment_attempt_provider()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.provider is distinct from old.provider or new.method is distinct from old.method then
    raise exception 'Payment method and provider are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_payment_attempt_provider() from public, anon, authenticated;
create trigger payment_attempts_protect_provider before update on public.payment_attempts
for each row execute function public.protect_payment_attempt_provider();

create or replace function public.create_customer_booking(
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
  selected_provider text;
  v_expiry timestamptz; v_status public.booking_status;
begin
  if current_role <> 'service_role' then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_payment_method is null or p_payment_method not in ('online', 'pay_at_club')
    or (p_payment_method = 'online' and (p_provider is null or p_provider not in ('stripe', 'netopia')
      or p_hold_seconds is null or p_hold_seconds not between 1 and 3600))
    or (p_payment_method = 'pay_at_club' and p_provider is not null) then
    raise exception 'Invalid payment intent' using errcode = '22023';
  end if;
  if p_payment_method = 'online' then
    select active_provider into selected_provider from public.payment_provider_settings where id = true for share;
    if selected_provider is null or selected_provider is distinct from p_provider then
      raise exception 'Online payment unavailable' using errcode = 'P0001';
    end if;
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
