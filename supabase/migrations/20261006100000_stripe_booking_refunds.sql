-- Full refunds retain the original successful attempt and financial snapshot.
create table public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id) on delete cascade,
  payment_attempt_id uuid not null unique references public.payment_attempts(id) on delete cascade,
  provider text not null check (provider = 'stripe'),
  provider_payment_id text not null,
  amount_minor integer not null check (amount_minor > 0),
  currency text not null,
  status text not null default 'pending' check (status in ('pending', 'pending_retry', 'succeeded', 'failed')),
  provider_refund_id text unique,
  requested_by_user_id uuid references public.users(id) on delete set null,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.payment_refunds enable row level security;
revoke all on public.payment_refunds from public, anon, authenticated;
grant select, insert, update, delete on public.payment_refunds to service_role;
create trigger payment_refunds_set_updated_at before update on public.payment_refunds
for each row execute function public.set_updated_at();

create function public.protect_payment_refund() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.id, new.booking_id, new.payment_attempt_id, new.provider,
    new.provider_payment_id, new.amount_minor, new.currency, new.created_at)
    is distinct from (old.id, old.booking_id, old.payment_attempt_id, old.provider,
    old.provider_payment_id, old.amount_minor, old.currency, old.created_at) then
    raise exception 'Immutable refund snapshot' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and not exists (
    select 1 from public.payment_attempts p join public.bookings b on b.id = p.booking_id
    where p.id = new.payment_attempt_id and p.booking_id = new.booking_id
      and p.status = 'succeeded' and p.method = 'online' and p.provider = new.provider
      and p.provider_payment_id = new.provider_payment_id
      and p.amount_minor = new.amount_minor and p.currency = new.currency and b.status = 'cancelled'
  ) then raise exception 'Invalid full refund' using errcode = '23514'; end if;
  if tg_op = 'UPDATE' and old.provider_refund_id is not null
    and new.provider_refund_id is distinct from old.provider_refund_id then
    raise exception 'Immutable provider refund' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.status = 'succeeded' and new.status <> 'succeeded' then
    raise exception 'Refund already succeeded' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger payment_refunds_protect before insert or update on public.payment_refunds
for each row execute function public.protect_payment_refund();

-- Reuse the existing eligibility, cutoff, occupancy and notification implementation.
-- These helpers must no longer be callable by browser database roles.
alter function public.cancel_own_customer_booking(uuid) rename to cancel_own_customer_booking_lifecycle;
alter function public.cancel_admin_customer_booking(uuid) rename to cancel_admin_customer_booking_lifecycle;
revoke all on function public.cancel_own_customer_booking_lifecycle(uuid) from public, anon, authenticated;
revoke all on function public.cancel_admin_customer_booking_lifecycle(uuid) from public, anon, authenticated;

create function public.cancel_customer_booking_with_refund(p_id uuid, p_admin boolean, p_refund boolean default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare b public.bookings%rowtype; p public.payment_attempts%rowtype;
  refund_id uuid; outcome text;
begin
  perform 1 from public.users where id = auth.uid() and status = 'active' for share;
  if not found or p_admin is null or (p_admin and not public.has_role('admin')) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  select * into b from public.bookings where id = p_id
    and (p_admin or account_user_id = auth.uid()) for update;
  if not found then return jsonb_build_object('outcome', 'unavailable', 'refund_id', null); end if;
  -- A replay can only reuse the decision recorded by the original cancellation.
  select id into refund_id from public.payment_refunds where booking_id = b.id;
  if b.status = 'cancelled' then
    return jsonb_build_object('outcome', case when refund_id is not null then 'cancelled' else 'unavailable' end,
      'refund_id', refund_id);
  end if;
  -- Preserve booking -> reservation -> payment lock order used by settlement.
  perform 1 from public.court_reservations where id = b.reservation_id for update;
  select * into p from public.payment_attempts where booking_id = b.id and status = 'succeeded'
    and method = 'online' and provider = 'stripe' order by created_at, id limit 1 for update;
  if p.id is not null and p_admin and p_refund is null then
    return jsonb_build_object('outcome', 'refund_choice_required', 'refund_id', null);
  end if;
  if p_admin then
    outcome := case when public.cancel_admin_customer_booking_lifecycle(p_id) then 'cancelled' else 'unavailable' end;
  else
    outcome := public.cancel_own_customer_booking_lifecycle(p_id);
  end if;
  if outcome = 'cancelled' and p.id is not null and (not p_admin or p_refund) then
    insert into public.payment_refunds(booking_id, payment_attempt_id, provider, provider_payment_id,
      amount_minor, currency, requested_by_user_id)
    values (b.id, p.id, p.provider, p.provider_payment_id, p.amount_minor, p.currency, auth.uid())
    returning id into refund_id;
    -- Snapshot only the committed request; delivery may precede Stripe completion.
    update public.booking_email_outbox set payload = payload || jsonb_build_object('refund_status', 'requested')
      where booking_id = b.id and event_kind in ('customer_cancelled', 'admin_cancelled') and mutation_key = 'cancelled';
  end if;
  return jsonb_build_object('outcome', outcome, 'refund_id', refund_id);
end;
$$;
revoke all on function public.cancel_customer_booking_with_refund(uuid,boolean,boolean) from public, anon;
grant execute on function public.cancel_customer_booking_with_refund(uuid,boolean,boolean) to authenticated;

-- Compatibility entrypoints also go through refund persistence; no bypass remains.
create function public.cancel_own_customer_booking(p_id uuid) returns text
language sql security definer set search_path = '' as $$
  select public.cancel_customer_booking_with_refund(p_id, false)->>'outcome';
$$;
create function public.cancel_admin_customer_booking(p_id uuid) returns boolean
language sql security definer set search_path = '' as $$
  select public.cancel_customer_booking_with_refund(p_id, true)->>'outcome' = 'cancelled';
$$;
revoke all on function public.cancel_own_customer_booking(uuid) from public, anon;
revoke all on function public.cancel_admin_customer_booking(uuid) from public, anon;
grant execute on function public.cancel_own_customer_booking(uuid) to authenticated;
grant execute on function public.cancel_admin_customer_booking(uuid) to authenticated;

drop function public.list_admin_operational_occupancy(uuid[],date);
create function public.list_admin_operational_occupancy(p_court_ids uuid[], p_date date)
returns table (
  kind text, id uuid, court_id uuid, booking_date date,
  starts_at_minute integer, ends_at_minute integer,
  reason text, created_by_user_id uuid, creator_name text,
  customer_name text, customer_email text, customer_phone text,
  total_amount_minor integer, currency text, cancellation_notice_minutes integer, stripe_refund_available boolean
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
      b.total_amount_minor, b.currency, b.cancellation_notice_minutes,
      exists (select 1 from public.payment_attempts p where p.booking_id = b.id
        and p.status = 'succeeded' and p.method = 'online' and p.provider = 'stripe')
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


