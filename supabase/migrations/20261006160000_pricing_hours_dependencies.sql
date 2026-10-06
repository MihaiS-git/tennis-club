-- TypeScript supplies applicability; PostgreSQL retains unconditional structural integrity.
create table public.pricing_opening_hours_requirements (
  rule_id uuid primary key references public.location_pricing_rules(id) on delete cascade
);
alter table public.pricing_opening_hours_requirements enable row level security;
revoke all on public.pricing_opening_hours_requirements from public,anon,authenticated;
grant select,insert,delete on public.pricing_opening_hours_requirements to service_role;
-- Establish dependencies for the structurally covered configuration already stored.
insert into public.pricing_opening_hours_requirements(rule_id)
select p.id from public.location_pricing_rules p where exists(select 1 from public.location_opening_hours h
  where h.location_id=p.location_id and h.weekday=p.weekday and h.opens_at_minute<=p.starts_at_minute and p.ends_at_minute<=h.closes_at_minute);
create function public.create_pricing_hours_requirement() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.pricing_opening_hours_requirements(rule_id) values(new.id);
  return null;
end;
$$;
revoke all on function public.create_pricing_hours_requirement() from public,anon,authenticated;
create trigger pricing_hours_requirement after insert on public.location_pricing_rules
for each row execute function public.create_pricing_hours_requirement();
create function public.check_hours_cover_pricing() returns trigger
language plpgsql security definer set search_path = '' as $$
declare conflicts jsonb; target uuid;
begin
  target:=case when tg_op='DELETE' then old.location_id else new.location_id end;
  select jsonb_agg(to_jsonb(item)) into conflicts from (
    select distinct p.weekday,p.starts_at_minute,p.ends_at_minute
    from public.location_pricing_rules p join public.pricing_opening_hours_requirements d on d.rule_id=p.id
    where p.location_id=target and not exists(select 1 from public.location_opening_hours h
      where h.location_id=p.location_id and h.weekday=p.weekday and h.opens_at_minute<=p.starts_at_minute and p.ends_at_minute<=h.closes_at_minute)
    order by p.weekday,p.starts_at_minute,p.ends_at_minute limit 4) item;
  if conflicts is not null then raise exception 'opening_hours_pricing_conflict' using errcode='P0001',detail=conflicts::text; end if;
  return null;
end;
$$;
revoke all on function public.check_hours_cover_pricing() from public,anon,authenticated;
create constraint trigger check_hours_cover_pricing after insert or update or delete on public.location_opening_hours
 deferrable initially deferred for each row execute function public.check_hours_cover_pricing();
create or replace function public.commit_location_opening_hours(
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
    delete from public.pricing_opening_hours_requirements d using public.location_pricing_rules p
      where d.rule_id=p.id and p.location_id=p_location_id;
    insert into public.pricing_opening_hours_requirements(rule_id)
      select p.id from public.location_pricing_rules p where p.location_id=p_location_id and p.id=any(p_applicable_rule_ids);
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
  return jsonb_build_object('status', 'ok');
end;
$$;
drop function public.check_applicable_pricing_hours(uuid,uuid[]);
create or replace function public.commit_booking_cancellation(p_id uuid,p_fingerprint text,p_revision bigint,
  p_actor uuid,p_scope text,p_deadline timestamptz,p_inclusive boolean,p_refund jsonb,p_event jsonb,p_actor_expected jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare b public.bookings%rowtype; refund_id uuid;
begin
  if p_scope is null or p_scope not in ('owner','admin') or p_deadline is null then raise exception 'Invalid command boundary' using errcode='42501'; end if;
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
create or replace function public.commit_booking_reschedule(p_id uuid,p_fingerprint text,p_revision bigint,
  p_actor uuid,p_scope text,p_deadline timestamptz,p_inclusive boolean,p_schedule jsonb,p_total integer,p_event jsonb,p_actor_expected jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare b public.bookings%rowtype; r public.court_reservations%rowtype; v_location_id uuid;
begin
  if p_scope is null or p_scope not in ('owner','admin') or p_deadline is null then raise exception 'Invalid command boundary' using errcode='42501'; end if;
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
