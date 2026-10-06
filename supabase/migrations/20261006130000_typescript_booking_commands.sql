-- Final server-only command API. Decisions are computed in TypeScript.
create table public.booking_configuration_revision (
  id boolean primary key default true check (id), revision bigint not null default 0
);
insert into public.booking_configuration_revision(id) values (true);
alter table public.booking_configuration_revision enable row level security;
revoke all on public.booking_configuration_revision from public, anon, authenticated;

create function public.advance_booking_configuration_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.booking_configuration_revision set revision = revision + 1 where id;
  return null;
end;
$$;

create function public.commit_checkout(p_command jsonb,p_revision bigint,p_event jsonb)
returns table(booking_id uuid,reservation_id uuid,payment_attempt_id uuid,booking_status public.booking_status,hold_expires_at timestamptz)
language plpgsql security invoker set search_path = '' as $$
declare l public.locations%rowtype; c public.courts%rowtype; expiry timestamptz; selected text; revision bigint;
  bid uuid:=(p_command->>'booking_id')::uuid; rid uuid:=(p_command->>'reservation_id')::uuid; aid uuid:=(p_command->>'attempt_id')::uuid;
begin
  select x.revision into revision from public.booking_configuration_revision x where id for share;
  if revision is distinct from p_revision then raise exception 'Stale configuration' using errcode='40001'; end if;
  select * into c from public.courts where id=(p_command->>'court_id')::uuid and is_active for share;
  if not found then raise exception 'Court unavailable' using errcode='23514'; end if;
  select * into l from public.locations where id=c.location_id and is_active and archived_at is null and is_public for share;
  if not found or l.currency is distinct from p_command->>'currency' or
    l.customer_cancellation_notice_minutes is distinct from (p_command->>'cancellation_notice_minutes')::integer then
    raise exception 'Location unavailable' using errcode='23514'; end if;
  if p_command->>'account_user_id' is not null then
    perform 1 from public.users where id=(p_command->>'account_user_id')::uuid and status='active' for share;
    if not found then raise exception 'Account unavailable' using errcode='42501'; end if;
  end if;
  if p_command->>'provider' is not null then
    select active_provider into selected from public.payment_provider_settings where id for share;
    if selected is distinct from p_command->>'provider' then raise exception 'Provider changed' using errcode='40001'; end if;
  end if;
  if p_command->>'method'='pay_at_club' and not l.allow_pay_at_club then raise exception 'Collection unavailable' using errcode='42501'; end if;
  if ((p_command->>'date')::date+make_interval(mins=>(p_command->>'start')::integer)) at time zone l.timezone <= clock_timestamp() then
    raise exception 'Start unavailable' using errcode='23514'; end if;
  expiry:=clock_timestamp()+make_interval(secs=>(p_command->>'hold_seconds')::integer);
  insert into public.court_reservations(id,court_id,booking_date,starts_at_minute,ends_at_minute,status,hold_expires_at)
  values(rid,c.id,(p_command->>'date')::date,(p_command->>'start')::integer,(p_command->>'end')::integer,
    (p_command->>'reservation_status')::public.court_reservation_status,expiry);
  insert into public.bookings(id,reservation_id,account_user_id,customer_name,customer_email,customer_phone,status,total_amount_minor,currency,cancellation_notice_minutes,payment_method)
  values(bid,rid,(p_command->>'account_user_id')::uuid,p_command->>'customer_name',p_command->>'customer_email',p_command->>'customer_phone',
    (p_command->>'booking_status')::public.booking_status,(p_command->>'amount')::integer,p_command->>'currency',
    (p_command->>'cancellation_notice_minutes')::integer,p_command->>'method');
  insert into public.payment_attempts(id,booking_id,method,provider,amount_minor,currency,status,expires_at)
  values(aid,bid,p_command->>'method',p_command->>'provider',(p_command->>'amount')::integer,p_command->>'currency',p_command->>'attempt_status',expiry);
  perform public.persist_booking_outbox(bid,p_event);
  return query select bid,rid,aid,(p_command->>'booking_status')::public.booking_status,expiry;
end;
$$;

