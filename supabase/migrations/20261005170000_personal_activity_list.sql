-- Read-only owner-scoped mixed activity list. Existing mutation/read RPCs remain unchanged.
create function public.list_own_court_activity(
  p_scope text default 'upcoming', p_page integer default 1,
  p_type text default 'all', p_status text default 'all',
  p_location_id uuid default null, p_court_id uuid default null,
  p_date_from date default null, p_date_to date default null,
  p_sort text default 'datetime', p_direction text default 'asc',
  p_now timestamptz default now()
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not exists (select 1 from public.users u where u.id = (select auth.uid()) and u.status = 'active') then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('upcoming', 'history')
    or p_page is null or p_page < 1 or p_page > 1000000
    or p_type is null or p_type not in ('all', 'booking', 'reservation')
    or p_status is null or p_status not in ('all', 'completed', 'cancelled')
    or (p_scope = 'upcoming' and p_status <> 'all')
    or p_sort is null or p_sort not in ('datetime', 'location', 'court', 'type', 'duration', 'status')
    or (p_scope = 'upcoming' and p_sort = 'status')
    or p_direction is null or p_direction not in ('asc', 'desc') or p_now is null
    or (p_date_from is not null and p_date_to is not null and p_date_from > p_date_to) then
    raise exception 'Invalid activity query' using errcode = '22023';
  end if;

  with activity as (
    select 'booking'::text as kind, b.id,
      (r.booking_date::timestamp + r.starts_at_minute * interval '1 minute') at time zone l.timezone as starts_at_instant,
      (r.booking_date::timestamp + r.ends_at_minute * interval '1 minute') at time zone l.timezone as ends_at_instant,
      case when b.status = 'cancelled' then b.updated_at
        else (r.booking_date::timestamp + r.ends_at_minute * interval '1 minute') at time zone l.timezone end as history_at,
      r.booking_date, r.starts_at_minute, r.ends_at_minute,
      l.name as location_name, l.timezone as location_timezone, c.name as court_name,
      b.status::text as status, r.status::text as reservation_status,
      b.customer_name, b.customer_email, b.customer_phone,
      b.total_amount_minor, b.currency, b.cancellation_notice_minutes,
      r.court_id, c.location_id, null::timestamptz as updated_at,
      null::text as reason, null::uuid as created_by_user_id,
      null::text as creator_name, null::timestamptz as cancelled_at,
      null::text as cancelled_by_name
    from public.bookings b
    join public.court_reservations r on r.id = b.reservation_id
    join public.courts c on c.id = r.court_id
    join public.locations l on l.id = c.location_id
    where b.account_user_id = (select auth.uid())
    union all
    select 'reservation'::text, r.id,
      (r.booking_date::timestamp + r.starts_at_minute * interval '1 minute') at time zone l.timezone,
      (r.booking_date::timestamp + r.ends_at_minute * interval '1 minute') at time zone l.timezone,
      case when r.status = 'cancelled' then coalesce(r.cancelled_at, r.updated_at)
        else (r.booking_date::timestamp + r.ends_at_minute * interval '1 minute') at time zone l.timezone end,
      r.booking_date, r.starts_at_minute, r.ends_at_minute,
      l.name, l.timezone, c.name, r.status::text, r.status::text,
      null::text, null::text, null::text, null::integer, null::text, null::integer,
      r.court_id, c.location_id, r.updated_at, r.reason, r.created_by_user_id,
      nullif(concat_ws(' ', creator.first_name, creator.last_name), ''),
      r.cancelled_at, nullif(concat_ws(' ', canceller.first_name, canceller.last_name), '')
    from public.court_reservations r
    join public.courts c on c.id = r.court_id
    join public.locations l on l.id = c.location_id
    left join public.users creator on creator.id = r.created_by_user_id
    left join public.users canceller on canceller.id = r.cancelled_by_user_id
    where r.created_by_user_id = (select auth.uid())
      and (public.has_role('admin') or public.has_role('coach'))
  ), eligible as materialized (
    select a.*, case when a.status = 'cancelled' then 'cancelled' else 'completed' end as display_status
    from activity a
    where (p_scope = 'upcoming' and a.status in ('active', 'confirmed')
        and a.reservation_status = 'active' and a.ends_at_instant > p_now)
      or (p_scope = 'history' and (a.status = 'cancelled'
        or (a.status in ('active', 'confirmed') and a.reservation_status = 'active' and a.ends_at_instant <= p_now)))
  ), filtered as materialized (
    select a.* from eligible a
    where (p_type = 'all' or a.kind = p_type)
      and (p_status = 'all' or a.display_status = p_status)
      and (p_location_id is null or a.location_id = p_location_id)
      and (p_court_id is null or a.court_id = p_court_id)
      and (p_date_from is null or a.booking_date >= p_date_from)
      and (p_date_to is null or a.booking_date <= p_date_to)
  ), numbered as (
    select a.*, row_number() over (order by
      case when p_sort = 'datetime' and p_direction = 'asc' then a.starts_at_instant end asc,
      case when p_sort = 'datetime' and p_direction = 'desc' then a.starts_at_instant end desc,
      case when p_sort = 'location' and p_direction = 'asc' then lower(a.location_name) end asc,
      case when p_sort = 'location' and p_direction = 'desc' then lower(a.location_name) end desc,
      case when p_sort = 'court' and p_direction = 'asc' then lower(a.court_name) end asc,
      case when p_sort = 'court' and p_direction = 'desc' then lower(a.court_name) end desc,
      case when p_sort = 'type' and p_direction = 'asc' then a.kind end asc,
      case when p_sort = 'type' and p_direction = 'desc' then a.kind end desc,
      case when p_sort = 'duration' and p_direction = 'asc' then a.ends_at_minute - a.starts_at_minute end asc,
      case when p_sort = 'duration' and p_direction = 'desc' then a.ends_at_minute - a.starts_at_minute end desc,
      case when p_sort = 'status' and p_direction = 'asc' then a.display_status end asc,
      case when p_sort = 'status' and p_direction = 'desc' then a.display_status end desc,
      case when p_scope = 'upcoming' then a.starts_at_instant end asc,
      case when p_scope = 'history' then a.starts_at_instant end desc,
      a.kind asc, a.id asc
    ) as position from filtered a
  ), page as (
    select a.* from numbered a order by a.position limit 20 offset (p_page - 1) * 20
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(a) - 'position' - 'display_status' - 'reservation_status' - 'ends_at_instant' order by a.position) from page a), '[]'::jsonb),
    'hasNext', (select count(*) > p_page * 20 from filtered),
    'locations', coalesce((select jsonb_agg(to_jsonb(l) order by l.name, l.id)
      from (select distinct a.location_id as id, a.location_name as name from eligible a) l), '[]'::jsonb),
    'courts', coalesce((select jsonb_agg(to_jsonb(c) order by c.name, c.id)
      from (select distinct a.court_id as id, a.court_name as name, a.location_id from eligible a) c), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.list_own_court_activity(text, integer, text, text, uuid, uuid, date, date, text, text, timestamptz) from public, anon;
grant execute on function public.list_own_court_activity(text, integer, text, text, uuid, uuid, date, date, text, text, timestamptz) to authenticated;
