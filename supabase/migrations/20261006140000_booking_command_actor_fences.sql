-- Fence server authorization facts and standardize configuration lock ordering.
create function public.booking_actor_snapshot(p_actor uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('id',u.id,'status',u.status,'roles',coalesce((select jsonb_agg(r.role_code order by r.role_code)
    from public.user_roles r where r.user_id=u.id),'[]'::jsonb)) from public.users u where u.id=p_actor;
$$;

drop function public.lock_booking_command(uuid,text,bigint,uuid,text,timestamptz,boolean);
create function public.lock_booking_command(p_id uuid,p_fingerprint text,p_revision bigint,
  p_actor uuid,p_scope text,p_deadline timestamptz,p_inclusive boolean,p_actor_expected jsonb) returns void
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
    if p_actor_expected is null or p_actor_expected is distinct from public.booking_actor_snapshot(p_actor) then
      raise exception 'Changed actor facts' using errcode='40001'; end if;
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

drop function public.commit_booking_cancellation(uuid,text,bigint,uuid,text,timestamptz,boolean,jsonb,jsonb);
create function public.commit_booking_cancellation(p_id uuid,p_fingerprint text,p_revision bigint,
  p_actor uuid,p_scope text,p_deadline timestamptz,p_inclusive boolean,p_refund jsonb,p_event jsonb,p_actor_expected jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare b public.bookings%rowtype; refund_id uuid;
begin
  perform public.lock_booking_command(p_id,p_fingerprint,p_revision,p_actor,p_scope,p_deadline,p_inclusive,p_actor_expected);
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

drop function public.commit_booking_reschedule(uuid,text,bigint,uuid,text,timestamptz,boolean,jsonb,integer,jsonb);
create function public.commit_booking_reschedule(p_id uuid,p_fingerprint text,p_revision bigint,
  p_actor uuid,p_scope text,p_deadline timestamptz,p_inclusive boolean,p_schedule jsonb,p_total integer,p_event jsonb,p_actor_expected jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare b public.bookings%rowtype; r public.court_reservations%rowtype; location_id uuid;
begin
  perform public.lock_booking_command(p_id,p_fingerprint,p_revision,p_actor,p_scope,p_deadline,p_inclusive,p_actor_expected);
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

drop function public.claim_refund_command(uuid,text,bigint,uuid,jsonb,uuid,integer,jsonb);
create function public.claim_refund_command(p_id uuid,p_fingerprint text,p_revision bigint,p_actor uuid,
  p_refund jsonb,p_token uuid,p_lease_seconds integer,p_events jsonb,p_actor_expected jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare f public.payment_refunds%rowtype;
begin
  perform public.lock_booking_command(p_id,p_fingerprint,p_revision,p_actor,'admin',null,false,p_actor_expected);
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
create or replace function public.commit_payment_transition(p_id uuid,p_fingerprint text,p_revision bigint,p_attempt_id uuid,
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
  perform public.lock_booking_command(p_id,p_fingerprint,p_revision,null,'system',p_deadline,false,null);
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
create or replace function public.commit_refund_result(p_id uuid,p_fingerprint text,p_revision bigint,p_refund_id uuid,
  p_token uuid,p_actor_id uuid,p_status text,p_provider_refund_id text,p_error text,p_events jsonb) returns text
language plpgsql security invoker set search_path = '' as $$
declare f public.payment_refunds%rowtype;
begin
  perform public.lock_booking_command(p_id,p_fingerprint,p_revision,null,'system',null,false,null);
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

create function public.lock_booking_configuration() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if current_role <> 'service_role' and not public.has_role('admin') then raise exception 'Not authorized' using errcode='42501'; end if;
  perform 1 from public.booking_configuration_revision where id for update;
end;
$$;
create or replace function public.save_pricing_rule_set(
  p_rule_set_id uuid, p_location_id uuid, p_court_ids uuid[], p_weekdays integer[],
  p_court_state text, p_starts_at_minute integer, p_ends_at_minute integer,
  p_starts_on date, p_ends_on date, p_price_per_hour_minor integer, p_updated_at timestamptz
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  target_id uuid;
begin
  perform public.lock_booking_configuration();
  if not public.has_role('admin') then
    raise exception 'Administrator required' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_court_ids), 0) = 0 or coalesce(cardinality(p_weekdays), 0) = 0 then
    raise exception 'Empty pricing applicability' using errcode = '23514';
  end if;
  perform 1 from public.locations where id = p_location_id for update;
  if p_rule_set_id is null then
    insert into public.pricing_rule_sets(location_id) values (p_location_id) returning id into target_id;
  else
    select id into target_id from public.pricing_rule_sets
      where id = p_rule_set_id and location_id = p_location_id for update;
    if not found then return null; end if;
    delete from public.location_pricing_rules where rule_set_id = target_id;
  end if;
  insert into public.location_pricing_rules (
    rule_set_id, location_id, court_id, court_state, weekday, starts_at_minute, ends_at_minute,
    starts_on, ends_on, price_per_hour_minor, updated_at
  ) select target_id, p_location_id, court_id, p_court_state, weekday, p_starts_at_minute, p_ends_at_minute,
    p_starts_on, p_ends_on, p_price_per_hour_minor, p_updated_at
    from unnest(p_court_ids) as courts(court_id) cross join unnest(p_weekdays) as days(weekday);
  return target_id;
end;
$$;
create or replace function public.remove_pricing_rule_set(p_rule_set_id uuid, p_location_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  target_id uuid;
begin
  perform public.lock_booking_configuration();
  if not public.has_role('admin') then
    raise exception 'Administrator required' using errcode = '42501';
  end if;
  select id into target_id from public.pricing_rule_sets
    where id = p_rule_set_id and location_id = p_location_id for update;
  if not found then return null; end if;
  delete from public.pricing_rule_sets where id = target_id;
  return target_id;
end;
$$;

revoke all on function public.booking_actor_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.booking_actor_snapshot(uuid) to service_role;

revoke all on function public.lock_booking_command(uuid,text,bigint,uuid,text,timestamptz,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.lock_booking_command(uuid,text,bigint,uuid,text,timestamptz,boolean,jsonb) to service_role;

revoke all on function public.commit_booking_cancellation(uuid,text,bigint,uuid,text,timestamptz,boolean,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.commit_booking_cancellation(uuid,text,bigint,uuid,text,timestamptz,boolean,jsonb,jsonb,jsonb) to service_role;

revoke all on function public.commit_booking_reschedule(uuid,text,bigint,uuid,text,timestamptz,boolean,jsonb,integer,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.commit_booking_reschedule(uuid,text,bigint,uuid,text,timestamptz,boolean,jsonb,integer,jsonb,jsonb) to service_role;

revoke all on function public.claim_refund_command(uuid,text,bigint,uuid,jsonb,uuid,integer,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.claim_refund_command(uuid,text,bigint,uuid,jsonb,uuid,integer,jsonb,jsonb) to service_role;

revoke all on function public.commit_payment_transition(uuid,text,bigint,uuid,timestamptz,jsonb,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.commit_payment_transition(uuid,text,bigint,uuid,timestamptz,jsonb,jsonb,jsonb,text) to service_role;

revoke all on function public.commit_refund_result(uuid,text,bigint,uuid,uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.commit_refund_result(uuid,text,bigint,uuid,uuid,uuid,text,text,text,jsonb) to service_role;

revoke all on function public.lock_booking_configuration() from public,anon,authenticated;
grant execute on function public.lock_booking_configuration() to service_role;
grant execute on function public.lock_booking_configuration() to authenticated;
