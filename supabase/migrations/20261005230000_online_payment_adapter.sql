-- Browser polling uses an unguessable checkout capability, never a customer ID.
alter table public.payment_attempts add column checkout_token_hash text;
create unique index payment_checkout_token_idx on public.payment_attempts(checkout_token_hash)
  where checkout_token_hash is not null;

create table public.payment_provider_events (
  provider text not null check (provider in ('stripe','netopia')),
  event_id text not null,
  attempt_id uuid not null references public.payment_attempts(id) on delete cascade,
  provider_payment_id text not null,
  outcome text not null check (outcome in ('succeeded','failed','retryable_failed','cancelled')),
  settlement_result text not null,
  reconciliation_required boolean not null default false,
  amount_minor integer not null,
  currency text not null,
  received_at timestamptz not null default clock_timestamp(),
  primary key(provider,event_id)
);
alter table public.payment_provider_events enable row level security;
revoke all on public.payment_provider_events from public, anon, authenticated;
create index payment_reconciliation_idx on public.payment_provider_events(attempt_id)
  where reconciliation_required;

-- Atomic event receipt + existing settlement. Lock order stays booking/reservation/attempt.
create function public.process_online_payment_event(p_provider text, p_event_id text,
  p_attempt_id uuid, p_provider_payment_id text, p_outcome text,
  p_amount_minor integer, p_currency text)
returns text language plpgsql security invoker set search_path = '' as $$
declare target uuid; attempt public.payment_attempts%rowtype; result text;
begin
  if current_role <> 'service_role' then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_event_id is null or length(p_event_id) not between 1 and 255
    or p_outcome is null or p_outcome not in ('succeeded','failed','retryable_failed','cancelled') then
    raise exception 'Invalid event' using errcode = '22023';
  end if;
  select booking_id into target from public.payment_attempts where id = p_attempt_id;
  perform 1 from public.bookings where id = target for update;
  if not found then return 'unavailable'; end if;
  select * into attempt from public.payment_attempts where id = p_attempt_id;
  -- Only the registered intent, stored provider and exact financial snapshot may settle.
  if attempt.method <> 'online' or attempt.provider is distinct from p_provider
    or attempt.provider_payment_id is distinct from p_provider_payment_id then return 'unavailable'; end if;
  select settlement_result into result from public.payment_provider_events
    where provider = p_provider and event_id = p_event_id;
  if found then return result; end if;
  if attempt.amount_minor is distinct from p_amount_minor or attempt.currency is distinct from upper(p_currency) then
    result := 'amount_mismatch';
  else
    result := public.settle_online_payment(p_attempt_id,p_provider,p_provider_payment_id,p_outcome);
  end if;
  insert into public.payment_provider_events(provider,event_id,attempt_id,provider_payment_id,outcome,
    settlement_result,reconciliation_required,amount_minor,currency)
  values (p_provider,p_event_id,p_attempt_id,p_provider_payment_id,p_outcome,result,
    p_outcome = 'succeeded' and result <> 'succeeded',p_amount_minor,upper(p_currency));
  return result;
end;
$$;
revoke all on function public.process_online_payment_event(text,text,uuid,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.process_online_payment_event(text,text,uuid,text,text,integer,text) to service_role;

-- Register before exposing the client secret. An expired attempt cannot reopen a hold.
create function public.attach_online_payment(p_attempt_id uuid, p_provider text,
  p_provider_payment_id text, p_token_hash text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if current_role <> 'service_role' then raise exception 'Not authorized' using errcode = '42501'; end if;
  if length(p_token_hash) <> 64 or p_token_hash is null
    or p_provider_payment_id is null or length(p_provider_payment_id) not between 1 and 255 then
    raise exception 'Invalid checkout' using errcode = '22023'; end if;
  -- Keep the reference even when creation outlives expiry, for late-charge reconciliation.
  update public.payment_attempts set provider_payment_id = p_provider_payment_id, checkout_token_hash = p_token_hash
    where id = p_attempt_id and method = 'online' and provider = p_provider
      and (provider_payment_id is null or provider_payment_id = p_provider_payment_id)
      and checkout_token_hash is null;
  return found;
end;
$$;
revoke all on function public.attach_online_payment(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.attach_online_payment(uuid,text,text,text) to service_role;
