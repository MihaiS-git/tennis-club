-- Keep the final persistence API unambiguous and provider-neutral.
alter table public.payment_refunds drop constraint payment_refunds_provider_check;
alter table public.payment_refunds add constraint payment_refunds_provider_check check(provider in ('stripe','netopia'));
create or replace function public.commit_booking_reschedule(p_id uuid,p_fingerprint text,p_revision bigint,
  p_actor uuid,p_scope text,p_deadline timestamptz,p_inclusive boolean,p_schedule jsonb,p_total integer,p_event jsonb,p_actor_expected jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare b public.bookings%rowtype; r public.court_reservations%rowtype; v_location_id uuid;
begin
  perform public.lock_booking_command(p_id,p_fingerprint,p_revision,p_actor,p_scope,p_deadline,p_inclusive,p_actor_expected);
  select * into b from public.bookings where id=p_id;
  select * into r from public.court_reservations where id=b.reservation_id;
  if b.status<>'confirmed' or r.status<>'active' then raise exception 'Invalid reschedule state' using errcode='23514'; end if;
  select c.location_id into v_location_id from public.courts c where c.id=r.court_id;
  if not exists(select 1 from public.courts c join public.locations l on l.id=c.location_id
    where c.id=(p_schedule->>'court_id')::uuid and c.location_id=v_location_id and c.is_active and l.is_active and l.archived_at is null and l.currency=b.currency) then
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