create function public.commit_payment_transition(p_id uuid,p_fingerprint text,p_revision bigint,p_attempt_id uuid,
  p_deadline timestamptz,p_targets jsonb,p_event jsonb,p_receipt jsonb,p_result text)
returns text language plpgsql security invoker set search_path = '' as $$
declare b public.bookings%rowtype; p public.payment_attempts%rowtype; existing text;
begin
  -- A concurrent duplicate returns its durable result, never reapplies the command.
  perform 1 from public.bookings where id=p_id for update;
  if p_receipt is not null then
    select settlement_result into existing from public.payment_provider_events
      where provider=p_receipt->>'provider' and event_id=p_receipt->>'event_id';
    if found then return existing; end if;
  end if;
  perform public.lock_booking_command(p_id,p_fingerprint,p_revision,null,'system',p_deadline,false);
  select * into b from public.bookings where id=p_id;
  select * into p from public.payment_attempts where id=p_attempt_id and booking_id=b.id;
  if not found then raise exception 'Invalid payment relationship' using errcode='23514'; end if;
  if p_receipt is not null and (p.provider is distinct from p_receipt->>'provider' or
    p.provider_payment_id is distinct from p_receipt->>'provider_payment_id') then
    raise exception 'Invalid payment evidence' using errcode='23514'; end if;
  if p_targets is not null then
    if p_receipt is not null and (p.amount_minor is distinct from (p_receipt->>'amount_minor')::integer or p.currency is distinct from p_receipt->>'currency') then
      raise exception 'Financial snapshot mismatch' using errcode='23514'; end if;
    if b.status<>'pending_payment' or p.status<>'pending' or not exists(
      select 1 from public.court_reservations where id=b.reservation_id and status='held') then
      raise exception 'Invalid payment state' using errcode='23514'; end if;
    update public.payment_attempts set status=p_targets->>'attempt',completed_at=clock_timestamp(),
      provider_payment_id=coalesce(p_targets->>'provider_payment_id',provider_payment_id) where id=p.id;
    update public.bookings set status=(p_targets->>'booking')::public.booking_status where id=b.id;
    update public.court_reservations set status=(p_targets->>'reservation')::public.court_reservation_status,
      hold_expires_at=null where id=b.reservation_id;
  end if;
  perform public.persist_booking_outbox(b.id,p_event);
  if p_receipt is not null then
    insert into public.payment_provider_events(provider,event_id,attempt_id,provider_payment_id,outcome,settlement_result,reconciliation_required,amount_minor,currency)
    values(p_receipt->>'provider',p_receipt->>'event_id',p.id,p_receipt->>'provider_payment_id',p_receipt->>'outcome',p_result,
      (p_receipt->>'reconciliation_required')::boolean,(p_receipt->>'amount_minor')::integer,p_receipt->>'currency');
  end if;
  return p_result;
end;
$$;
create trigger locations_booking_revision before insert or update or delete on public.locations
for each statement execute function public.advance_booking_configuration_revision();
create trigger courts_booking_revision before insert or update or delete on public.courts
for each statement execute function public.advance_booking_configuration_revision();
create trigger hours_booking_revision before insert or update or delete on public.location_opening_hours
for each statement execute function public.advance_booking_configuration_revision();
create trigger coverage_booking_revision before insert or update or delete on public.court_coverage_periods
for each statement execute function public.advance_booking_configuration_revision();
create trigger pricing_booking_revision before insert or update or delete on public.location_pricing_rules
for each statement execute function public.advance_booking_configuration_revision();

create function public.booking_command_snapshot(p_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('booking',to_jsonb(b),'reservation',to_jsonb(r),
    'payments',coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at,p.id)
      from public.payment_attempts p where p.booking_id=b.id),'[]'::jsonb),
    'refund', (select to_jsonb(f) from public.payment_refunds f where f.booking_id=b.id),
    'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.provider,e.event_id)
      from public.payment_provider_events e join public.payment_attempts p on p.id=e.attempt_id
      where p.booking_id=b.id),'[]'::jsonb))
  from public.bookings b join public.court_reservations r on r.id=b.reservation_id where b.id=p_id;
$$;

