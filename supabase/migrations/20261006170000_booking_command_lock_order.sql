-- Acquire configuration locks before booking locks, including lazy hold cleanup writers.
create or replace function public.lock_booking_command(p_id uuid,p_fingerprint text,p_revision bigint,
  p_actor uuid,p_scope text,p_deadline timestamptz,p_inclusive boolean,p_actor_expected jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
declare b public.bookings%rowtype; current_revision bigint;
begin
  select revision into current_revision from public.booking_configuration_revision where id for share;
  if p_revision is distinct from current_revision then raise exception 'Stale configuration' using errcode='40001'; end if;
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
  if p_fingerprint is distinct from md5(public.booking_command_snapshot(p_id)::text) then
    raise exception 'Stale command' using errcode='40001'; end if;
  if p_deadline is not null and (clock_timestamp()>p_deadline or
    (not p_inclusive and clock_timestamp()>=p_deadline)) then
    raise exception 'Command deadline elapsed' using errcode='40001'; end if;
end;
$$;

create or replace function public.commit_payment_transition(p_id uuid,p_fingerprint text,p_revision bigint,p_attempt_id uuid,
  p_deadline timestamptz,p_targets jsonb,p_event jsonb,p_receipt jsonb,p_result text)
returns text language plpgsql security invoker set search_path = '' as $$
declare b public.bookings%rowtype; p public.payment_attempts%rowtype; existing public.payment_provider_events%rowtype;
begin
  -- A concurrent duplicate returns its durable result, never reapplies the command.
  perform 1 from public.booking_configuration_revision where id for share;
  perform 1 from public.bookings where id=p_id for update;
  if p_receipt is not null then
    select * into existing from public.payment_provider_events
      where provider=p_receipt->>'provider' and event_id=p_receipt->>'event_id';
    if found then
      if existing.attempt_id is distinct from p_attempt_id or existing.provider_payment_id is distinct from p_receipt->>'provider_payment_id'
        or existing.outcome is distinct from p_receipt->>'outcome' or existing.amount_minor is distinct from (p_receipt->>'amount_minor')::integer
        or existing.currency is distinct from p_receipt->>'currency' then
        raise exception 'Changed event evidence' using errcode='23514';
      end if;
      return existing.settlement_result;
    end if;
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
