-- Upcoming direct reservations retain their owner-only read. History uses the
-- mixed projection below, so the old reservation-only history path is retired.
drop function public.list_personal_court_reservations(text, integer, integer, timestamptz);

create function public.list_personal_court_reservations(p_now timestamptz default now())
returns table (id uuid, court_id uuid, location_id uuid, updated_at timestamptz,
  booking_date date, starts_at_minute integer, ends_at_minute integer,
  reason text, status public.court_reservation_status, created_by_user_id uuid,
  creator_name text, cancelled_at timestamptz, cancelled_by_name text,
  location_name text, location_timezone text, court_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.has_role('admin') or public.has_role('coach')) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  return query
    select r.id, r.court_id, c.location_id, r.updated_at,
      r.booking_date, r.starts_at_minute, r.ends_at_minute,
      r.reason, r.status, r.created_by_user_id,
      nullif(concat_ws(' ', creator.first_name, creator.last_name), ''),
      r.cancelled_at,
      nullif(concat_ws(' ', canceller.first_name, canceller.last_name), ''),
      l.name, l.timezone, c.name
    from public.court_reservations r
    join public.courts c on c.id = r.court_id
    join public.locations l on l.id = c.location_id
    left join public.users creator on creator.id = r.created_by_user_id
    left join public.users canceller on canceller.id = r.cancelled_by_user_id
    where r.created_by_user_id = (select auth.uid()) and r.status = 'active'
      and (r.booking_date > (p_now at time zone l.timezone)::date
        or (r.booking_date = (p_now at time zone l.timezone)::date
          and r.ends_at_minute > extract(hour from p_now at time zone l.timezone)::integer * 60
            + extract(minute from p_now at time zone l.timezone)::integer))
    order by r.booking_date, r.starts_at_minute, r.id;
end;
$$;
revoke all on function public.list_personal_court_reservations(timestamptz) from public, anon;
grant execute on function public.list_personal_court_reservations(timestamptz) to authenticated;

create function public.list_own_court_activity_history(
  p_page integer default 1, p_now timestamptz default now()
)
returns table (
  kind text, id uuid, history_at timestamptz,
  booking_date date, starts_at_minute integer, ends_at_minute integer,
  location_name text, location_timezone text, court_name text,
  status text, customer_name text, customer_email text, customer_phone text,
  total_amount_minor integer, currency text,
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
      h.total_amount_minor, h.currency,
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
        b.total_amount_minor, b.currency,
        null::uuid as court_id, null::uuid as location_id, null::timestamptz as updated_at,
        null::text as reason, null::uuid as created_by_user_id,
        null::text as creator_name, null::timestamptz as cancelled_at,
        null::text as cancelled_by_name
      from public.bookings b
      join public.court_reservations r on r.id = b.reservation_id
      join public.courts c on c.id = r.court_id
      join public.locations l on l.id = c.location_id
      where b.account_user_id = (select auth.uid())
        and (b.status = 'cancelled' or (b.status = 'confirmed' and r.status = 'active'
          and (r.booking_date::timestamp + r.ends_at_minute * interval '1 minute') at time zone l.timezone <= p_now))
      union all
      select 'reservation'::text, r.id,
        case when r.status = 'cancelled' then coalesce(r.cancelled_at, r.updated_at)
          else (r.booking_date::timestamp + r.ends_at_minute * interval '1 minute') at time zone l.timezone end,
        r.booking_date, r.starts_at_minute, r.ends_at_minute,
        l.name, l.timezone, c.name, r.status::text,
        null::text, null::text, null::text, null::integer, null::text,
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
revoke all on function public.list_own_court_activity_history(integer, timestamptz) from public, anon;
grant execute on function public.list_own_court_activity_history(integer, timestamptz) to authenticated;
