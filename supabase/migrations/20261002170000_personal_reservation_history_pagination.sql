-- The owner's read includes the stable court identity and the optimistic edit token.
drop function if exists public.list_personal_court_reservations();
create or replace function public.list_personal_court_reservations(
  p_scope text default 'upcoming', p_page integer default 1,
  p_page_size integer default 20, p_now timestamptz default now())
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
  if p_scope not in ('upcoming', 'history') or p_page < 1 or p_page > 1000000
    or p_page_size < 1 or p_page_size > 100 then
    raise exception 'Invalid activity page' using errcode = '22023';
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
    where r.created_by_user_id = (select auth.uid())
      and ((p_scope = 'upcoming' and r.status = 'active'
        and (r.booking_date > (p_now at time zone l.timezone)::date
          or (r.booking_date = (p_now at time zone l.timezone)::date
            and r.ends_at_minute > extract(hour from p_now at time zone l.timezone)::integer * 60
              + extract(minute from p_now at time zone l.timezone)::integer)))
        or (p_scope = 'history' and (r.status = 'cancelled'
          or r.booking_date < (p_now at time zone l.timezone)::date
          or (r.booking_date = (p_now at time zone l.timezone)::date
            and r.ends_at_minute <= extract(hour from p_now at time zone l.timezone)::integer * 60
              + extract(minute from p_now at time zone l.timezone)::integer))))
    order by
      case when p_scope = 'upcoming' then r.booking_date end asc,
      case when p_scope = 'upcoming' then r.starts_at_minute end asc,
      case when p_scope = 'history' then
        case when r.status = 'cancelled' then r.cancelled_at
          else (r.booking_date::timestamp + r.ends_at_minute * interval '1 minute') at time zone l.timezone end
      end desc,
      r.id desc
    limit case when p_scope = 'history' then p_page_size + 1 else null end
    offset case when p_scope = 'history' then (p_page - 1) * p_page_size else 0 end;
end;
$$;
revoke all on function public.list_personal_court_reservations(text, integer, integer, timestamptz) from public;
grant execute on function public.list_personal_court_reservations(text, integer, integer, timestamptz) to authenticated;
