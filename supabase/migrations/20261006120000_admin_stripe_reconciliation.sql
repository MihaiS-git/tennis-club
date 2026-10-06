alter table public.payment_provider_events
  add column resolved_at timestamptz,
  add column resolved_by_user_id uuid references public.users(id) on delete set null,
  add constraint payment_event_resolution_check check (
    (resolved_at is null and resolved_by_user_id is null)
    or (resolved_at is not null and not reconciliation_required)
  );
alter table public.payment_refunds
  add column admin_lease_token uuid,
  add column admin_lease_until timestamptz,
  add column admin_lease_actor_id uuid references public.users(id) on delete set null;

-- Only a verified, exact-amount late capture may refund a non-confirmed attempt.
create function public.is_refundable_late_payment(p_event_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.payment_provider_events e
    join public.payment_attempts p on p.id = e.attempt_id
    join public.bookings b on b.id = p.booking_id
    join public.court_reservations r on r.id = b.reservation_id
    where e.provider = 'stripe' and e.event_id = p_event_id and e.outcome = 'succeeded'
      and e.settlement_result in ('expired','cancelled','failed')
      and p.provider = 'stripe' and p.method = 'online'
      and p.provider_payment_id = e.provider_payment_id
      and p.amount_minor = e.amount_minor and p.currency = e.currency
      and p.status in ('expired','cancelled','failed')
      and b.status in ('expired','failed','cancelled') and r.status in ('released','cancelled')
  );
$$;
revoke all on function public.is_refundable_late_payment(text) from public,anon,authenticated;
grant execute on function public.is_refundable_late_payment(text) to service_role;