-- Shared locking/fencing only; no command is selected here.
create function public.lock_booking_command(p_id uuid,p_fingerprint text,p_revision bigint,
  p_actor uuid,p_scope text,p_deadline timestamptz,p_inclusive boolean default false) returns void
language plpgsql security invoker set search_path = '' as $$
declare b public.bookings%rowtype; current_revision bigint;
begin
  select * into b from public.bookings where id=p_id for update;
  if not found then raise exception 'Stale command' using errcode='40001'; end if;
  perform 1 from public.court_reservations where id=b.reservation_id for update;
  perform 1 from public.payment_attempts where booking_id=b.id order by id for update;
  perform 1 from public.payment_provider_events e join public.payment_attempts p on p.id=e.attempt_id
    where p.booking_id=b.id order by e.provider,e.event_id for update of e;
  perform 1 from public.payment_refunds where booking_id=b.id for update;
  if p_scope not in ('owner','admin','system') or p_scope is null then
    raise exception 'Not authorized' using errcode='42501'; end if;
  if p_scope <> 'system' then
    perform 1 from public.users where id=p_actor and status='active' for share;
    if not found or (p_scope='owner' and b.account_user_id is distinct from p_actor) then
      raise exception 'Not authorized' using errcode='42501'; end if;
    if p_scope='admin' then
      perform 1 from public.user_roles where user_id=p_actor and role_code='admin' for share;
      if not found then raise exception 'Not authorized' using errcode='42501'; end if;
    end if;
  end if;
  select revision into current_revision from public.booking_configuration_revision where id for share;
  if p_revision is distinct from current_revision or
    p_fingerprint is distinct from md5(public.booking_command_snapshot(p_id)::text) then
    raise exception 'Stale command' using errcode='40001'; end if;
  if p_deadline is not null and (clock_timestamp()>p_deadline or
    (not p_inclusive and clock_timestamp()>=p_deadline)) then
    raise exception 'Command deadline elapsed' using errcode='40001'; end if;
end;
$$;

create function public.persist_booking_outbox(p_booking_id uuid,p_event jsonb) returns void
language sql security invoker set search_path = '' as $$
  insert into public.booking_email_outbox(booking_id,event_kind,mutation_key,recipient,payload)
  select p_booking_id,p_event->>'kind',p_event->>'key',p_event->>'recipient',p_event->'payload'
  where p_event is not null and p_event <> 'null'::jsonb
  on conflict(booking_id,event_kind,mutation_key) do nothing;
$$;

drop function public.finish_booking_email(uuid,uuid,text,text);
create function public.finish_booking_email(p_id uuid,p_token uuid,p_status text,p_delay_seconds integer,p_error text default null)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_status is null or p_status not in ('pending','delivered','uncertain','failed') or p_delay_seconds<0 then
    raise exception 'Invalid delivery result' using errcode='22023'; end if;
  update public.booking_email_outbox set status=p_status,
    available_at=clock_timestamp()+make_interval(secs=>p_delay_seconds),
    delivered_at=case when p_status='delivered' then clock_timestamp() else null end,
    last_error=left(p_error,100),lease_token=null,lease_until=null
    where id=p_id and lease_token=p_token and status in ('processing','sending');
  return found;
end;
$$;