create or replace function public.protect_payment_refund() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.id,new.booking_id,new.payment_attempt_id,new.provider,
    new.provider_payment_id,new.amount_minor,new.currency,new.created_at)
    is distinct from (old.id,old.booking_id,old.payment_attempt_id,old.provider,
    old.provider_payment_id,old.amount_minor,old.currency,old.created_at) then
    raise exception 'Immutable refund snapshot' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and not exists (
    select 1 from public.payment_attempts p join public.bookings b on b.id = p.booking_id
    where p.id = new.payment_attempt_id and p.booking_id = new.booking_id
      and p.method = 'online' and p.provider = new.provider
      and p.provider_payment_id = new.provider_payment_id
      and p.amount_minor = new.amount_minor and p.currency = new.currency
      and ((p.status = 'succeeded' and b.status = 'cancelled') or exists (
        select 1 from public.payment_provider_events e where e.attempt_id = p.id
          and public.is_refundable_late_payment(e.event_id)))
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

create function public.prepare_admin_stripe_refund(p_refund_id uuid default null, p_event_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare target uuid; b public.bookings%rowtype; p public.payment_attempts%rowtype;
  f public.payment_refunds%rowtype; e public.payment_provider_events%rowtype; token uuid;
begin
  if not public.has_role('admin') then raise exception 'Not authorized' using errcode = '42501'; end if;
  if (p_refund_id is null) = (p_event_id is null) then raise exception 'Invalid request' using errcode = '22023'; end if;
  if p_refund_id is not null then
    select booking_id into target from public.payment_refunds where id = p_refund_id;
  else
    select a.booking_id into target from public.payment_provider_events ev
      join public.payment_attempts a on a.id = ev.attempt_id where ev.provider = 'stripe' and ev.event_id = p_event_id;
  end if;
  select * into b from public.bookings where id = target for update;
  if not found then return jsonb_build_object('outcome','unavailable'); end if;
  -- Same lock order as payment settlement. Never change these lifecycle rows.
  perform 1 from public.court_reservations where id = b.reservation_id for update;
  if p_event_id is not null then
    select a.* into p from public.payment_attempts a join public.payment_provider_events ev on ev.attempt_id = a.id
      where ev.provider = 'stripe' and ev.event_id = p_event_id for update of a;
    select * into e from public.payment_provider_events where provider = 'stripe' and event_id = p_event_id for update;
    if not public.is_refundable_late_payment(p_event_id) then return jsonb_build_object('outcome','unavailable'); end if;
  else
    select a.* into p from public.payment_attempts a join public.payment_refunds rf on rf.payment_attempt_id = a.id
      where rf.id = p_refund_id for update of a;
  end if;
  select * into f from public.payment_refunds where booking_id = b.id for update;
  if f.id is null and p_event_id is not null and e.reconciliation_required then
    insert into public.payment_refunds(booking_id,payment_attempt_id,provider,provider_payment_id,amount_minor,currency,requested_by_user_id)
      values (b.id,p.id,'stripe',p.provider_payment_id,p.amount_minor,p.currency,auth.uid()) returning * into f;
  end if;
  if f.id is null or f.provider <> 'stripe' or p.provider <> 'stripe' or p.method <> 'online'
    or f.payment_attempt_id <> p.id or f.booking_id <> p.booking_id
    or f.provider_payment_id is distinct from p.provider_payment_id
    or f.amount_minor <> p.amount_minor or f.currency <> p.currency
    or not ((p.status = 'succeeded' and b.status = 'cancelled') or exists (
      select 1 from public.payment_provider_events ev where ev.attempt_id = p.id and public.is_refundable_late_payment(ev.event_id)))
    then return jsonb_build_object('outcome','unavailable'); end if;
  if f.status = 'succeeded' then
    if p_event_id is null then return jsonb_build_object('outcome','already_refunded'); end if;
    update public.payment_provider_events ev set reconciliation_required = false,
      resolved_at = clock_timestamp(),resolved_by_user_id = auth.uid()
      where ev.attempt_id = p.id and ev.reconciliation_required and public.is_refundable_late_payment(ev.event_id);
    return jsonb_build_object('outcome','resolved','booking_id',b.id);
  end if;
  if p_event_id is not null and not e.reconciliation_required then return jsonb_build_object('outcome','unavailable'); end if;
  if p_event_id is null and f.status not in ('pending_retry','failed') then return jsonb_build_object('outcome','unavailable'); end if;
  if f.admin_lease_until > clock_timestamp() then return jsonb_build_object('outcome','busy'); end if;
  token := gen_random_uuid();
  update public.payment_refunds set admin_lease_token = token,admin_lease_until = clock_timestamp() + interval '5 minutes',
    admin_lease_actor_id = auth.uid() where id = f.id;
  return jsonb_build_object('outcome','ready','refund_id',f.id,'booking_id',b.id,'lease_token',token);
end;
$$;
revoke all on function public.prepare_admin_stripe_refund(uuid,text) from public,anon;
grant execute on function public.prepare_admin_stripe_refund(uuid,text) to authenticated;

-- Only verified server adapter results may enter this persistence boundary.
create function public.finish_admin_stripe_refund(p_refund_id uuid,p_token uuid,p_actor_id uuid,
  p_status text,p_provider_refund_id text,p_error text)
returns text language plpgsql security invoker set search_path = '' as $$
declare f public.payment_refunds%rowtype; target uuid;
begin
  if current_role <> 'service_role' then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('pending','pending_retry','succeeded','failed')
    or (p_status = 'succeeded' and nullif(p_provider_refund_id,'') is null) then
    raise exception 'Invalid result' using errcode = '22023'; end if;
  select booking_id into target from public.payment_refunds where id = p_refund_id;
  perform 1 from public.bookings where id = target for update;
  select * into f from public.payment_refunds where id = p_refund_id for update;
  if f.admin_lease_token is distinct from p_token or f.admin_lease_actor_id is distinct from p_actor_id
    or p_token is null then return 'stale'; end if;
  -- Never downgrade success if the original cancellation processor won a race.
  if f.status <> 'succeeded' then
    update public.payment_refunds set status = p_status,
      provider_refund_id = coalesce(p_provider_refund_id,provider_refund_id),last_error = p_error
      where id = f.id returning * into f;
  end if;
  if f.status = 'succeeded' then
    update public.payment_provider_events ev set reconciliation_required = false,
      resolved_at = clock_timestamp(),resolved_by_user_id = p_actor_id
      where ev.attempt_id = f.payment_attempt_id and ev.reconciliation_required
        and public.is_refundable_late_payment(ev.event_id);
  end if;
  update public.payment_refunds set admin_lease_token = null,admin_lease_until = null,admin_lease_actor_id = null where id = f.id;
  return f.status;
end;
$$;
revoke all on function public.finish_admin_stripe_refund(uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.finish_admin_stripe_refund(uuid,uuid,uuid,text,text,text) to service_role;

drop function public.list_admin_payment_transactions(integer,text,text,text,boolean,text,text,text);
-- Read-only Admin projection. Browser roles retain no direct financial table access.
create function public.list_admin_payment_transactions(
  p_page integer default 1, p_status text default 'all', p_provider text default 'all',
  p_method text default 'all', p_attention boolean default false, p_search text default '',
  p_sort text default 'date', p_direction text default 'desc', p_booking_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not public.has_role('admin') then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_page is null or p_page not between 1 and 1000000
    or p_status is null or p_status not in ('all','pending','succeeded','failed','cancelled','expired','due')
    or p_provider is null or p_provider not in ('all','stripe','netopia')
    or p_method is null or p_method not in ('all','online','pay_at_club')
    or p_attention is null or p_search is null or length(p_search) > 200
    or p_sort is null or p_sort not in ('date','amount','payment')
    or p_direction is null or p_direction not in ('asc','desc') then
    raise exception 'Invalid payment query' using errcode = '22023';
  end if;
  with transactions as (
    select b.id as booking_id, b.reservation_id, b.customer_name, b.customer_email,
      coalesce(p.amount_minor, b.total_amount_minor) as amount_minor,
      coalesce(p.currency, b.currency) as currency,
      coalesce(p.method, b.payment_method) as method, p.provider, p.status as payment_status,
      p.provider_payment_id, coalesce(p.created_at, b.created_at) as created_at,
      coalesce(p.updated_at, b.updated_at) as updated_at,
      r.booking_date, r.starts_at_minute, r.ends_at_minute, c.name as court_name,
      l.name as location_name, l.timezone as location_timezone,
      case when f.id is null then null else jsonb_build_object(
        'id',f.id,'amount_minor',f.amount_minor,'currency',f.currency,'status',f.status,
        'provider_refund_id',f.provider_refund_id,'requested_by_user_id',f.requested_by_user_id,
        'requested_by_name',nullif(concat_ws(' ',u.first_name,u.last_name),''),
        'created_at',f.created_at,'updated_at',f.updated_at,'last_error',f.last_error) end as refund,
      coalesce(e.reconciliation, '[]'::jsonb) as reconciliation,
      (coalesce(f.status in ('pending_retry','failed'), false) or coalesce(e.required,false)) as needs_attention
    from public.bookings b
    join public.court_reservations r on r.id = b.reservation_id
    join public.courts c on c.id = r.court_id
    join public.locations l on l.id = c.location_id
    left join public.payment_refunds f on f.booking_id = b.id
    left join public.users u on u.id = f.requested_by_user_id
    left join lateral (
      select a.* from public.payment_attempts a where a.booking_id = b.id
      order by (a.id = f.payment_attempt_id) desc nulls last,
        (a.status = 'succeeded') desc,
        case when a.status = 'succeeded' then a.created_at end asc,
        a.created_at desc, a.id limit 1
    ) p on true
    left join lateral (
      select bool_or(ev.reconciliation_required) as required, jsonb_agg(jsonb_build_object(
        'event_id',ev.event_id,'provider',ev.provider,'reconciliation_required',ev.reconciliation_required,
        'resolved_at',ev.resolved_at,'resolved_by_user_id',ev.resolved_by_user_id,
        'can_refund',ev.reconciliation_required and public.is_refundable_late_payment(ev.event_id),
        'settlement_result', ev.settlement_result,
        'outcome', ev.outcome, 'received_at', ev.received_at) order by ev.received_at, ev.event_id) as reconciliation
      from public.payment_provider_events ev join public.payment_attempts a on a.id = ev.attempt_id
      where a.booking_id = b.id and (ev.reconciliation_required or ev.resolved_at is not null)
      having count(*) > 0
    ) e on true
  ), filtered as materialized (
    select * from transactions t where (p_booking_id is null or t.booking_id = p_booking_id) and (p_status = 'all' or t.payment_status = p_status)
      and (p_provider = 'all' or t.provider = p_provider)
      and (p_method = 'all' or t.method = p_method)
      and (not p_attention or t.needs_attention)
      -- Literal substring matching: %, _ and other input are not SQL patterns.
      and (p_search = '' or strpos(lower(t.customer_name),lower(p_search)) > 0
        or strpos(lower(t.customer_email),lower(p_search)) > 0
        or strpos(t.booking_id::text,lower(p_search)) > 0
        or strpos(lower(coalesce(t.provider_payment_id,'')),lower(p_search)) > 0)
  ), stats as (
    select count(*)::integer as total, greatest(1,ceil(count(*) / 20.0)::integer) as total_pages from filtered
  ), ordered as (
    select t.*, row_number() over (order by
      case when p_sort = 'date' and p_direction = 'asc' then t.created_at end asc,
      case when p_sort = 'date' and p_direction = 'desc' then t.created_at end desc,
      case when p_sort = 'amount' and p_direction = 'asc' then t.amount_minor end asc,
      case when p_sort = 'amount' and p_direction = 'desc' then t.amount_minor end desc,
      case when p_sort = 'payment' and p_direction = 'asc' then t.payment_status end asc nulls last,
      case when p_sort = 'payment' and p_direction = 'desc' then t.payment_status end desc nulls last,
      t.booking_id asc) as position from filtered t
  )
  select jsonb_build_object('total',s.total,'totalPages',s.total_pages,'page',least(p_page,s.total_pages),
    'rows',coalesce((select jsonb_agg(to_jsonb(o) - 'position' - 'needs_attention' order by o.position)
      from ordered o where o.position > (least(p_page,s.total_pages)-1)*20
        and o.position <= least(p_page,s.total_pages)*20),'[]'::jsonb)) into result from stats s;
  return result;
end;
$$;
revoke all on function public.list_admin_payment_transactions(integer,text,text,text,boolean,text,text,text,uuid) from public,anon;
grant execute on function public.list_admin_payment_transactions(integer,text,text,text,boolean,text,text,text,uuid) to authenticated;