create function public.commit_booking_cancellation(p_id uuid,p_fingerprint text,p_revision bigint,
  p_actor uuid,p_scope text,p_deadline timestamptz,p_inclusive boolean,p_refund jsonb,p_event jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare b public.bookings%rowtype; refund_id uuid;
begin
  perform public.lock_booking_command(p_id,p_fingerprint,p_revision,p_actor,p_scope,p_deadline,p_inclusive);
  select * into b from public.bookings where id=p_id;
  if b.status<>'confirmed' or not exists(select 1 from public.court_reservations where id=b.reservation_id and status='active') then
    raise exception 'Invalid cancellation state' using errcode='23514'; end if;
  update public.bookings set status='cancelled' where id=b.id;
  update public.court_reservations set status='cancelled',cancelled_at=clock_timestamp(),
    cancelled_by_user_id=p_actor,updated_at=clock_timestamp() where id=b.reservation_id;
  if p_refund is not null and p_refund <> 'null'::jsonb then
    insert into public.payment_refunds(booking_id,payment_attempt_id,provider,provider_payment_id,amount_minor,currency,requested_by_user_id)
    values(b.id,(p_refund->>'payment_attempt_id')::uuid,p_refund->>'provider',p_refund->>'provider_payment_id',
      (p_refund->>'amount_minor')::integer,p_refund->>'currency',p_actor) returning id into refund_id;
  end if;
  perform public.persist_booking_outbox(b.id,p_event);
  return jsonb_build_object('outcome','cancelled','refund_id',refund_id);
end;
$$;

create function public.commit_booking_reschedule(p_id uuid,p_fingerprint text,p_revision bigint,
  p_actor uuid,p_scope text,p_deadline timestamptz,p_inclusive boolean,p_schedule jsonb,p_total integer,p_event jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare b public.bookings%rowtype; r public.court_reservations%rowtype; location_id uuid;
begin
  perform public.lock_booking_command(p_id,p_fingerprint,p_revision,p_actor,p_scope,p_deadline,p_inclusive);
  select * into b from public.bookings where id=p_id;
  select * into r from public.court_reservations where id=b.reservation_id;
  if b.status<>'confirmed' or r.status<>'active' then raise exception 'Invalid reschedule state' using errcode='23514'; end if;
  select c.location_id into location_id from public.courts c where c.id=r.court_id;
  if not exists(select 1 from public.courts c join public.locations l on l.id=c.location_id
    where c.id=(p_schedule->>'court_id')::uuid and c.location_id=location_id and c.is_active and l.is_active and l.archived_at is null and l.currency=b.currency) then
    raise exception 'Invalid target resource' using errcode='23514'; end if;
  update public.court_reservations set court_id=(p_schedule->>'court_id')::uuid,
    booking_date=(p_schedule->>'booking_date')::date,starts_at_minute=(p_schedule->>'starts_at_minute')::integer,
    ends_at_minute=(p_schedule->>'ends_at_minute')::integer,
    updated_at=greatest(clock_timestamp(),r.updated_at+interval '1 microsecond') where id=r.id;
  update public.bookings set total_amount_minor=p_total,
    updated_at=greatest(clock_timestamp(),b.updated_at+interval '1 microsecond') where id=b.id;
  perform public.persist_booking_outbox(b.id,p_event);
  return jsonb_build_object('status','updated','total_amount_minor',p_total);
end;
$$;

create or replace function public.protect_payment_refund() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op='UPDATE' and (new.id,new.booking_id,new.payment_attempt_id,new.provider,new.provider_payment_id,new.amount_minor,new.currency,new.created_at)
    is distinct from (old.id,old.booking_id,old.payment_attempt_id,old.provider,old.provider_payment_id,old.amount_minor,old.currency,old.created_at) then
    raise exception 'Immutable refund snapshot' using errcode='23514'; end if;
  if tg_op='INSERT' and not exists(select 1 from public.payment_attempts p
    where p.id=new.payment_attempt_id and p.booking_id=new.booking_id and p.provider=new.provider
      and p.provider_payment_id=new.provider_payment_id and p.amount_minor=new.amount_minor and p.currency=new.currency
      and (p.status='succeeded' or exists(select 1 from public.payment_provider_events e
        where e.attempt_id=p.id and e.provider=p.provider and e.provider_payment_id=p.provider_payment_id
          and e.outcome='succeeded' and e.amount_minor=p.amount_minor and e.currency=p.currency))) then
    raise exception 'Invalid captured snapshot' using errcode='23514'; end if;
  if tg_op='UPDATE' and old.provider_refund_id is not null and new.provider_refund_id is distinct from old.provider_refund_id then
    raise exception 'Immutable provider refund' using errcode='23514'; end if;
  if tg_op='UPDATE' and old.status='succeeded' and new.status<>'succeeded' then
    raise exception 'Refund already succeeded' using errcode='23514'; end if;
  return new;
end;
$$;

create function public.persist_refund_event_resolution(p_refund_id uuid,p_actor uuid,p_events jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
declare f public.payment_refunds%rowtype; event jsonb;
begin
  select * into f from public.payment_refunds where id=p_refund_id;
  if jsonb_array_length(p_events)>0 and f.status<>'succeeded' then raise exception 'Refund not complete' using errcode='23514'; end if;
  for event in select value from jsonb_array_elements(p_events) loop
    update public.payment_provider_events e set reconciliation_required=false,resolved_at=clock_timestamp(),resolved_by_user_id=p_actor
    where e.provider=event->>'provider' and e.event_id=event->>'event_id' and e.attempt_id=f.payment_attempt_id
      and e.provider=f.provider and e.provider_payment_id=f.provider_payment_id
      and e.outcome='succeeded' and e.amount_minor=f.amount_minor and e.currency=f.currency and e.reconciliation_required;
    if not found then raise exception 'Changed event evidence' using errcode='40001'; end if;
  end loop;
end;
$$;

create function public.claim_refund_command(p_id uuid,p_fingerprint text,p_revision bigint,p_actor uuid,
  p_refund jsonb,p_token uuid,p_lease_seconds integer,p_events jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare f public.payment_refunds%rowtype;
begin
  perform public.lock_booking_command(p_id,p_fingerprint,p_revision,p_actor,'admin',null,false);
  if p_refund is not null then
    insert into public.payment_refunds(booking_id,payment_attempt_id,provider,provider_payment_id,amount_minor,currency,requested_by_user_id)
    values(p_id,(p_refund->>'payment_attempt_id')::uuid,p_refund->>'provider',p_refund->>'provider_payment_id',
      (p_refund->>'amount_minor')::integer,p_refund->>'currency',p_actor);
  end if;
  select * into f from public.payment_refunds where booking_id=p_id for update;
  if not found then raise exception 'Refund missing' using errcode='23514'; end if;
  perform public.persist_refund_event_resolution(f.id,p_actor,p_events);
  if p_token is not null then
    if f.admin_lease_until>clock_timestamp() then return jsonb_build_object('outcome','busy'); end if;
    if p_lease_seconds is null or p_lease_seconds<=0 then raise exception 'Invalid lease' using errcode='22023'; end if;
    update public.payment_refunds set admin_lease_token=p_token,admin_lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      admin_lease_actor_id=p_actor where id=f.id;
  end if;
  return jsonb_build_object('refund_id',f.id,'booking_id',p_id,'lease_token',p_token);
end;
$$;

create function public.commit_refund_result(p_id uuid,p_fingerprint text,p_revision bigint,p_refund_id uuid,
  p_token uuid,p_actor_id uuid,p_status text,p_provider_refund_id text,p_error text,p_events jsonb) returns text
language plpgsql security invoker set search_path = '' as $$
declare f public.payment_refunds%rowtype;
begin
  perform public.lock_booking_command(p_id,p_fingerprint,p_revision,null,'system',null,false);
  select * into f from public.payment_refunds where id=p_refund_id and booking_id=p_id for update;
  if not found or p_token is null or f.admin_lease_token is distinct from p_token or f.admin_lease_actor_id is distinct from p_actor_id then return 'stale'; end if;
  if f.status='succeeded' and p_status<>'succeeded' then raise exception 'Refund already succeeded' using errcode='40001'; end if;
  if p_status='succeeded' and nullif(p_provider_refund_id,'') is null then raise exception 'Missing refund reference' using errcode='23514'; end if;
  update public.payment_refunds set status=p_status,provider_refund_id=coalesce(p_provider_refund_id,provider_refund_id),last_error=p_error,
    admin_lease_token=null,admin_lease_until=null,admin_lease_actor_id=null where id=f.id;
  perform public.persist_refund_event_resolution(f.id,p_actor_id,p_events);
  return p_status;
end;
$$;

drop function public.list_admin_payment_transactions(integer,text,text,text,boolean,text,text,text,uuid);
create function public.list_admin_payment_transactions(
  p_page integer default 1, p_status text default 'all', p_provider text default 'all',
  p_method text default 'all', p_attention boolean default false, p_search text default '',
  p_sort text default 'date', p_direction text default 'desc', p_booking_id uuid default null, p_attention_refund_statuses text[] default '{}', p_attention_reconciliation boolean default false
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
      b.status::text as booking_status,r.status::text as reservation_status,r.booking_date, r.starts_at_minute, r.ends_at_minute, c.name as court_name,
      l.name as location_name, l.timezone as location_timezone,
      case when f.id is null then null else jsonb_build_object(
        'id',f.id,'amount_minor',f.amount_minor,'currency',f.currency,'status',f.status,
        'provider_refund_id',f.provider_refund_id,'requested_by_user_id',f.requested_by_user_id,
        'requested_by_name',nullif(concat_ws(' ',u.first_name,u.last_name),''),
        'payment_attempt_id',f.payment_attempt_id,'created_at',f.created_at,'updated_at',f.updated_at,'last_error',f.last_error) end as refund,
      coalesce(e.reconciliation, '[]'::jsonb) as reconciliation,
      (coalesce(f.status = any(p_attention_refund_statuses), false) or (p_attention_reconciliation and coalesce(e.required,false))) as matches_attention
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
        'event_id',ev.event_id,'attempt_id',ev.attempt_id,'provider',ev.provider,'reconciliation_required',ev.reconciliation_required,
        'resolved_at',ev.resolved_at,'resolved_by_user_id',ev.resolved_by_user_id,
        'attempt',to_jsonb(a),'amount_minor',ev.amount_minor,'currency',ev.currency,'provider_payment_id',ev.provider_payment_id,
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
      and (not p_attention or t.matches_attention)
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
    'rows',coalesce((select jsonb_agg(to_jsonb(o) - 'position' - 'matches_attention' order by o.position)
      from ordered o where o.position > (least(p_page,s.total_pages)-1)*20
        and o.position <= least(p_page,s.total_pages)*20),'[]'::jsonb)) into result from stats s;
  return result;
end;
$$;
revoke all on function public.list_admin_payment_transactions(integer,text,text,text,boolean,text,text,text,uuid,text[],boolean) from public,anon;
grant execute on function public.list_admin_payment_transactions(integer,text,text,text,boolean,text,text,text,uuid,text[],boolean) to authenticated;

drop function public.list_admin_operational_occupancy(uuid[],date);
create function public.list_admin_operational_occupancy(p_court_ids uuid[], p_date date)
returns table (
  kind text, id uuid, court_id uuid, booking_date date,
  starts_at_minute integer, ends_at_minute integer,
  reason text, created_by_user_id uuid, creator_name text,
  customer_name text, customer_email text, customer_phone text,
  total_amount_minor integer, currency text, cancellation_notice_minutes integer, payment_facts jsonb
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
      coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at,p.id) from public.payment_attempts p where p.booking_id=b.id),'[]'::jsonb)
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



create function public.read_opening_hours_command_context(p_location_id uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare revision bigint; result jsonb;
begin
  select x.revision into revision from public.booking_configuration_revision x where id for share;
  select jsonb_build_object('revision',revision,'now',clock_timestamp(),'timezone',l.timezone,
    'hours',coalesce((select jsonb_agg(to_jsonb(h)) from public.location_opening_hours h where h.location_id=l.id),'[]'::jsonb),
    'pricing',coalesce((select jsonb_agg(to_jsonb(p)) from public.location_pricing_rules p where p.location_id=l.id),'[]'::jsonb))
  into result from public.locations l where l.id=p_location_id;
  return result;
end;
$$;
drop trigger check_hours_cover_pricing on public.location_opening_hours;
drop function public.check_hours_cover_pricing();
create function public.check_applicable_pricing_hours(p_location_id uuid,p_rule_ids uuid[]) returns void
language plpgsql security invoker set search_path = '' as $$
declare conflicts jsonb;
begin
  select jsonb_agg(to_jsonb(item)) into conflicts from (
    select distinct p.weekday,p.starts_at_minute,p.ends_at_minute from public.location_pricing_rules p
    where p.location_id=p_location_id and p.id=any(p_rule_ids) and not exists (
      select 1 from public.location_opening_hours h where h.location_id=p.location_id and h.weekday=p.weekday
        and h.opens_at_minute<=p.starts_at_minute and p.ends_at_minute<=h.closes_at_minute)
    order by p.weekday,p.starts_at_minute,p.ends_at_minute limit 4) item;
  if conflicts is not null then raise exception 'opening_hours_pricing_conflict' using errcode='P0001',detail=conflicts::text; end if;
end;
$$;
create function public.commit_location_opening_hours(
  p_location_id uuid, p_weekdays integer[], p_replace_ids uuid[],
  p_opens_at_minutes integer[], p_closes_at_minutes integer[], p_actor uuid, p_revision bigint, p_applicable_rule_ids uuid[]
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  conflict_days integer[];
  existing_count integer;
  location_archived_at timestamptz; revision bigint;
begin
  perform 1 from public.users u join public.user_roles r on r.user_id=u.id where u.id=p_actor and u.status='active' and r.role_code='admin' for share of u,r;
  if not found then
    raise exception 'Administrator required' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_weekdays), 0) = 0
    or exists (select 1 from unnest(p_weekdays) day where day not between 0 and 6)
    or (select count(distinct day) from unnest(p_weekdays) day) <> cardinality(p_weekdays)
    or p_replace_ids is null or cardinality(p_replace_ids) <> (select count(distinct id) from unnest(p_replace_ids) id)
    or p_opens_at_minutes is null or p_closes_at_minutes is null
    or cardinality(p_opens_at_minutes) <> cardinality(p_closes_at_minutes)
    or (cardinality(p_replace_ids) = 0 and cardinality(p_opens_at_minutes) = 0)
    or exists (select 1 from unnest(p_opens_at_minutes, p_closes_at_minutes) proposed(opens, closes)
      where opens is null or closes is null or opens not between 0 and 1439
        or closes not between 1 and 1440 or opens >= closes) then
    raise exception 'Invalid weekly opening hours' using errcode = '23514';
  end if;

  select x.revision into revision from public.booking_configuration_revision x where id for update;
  if revision is distinct from p_revision then raise exception 'Stale configuration' using errcode='40001'; end if;
  select archived_at into location_archived_at from public.locations where id = p_location_id for update;
  if not found then return jsonb_build_object('status', 'not-found'); end if;
  if location_archived_at is not null then return jsonb_build_object('status', 'archived'); end if;
  select count(*) into existing_count from public.location_opening_hours
    where location_id = p_location_id and id = any(p_replace_ids);
  if existing_count <> cardinality(p_replace_ids) then
    return jsonb_build_object('status', 'not-found');
  end if;

  begin
    delete from public.location_opening_hours
      where location_id = p_location_id and id = any(p_replace_ids);
    insert into public.location_opening_hours
      (location_id, weekday, opens_at_minute, closes_at_minute, updated_at)
    select p_location_id, day, proposed.opens, proposed.closes, now()
      from unnest(p_weekdays) day
      cross join unnest(p_opens_at_minutes, p_closes_at_minutes) proposed(opens, closes);
  exception when exclusion_violation then
    select array_agg(distinct existing.weekday order by existing.weekday) into conflict_days
      from public.location_opening_hours existing
      join unnest(p_weekdays) day on day = existing.weekday
      cross join unnest(p_opens_at_minutes, p_closes_at_minutes) proposed(opens, closes)
      where existing.location_id = p_location_id and existing.id <> all(p_replace_ids)
        and int4range(existing.opens_at_minute, existing.closes_at_minute, '[)')
          && int4range(proposed.opens, proposed.closes, '[)');
    return jsonb_build_object('status', 'overlap', 'weekdays', coalesce(conflict_days, p_weekdays));
  end;
  perform public.check_applicable_pricing_hours(p_location_id,p_applicable_rule_ids);
  return jsonb_build_object('status', 'ok');
end;
$$;

revoke insert,update,delete on public.location_opening_hours from authenticated;
revoke insert(location_id,weekday,opens_at_minute,closes_at_minute,updated_at),
  update(location_id,weekday,opens_at_minute,closes_at_minute,updated_at)
  on public.location_opening_hours from authenticated;
drop function public.mutate_location_opening_hours(uuid,integer[],uuid[],integer[],integer[]);
drop function public.cancel_own_customer_booking(uuid);
drop function public.cancel_admin_customer_booking(uuid);
drop function public.cancel_customer_booking_with_refund(uuid,boolean,boolean);
drop function public.cancel_own_customer_booking_lifecycle(uuid);
drop function public.cancel_admin_customer_booking_lifecycle(uuid);
drop function public.reschedule_own_customer_booking(uuid,timestamptz,timestamptz,uuid,date,integer,integer,boolean,integer,boolean);
drop function public.reschedule_admin_customer_booking(uuid,timestamptz,timestamptz,uuid,date,integer,integer,boolean,integer,boolean);
drop function public.reschedule_customer_booking(uuid,timestamptz,timestamptz,uuid,date,integer,integer,boolean,integer,boolean,boolean);
drop function public.read_own_booking_edit_availability(uuid,date);
drop function public.read_admin_booking_edit_availability(uuid,date);
drop function public.read_customer_booking_edit_availability(uuid,date,boolean);
drop function public.create_customer_booking(uuid,date,integer,integer,uuid,text,text,text,integer,text,text,text,integer);
drop function public.process_online_payment_event(text,text,uuid,text,text,integer,text);
drop function public.settle_online_payment(uuid,text,text,text);
drop function public.prepare_admin_stripe_refund(uuid,text);
drop function public.finish_admin_stripe_refund(uuid,uuid,uuid,text,text,text);
drop function public.is_refundable_late_payment(text);
drop function public.enqueue_booking_email(uuid,text,text,jsonb);

revoke all on function public.advance_booking_configuration_revision() from public,anon,authenticated;
grant execute on function public.advance_booking_configuration_revision() to service_role;


revoke all on function public.commit_checkout(jsonb,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.commit_checkout(jsonb,bigint,jsonb) to service_role;

revoke all on function public.commit_payment_transition(uuid,text,bigint,uuid,timestamptz,jsonb,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.commit_payment_transition(uuid,text,bigint,uuid,timestamptz,jsonb,jsonb,jsonb,text) to service_role;

revoke all on function public.booking_command_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.booking_command_snapshot(uuid) to service_role;


revoke all on function public.lock_booking_command(uuid,text,bigint,uuid,text,timestamptz,boolean) from public,anon,authenticated;
grant execute on function public.lock_booking_command(uuid,text,bigint,uuid,text,timestamptz,boolean) to service_role;

revoke all on function public.persist_booking_outbox(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.persist_booking_outbox(uuid,jsonb) to service_role;

revoke all on function public.finish_booking_email(uuid,uuid,text,integer,text) from public,anon,authenticated;
grant execute on function public.finish_booking_email(uuid,uuid,text,integer,text) to service_role;

revoke all on function public.commit_booking_cancellation(uuid,text,bigint,uuid,text,timestamptz,boolean,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.commit_booking_cancellation(uuid,text,bigint,uuid,text,timestamptz,boolean,jsonb,jsonb) to service_role;

revoke all on function public.commit_booking_reschedule(uuid,text,bigint,uuid,text,timestamptz,boolean,jsonb,integer,jsonb) from public,anon,authenticated;
grant execute on function public.commit_booking_reschedule(uuid,text,bigint,uuid,text,timestamptz,boolean,jsonb,integer,jsonb) to service_role;

revoke all on function public.persist_refund_event_resolution(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.persist_refund_event_resolution(uuid,uuid,jsonb) to service_role;

revoke all on function public.claim_refund_command(uuid,text,bigint,uuid,jsonb,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.claim_refund_command(uuid,text,bigint,uuid,jsonb,uuid,integer,jsonb) to service_role;

revoke all on function public.commit_refund_result(uuid,text,bigint,uuid,uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.commit_refund_result(uuid,text,bigint,uuid,uuid,uuid,text,text,text,jsonb) to service_role;

revoke all on function public.read_opening_hours_command_context(uuid) from public,anon,authenticated;
grant execute on function public.read_opening_hours_command_context(uuid) to service_role;

revoke all on function public.check_applicable_pricing_hours(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.check_applicable_pricing_hours(uuid,uuid[]) to service_role;

revoke all on function public.commit_location_opening_hours(uuid,integer[],uuid[],integer[],integer[],uuid,bigint,uuid[]) from public,anon,authenticated;
grant execute on function public.commit_location_opening_hours(uuid,integer[],uuid[],integer[],integer[],uuid,bigint,uuid[]) to service_role;

grant select,update on public.booking_configuration_revision to service_role;
